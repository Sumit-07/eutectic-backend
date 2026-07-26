/**
 * Shared test infrastructure for `@eutectic/cache`'s suite.
 *
 * Every test in this package (except the loss-tolerance suite, which points
 * deliberately at a closed port) runs against the REAL dev Redis container
 * (`eutectic-redis`, host port 6380) rather than a mock — the whole point of
 * this package is what happens against an actual Redis connection (offline
 * queue behaviour, EVAL atomicity, TTL semantics), which a mock cannot stand
 * in for.
 *
 * Because the instance is SHARED (other packages, a developer's own
 * `redis-cli` session, another suite run concurrently), this file enforces
 * two rules everywhere it is used:
 *
 *   1. every test key lives under a prefix unique to that `before()` run
 *      (`randomUUID()`-derived), so two suites — or two runs of this suite —
 *      can never collide even if they overlap in time;
 *   2. teardown deletes ONLY keys matching that prefix (`SCAN` + `DEL`,
 *      never `FLUSHDB`/`FLUSHALL`), so this suite can never destroy another
 *      package's or another developer's data on the same instance.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// Direct ioredis use, not `createCache(...)`: this file exists to verify AND
// clean up what the package under test did, from outside it — exactly the
// role `packages/db`'s test suites give a raw `postgres` client alongside
// `@eutectic/db`'s own API.
import { Redis } from "ioredis";

/** The dev Redis this whole suite (other than loss-tolerance) targets. Never read from `REDIS_URL` — a test suite must not silently point at something else. */
export const DEV_REDIS_URL = "redis://localhost:6380";

/** A port nothing is listening on, for the loss-tolerance suite. Must never be the shared dev instance's port. */
export const UNREACHABLE_REDIS_URL = "redis://localhost:6399";

/**
 * Confirm the dev Redis is actually reachable before any test tries to use
 * it, and fail with an instruction rather than a generic connection-timeout
 * stack trace if it is not.
 */
export async function requireDevRedis(): Promise<void> {
  const probe = new Redis(DEV_REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 1000,
    retryStrategy: () => null,
  });
  probe.on("error", () => {});
  try {
    await probe.connect();
    await probe.ping();
  } catch (error) {
    throw new Error(
      `@eutectic/cache's tests need the dev Redis container reachable at ${DEV_REDIS_URL}. ` +
        `It is not responding. Start it with: docker compose up -d eutectic-redis ` +
        `(see docker-compose.yml — image redis:7-alpine, host port 6380). ` +
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    probe.disconnect();
  }
}

/** A prefix unique to one test run, e.g. `m0be19:3f9c2a1b4e7d:`. */
export function uniqueTestPrefix(): string {
  return `m0be19:${randomUUID().replace(/-/g, "").slice(0, 16)}:`;
}

/**
 * Delete every key under `prefix` (and only those keys) from the dev Redis.
 * Uses `SCAN` (cursor-based, non-blocking) rather than `KEYS` — irrelevant at
 * this data volume, but `KEYS` on a shared instance is exactly the kind of
 * habit this package should not model for its own tests.
 */
export async function cleanupTestKeys(prefix: string): Promise<void> {
  const redis = new Redis(DEV_REDIS_URL);
  redis.on("error", () => {});
  try {
    let cursor = "0";
    const found: string[] = [];
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", `${prefix}*`, "COUNT", "200");
      cursor = next;
      found.push(...keys);
    } while (cursor !== "0");

    if (found.length > 0) {
      await redis.del(...found);
    }
  } finally {
    await redis.quit().catch(() => redis.disconnect());
  }
}

/** Raw access to the dev Redis, for assertions the package's own typed surface deliberately does not expose (e.g. reading a key's TTL). */
export function rawDevRedisClient(): Redis {
  const redis = new Redis(DEV_REDIS_URL);
  redis.on("error", () => {});
  return redis;
}

/** Convenience assertion mirroring the house style in `packages/events`' suite. */
export function assertDefined<T>(value: T | undefined, message: string): asserts value is T {
  assert.notEqual(value, undefined, message);
}
