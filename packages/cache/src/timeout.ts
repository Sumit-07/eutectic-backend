/**
 * The client-side command timeout every Redis call in this package races
 * against — "short command timeouts so a hung Redis degrades fast rather
 * than blocking a request" (the ticket's own words for this requirement).
 *
 * This is DELIBERATELY not ioredis's built-in `commandTimeout` option. That
 * option was tried first and rejected: it fires by tearing down the whole
 * socket, and reaching for it also pushes toward `enableOfflineQueue: false`
 * to make "not connected yet" fail fast too — but that combination fails a
 * command the INSTANT it is issued during the ordinary, harmless window
 * between `createCache()` returning and the lazy connection finishing its
 * handshake (a few milliseconds on `redis://localhost:6380`), because a
 * disabled offline queue rejects immediately with "Stream isn't writeable"
 * rather than waiting for the in-flight connect. That would make a
 * perfectly healthy Redis miss on every cold start.
 *
 * The fix kept here: leave ioredis's offline queue ON (its default) so a
 * command issued while still connecting is queued and flushed the moment the
 * connection is ready — the common, harmless case — and put OUR OWN timeout
 * around every command instead. If Redis is actually down, the queued
 * command sits waiting for a connection that will not arrive in time, our
 * timeout fires at `commandTimeoutMs` regardless of what ioredis's internal
 * queue is doing, and the caller gets a miss / not-stored signal exactly as
 * fast either way. The original (queued) command is left to resolve or
 * reject on its own later — harmless, and explicitly swallowed below so it
 * can never surface as an unhandled rejection.
 */

import { setTimeout as delay } from "node:timers/promises";

const TIMED_OUT = Symbol("cache-command-timed-out");

export class CacheCommandTimeoutError extends Error {
  constructor(ms: number) {
    super(`cache command exceeded ${ms}ms`);
    this.name = "CacheCommandTimeoutError";
  }
}

/**
 * Race `promise` against a timer. Resolves/rejects with whichever finishes
 * first; on a timeout, throws {@link CacheCommandTimeoutError} and detaches
 * from `promise` (any later settlement is swallowed, never rethrown, never
 * left as an unhandled rejection).
 */
export async function withCommandTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
    // `node:timers/promises`' `setTimeout` (see rate-limiter.ts / node-builtins.d.ts
    // for why: no global `setTimeout` type exists without `@types/node`,
    // D-010's precedent) resolves after `ms`; wrapping it so the timeout
    // ALWAYS resolves rather than rejects keeps this a plain `Promise.race`
    // with no separate rejection path to also guard against.
    void delay(ms).then(() => resolve(TIMED_OUT));
  });

  const result = await Promise.race([promise, timedOut]);
  if (result === TIMED_OUT) {
    // Never let the original settle unobserved — a rejection with no handler
    // is an unhandled rejection, which is exactly the kind of crash this
    // whole package exists to prevent.
    promise.catch(() => {});
    throw new CacheCommandTimeoutError(ms);
  }
  return result;
}
