/**
 * Sliding-window limiter tests — the acceptance's "unit tests cover window
 * boundaries" against the REAL dev Redis (the atomicity the Lua script buys
 * is only meaningful against a real server).
 *
 * `now` is always an explicit `Date` passed to `check(...)` (D-014) — every
 * test below drives the window by constructing `Date`s, never by sleeping
 * real time. That is what makes the EXACT boundary (a request aged exactly
 * `windowMs`) reproducible instead of a flaky race against the wall clock.
 *
 *   pnpm --filter @eutectic/cache test
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { createCache, type Cache } from "../client.js";
import { cleanupTestKeys, requireDevRedis, uniqueTestPrefix } from "./test-support.js";

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

/** A fresh, uncollided subject key per test — the shared dev instance rules this out as a source of flakiness. */
function subject(): string {
  return randomUUID();
}

describe("sliding-window limiter — admits up to the limit, then denies", () => {
  it("allows exactly `limit` requests inside one window, then denies the next", async () => {
    const ns = cache.namespace(prefix);
    const limiter = ns.limiter("basic", { limit: 3, windowSeconds: 10 });
    const key = subject();
    const now = new Date("2026-01-01T00:00:00.000Z");

    const first = await limiter.check(key, now);
    assert.equal(first.allowed, true);
    assert.equal(first.remaining, 2);

    const second = await limiter.check(key, now);
    assert.equal(second.allowed, true);
    assert.equal(second.remaining, 1);

    const third = await limiter.check(key, now);
    assert.equal(third.allowed, true);
    assert.equal(third.remaining, 0);

    const fourth = await limiter.check(key, now);
    assert.equal(fourth.allowed, false);
    assert.equal(fourth.remaining, 0);
    assert.equal(fourth.retryAfterSeconds, 10, "nothing has aged out yet — wait the full window");
  });

  it("tracks independent subjects independently", async () => {
    const ns = cache.namespace(prefix);
    const limiter = ns.limiter("independent", { limit: 1, windowSeconds: 10 });
    const now = new Date("2026-01-01T00:00:00.000Z");

    const a = subject();
    const b = subject();

    assert.equal((await limiter.check(a, now)).allowed, true);
    assert.equal((await limiter.check(a, now)).allowed, false, "a's own second request is denied");
    assert.equal((await limiter.check(b, now)).allowed, true, "b is unaffected by a's usage");
  });
});

describe("sliding-window limiter — the boundary is half-open: (now - window, now]", () => {
  it("a request exactly `windowSeconds` old has aged out — refill at the exact edge", async () => {
    const ns = cache.namespace(prefix);
    const limiter = ns.limiter("edge", { limit: 1, windowSeconds: 10 });
    const key = subject();
    const t0 = new Date("2026-01-01T00:00:00.000Z");

    assert.equal((await limiter.check(key, t0)).allowed, true);
    assert.equal((await limiter.check(key, t0)).allowed, false, "still inside the window");

    // Exactly 10s later: the first request's age is precisely `windowSeconds`,
    // which the script's `<=` eviction test treats as aged out (the module
    // doc comment's documented half-open boundary).
    const exactlyAtEdge = new Date(t0.getTime() + 10_000);
    const atEdge = await limiter.check(key, exactlyAtEdge);
    assert.equal(atEdge.allowed, true, "a request aged exactly windowSeconds must be evicted");
    assert.equal(atEdge.remaining, 0);
  });

  it("one millisecond before the edge, the original request still counts", async () => {
    const ns = cache.namespace(prefix);
    const limiter = ns.limiter("just-inside", { limit: 1, windowSeconds: 10 });
    const key = subject();
    const t0 = new Date("2026-01-01T00:00:00.000Z");

    assert.equal((await limiter.check(key, t0)).allowed, true);

    const oneMsBeforeEdge = new Date(t0.getTime() + 10_000 - 1);
    const stillDenied = await limiter.check(key, oneMsBeforeEdge);
    assert.equal(stillDenied.allowed, false, "1ms before the edge, the original request still counts");
    assert.equal(stillDenied.retryAfterSeconds, 1, "rounds the remaining 1ms up to 1s");
  });
});

describe("sliding-window limiter — deny, then allow again once the window rolls", () => {
  it("denies mid-window and transitions back to allow once capacity frees up", async () => {
    const ns = cache.namespace(prefix);
    const limiter = ns.limiter("rolls", { limit: 2, windowSeconds: 10 });
    const key = subject();
    const t0 = new Date("2026-01-01T00:00:00.000Z");

    // Two requests, 4 seconds apart, fill the limit of 2.
    assert.equal((await limiter.check(key, t0)).allowed, true);
    const t1 = new Date(t0.getTime() + 4_000);
    assert.equal((await limiter.check(key, t1)).allowed, true);

    // 1 second later (t0+5s): both are still inside the 10s window — deny.
    const t2 = new Date(t0.getTime() + 5_000);
    const denied = await limiter.check(key, t2);
    assert.equal(denied.allowed, false);
    // The oldest member (t0) ages out at t0+10s, so from t2=t0+5s that is 5s away.
    assert.equal(denied.retryAfterSeconds, 5);

    // At t0+10s+1ms, the FIRST request (at t0) has aged out. The second
    // request (t1 = t0+4s) has not (it ages out at t1+10s = t0+14s). One
    // slot should have freed up.
    const t3 = new Date(t0.getTime() + 10_000 + 1);
    const refilled = await limiter.check(key, t3);
    assert.equal(refilled.allowed, true, "the oldest request aged out, freeing exactly one slot");
    assert.equal(refilled.remaining, 0, "the slot just freed was immediately consumed by this request");

    // Immediately after, the window is full again (t1's and t3's requests).
    const t4 = new Date(t0.getTime() + 10_000 + 2);
    const deniedAgain = await limiter.check(key, t4);
    assert.equal(deniedAgain.allowed, false);
  });
});

describe("sliding-window limiter — same-millisecond requests never collide", () => {
  it("two checks at the identical instant both count toward the limit", async () => {
    const ns = cache.namespace(prefix);
    const limiter = ns.limiter("same-instant", { limit: 2, windowSeconds: 10 });
    const key = subject();
    const now = new Date("2026-01-01T00:00:00.000Z");

    const [a, b] = await Promise.all([limiter.check(key, now), limiter.check(key, now)]);
    const allowedCount = [a, b].filter((r) => r.allowed).length;
    assert.equal(allowedCount, 2, "both requests at the same instant must be admitted and counted");

    const third = await limiter.check(key, now);
    assert.equal(third.allowed, false, "the limit is 2 — a third at the same instant is denied");
  });
});
