/**
 * Worker test for P-09's `findAdminUser` (D-029, D-040, DIRECTIVE §5).
 *
 * Real migrations into a throwaway schema, same as the rest of this package.
 * The query is unqualified (it is production code, with no scratch-schema
 * concept), so the schema is pinned as a connection startup parameter.
 *
 * The behaviour worth a test here is not "SELECT returns a row". It is the
 * three decisions the module doc argues for and could silently lose:
 *   - a TOMBSTONED user is RETURNED, not hidden — moderation attaches to
 *     accounts that no longer post;
 *   - `tier_would_be` is NULL in the schema and required on the wire, and the
 *     fallback is the user's actual tier, never 0;
 *   - `github_id` is a bigint the driver hands back as a STRING, and the
 *     contract wants an integer.
 *
 *   pnpm --filter @eutectic/db test
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { Sql } from "postgres";

import { findAdminUser } from "../admin-users.js";
import { createPool } from "../client.js";
import { requireDatabaseUrl } from "../env.js";
import { runSqlMigrations } from "../migrate.js";
import { MIGRATIONS_DIR } from "../paths.js";

const silent = (): void => {};

let cleanupSql: Sql;
let sql: Sql;
let schema: string;

before(async () => {
  requireDatabaseUrl();
  cleanupSql = createPool({ max: 1 });
  schema = `p09users_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await runSqlMigrations({ dir: MIGRATIONS_DIR, schema, log: silent });
  sql = createPool({
    max: 2,
    extra: { connection: { search_path: `${schema}, public` } },
  });
});

after(async () => {
  await sql.end();
  await cleanupSql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await cleanupSql.end();
});

interface UserFixture {
  handle: string;
  githubId: number | string;
  githubLogin?: string;
  githubCreatedAt?: Date;
  githubPublicRepos?: number;
  tier?: number;
  tierWouldBe?: number | null;
  deletedAt?: Date | null;
  showGithubLogin?: boolean;
}

async function insertUser(fixture: UserFixture): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (
      github_id, github_login, github_created_at, github_public_repos,
      handle, tier, tier_would_be, deleted_at, show_github_login
    )
    VALUES (
      ${fixture.githubId},
      ${fixture.githubLogin ?? fixture.handle},
      ${fixture.githubCreatedAt ?? new Date("2019-05-06T00:00:00.000Z")},
      ${fixture.githubPublicRepos ?? 12},
      ${fixture.handle},
      ${fixture.tier ?? 1},
      ${fixture.tierWouldBe ?? null},
      ${fixture.deletedAt ?? null},
      ${fixture.showGithubLogin ?? false}
    )
    RETURNING id
  `;
  const id = rows[0]?.id;
  assert.ok(id, "insertUser must return an id");
  return id;
}

describe("findAdminUser", () => {
  it("returns the full admin projection for a live user", async () => {
    const id = await insertUser({
      handle: "ada",
      githubId: 606001,
      githubLogin: "ada-lovelace",
      githubCreatedAt: new Date("2018-02-03T04:05:06.000Z"),
      githubPublicRepos: 41,
      tier: 2,
      tierWouldBe: 3,
      showGithubLogin: true,
    });

    const row = await findAdminUser(sql, id);
    assert.ok(row);
    assert.equal(row.id, id);
    assert.equal(row.handle, "ada");
    assert.equal(row.tier, 2);
    assert.equal(row.deletedAt, null);
    assert.equal(row.githubLogin, "ada-lovelace");
    assert.equal(row.githubId, 606001);
    assert.equal(row.githubCreatedAt.toISOString(), "2018-02-03T04:05:06.000Z");
    assert.equal(row.githubPublicRepos, 41);
    assert.equal(row.tierWouldBe, 3);
    assert.equal(row.showGithubLogin, true);
    assert.ok(row.createdAt instanceof Date, "createdAt is the PLATFORM join date");
  });

  it("RETURNS a tombstoned user rather than hiding it", async () => {
    // The invariant D-040 states outright: "admins see the record". A
    // `WHERE deleted_at IS NULL` here would 404 every moderation lookup for
    // exactly the accounts most likely to need one.
    const deletedAt = new Date("2026-06-01T12:00:00.000Z");
    const id = await insertUser({ handle: "gone", githubId: 606002, deletedAt });

    const row = await findAdminUser(sql, id);
    assert.ok(row, "a tombstoned user must still be found");
    assert.equal(row.deletedAt?.toISOString(), deletedAt.toISOString());
    assert.equal(row.handle, "gone");
  });

  it("returns null only for an id that has never existed", async () => {
    assert.equal(await findAdminUser(sql, randomUUID()), null);
  });

  it("falls tier_would_be back to the actual tier, never to 0", async () => {
    // Every row written before the login path computes the gate opinion has a
    // NULL here (migration 0013: "Null until the first login after P-09").
    // `0` would be an active claim that the gate would demote this account.
    const id = await insertUser({ handle: "ungated", githubId: 606003, tier: 2, tierWouldBe: null });
    const row = await findAdminUser(sql, id);
    assert.equal(row?.tierWouldBe, 2);
  });

  it("prefers a recorded tier_would_be over the actual tier when they differ", async () => {
    const id = await insertUser({ handle: "demoted", githubId: 606004, tier: 1, tierWouldBe: 0 });
    const row = await findAdminUser(sql, id);
    assert.equal(row?.tier, 1);
    assert.equal(row?.tierWouldBe, 0, "a recorded 0 is real and must survive the coalesce");
  });

  it("coerces the bigint account id to a number the contract can carry", async () => {
    const id = await insertUser({ handle: "bignum", githubId: "9007199254740991" });
    const row = await findAdminUser(sql, id);
    assert.equal(typeof row?.githubId, "number");
    assert.equal(row?.githubId, 9_007_199_254_740_991);
  });

  it("throws rather than silently rounding an unrepresentable account id", async () => {
    // Loud beats lossy: a value this function cannot represent as the
    // contract's `integer` is a value it must not guess at.
    const id = await insertUser({ handle: "toobig", githubId: "9007199254740993" });
    await assert.rejects(() => findAdminUser(sql, id), TypeError);
  });
});
