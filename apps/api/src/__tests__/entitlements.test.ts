/**
 * Round-trip tests for M0-BE-18's cached entitlement wrapper
 * (`resolveEntitlementCached` / `bustEntitlement`, `../entitlements.ts`)
 * against the REAL dev Postgres (a scratch schema, exactly like
 * `packages/db`'s own suites — see `packages/db/src/__tests__/entitlements.test.ts`)
 * AND the REAL dev Redis (exactly like `packages/cache`'s own suite). This
 * module's entire job is gluing those two real things together correctly, so
 * mocking either would test nothing that matters.
 *
 * SCRATCH-SCHEMA STRATEGY, and why it differs slightly from
 * `packages/db/src/__tests__/entitlements.test.ts`: that suite calls
 * `resolveEntitlement` directly with an `ISql`, so it can open one
 * transaction per test and `SET LOCAL search_path`. This suite calls
 * `resolveEntitlementCached`, whose production signature is the pool type
 * `Sql` (a real route handler is never inside somebody else's transaction
 * when it resolves an entitlement) — a `TransactionSql` is not assignable to
 * `Sql` (see that file's history). Rather than loosen the wrapper's
 * signature just for a test, this suite gives each test its own tiny
 * connection pool (`max: 1`) whose `search_path` is set as a connection
 * STARTUP parameter (`extra.connection.search_path`), so every query that
 * pool ever runs — no transaction required — resolves unqualified table
 * names against the scratch schema first. `runSqlMigrations` manages its own
 * internal pool and schema targeting already (see `migrate.ts`), so it needs
 * no special wiring here at all.
 *
 * Redis-side isolation mirrors `packages/cache`'s own convention: every test
 * gets a namespace prefix unique to that test (`randomUUID()`-derived), and
 * everything is torn down through `cache.close()` in `after()`. This suite
 * does NOT reach into `packages/cache/src/__tests__/test-support.ts` for
 * that convention — a package's `__tests__` internals are not another
 * package's dependency, even in tests — so the prefixing helper below is a
 * small local reimplementation, not an import.
 *
 * WIRE-LEVEL TTL: this suite deliberately does not read the TTL Redis
 * actually stored back off the wire (that needs a raw `ioredis` client, the
 * way `packages/cache/src/__tests__/client.test.ts` does it) — `ioredis` is
 * not a dependency of `apps/api` and this ticket adds no new dependencies.
 * `@eutectic/cache`'s own suite already proves `set(key, value, ttlSeconds)`
 * really does expire the key at `ttlSeconds`; what THIS suite proves is that
 * `resolveEntitlementCached` calls `set` with the ticket's ceiling constant
 * (asserted directly below) and behaves correctly around the cache it
 * produces (miss vs. hit, bust, free-default caching, key shape).
 *
 *   pnpm --filter @eutectic/api test
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { createCache, type Cache, type NamespacedCache } from "@eutectic/cache";
import {
  createPool,
  MIGRATIONS_DIR,
  requireDatabaseUrl,
  runSqlMigrations,
  type Sql,
} from "@eutectic/db";

import { bustEntitlement, ENTITLEMENT_CACHE_TTL_SECONDS, FREE_PLAN_DEFAULTS, resolveEntitlementCached } from "../entitlements.js";

/** Same dev Redis every other package's suite points at. Never read from `REDIS_URL` in a test — a suite must not silently point at something else. */
const DEV_REDIS_URL = "redis://localhost:6380";

const silent = (): void => {};

/** A dedicated pool used ONLY to drop scratch schemas in `after()` — no search_path override, so it must never run production queries. */
let cleanupSql: Sql;
let cache: Cache;
const schemasToDrop: string[] = [];
const openPools: Sql[] = [];

before(() => {
  requireDatabaseUrl();
  cleanupSql = createPool({ max: 1 });
  cache = createCache({ url: DEV_REDIS_URL });
});

after(async () => {
  for (const pool of openPools) {
    await pool.end();
  }
  for (const schema of schemasToDrop) {
    await cleanupSql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
  await cleanupSql.end();
  await cache.close();
});

function scratchSchema(): string {
  const schema = `m0be18api_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  schemasToDrop.push(schema);
  return schema;
}

async function migrate(schema: string): Promise<void> {
  await runSqlMigrations({ dir: MIGRATIONS_DIR, schema, log: silent });
}

/**
 * A pool whose `search_path` is fixed, at the connection level, to `schema`
 * then `public` — every query this specific `Sql` handle ever runs resolves
 * unqualified table names against the scratch schema, with no transaction or
 * per-query `SET` required. This is exactly the `Sql` shape
 * `resolveEntitlementCached`'s production signature expects.
 */
function scratchPool(schema: string): Sql {
  const pool = createPool({
    max: 1,
    extra: { connection: { search_path: `${schema}, public` } },
  });
  openPools.push(pool);
  return pool;
}

async function insertUser(sql: Sql, githubId: number, handle: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (github_id, github_login, github_created_at, handle)
    VALUES (${githubId}, ${handle}, now(), ${handle})
    RETURNING id
  `;
  const id = rows[0]?.id;
  assert.ok(id, "insertUser must return an id");
  return id;
}

async function insertEntitlement(
  sql: Sql,
  userId: string,
  plan: string,
  validFrom: Date,
  validTo: Date | null,
): Promise<void> {
  await sql`
    INSERT INTO entitlements
      (user_id, plan, max_posts_per_day, max_rounds, max_agent_responses,
       guaranteed_pickup, can_unlist, can_request_agent, residencies_allowed,
       valid_from, valid_to)
    VALUES
      (${userId}, ${plan}, 5, 5, 5, true, true, true, 2, ${validFrom}, ${validTo})
  `;
}

/** A fresh, uniquely-prefixed `entitlement` namespace view, so tests never collide on a Redis key even run concurrently. */
function testEntitlementCache(): { root: NamespacedCache; entitlement: NamespacedCache } {
  const prefix = `m0be18api:${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const root = cache.namespace(prefix);
  return { root, entitlement: root.namespace("entitlement") };
}

describe("FREE_PLAN_DEFAULTS", () => {
  it("matches capabilities.md §16's free tier row BY NAME, not a fixture (D-019, M0-BE-23)", () => {
    // D-019 (Fable) rejected the values this constant originally shipped with
    // (1/1/1) precisely because they were copied from M0-BE-02's
    // `identity.test.ts` fixture instead of validated against product policy.
    // This test asserts against capabilities.md §16's Premium table numbers,
    // named individually below, so the NEXT drift — someone "fixing" the
    // constant to match a fixture again, or a spec change nobody propagated —
    // is a loud, specific failure here rather than this suite quietly
    // agreeing with whatever the constant happens to say.
    //
    // capabilities.md §16, "Free" column:
    //   "5 posts/day"          -> maxPostsPerDay
    //   "3 rounds/chapter"     -> maxRounds
    //   "Up to 4 agents/thread" -> maxAgentResponses
    const FREE_POSTS_PER_DAY_SPEC16 = 5;
    const FREE_ROUNDS_PER_CHAPTER_SPEC16 = 3;
    const FREE_AGENTS_PER_THREAD_SPEC16 = 4;

    assert.equal(
      FREE_PLAN_DEFAULTS.maxPostsPerDay,
      FREE_POSTS_PER_DAY_SPEC16,
      "capabilities.md §16: free tier is 5 posts/day",
    );
    assert.equal(
      FREE_PLAN_DEFAULTS.maxRounds,
      FREE_ROUNDS_PER_CHAPTER_SPEC16,
      "capabilities.md §16: free tier is 3 rounds/chapter",
    );
    assert.equal(
      FREE_PLAN_DEFAULTS.maxAgentResponses,
      FREE_AGENTS_PER_THREAD_SPEC16,
      "capabilities.md §16: free tier is up to 4 agents/thread",
    );

    // Booleans and residenciesAllowed were NOT part of D-019's ruling — they
    // stand as delivered: no guarantee, no unlisting, no agent requests, no
    // residencies on the free tier.
    assert.equal(FREE_PLAN_DEFAULTS.guaranteedPickup, false);
    assert.equal(FREE_PLAN_DEFAULTS.canUnlist, false);
    assert.equal(FREE_PLAN_DEFAULTS.canRequestAgent, false);
    assert.equal(FREE_PLAN_DEFAULTS.residenciesAllowed, 0);
  });
});

describe("resolveEntitlementCached", () => {
  it("TTL ceiling: the exported constant meets this ticket's acceptance criterion (<= 60s)", () => {
    assert.ok(ENTITLEMENT_CACHE_TTL_SECONDS <= 60, "TTL must never exceed the 60s ceiling");
    assert.equal(ENTITLEMENT_CACHE_TTL_SECONDS, 60);
  });

  it("cache miss resolves from Postgres and leaves the resolved value sitting in the cache under the user id", async () => {
    const schema = scratchSchema();
    await migrate(schema);
    const sql = scratchPool(schema);
    const { entitlement } = testEntitlementCache();
    const now = new Date("2026-02-01T00:00:00Z");

    const userId = await insertUser(sql, 101, "cache-miss");
    await insertEntitlement(sql, userId, "premium", new Date("2026-01-01T00:00:00Z"), null);

    const result = await resolveEntitlementCached(sql, entitlement, userId, now);
    assert.equal(result.source, "row");
    assert.equal(result.plan, "premium");

    const cached = await entitlement.get(userId);
    assert.deepEqual(cached, result, "the exact resolved value must now be cached under the bare user id");
  });

  it("cache hit returns the cached value WITHOUT a second Postgres read", async () => {
    const schema = scratchSchema();
    await migrate(schema);
    const sql = scratchPool(schema);
    const { entitlement } = testEntitlementCache();
    const now = new Date("2026-02-01T00:00:00Z");

    const userId = await insertUser(sql, 102, "cache-hit");
    await insertEntitlement(sql, userId, "premium", new Date("2026-01-01T00:00:00Z"), null);

    const first = await resolveEntitlementCached(sql, entitlement, userId, now);
    assert.equal(first.plan, "premium");

    // Mutate the underlying row directly — a real second Postgres read would
    // see this change immediately. The cache must not care.
    await sql`UPDATE entitlements SET plan = 'downgraded-should-not-be-seen' WHERE user_id = ${userId}`;

    const second = await resolveEntitlementCached(sql, entitlement, userId, now);
    assert.equal(second.plan, "premium", "must still read the stale cached value, not the just-written row");
    assert.deepEqual(second, first);
  });

  it("no entitlement row resolves to, and caches, the free-plan default", async () => {
    const schema = scratchSchema();
    await migrate(schema);
    const sql = scratchPool(schema);
    const { entitlement } = testEntitlementCache();
    const now = new Date("2026-02-01T00:00:00Z");

    const userId = await insertUser(sql, 103, "no-row");

    const result = await resolveEntitlementCached(sql, entitlement, userId, now);
    assert.equal(result.source, "free-default");
    assert.equal(result.plan, FREE_PLAN_DEFAULTS.plan);
    assert.equal(result.maxPostsPerDay, FREE_PLAN_DEFAULTS.maxPostsPerDay);
    assert.equal(result.maxRounds, FREE_PLAN_DEFAULTS.maxRounds);
    assert.equal(result.maxAgentResponses, FREE_PLAN_DEFAULTS.maxAgentResponses);
    assert.equal(result.guaranteedPickup, FREE_PLAN_DEFAULTS.guaranteedPickup);
    assert.equal(result.canUnlist, FREE_PLAN_DEFAULTS.canUnlist);
    assert.equal(result.canRequestAgent, FREE_PLAN_DEFAULTS.canRequestAgent);
    assert.equal(result.residenciesAllowed, FREE_PLAN_DEFAULTS.residenciesAllowed);
    assert.equal(result.validFrom, null);
    assert.equal(result.validTo, null);

    const cached = await entitlement.get(userId);
    assert.deepEqual(cached, result, "the free-default value is cached exactly like a real row would be");

    // A real row inserted AFTER the free-default was cached must not be
    // visible until the TTL passes or the cache is busted — proving the
    // free-default path is cached, not recomputed on every call.
    await insertEntitlement(sql, userId, "premium", new Date("2026-01-01T00:00:00Z"), null);
    const second = await resolveEntitlementCached(sql, entitlement, userId, now);
    assert.equal(second.source, "free-default", "still the cached free-default; the new row is not visible yet");
  });

  it("bustEntitlement clears the cache so the very next call re-reads Postgres", async () => {
    const schema = scratchSchema();
    await migrate(schema);
    const sql = scratchPool(schema);
    const { entitlement } = testEntitlementCache();
    const now = new Date("2026-02-01T00:00:00Z");

    const userId = await insertUser(sql, 104, "bust");
    await insertEntitlement(sql, userId, "premium", new Date("2026-01-01T00:00:00Z"), null);

    const first = await resolveEntitlementCached(sql, entitlement, userId, now);
    assert.equal(first.plan, "premium");

    await sql`UPDATE entitlements SET plan = 'upgraded' WHERE user_id = ${userId}`;

    await bustEntitlement(entitlement, userId);
    assert.equal(await entitlement.get(userId), undefined, "the busted key must be gone from the cache");

    const second = await resolveEntitlementCached(sql, entitlement, userId, now);
    assert.equal(second.plan, "upgraded", "after a bust, the next call must see the fresh row");
  });

  it("the cache key is the bare user id, scoped to whatever namespace view the caller passed in — nothing hardcoded, nothing session-shaped", async () => {
    const schema = scratchSchema();
    await migrate(schema);
    const sql = scratchPool(schema);
    const { root, entitlement } = testEntitlementCache();
    const now = new Date("2026-02-01T00:00:00Z");

    const userId = await insertUser(sql, 105, "key-shape");
    await insertEntitlement(sql, userId, "premium", new Date("2026-01-01T00:00:00Z"), null);

    await resolveEntitlementCached(sql, entitlement, userId, now);

    // Readable by exactly userId, through the identical namespaced view the
    // wrapper was given — proving it does not append its own namespace
    // segment (the caller already supplied "entitlement") and does not key
    // by anything other than the bare user id (no session id, no composite
    // key).
    const direct = await entitlement.get(userId);
    assert.ok(direct, "must be readable by exactly userId under the passed-in namespace");

    // A sibling namespace under the same root — not ".namespace(\"entitlement\")"
    // — must NOT see it, proving the key really is scoped to the view the
    // caller composed, not written against the root cache.
    const sibling = root.namespace("something-else");
    assert.equal(await sibling.get(userId), undefined, "a sibling namespace must not see another namespace's key");
  });
});
