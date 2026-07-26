/**
 * `/healthz` and `/readyz` (M0-BE-20, system-design §13). See `../health.ts`
 * for the response shape and the semantics this file asserts:
 *
 *   - `/healthz` is always 200 while the process serves.
 *   - `/readyz` is 200 "ready" when both dependencies (or neither — see the
 *     "no handle injected" cases) are healthy.
 *   - `/readyz` is 200 "degraded" — NEVER a failure — when only Redis is
 *     down (D-001: cache loss is not an outage).
 *   - `/readyz` is 503 "down" when Postgres is down, regardless of Redis.
 *   - Neither endpoint negotiates `Accept`: no `Accept` header is sent below,
 *     on purpose, matching the liveness/readiness probe use case.
 *
 *   pnpm --filter @eutectic/api test
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createCache, type Cache } from "@eutectic/cache";
import { createPool, requireDatabaseUrl, type Sql } from "@eutectic/db";

import { buildApp } from "../app.js";

/** A port nothing listens on — the same convention `packages/cache`'s loss-tolerance suite uses. Never the shared dev container's port (6380). */
const UNREACHABLE_REDIS_URL = "redis://localhost:6399";

let liveDb: Sql;
let liveCache: Cache;
let deadDb: Sql;
let deadCache: Cache;

before(async () => {
  const url = requireDatabaseUrl();
  liveDb = createPool({ url, max: 2 });
  liveCache = createCache();

  // A pool whose connection is ALREADY ended rejects on the very next query,
  // fast and deterministically — a faithful, fast stand-in for "Postgres is
  // down" with no slow connect-timeout to wait out.
  deadDb = createPool({ url, max: 1 });
  await deadDb.end();

  deadCache = createCache({ url: UNREACHABLE_REDIS_URL, connectTimeoutMs: 100, commandTimeoutMs: 100 });
});

after(async () => {
  await liveDb.end();
  await liveCache.close();
  await deadCache.close();
});

describe("/healthz", () => {
  it("is always 200, with no dependencies injected", async () => {
    const app = buildApp({ logger: false });
    const response = await app.inject({ method: "GET", url: "/healthz" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.payload), { status: "ok" });
  });

  it("does not negotiate Accept", async () => {
    const app = buildApp({ logger: false });
    // No Accept header at all — a plain liveness probe.
    const response = await app.inject({ method: "GET", url: "/healthz" });
    assert.equal(response.statusCode, 200);
  });
});

describe("/readyz — happy path", () => {
  it("is 200 ready when both dependencies answer", async () => {
    const app = buildApp({ logger: false, health: { db: liveDb, cache: liveCache } });
    const response = await app.inject({ method: "GET", url: "/readyz" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.payload), {
      status: "ready",
      checks: { postgres: "ok", redis: "ok" },
    });
  });
});

describe("/readyz — Redis degrades, never fails readiness (D-001)", () => {
  it("is 200 degraded when Redis is unreachable and Postgres is fine", async () => {
    const app = buildApp({ logger: false, health: { db: liveDb, cache: deadCache } });
    const response = await app.inject({ method: "GET", url: "/readyz" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.payload), {
      status: "degraded",
      checks: { postgres: "ok", redis: "down" },
    });
  });
});

describe("/readyz — Postgres failure is a hard down", () => {
  it("is 503 down when Postgres is unreachable, regardless of Redis", async () => {
    const app = buildApp({ logger: false, health: { db: deadDb, cache: liveCache } });
    const response = await app.inject({ method: "GET", url: "/readyz" });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(JSON.parse(response.payload), {
      status: "down",
      checks: { postgres: "down", redis: "ok" },
    });
  });

  it("is still 503 down when Redis is ALSO unreachable", async () => {
    const app = buildApp({ logger: false, health: { db: deadDb, cache: deadCache } });
    const response = await app.inject({ method: "GET", url: "/readyz" });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(JSON.parse(response.payload), {
      status: "down",
      checks: { postgres: "down", redis: "down" },
    });
  });
});

describe("/readyz — no handle injected (see health.ts's judgment call)", () => {
  it("reports both checks skipped and stays ready", async () => {
    const app = buildApp({ logger: false });
    const response = await app.inject({ method: "GET", url: "/readyz" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.payload), {
      status: "ready",
      checks: { postgres: "skipped", redis: "skipped" },
    });
  });
});
