/**
 * Worker test for M0-BE-18: `resolveEntitlement` (system-design §5, §6, §11).
 *
 * Same conventions as `identity.test.ts`: applies the *real* `migrations/`
 * directory into a throwaway schema (dropped in `after()`), so this suite
 * never touches the dev database and is safely rerunnable.
 *
 * `resolveEntitlement` queries the unqualified `entitlements` table name (it
 * is a production function, not a test helper — it has no scratch-schema
 * concept). To point it at this suite's scratch schema, every test opens one
 * transaction, sets `search_path` on it, and passes that `TransactionSql`
 * handle to `resolveEntitlement` — proving, incidentally, that the function's
 * `sql` parameter really does accept anything postgres.js can tag a query
 * with, not just the pool.
 *
 *   pnpm --filter @eutectic/db test
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { ISql, Sql } from "postgres";

import { createPool } from "../client.js";
import { resolveEntitlement } from "../entitlements.js";
import { requireDatabaseUrl } from "../env.js";
import { runSqlMigrations } from "../migrate.js";
import { MIGRATIONS_DIR } from "../paths.js";

const silent = (): void => {};

let sql: Sql;
const schemasToDrop: string[] = [];

before(() => {
  requireDatabaseUrl();
  sql = createPool({ max: 4 });
});

after(async () => {
  for (const schema of schemasToDrop) {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
  await sql.end();
});

function scratchSchema(): string {
  return `m0be18_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function useScratchSchema(): string {
  const schema = scratchSchema();
  schemasToDrop.push(schema);
  return schema;
}

async function migrate(schema: string): Promise<void> {
  await runSqlMigrations({ dir: MIGRATIONS_DIR, schema, log: silent });
}

async function insertUser(tx: ISql, githubId: number, handle: string): Promise<string> {
  const rows = await tx<{ id: string }[]>`
    INSERT INTO users (github_id, github_login, github_created_at, handle)
    VALUES (${githubId}, ${handle}, now(), ${handle})
    RETURNING id
  `;
  const id = rows[0]?.id;
  assert.ok(id, "insertUser must return an id");
  return id;
}

interface EntitlementFixture {
  plan: string;
  validFrom: Date;
  validTo: Date | null;
  maxPostsPerDay?: number;
  maxRounds?: number;
  maxAgentResponses?: number;
  guaranteedPickup?: boolean;
  canUnlist?: boolean;
  canRequestAgent?: boolean;
  residenciesAllowed?: number;
}

async function insertEntitlement(tx: ISql, userId: string, fixture: EntitlementFixture): Promise<void> {
  await tx`
    INSERT INTO entitlements
      (user_id, plan, max_posts_per_day, max_rounds, max_agent_responses,
       guaranteed_pickup, can_unlist, can_request_agent, residencies_allowed,
       valid_from, valid_to)
    VALUES
      (${userId}, ${fixture.plan}, ${fixture.maxPostsPerDay ?? 1}, ${fixture.maxRounds ?? 1},
       ${fixture.maxAgentResponses ?? 1}, ${fixture.guaranteedPickup ?? false},
       ${fixture.canUnlist ?? false}, ${fixture.canRequestAgent ?? false},
       ${fixture.residenciesAllowed ?? 0}, ${fixture.validFrom}, ${fixture.validTo})
  `;
}

/**
 * Runs `body` inside one transaction whose `search_path` points at `schema`,
 * so unqualified table names in production code (here, `resolveEntitlement`)
 * resolve against the scratch schema instead of `public`.
 */
async function withScratchSearchPath<T>(schema: string, body: (tx: ISql) => Promise<T>): Promise<T> {
  const result = await sql.begin<T>(async (tx) => {
    await tx.unsafe(`SET LOCAL search_path TO "${schema}", public`);
    return body(tx);
  });
  // `sql.begin`'s return type is `UnwrapPromiseArray<T>` (it also flattens a
  // returned *array* of promises, a shape this helper never produces) — for
  // every non-array `T` this suite uses, that is exactly `T`.
  return result as T;
}

describe("resolveEntitlement", () => {
  it("returns null when the user has no entitlement row at all", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const result = await withScratchSearchPath(schema, async (tx) => {
      const userId = await insertUser(tx, 1, "no-rows");
      return resolveEntitlement(tx, userId, new Date());
    });

    assert.equal(result, null);
  });

  it("resolves the single open-ended row as active", async () => {
    const schema = useScratchSchema();
    await migrate(schema);
    const now = new Date("2026-01-15T00:00:00Z");

    const result = await withScratchSearchPath(schema, async (tx) => {
      const userId = await insertUser(tx, 2, "single-row");
      await insertEntitlement(tx, userId, {
        plan: "premium",
        validFrom: new Date("2026-01-01T00:00:00Z"),
        validTo: null,
      });
      return resolveEntitlement(tx, userId, now);
    });

    assert.ok(result);
    assert.equal(result.plan, "premium");
    assert.equal(result.validTo, null);
  });

  it("excludes a row whose valid_to has passed, and the row is invisible at any later `now`", async () => {
    const schema = useScratchSchema();
    await migrate(schema);
    // Deliberately a date far in this suite's past AND far from the real
    // wall-clock "now" — proving the function reads no clock of its own; if
    // it ever called `Date.now()` internally, this assertion would still
    // pass today but silently rot the day this test file is read again.
    const now = new Date("2020-06-01T00:00:00Z");

    const result = await withScratchSearchPath(schema, async (tx) => {
      const userId = await insertUser(tx, 3, "expired-row");
      await insertEntitlement(tx, userId, {
        plan: "free",
        validFrom: new Date("2019-01-01T00:00:00Z"),
        validTo: new Date("2019-06-01T00:00:00Z"),
      });
      return resolveEntitlement(tx, userId, now);
    });

    assert.equal(result, null, "a closed row must not resolve, even at a `now` in its own era");
  });

  it("newest valid_from wins when two rows are both technically in range", async () => {
    const schema = useScratchSchema();
    await migrate(schema);
    const now = new Date("2026-03-10T00:00:00Z");

    const result = await withScratchSearchPath(schema, async (tx) => {
      const userId = await insertUser(tx, 4, "newest-wins");
      // Older row, open-ended (not explicitly closed — a bad write, but the
      // resolution rule must still prefer the newer one over it).
      await insertEntitlement(tx, userId, {
        plan: "free",
        validFrom: new Date("2026-01-01T00:00:00Z"),
        validTo: null,
      });
      // Newer row, also active at `now`.
      await insertEntitlement(tx, userId, {
        plan: "premium",
        validFrom: new Date("2026-03-01T00:00:00Z"),
        validTo: null,
      });
      return resolveEntitlement(tx, userId, now);
    });

    assert.ok(result);
    assert.equal(result.plan, "premium", "the row with the newer valid_from must win");
  });

  it("valid_from is inclusive: a row becomes active at the exact instant valid_from equals now", async () => {
    const schema = useScratchSchema();
    await migrate(schema);
    const boundary = new Date("2026-05-01T00:00:00.000Z");

    const result = await withScratchSearchPath(schema, async (tx) => {
      const userId = await insertUser(tx, 5, "inclusive-start");
      await insertEntitlement(tx, userId, { plan: "premium", validFrom: boundary, validTo: null });
      return resolveEntitlement(tx, userId, boundary);
    });

    assert.ok(result, "valid_from <= now must include the exact boundary instant");
    assert.equal(result.plan, "premium");
  });

  it("valid_to is exclusive: a row is no longer active at the exact instant valid_to equals now", async () => {
    const schema = useScratchSchema();
    await migrate(schema);
    const boundary = new Date("2026-05-01T00:00:00.000Z");

    const result = await withScratchSearchPath(schema, async (tx) => {
      const userId = await insertUser(tx, 6, "exclusive-end");
      await insertEntitlement(tx, userId, {
        plan: "premium",
        validFrom: new Date("2026-01-01T00:00:00Z"),
        validTo: boundary,
      });
      return resolveEntitlement(tx, userId, boundary);
    });

    assert.equal(result, null, "now < coalesce(valid_to, 'infinity') must exclude the exact boundary instant");
  });

  it("returns the full row shape, not a boolean projection", async () => {
    const schema = useScratchSchema();
    await migrate(schema);
    const now = new Date("2026-02-01T00:00:00Z");

    const result = await withScratchSearchPath(schema, async (tx) => {
      const userId = await insertUser(tx, 7, "full-shape");
      await insertEntitlement(tx, userId, {
        plan: "premium",
        validFrom: new Date("2026-01-01T00:00:00Z"),
        validTo: null,
        maxPostsPerDay: 10,
        maxRounds: 5,
        maxAgentResponses: 4,
        guaranteedPickup: true,
        canUnlist: true,
        canRequestAgent: true,
        residenciesAllowed: 2,
      });
      return resolveEntitlement(tx, userId, now);
    });

    assert.ok(result);
    assert.equal(result.maxPostsPerDay, 10);
    assert.equal(result.maxRounds, 5);
    assert.equal(result.maxAgentResponses, 4);
    assert.equal(result.guaranteedPickup, true);
    assert.equal(result.canUnlist, true);
    assert.equal(result.canRequestAgent, true);
    assert.equal(result.residenciesAllowed, 2);
    assert.ok(result.id);
    assert.ok(result.createdAt instanceof Date);
    assert.ok(result.validFrom instanceof Date);
  });
});
