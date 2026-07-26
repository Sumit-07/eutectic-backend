/**
 * THE ACCEPTANCE: "Redis is CACHE ONLY (D-001): every helper is
 * loss-tolerant — a Redis outage degrades to Postgres reads, never to an
 * error; test proves fallback."
 *
 * Every cache created here points at `UNREACHABLE_REDIS_URL`
 * (`localhost:6399`) — a port nothing listens on — NEVER at the shared dev
 * container. Stopping `eutectic-redis` to simulate an outage would break
 * every other suite (and every other engineer's session) sharing it; a
 * closed port is a faithful enough stand-in for "Redis is down" for every
 * helper here, none of which distinguish connection-refused from any other
 * unreachable state.
 *
 * Every assertion below is the same shape: call the helper, assert it
 * resolves (never rejects) with the documented "nothing happened" value.
 * `assert.doesNotReject` makes that structure explicit rather than relying
 * on an uncaught rejection failing the test some other way.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createCache, type Cache } from "../client.js";
import { UNREACHABLE_REDIS_URL } from "./test-support.js";

let cache: Cache;

before(() => {
  // Deliberately NOT `requireDevRedis()` — this suite never touches the dev
  // instance, so it must not depend on it being up either.
  cache = createCache({ url: UNREACHABLE_REDIS_URL, connectTimeoutMs: 100, commandTimeoutMs: 100 });
});

after(async () => {
  await cache.close();
});

describe("loss-tolerance — reads miss, never throw", () => {
  it("get() resolves to undefined", async () => {
    const ns = cache.namespace("loss-tolerance");
    await assert.doesNotReject(async () => {
      const value = await ns.get("anything");
      assert.equal(value, undefined);
    });
  });
});

describe("loss-tolerance — writes degrade, never throw", () => {
  it("set() resolves to false", async () => {
    const ns = cache.namespace("loss-tolerance");
    await assert.doesNotReject(async () => {
      const stored = await ns.set("anything", { some: "value" }, 30);
      assert.equal(stored, false);
    });
  });

  it("del() resolves to false", async () => {
    const ns = cache.namespace("loss-tolerance");
    await assert.doesNotReject(async () => {
      const deleted = await ns.del("anything");
      assert.equal(deleted, false);
    });
  });

  it("incr() resolves to undefined — never fabricates a count", async () => {
    const ns = cache.namespace("loss-tolerance");
    await assert.doesNotReject(async () => {
      const value = await ns.incr("anything", 30);
      assert.equal(value, undefined);
    });
  });
});

describe("loss-tolerance — ping() degrades, never throws", () => {
  it("resolves false against an unreachable Redis", async () => {
    await assert.doesNotReject(async () => {
      assert.equal(await cache.ping(), false);
    });
  });
});

describe("loss-tolerance — the rate limiter FAILS OPEN", () => {
  it("check() allows the request and reports no real count", async () => {
    const ns = cache.namespace("loss-tolerance");
    const limiter = ns.limiter("outage", { limit: 1, windowSeconds: 60 });
    await assert.doesNotReject(async () => {
      const first = await limiter.check("subject", new Date());
      assert.equal(first.allowed, true);
      assert.equal(first.remaining, undefined, "no real count exists without Redis");
      assert.equal(first.retryAfterSeconds, 0);

      // A second call for the SAME subject, still allowed — fail-open means
      // "stop limiting," not "limit once from memory."
      const second = await limiter.check("subject", new Date());
      assert.equal(second.allowed, true);
    });
  });
});

describe("loss-tolerance — degrading is bounded, not a hang", () => {
  it("every helper resolves within a small multiple of the configured command timeout", async () => {
    const ns = cache.namespace("loss-tolerance");
    const startedAt = Date.now();
    await ns.get("bounded");
    const elapsedMs = Date.now() - startedAt;
    assert.ok(
      elapsedMs < 2000,
      `a 100ms command timeout should never let a single call take ${elapsedMs}ms`,
    );
  });

  it("close() never hangs waiting on a connection that will never arrive", async () => {
    const shortLived = createCache({
      url: UNREACHABLE_REDIS_URL,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
    });
    // Issue a command first so it lands (and is abandoned) in ioredis's
    // internal offline queue before close() runs — the exact condition that
    // used to make `close()` hang forever (see client.ts's `close()` doc
    // comment).
    await shortLived.get("prime-the-offline-queue");

    const startedAt = Date.now();
    await shortLived.close();
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 2000, `close() should never hang, took ${elapsedMs}ms`);
  });
});
