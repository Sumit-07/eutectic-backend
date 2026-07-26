/**
 * Worker test for M0-BE-03: migration 0002 (agents, agent_affinities,
 * agent_budgets, agent_tokens↯, agent_liveness↯).
 *
 * Same conventions as `identity.test.ts`: every test applies the *real*
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

const MIGRATION_ID = "0002_agents";
const silent = (): void => {};

let sql: Sql;
const schemasToDrop: string[] = [];

before(() => {
  // Fail with the actionable message rather than a connection timeout.
  requireDatabaseUrl();
  // max: 5 so the concurrency test below can genuinely hold five overlapping
  // connections at once, per the acceptance criterion.
  sql = createPool({ max: 5 });
});

after(async () => {
  for (const schema of schemasToDrop) {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
  await sql.end();
});

function scratchSchema(): string {
  return `m0be03_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function useScratchSchema(): string {
  const schema = scratchSchema();
  schemasToDrop.push(schema);
  return schema;
}

async function migrate(schema: string): Promise<Awaited<ReturnType<typeof runSqlMigrations>>> {
  return runSqlMigrations({ dir: MIGRATIONS_DIR, schema, log: silent });
}

interface AgentOverrides {
  slug?: string;
  ink?: string;
}

/** Insert a minimally-valid agent row, returning its id. */
async function insertAgent(schema: string, overrides: AgentOverrides = {}): Promise<string> {
  const slug = overrides.slug ?? `agent-${randomUUID().slice(0, 8)}`;
  const ink = overrides.ink ?? "bricklayer";

  const rows = await sql<{ id: string }[]>`
    INSERT INTO ${sql(schema)}.${sql("agents")}
      (slug, name, class, ink, voice, beat, hobby_horse, persona_ref, base_model)
    VALUES
      (${slug}, 'Test Agent', 'staff', ${ink}, 'plain', 'testing', 'thoroughness',
       'packages/agents/test', 'anthropic:claude')
    RETURNING id
  `;
  const id = rows[0]?.id;
  assert.ok(id, "insertAgent must return an id");
  return id;
}

describe("migration 0002 — agents, agent_affinities, agent_budgets, agent_tokens, agent_liveness", () => {
  it("applies the real migrations directory, and a second run is a no-op", async () => {
    const schema = useScratchSchema();

    const first = await migrate(schema);
    assert.ok(
      first.applied.includes(MIGRATION_ID),
      `expected ${MIGRATION_ID} among applied migrations: ${first.applied.join(", ")}`,
    );

    const second = await migrate(schema);
    assert.deepEqual([...second.applied], [], "second run applies nothing");
    assert.ok(second.skipped.includes(MIGRATION_ID), "second run recognises 0002 as already applied");
  });

  it("allows two budget rows for the same agent on different days, and rejects a duplicate (agent_id, day)", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const agentId = await insertAgent(schema);

    await sql`
      INSERT INTO ${sql(schema)}.${sql("agent_budgets")}
        (agent_id, day, actions_allowed, spend_cents_allowed)
      VALUES
        (${agentId}, '2026-07-25', 10, 500)
    `;
    await sql`
      INSERT INTO ${sql(schema)}.${sql("agent_budgets")}
        (agent_id, day, actions_allowed, spend_cents_allowed)
      VALUES
        (${agentId}, '2026-07-26', 10, 500)
    `;

    const rows = await sql<{ day: string }[]>`
      SELECT day FROM ${sql(schema)}.${sql("agent_budgets")}
      WHERE agent_id = ${agentId}
      ORDER BY day ASC
    `;
    assert.equal(rows.length, 2, "both day rows exist for the same agent");

    await assert.rejects(
      () => sql`
        INSERT INTO ${sql(schema)}.${sql("agent_budgets")}
          (agent_id, day, actions_allowed, spend_cents_allowed)
        VALUES
          (${agentId}, '2026-07-26', 10, 500)
      `,
      /duplicate key|violates.*primary key/i,
      "a duplicate (agent_id, day) must violate the PRIMARY KEY",
    );
  });

  it("reserves the budget atomically: exactly one of 5 concurrent attempts succeeds, and the ceiling is never exceeded", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const agentId = await insertAgent(schema);
    const day = "2026-07-26";

    await sql`
      INSERT INTO ${sql(schema)}.${sql("agent_budgets")}
        (agent_id, day, actions_allowed, spend_cents_allowed)
      VALUES
        (${agentId}, ${day}, 1, 500)
    `;

    // 5 concurrent reserve attempts against a budget with room for exactly 1.
    // postgres.js pools internally; the pool created in before() is max: 5, so
    // firing these together genuinely overlaps across distinct connections
    // rather than serialising through one.
    const attempts = await Promise.all(
      Array.from({ length: 5 }, () =>
        sql<{ agent_id: string }[]>`
          UPDATE ${sql(schema)}.${sql("agent_budgets")}
             SET actions_used = actions_used + 1
           WHERE agent_id = ${agentId}
             AND day = ${day}
             AND actions_used < actions_allowed
           RETURNING agent_id
        `,
      ),
    );

    const succeeded = attempts.filter((rows) => rows.length === 1);
    const failed = attempts.filter((rows) => rows.length === 0);

    assert.equal(succeeded.length, 1, "exactly one of the 5 concurrent attempts returns a row");
    assert.equal(failed.length, 4, "the other 4 attempts return zero rows");

    const final = await sql<{ actions_used: number }[]>`
      SELECT actions_used FROM ${sql(schema)}.${sql("agent_budgets")}
      WHERE agent_id = ${agentId} AND day = ${day}
    `;
    assert.equal(final[0]?.actions_used, 1, "actions_used is exactly 1 — never overspent");
  });

  it("accepts any ink string with no CHECK constraint (D-011: service-layer validation, not a DB enum)", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    // 'bricklayer' is a real token name (frontend-spec §5.2) — this succeeds
    // as expected.
    const knownInk = await insertAgent(schema, { ink: "bricklayer" });
    assert.ok(knownInk);

    // There is deliberately no CHECK/enum on `ink` (D-011): adding a new token
    // name in packages/tokens must never require a migration here. An
    // arbitrary, not-yet-real token name inserts just as freely — validity is
    // the service layer's job, not the database's.
    const arbitraryInk = await insertAgent(schema, { ink: "not-a-real-token-yet" });
    assert.ok(arbitraryInk);
  });
});
