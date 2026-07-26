/**
 * Worker test for M0-BE-02: migration 0001 (users, sessions, entitlements).
 *
 * Same conventions as `migrate.test.ts`: every test applies the *real*
 * `migrations/` directory into a throwaway schema (dropped in `after()`), so
 * the suite never touches the dev database and is safely rerunnable.
 *
 *   pnpm --filter @eutectic/db test
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { Sql } from "postgres";

import { createPool } from "../client.js";
import { requireDatabaseUrl } from "../env.js";
import { runSqlMigrations } from "../migrate.js";
import { MIGRATIONS_DIR } from "../paths.js";

const MIGRATION_ID = "0001_users_sessions_entitlements";
const silent = (): void => {};

let sql: Sql;
const schemasToDrop: string[] = [];

before(() => {
  // Fail with the actionable message rather than a connection timeout.
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
  return `m0be02_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function useScratchSchema(): string {
  const schema = scratchSchema();
  schemasToDrop.push(schema);
  return schema;
}

async function migrate(schema: string): Promise<Awaited<ReturnType<typeof runSqlMigrations>>> {
  return runSqlMigrations({ dir: MIGRATIONS_DIR, schema, log: silent });
}

async function insertUser(schema: string, githubId: number, handle: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO ${sql(schema)}.${sql("users")}
      (github_id, github_login, github_created_at, handle)
    VALUES (${githubId}, ${handle}, now(), ${handle})
    RETURNING id
  `;
  const id = rows[0]?.id;
  assert.ok(id, "insertUser must return an id");
  return id;
}

describe("migration 0001 — users, sessions, entitlements", () => {
  it("applies the real migrations directory, and a second run is a no-op", async () => {
    const schema = useScratchSchema();

    const first = await migrate(schema);
    assert.ok(
      first.applied.includes(MIGRATION_ID),
      `expected ${MIGRATION_ID} among applied migrations: ${first.applied.join(", ")}`,
    );

    const second = await migrate(schema);
    assert.deepEqual([...second.applied], [], "second run applies nothing");
    assert.ok(second.skipped.includes(MIGRATION_ID), "second run recognises 0001 as already applied");
  });

  it("resolves exactly one active entitlement row at now()", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const userId = await insertUser(schema, 1, "octocat");

    // Expired: closed a day ago.
    await sql`
      INSERT INTO ${sql(schema)}.${sql("entitlements")}
        (user_id, plan, max_posts_per_day, max_rounds, max_agent_responses,
         guaranteed_pickup, can_unlist, can_request_agent, valid_from, valid_to)
      VALUES
        (${userId}, 'free', 1, 1, 1, false, false, false,
         now() - interval '30 days', now() - interval '1 day')
    `;

    // Active: opened yesterday, still open.
    await sql`
      INSERT INTO ${sql(schema)}.${sql("entitlements")}
        (user_id, plan, max_posts_per_day, max_rounds, max_agent_responses,
         guaranteed_pickup, can_unlist, can_request_agent, valid_from, valid_to)
      VALUES
        (${userId}, 'premium', 10, 5, 5, true, true, true,
         now() - interval '1 day', NULL)
    `;

    const active = await sql<{ plan: string }[]>`
      SELECT plan
      FROM ${sql(schema)}.${sql("entitlements")}
      WHERE user_id = ${userId}
        AND valid_from <= now()
        AND (valid_to IS NULL OR valid_to > now())
      ORDER BY valid_from DESC
      LIMIT 1
    `;

    assert.equal(active.length, 1, "exactly one active entitlement row");
    assert.equal(active[0]?.plan, "premium", "the open-ended row is the one returned");
  });

  it("rejects a second session with the same token_hash (UNIQUE)", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const userId = await insertUser(schema, 2, "monalisa");

    await sql`
      INSERT INTO ${sql(schema)}.${sql("sessions")} (user_id, token_hash, expires_at)
      VALUES (${userId}, 'same-hash', now() + interval '1 day')
    `;

    await assert.rejects(
      () => sql`
        INSERT INTO ${sql(schema)}.${sql("sessions")} (user_id, token_hash, expires_at)
        VALUES (${userId}, 'same-hash', now() + interval '1 day')
      `,
      /unique/i,
      "a duplicate token_hash must violate the UNIQUE constraint",
    );
  });
});
