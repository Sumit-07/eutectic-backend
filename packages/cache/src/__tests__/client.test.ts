/**
 * Round-trip tests for `createCache(...)`'s typed surface, against the REAL
 * dev Redis (see test-support.ts). Covers the acceptance criteria that need
 * an actual Redis to mean anything: TTL-bucketed `incr`, namespace prefixing,
 * and the codec treating a corrupt value as a miss.
 *
 * Loss-tolerance (every helper degrading instead of throwing) is its own
 * suite — `loss-tolerance.test.ts` — because it needs a Redis that is
 * actually unreachable, which this suite deliberately is not.
 *
 *   pnpm --filter @eutectic/cache test
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createCache, type Cache } from "../client.js";
import {
  assertDefined,
  cleanupTestKeys,
  rawDevRedisClient,
  requireDevRedis,
  uniqueTestPrefix,
} from "./test-support.js";

let cache: Cache;
const prefix = uniqueTestPrefix();

before(async () => {
  await requireDevRedis();
  cache = createCache({ url: "redis://localhost:6380" });
});

after(async () => {
  await cleanupTestKeys(prefix);
  await cache.close();
});

describe("createCache — get/set/del", () => {
  it("round-trips a JSON value", async () => {
    const ns = cache.namespace(prefix);
    const stored = await ns.set("widget", { a: 1, b: [true, "x"] }, 30);
    assert.equal(stored, true);

    const got = await ns.get<{ a: number; b: unknown[] }>("widget");
    assertDefined(got, "expected the value just stored");
    assert.deepEqual(got, { a: 1, b: [true, "x"] });
  });

  it("misses on a key that was never set", async () => {
    const ns = cache.namespace(prefix);
    assert.equal(await ns.get("never-set"), undefined);
  });

  it("del reports true for an existing key, false for a missing one", async () => {
    const ns = cache.namespace(prefix);
    await ns.set("to-delete", "value", 30);
    assert.equal(await ns.del("to-delete"), true);
    assert.equal(await ns.get("to-delete"), undefined, "gone after del");
    assert.equal(await ns.del("to-delete"), false, "already gone — nothing to delete");
  });

  it("a value another writer left in a shape this codec cannot parse is a miss, not a throw", async () => {
    const ns = cache.namespace(prefix);
    const raw = rawDevRedisClient();
    try {
      // Bypass the codec entirely: write a raw string that is not valid JSON,
      // exactly like a `redis-cli SET` from outside this package would.
      await raw.set(`${prefix}:corrupt`, "{not valid json");
      const got = await ns.get("corrupt");
      assert.equal(got, undefined, "corrupt data is treated exactly like an absent key");
    } finally {
      await raw.quit().catch(() => raw.disconnect());
    }
  });

  it("respects the TTL: the key is gone from Redis once it expires", async () => {
    const ns = cache.namespace(prefix);
    await ns.set("short-lived", "value", 1);
    const raw = rawDevRedisClient();
    try {
      const ttl = await raw.ttl(`${prefix}:short-lived`);
      assert.ok(ttl > 0 && ttl <= 1, `expected a positive TTL <= 1s, got ${ttl}`);
    } finally {
      await raw.quit().catch(() => raw.disconnect());
    }
  });
});

describe("createCache — namespace composition", () => {
  it("prefixes compose with ':' and do not collide with a sibling namespace", async () => {
    const a = cache.namespace(prefix).namespace("alpha");
    const b = cache.namespace(prefix).namespace("beta");

    await a.set("k", "from-alpha", 30);
    await b.set("k", "from-beta", 30);

    assert.equal(await a.get("k"), "from-alpha");
    assert.equal(await b.get("k"), "from-beta");
  });

  it("actually writes under the composed key on the wire", async () => {
    const ns = cache.namespace(prefix).namespace("entitlement");
    await ns.set("user-1", { plan: "free" }, 30);

    const raw = rawDevRedisClient();
    try {
      const value = await raw.get(`${prefix}:entitlement:user-1`);
      assert.equal(value, JSON.stringify({ plan: "free" }));
    } finally {
      await raw.quit().catch(() => raw.disconnect());
    }
  });
});

describe("createCache — incr (atomic counter with a TTL bucket)", () => {
  it("starts at 1 and increments from there", async () => {
    const ns = cache.namespace(prefix);
    assert.equal(await ns.incr("hits", 30), 1);
    assert.equal(await ns.incr("hits", 30), 2);
    assert.equal(await ns.incr("hits", 30), 3);
  });

  it("sets a TTL only on the creating call, and later calls do not reset it", async () => {
    const ns = cache.namespace(prefix);
    const raw = rawDevRedisClient();
    try {
      assert.equal(await ns.incr("bucket", 100), 1);
      const ttlAfterCreate = await raw.ttl(`${prefix}:bucket`);
      assert.ok(ttlAfterCreate > 90, `expected the fresh TTL close to 100s, got ${ttlAfterCreate}`);

      // A key with a much shorter TTL passed on a later call must NOT
      // overwrite the original expiry — only the creating call sets it.
      assert.equal(await ns.incr("bucket", 1), 2);
      const ttlAfterSecondCall = await raw.ttl(`${prefix}:bucket`);
      assert.ok(
        ttlAfterSecondCall > 90,
        `a later incr must not reset the TTL bucket, got ${ttlAfterSecondCall}`,
      );
    } finally {
      await raw.quit().catch(() => raw.disconnect());
    }
  });

  it("20 concurrent increments on a fresh key land on exactly 1..20 with no duplicates", async () => {
    const ns = cache.namespace(prefix);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => ns.incr("concurrent", 30)),
    );
    const sorted = [...results].sort((a, b) => (a ?? 0) - (b ?? 0));
    assert.deepEqual(sorted, Array.from({ length: 20 }, (_, i) => i + 1));
  });
});
