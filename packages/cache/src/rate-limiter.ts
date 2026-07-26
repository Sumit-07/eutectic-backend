/**
 * Sliding-window rate limiter, backed by a Redis sorted set (the "sliding
 * window log" algorithm).
 *
 * One key per limited subject holds one member per request still inside the
 * window, scored by its arrival time in milliseconds:
 *
 *   1. evict every member with score <= (now - window)        — ZREMRANGEBYSCORE
 *   2. count what is left                                     — ZCARD
 *   3. count < limit  → admit: add this request, extend the key's TTL, allow
 *      count >= limit → deny: report the oldest surviving member's age as
 *                        the wait
 *
 * All three steps run in ONE Lua script (`redis.eval`), which is how the
 * decision stays atomic without a client-side MULTI: two concurrent
 * `check()` calls for the same key cannot both observe "count < limit" for
 * the request that should have been the one to tip it over, because Redis
 * executes one Lua script to completion before starting the next command,
 * full stop. A MULTI/EXEC pipeline could batch the same four commands but
 * cannot make the eviction-count-decide sequence atomic, because the count is
 * read as part of the same transaction that has already been queued — there
 * is no way to branch inside MULTI on a value MULTI itself produced. Lua is
 * the only way to keep "count, then decide, then maybe write" as one
 * indivisible step.
 *
 * WINDOW BOUNDARY, precisely: a member is evicted when its score is <= the
 * window start (`now - windowMs`), so the covered window is the
 * HALF-OPEN interval `(now - windowMs, now]`. A request made EXACTLY
 * `windowMs` ago has aged out by the time `now` arrives at that instant —
 * this is deliberate (see the boundary tests) and is what makes the window
 * "roll" continuously rather than jumping in fixed buckets.
 *
 * FAIL OPEN is the limiter's one hard-coded judgment call, not a default a
 * caller can flip: SD's cache-only invariant (D-001) says a Redis outage may
 * degrade latency or precision but never correctness for a READ. A rate
 * limiter is the one place in this package where "degrade" could plausibly
 * mean "start rejecting everything" instead of "stop rate-limiting" — and
 * rejecting everything is a self-inflicted outage of whatever the limiter is
 * guarding. Between "Redis is down, so let every request through
 * unthrottled" and "Redis is down, so block every request", only the former
 * keeps the product function that fail-closed budget/kill-switch logic
 * (system-design §7, a DIFFERENT gate, enforced in Postgres) still governs
 * money. This is flagged in the PR body for Fable/CTO ratification, per the
 * ticket's own framing of it as a judgment call.
 */

// See client.ts's import comment: the named `Redis` export, not the default
// import, is what actually resolves to the class under NodeNext/ESM interop.
import type { Redis } from "ioredis";
import { randomUUID } from "node:crypto";

import { withCommandTimeout } from "./timeout.js";

export interface SlidingWindowLimiterConfig {
  /** Requests allowed inside any rolling window of `windowSeconds`. */
  readonly limit: number;
  /** Window length, in seconds. */
  readonly windowSeconds: number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  /**
   * Requests still permitted in the CURRENT window after this check.
   * `undefined` when the decision was made without Redis (fail-open) — there
   * is no real count to report, and reporting `0` or `limit` would both be a
   * fabricated number.
   */
  readonly remaining: number | undefined;
  /** Seconds to wait before the next request would be admitted. `0` when `allowed`. */
  readonly retryAfterSeconds: number;
}

export interface SlidingWindowLimiter {
  /**
   * @param key  The limited subject — an agent id, a user id, an IP, whatever
   *             the caller namespaces it as.
   * @param now  Explicit clock, mirroring D-014 ("now is always an explicit
   *             parameter, never an internal `Date.now()`"). Required, not
   *             defaulted, so a boundary test can never accidentally read the
   *             wall clock.
   */
  check(key: string, now: Date): Promise<RateLimitResult>;
}

/**
 * KEYS[1] = the sorted-set key
 * ARGV[1] = now, milliseconds
 * ARGV[2] = window, milliseconds
 * ARGV[3] = limit
 * ARGV[4] = member — unique per call so same-millisecond requests don't
 *           collide (a sorted set can hold only one score per member; two
 *           requests arriving in the same millisecond must still both count)
 *
 * Returns [allowed (1|0), remaining, retry_after_ms].
 */
const SLIDING_WINDOW_SCRIPT = `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
local window_start = now - window

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', window_start)
local count = redis.call('ZCARD', KEYS[1])

if count < limit then
  redis.call('ZADD', KEYS[1], now, member)
  redis.call('PEXPIRE', KEYS[1], window)
  return { 1, limit - count - 1, 0 }
end

local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
local retry_after_ms = 0
if oldest[2] ~= nil then
  retry_after_ms = (tonumber(oldest[2]) + window) - now
  if retry_after_ms < 0 then
    retry_after_ms = 0
  end
end
return { 0, 0, retry_after_ms }
`;

function isEvalResult(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    typeof value[2] === "number"
  );
}

/**
 * Build a limiter over one Redis connection, all keys under `keyPrefix`.
 *
 * Internal to this package — reached through `Cache.limiter(...)` (client.ts)
 * so a limiter is always namespaced the same way the typed cache view is.
 */
export function createSlidingWindowLimiter(
  redis: Redis,
  keyPrefix: string,
  config: SlidingWindowLimiterConfig,
  commandTimeoutMs: number,
): SlidingWindowLimiter {
  const windowMs = config.windowSeconds * 1000;

  return {
    async check(key: string, now: Date): Promise<RateLimitResult> {
      const nowMs = now.getTime();
      const member = `${nowMs}:${randomUUID()}`;
      try {
        const raw = await withCommandTimeout(
          redis.eval(
            SLIDING_WINDOW_SCRIPT,
            1,
            `${keyPrefix}${key}`,
            nowMs,
            windowMs,
            config.limit,
            member,
          ),
          commandTimeoutMs,
        );
        if (!isEvalResult(raw)) {
          // Redis returned something the script cannot produce — treat exactly
          // like an outage rather than trust a shape we cannot account for.
          return { allowed: true, remaining: undefined, retryAfterSeconds: 0 };
        }
        const [allowedFlag, remaining, retryAfterMs] = raw;
        return {
          allowed: allowedFlag === 1,
          remaining: allowedFlag === 1 ? remaining : 0,
          retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
        };
      } catch {
        // FAIL OPEN — see the module doc comment. Never throws, never denies
        // on Redis's behalf.
        return { allowed: true, remaining: undefined, retryAfterSeconds: 0 };
      }
    },
  };
}
