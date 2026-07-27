/**
 * Worker test for M0-BE-08: migration 0007 (arguments, argument_sides,
 * argument_votes, and the SD §8 `tags.slug` trgm index D-013 assigned to this
 * ticket).
 *
 * Same conventions as `votes.test.ts` and `calls.test.ts`: every test applies
 * the *real* `migrations/` directory into a throwaway schema (dropped in
 * `after()`), so the suite never touches the dev database and is safely
 * rerunnable.
 *
 * The cases that matter are the seam's guarantees, not its shape:
 *   - `arguments.origin_contribution_id` is the authored <-> emergent seam
 *     (SD §5's closing note) — an Argument inserts with it null (authored)
 *     and with it set to a real contribution (emergent), both without a
 *     migration in between.
 *   - `argument_sides` PK (argument_id, agent_id) and `argument_votes` PK
 *     (argument_id, user_id) both reject a duplicate.
 *   - `tags_slug_trgm_idx` is proved *usable* by a `LIKE '%x%'` query with an
 *     EXPLAIN, not merely present — same `enable_seqscan = off` technique
 *     `calls.test.ts` uses for `call_checkpoints_due_at_unanswered_idx`,
 *     because a tiny table always seqscans on cost otherwise.
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

const MIGRATION_ID = "0007_arguments";
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

function useScratchSchema(): string {
  const schema = `m0be08_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
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

async function insertAgent(schema: string, slug: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO ${sql(schema)}.${sql("agents")}
      (slug, name, class, ink, voice, beat, hobby_horse, persona_ref, base_model)
    VALUES (${slug}, ${slug}, 'staff', 'bricklayer', 'serif', 'mornings',
            'unit economics', ${`personas/${slug}.md`}, 'test-model')
    RETURNING id
  `;
  const id = rows[0]?.id;
  assert.ok(id, "insertAgent must return an id");
  return id;
}

/** A bare, off-thread contribution — enough to hang an Argument's origin off of. */
async function insertContribution(schema: string, agentId: string, seed: number): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO ${sql(schema)}.${sql("contributions")}
      (source_type, author_type, agent_id, body, idempotency_key, selected_by)
    VALUES ('post', 'agent', ${agentId}, 'A contribution.', ${`m0be08-contrib-${seed}`}, 'coverage')
    RETURNING id
  `;
  const id = rows[0]?.id;
  assert.ok(id, "insertContribution must return an id");
  return id;
}

async function insertArgument(
  schema: string,
  motion: string,
  createdBy: string,
  originContributionId: string | null,
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO ${sql(schema)}.${sql("arguments")} (motion, created_by, origin_contribution_id)
    VALUES (${motion}, ${createdBy}, ${originContributionId})
    RETURNING id
  `;
  const id = rows[0]?.id;
  assert.ok(id, "insertArgument must return an id");
  return id;
}

describe("migration 0007 — arguments, argument_sides, argument_votes, tags trgm index", () => {
  it("applies the real migrations directory, and a second run is a no-op", async () => {
    const schema = useScratchSchema();

    const first = await migrate(schema);
    assert.ok(
      first.applied.includes(MIGRATION_ID),
      `expected ${MIGRATION_ID} among applied migrations: ${first.applied.join(", ")}`,
    );

    const second = await migrate(schema);
    assert.deepEqual([...second.applied], [], "second run applies nothing");
    assert.ok(second.skipped.includes(MIGRATION_ID), "second run recognises 0007 as already applied");
  });

  it("inserts an authored argument (no origin contribution)", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const id = await insertArgument(schema, "We should ship weekly.", "admin", null);

    const rows = await sql<{ origin_contribution_id: string | null; state: string }[]>`
      SELECT origin_contribution_id, state FROM ${sql(schema)}.${sql("arguments")} WHERE id = ${id}
    `;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.origin_contribution_id, null, "authored arguments have no origin contribution");
    assert.equal(rows[0]?.state, "open", "state defaults to 'open'");
  });

  it("inserts an emergent argument (a real origin contribution) — the authored <-> emergent seam", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const agentId = await insertAgent(schema, "disagreeagent");
    const contributionId = await insertContribution(schema, agentId, 1);

    const id = await insertArgument(schema, "This claim is wrong.", "agent", contributionId);

    const rows = await sql<{ origin_contribution_id: string | null }[]>`
      SELECT origin_contribution_id FROM ${sql(schema)}.${sql("arguments")} WHERE id = ${id}
    `;
    assert.equal(
      rows[0]?.origin_contribution_id,
      contributionId,
      "an emergent argument carries the contribution it grew out of",
    );

    // No migration in between: the same table takes both shapes. `state`
    // mutates in place (open -> judged), proving `updated_at`'s purpose.
    await sql`UPDATE ${sql(schema)}.${sql("arguments")} SET state = 'judged' WHERE id = ${id}`;
    const [judged] = await sql<{ state: string }[]>`
      SELECT state FROM ${sql(schema)}.${sql("arguments")} WHERE id = ${id}
    `;
    assert.equal(judged?.state, "judged", "state advances open -> judged with no CHECK standing in the way");
  });

  it("rejects a dangling origin_contribution_id", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    await assert.rejects(
      () => insertArgument(schema, "A motion.", "admin", randomUUID()),
      /foreign key/i,
      "origin_contribution_id must reference a real contribution",
    );
  });

  it("argument_sides: PK (argument_id, agent_id) rejects a duplicate; contribution_id fills in later", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const argumentId = await insertArgument(schema, "A motion worth taking sides on.", "admin", null);
    const agentId = await insertAgent(schema, "sidetaker");

    await sql`
      INSERT INTO ${sql(schema)}.${sql("argument_sides")} (argument_id, agent_id, side)
      VALUES (${argumentId}, ${agentId}, 1)
    `;

    await assert.rejects(
      () => sql`
        INSERT INTO ${sql(schema)}.${sql("argument_sides")} (argument_id, agent_id, side)
        VALUES (${argumentId}, ${agentId}, -1)
      `,
      /duplicate key|unique/i,
      "a duplicate (argument_id, agent_id) side must be rejected by the PK",
    );

    // The row is created before the agent's contribution exists, then filled
    // in once it lands — mutation in place, hence `updated_at`.
    const contributionId = await insertContribution(schema, agentId, 2);
    await sql`
      UPDATE ${sql(schema)}.${sql("argument_sides")}
      SET contribution_id = ${contributionId}
      WHERE argument_id = ${argumentId} AND agent_id = ${agentId}
    `;

    const rows = await sql<{ side: number; contribution_id: string | null }[]>`
      SELECT side, contribution_id FROM ${sql(schema)}.${sql("argument_sides")}
      WHERE argument_id = ${argumentId} AND agent_id = ${agentId}
    `;
    assert.equal(rows.length, 1, "still exactly one row for the (argument, agent) pair");
    assert.equal(rows[0]?.side, 1, "the original insert's side survived — no upsert happened here");
    assert.equal(rows[0]?.contribution_id, contributionId, "contribution_id filled in after the side was taken");
  });

  it("argument_votes: PK (argument_id, user_id) rejects a duplicate; a re-vote flips side in place", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const argumentId = await insertArgument(schema, "A motion worth voting on.", "admin", null);
    const userId = await insertUser(schema, 1, "voter1");

    await sql`
      INSERT INTO ${sql(schema)}.${sql("argument_votes")} (argument_id, user_id, side)
      VALUES (${argumentId}, ${userId}, 1)
    `;

    await assert.rejects(
      () => sql`
        INSERT INTO ${sql(schema)}.${sql("argument_votes")} (argument_id, user_id, side)
        VALUES (${argumentId}, ${userId}, -1)
      `,
      /duplicate key|unique/i,
      "a plain second insert for the same (argument, user) must be rejected by the PK",
    );

    // The upsert path: ON CONFLICT (argument_id, user_id) DO UPDATE flips the
    // side in place, same shape as 0006's `votes`.
    await sql`
      INSERT INTO ${sql(schema)}.${sql("argument_votes")} (argument_id, user_id, side)
      VALUES (${argumentId}, ${userId}, -1)
      ON CONFLICT (argument_id, user_id) DO UPDATE SET side = EXCLUDED.side
    `;

    const rows = await sql<{ side: number }[]>`
      SELECT side FROM ${sql(schema)}.${sql("argument_votes")}
      WHERE argument_id = ${argumentId} AND user_id = ${userId}
    `;
    assert.equal(rows.length, 1, "still exactly one row for the (argument, user) pair");
    assert.equal(rows[0]?.side, -1, "the upsert flipped the side in place");
  });

  it("uses tags_slug_trgm_idx for a LIKE '%x%' query over tags.slug", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    await sql`
      INSERT INTO ${sql(schema)}.${sql("tags")} (slug, post_count)
      VALUES ('growth-hacking', 0), ('backend', 0), ('frontend-design', 0)
    `;

    // Tiny tables always seqscan on cost, so disable it for one transaction:
    // the plan then proves the trgm index is *usable*, not merely present —
    // same technique `calls.test.ts` uses for the checkpoints partial index.
    const plan = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL enable_seqscan = off");
      const rows = await tx.unsafe<{ "QUERY PLAN": string }[]>(
        `EXPLAIN SELECT id FROM "${schema}".tags WHERE slug LIKE '%end%'`,
      );
      return rows.map((row) => row["QUERY PLAN"]).join("\n");
    });
    assert.match(
      plan,
      /tags_slug_trgm_idx/,
      `expected the LIKE query over tags.slug to use the trgm index:\n${plan}`,
    );

    const rows = await sql<{ slug: string }[]>`
      SELECT slug FROM ${sql(schema)}.${sql("tags")} WHERE slug LIKE ${"%end%"} ORDER BY slug
    `;
    assert.deepEqual(
      rows.map((row) => row.slug),
      ["backend", "frontend-design"],
      "the LIKE query returns the matching slugs",
    );
  });
});
