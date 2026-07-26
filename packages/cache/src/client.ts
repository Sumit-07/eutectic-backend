/**
 * @eutectic/cache's client lifecycle and typed cache surface.
 *
 * LOSS-TOLERANCE IS THE INVARIANT (D-001, system-design §3, §6's cache-layers
 * table): Redis is cache/counters/rate-limiting only, never the queue and
 * never a second source of truth. Every read helper here returns a MISS —
 * never a thrown error — when Redis is down, unreachable, timed out, or
 * simply holds a value this codec cannot parse. Every write helper is
 * fire-and-degrade: it returns a boolean "was this actually stored" signal
 * and never throws. A caller that ignores the return value gets exactly the
 * behaviour system-design §6 promises: Postgres reads, not an error page.
 *
 * How the ioredis client is configured to make that true rather than
 * aspirational:
 *
 *   - Every command is raced against a client-side timeout (`timeout.ts`,
 *     default 250ms), not ioredis's own `commandTimeout` option. See
 *     `timeout.ts`'s doc comment for why: that option, combined with the
 *     `enableOfflineQueue: false` it all but requires to be useful, fails a
 *     command instantly during the ordinary window between `createCache()`
 *     returning and the lazy connection finishing its handshake — a
 *     perfectly healthy Redis would miss on every cold start. ioredis's
 *     default offline queue is left ON here for exactly that reason; OUR
 *     timeout is what makes a genuinely hung/absent Redis degrade fast.
 *   - `connectTimeout` (default 1000ms) bounds one connection ATTEMPT —
 *     independent of the per-command timeout above, and mostly relevant to
 *     how quickly a single reconnect attempt gives up and lets
 *     `retryStrategy` schedule the next one.
 *   - `retryStrategy` NEVER returns `null` — a real outage must self-heal
 *     when Redis comes back, not require a process restart. Safe to retry
 *     forever specifically because the offline queue plus our own per-command
 *     timeout means no caller is ever blocked on the reconnect loop itself.
 *   - a permanent no-op `'error'` listener — ioredis (like every Node
 *     `EventEmitter`) throws and CRASHES THE PROCESS if an `'error'` event
 *     fires with zero listeners attached. Every connection failure emits one.
 *     Without this listener, "Redis is down" would take the whole process
 *     down with it — the opposite of loss-tolerant.
 *
 * No module-level singleton: `createCache(...)` returns a handle the caller
 * owns and must `close()` on shutdown, exactly like `@eutectic/db`'s
 * `createPool`/`closeDb` pair (`packages/db/src/client.ts`) — a shared hidden
 * client makes tests (and multi-tenant callers) fight over the same
 * connection and its lifecycle.
 */

// Named import, not default: under `module: NodeNext` + `"type": "module"`,
// a bare default import of a CJS package (ioredis ships CJS) binds to Node's
// real ESM/CJS interop value — the WHOLE `module.exports` object — not to the
// `exports.default` property ioredis's compiled output actually sets. The
// named `Redis` export (`export { default as Redis } from "./Redis"` in
// ioredis's own `index.d.ts`) is a real named property and resolves to the
// class itself, both for the type and the constructor value used below.
import { Redis, type RedisOptions } from "ioredis";

import { decode, encode } from "./codec.js";
import { readRedisUrl } from "./env.js";
import {
  createSlidingWindowLimiter,
  type SlidingWindowLimiter,
  type SlidingWindowLimiterConfig,
} from "./rate-limiter.js";
import { withCommandTimeout } from "./timeout.js";

export interface CacheOptions {
  /** Connection string. Defaults to `REDIS_URL`, then the dev default (see env.ts). */
  url?: string;
  /** Milliseconds ioredis waits for ONE connection attempt before giving up on it. Default 1000. */
  connectTimeoutMs?: number;
  /** Milliseconds any single command may take before this package treats it as failed (`timeout.ts`). Default 250. */
  commandTimeoutMs?: number;
}

/**
 * The operations available on any view of the cache — the root handle AND
 * every `.namespace(...)` view of it. Deliberately excludes `close()`: only
 * whoever called `createCache(...)` owns the connection's lifecycle (see
 * {@link Cache}).
 */
export interface NamespacedCache {
  /**
   * `undefined` on a true miss, on a Redis outage/timeout, AND on a value
   * this codec cannot parse — all three are "there is no usable cached value
   * here," never a thrown error.
   */
  get<T>(key: string): Promise<T | undefined>;
  /**
   * @returns `true` if the value is now in Redis, `false` if it is not
   *          (Redis unreachable, timed out, or the value could not be
   *          encoded as JSON) — never throws.
   */
  set<T>(key: string, value: T, ttlSeconds: number): Promise<boolean>;
  /** @returns `true` if a key was deleted, `false` otherwise (including "Redis is down") — never throws. */
  del(key: string): Promise<boolean>;
  /**
   * Atomic increment with a TTL bucket: the FIRST call that creates the
   * counter sets its expiry; every call after that only increments. See the
   * atomicity argument in client.ts's `incr` implementation.
   *
   * @returns the counter's new value, or `undefined` if Redis is unreachable
   *          — never throws, and never fabricates a count.
   */
  incr(key: string, ttlSeconds: number): Promise<number | undefined>;
  /** A sliding-window limiter scoped under this namespace (see rate-limiter.ts). FAILS OPEN on a Redis outage. */
  limiter(name: string, config: SlidingWindowLimiterConfig): SlidingWindowLimiter;
  /** A further-nested view, e.g. `cache.namespace('entitlement')` for BE-18. Composable: prefixes join with `:`. */
  namespace(prefix: string): NamespacedCache;
}

/** The root handle. Adds the one thing a namespaced view must not have: connection ownership. */
export interface Cache extends NamespacedCache {
  /**
   * Liveness probe (M0-BE-20, `/readyz` — system-design §13). `true` if Redis
   * answered `PING` within the command timeout, `false` on any outage, timeout
   * or unexpected reply — same loss-tolerant contract as every other helper
   * here, never throws. Deliberately a root-handle-only operation, not part of
   * {@link NamespacedCache}: liveness is a property of the connection, not of a
   * namespace, so `cache.namespace(...).ping` does not exist.
   */
  ping(): Promise<boolean>;
  /** Closes the underlying connection. Safe to call once; every helper above degrades to a miss/no-op afterwards, it does not throw. */
  close(): Promise<void>;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 1000;
const DEFAULT_COMMAND_TIMEOUT_MS = 250;

function buildRedisOptions(options: CacheOptions): RedisOptions {
  return {
    connectTimeout: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    // Left at ioredis's default (queue commands issued before the connection
    // is ready, flush them once it is) — see the module doc comment and
    // timeout.ts for why disabling this was tried and reverted.
    // enableOfflineQueue: true,
    // Keep trying forever, capped: a real outage must self-heal when Redis
    // comes back, not require a process restart. Safe because the offline
    // queue plus our own per-command timeout (timeout.ts) mean no caller is
    // ever blocked on this loop.
    retryStrategy: (times: number): number => Math.min(times * 50, 2000),
  };
}

function view(redis: Redis, prefix: string, commandTimeoutMs: number): NamespacedCache {
  return {
    async get<T>(key: string): Promise<T | undefined> {
      try {
        const raw = await withCommandTimeout(redis.get(`${prefix}${key}`), commandTimeoutMs);
        return decode<T>(raw);
      } catch {
        return undefined;
      }
    },

    async set<T>(key: string, value: T, ttlSeconds: number): Promise<boolean> {
      const encoded = encode(value);
      if (encoded === undefined) return false;
      try {
        const reply = await withCommandTimeout(
          redis.set(`${prefix}${key}`, encoded, "EX", ttlSeconds),
          commandTimeoutMs,
        );
        return reply === "OK";
      } catch {
        return false;
      }
    },

    async del(key: string): Promise<boolean> {
      try {
        const deleted = await withCommandTimeout(redis.del(`${prefix}${key}`), commandTimeoutMs);
        return deleted > 0;
      } catch {
        return false;
      }
    },

    async incr(key: string, ttlSeconds: number): Promise<number | undefined> {
      const fullKey = `${prefix}${key}`;
      try {
        // ATOMICITY ARGUMENT: `INCR` on a Redis key is a single command and
        // Redis is single-threaded — every concurrent `INCR` against the same
        // key is fully serialised, so the sequence of returned values is
        // exactly 1, 2, 3, ... with no two callers ever observing the same
        // post-increment value. That means the caller who observes `1` is,
        // BY CONSTRUCTION, the exact one call that just created the key
        // (every other caller, whenever it runs, sees 2 or higher) — so
        // "set the TTL only on creation" needs no MULTI, no NX-expire race,
        // and no Lua: exactly one caller ever takes the `=== 1` branch below,
        // and it does so having already durably incremented the counter.
        // The only residual risk is that the `EXPIRE` call itself fails
        // after a successful `INCR` (a timeout, a dropped connection) — the
        // counter would then persist without a TTL. Acceptable for a
        // cache-only value: worst case is a stale bucket outliving its
        // window, corrected the next time this key's namespace is written
        // with a fresh TTL, never an overspend or a lost write.
        const value = await withCommandTimeout(redis.incr(fullKey), commandTimeoutMs);
        if (value === 1) {
          await withCommandTimeout(redis.expire(fullKey, ttlSeconds), commandTimeoutMs);
        }
        return value;
      } catch {
        return undefined;
      }
    },

    limiter(name: string, config: SlidingWindowLimiterConfig): SlidingWindowLimiter {
      return createSlidingWindowLimiter(redis, `${prefix}limiter:${name}:`, config, commandTimeoutMs);
    },

    namespace(next: string): NamespacedCache {
      return view(redis, `${prefix}${next}:`, commandTimeoutMs);
    },
  };
}

/**
 * Create a cache handle. The caller owns the returned handle and MUST call
 * `close()` on shutdown — there is no module-level singleton to fall back on
 * (see the module doc comment).
 *
 * Connecting is NOT awaited here: ioredis connects lazily in the background
 * by default, and every helper already tolerates "not connected yet/anymore"
 * as a miss, so there is nothing correctness-relevant gained by blocking
 * `createCache` on a round trip that might never need to succeed.
 */
export function createCache(options: CacheOptions = {}): Cache {
  const redis = new Redis(options.url ?? readRedisUrl(), buildRedisOptions(options));

  // MUST be attached unconditionally and before any command is issued: see
  // the module doc comment on why an unhandled 'error' event is fatal.
  redis.on("error", () => {});

  const base = view(redis, "", options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);

  return {
    ...base,
    async ping(): Promise<boolean> {
      try {
        const reply = await withCommandTimeout(
          redis.ping(),
          options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        );
        return reply === "PONG";
      } catch {
        return false;
      }
    },
    async close(): Promise<void> {
      try {
        // `quit()` sends a command over the wire and asks the server to
        // close cleanly. It is raced against the SAME command timeout every
        // other helper uses rather than awaited bare, because `quit()` can
        // hang indefinitely on its own: ioredis only takes its fast,
        // synchronous disconnect path when `quit` is issued with an EMPTY
        // internal offline queue. If an earlier command was abandoned by
        // OUR timeout while Redis was unreachable (this package detaches
        // its own await on timeout — see timeout.ts — but never tells
        // ioredis to drop the command from its queue), that command is
        // still sitting in the offline queue. `quit()` then queues BEHIND
        // it instead of disconnecting immediately, waiting on a connection
        // that may never arrive. Racing it here guarantees `close()` always
        // returns promptly regardless of what state the connection is in.
        await withCommandTimeout(redis.quit(), options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
      } catch {
        // Timed out, or `quit()` itself rejected outright (no connection to
        // send it over at all) — either way, fall back to tearing the
        // client down locally. `disconnect()` is synchronous, always safe to
        // call regardless of connection state, and unconditionally stops the
        // retry loop, so this branch can never hang.
        redis.disconnect();
      }
    },
  };
}
