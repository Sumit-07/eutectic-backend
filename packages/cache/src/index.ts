/**
 * @eutectic/cache — the loss-tolerant Redis layer (system-design §3, §6's
 * cache-layers table; D-001: "Redis is used only for cache, counters, and
 * rate limiting — all of which are allowed to be lossy").
 *
 *   - `client.ts`       — `createCache(...)`: explicit lifecycle, typed
 *                         get/set/del/incr with a JSON codec, namespace
 *                         prefixes.
 *   - `rate-limiter.ts` — the sliding-window limiter reached through
 *                         `Cache.limiter(...)`. FAILS OPEN on a Redis outage
 *                         — the one place this package's default posture
 *                         ("degrade to a miss") is deliberately NOT what
 *                         happens; see that file's doc comment.
 *   - `codec.ts`        — the JSON encode/decode used by every typed helper;
 *                         a corrupt or unparseable value is a miss, never a
 *                         throw.
 *   - `env.ts`          — `REDIS_URL`, defaulting to the documented dev
 *                         address rather than throwing (the opposite of
 *                         `@eutectic/db`'s `requireDatabaseUrl`, and for the
 *                         opposite reason: Redis being unconfigured must
 *                         degrade, never crash the process).
 *
 * Nothing in this package is a queue. No `BLPOP`, no streams, no pub/sub
 * used as work dispatch — the queue lives in Postgres (system-design §3).
 *
 * Explicit named exports only — no barrel re-export (CLAUDE.md §4).
 */

export { createCache, type Cache, type CacheOptions, type NamespacedCache } from "./client.js";

export {
  type RateLimitResult,
  type SlidingWindowLimiter,
  type SlidingWindowLimiterConfig,
} from "./rate-limiter.js";

export { readRedisUrl } from "./env.js";
