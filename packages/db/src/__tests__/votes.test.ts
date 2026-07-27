/**
 * Worker test for M0-BE-07: migration 0006 (votes, contribution_counters,
 * follows, diaries, diary_refs, diary_addenda).
 *
 * Same conventions as `identity.test.ts` and `threads.test.ts`: every test
 * applies the *real* `migrations/` directory into a throwaway schema (dropped
 * in `after()`), so the suite never touches the dev database and is safely
 * rerunnable.
 *
 * This branch's migration 0005 (M0-BE-06, calls/call_checkpoints/
 * agent_calibration) is in flight on a sibling worktree and is not present
 * here, so the applied set has a gap at 0005 — deliberate per D-011 and this
 * ticket's brief. This suite only asserts that 0006 lands; the overall
 * shipped-migrations contiguity check belongs to `migrate.test.ts` and is
 * expected to fail on this branch alone.
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

const MIGRATION_ID = "0006_votes_follows_diaries";
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
  const schema = `m0be07_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
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

async function insertPost(schema: string, seed: number): Promise<string> {
  const userId = await insertUser(schema, seed, `poster${seed}`);
  const forums = await sql<{ id: string }[]>`
    INSERT INTO ${sql(schema)}.${sql("forums")} (slug, name, tone_policy)
    VALUES (${`validate${seed}`}, 'Validate', 'plain')
    RETURNING id
  `;
  const forumId = forums[0]?.id;
  assert.ok(forumId, "insertPost must create a forum");

  const rows = await sql<{ id: string }[]>`
    INSERT INTO ${sql(schema)}.${sql("posts")}
      (author_user_id, surface, forum_id, body_idea, field_who, field_today)
    VALUES (${userId}, 'validate', ${forumId}, 'An idea.', 'Someone.', 'Something else.')
    RETURNING id
  `;
  const id = rows[0]?.id;
  assert.ok(id, "insertPost must return an id");
  return id;
}

/** A bare, off-thread contribution — enough to hang votes/counters/refs off of. */
async function insertContribution(schema: string, agentId: string, seed: number): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO ${sql(schema)}.${sql("contributions")}
      (source_type, author_type, agent_id, body, idempotency_key, selected_by)
    VALUES ('post', 'agent', ${agentId}, 'A contribution.', ${`m0be07-contrib-${seed}`}, 'coverage')
    RETURNING id
  `;
  const id = rows[0]?.id;
  assert.ok(id, "insertContribution must return an id");
  return id;
}

describe("migration 0006 — votes, contribution_counters, follows, diaries", () => {
  it("applies the real migrations directory, and a second run is a no-op", async () => {
    const schema = useScratchSchema();

    const first = await migrate(schema);
    assert.ok(
      first.applied.includes(MIGRATION_ID),
      `expected ${MIGRATION_ID} among applied migrations: ${first.applied.join(", ")}`,
    );

    const second = await migrate(schema);
    assert.deepEqual([...second.applied], [], "second run applies nothing");
    assert.ok(second.skipped.includes(MIGRATION_ID), "second run recognises 0006 as already applied");
    // Deliberately not asserting overall contiguity here — this branch has a
    // gap at 0005 (M0-BE-06, in flight on a sibling worktree per D-011), and
    // that overall check is migrate.test.ts's job, not this file's.
  });

  it("upserts a re-vote instead of duplicating it (the acceptance case)", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const agentId = await insertAgent(schema, "voteagent");
    const userId = await insertUser(schema, 1, "voter1");
    const contributionId = await insertContribution(schema, agentId, 1);

    await sql`
      INSERT INTO ${sql(schema)}.${sql("votes")} (contribution_id, user_id, signal)
      VALUES (${contributionId}, ${userId}, 'well_made')
    `;

    // A plain second INSERT without ON CONFLICT collides on the composite PK.
    await assert.rejects(
      () => sql`
        INSERT INTO ${sql(schema)}.${sql("votes")} (contribution_id, user_id, signal)
        VALUES (${contributionId}, ${userId}, 'weak')
      `,
      /duplicate key|unique/i,
      "a plain second insert for the same (contribution, user) must be rejected by the PK",
    );

    // The upsert path: ON CONFLICT (contribution_id, user_id) DO UPDATE flips
    // the signal in place.
    await sql`
      INSERT INTO ${sql(schema)}.${sql("votes")} (contribution_id, user_id, signal)
      VALUES (${contributionId}, ${userId}, 'weak')
      ON CONFLICT (contribution_id, user_id) DO UPDATE SET signal = EXCLUDED.signal
    `;

    const rows = await sql<{ signal: string }[]>`
      SELECT signal FROM ${sql(schema)}.${sql("votes")}
      WHERE contribution_id = ${contributionId} AND user_id = ${userId}
    `;
    assert.equal(rows.length, 1, "still exactly one row for the (contribution, user) pair");
    assert.equal(rows[0]?.signal, "weak", "the upsert flipped the signal in place");
  });

  it("rejects a second diary for the same (agent, day), accepts a different day", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const agentId = await insertAgent(schema, "diaryagent");
    const day = "2026-07-26";

    await sql`
      INSERT INTO ${sql(schema)}.${sql("diaries")} (agent_id, day, body)
      VALUES (${agentId}, ${day}, 'A day, recounted.')
    `;

    await assert.rejects(
      () => sql`
        INSERT INTO ${sql(schema)}.${sql("diaries")} (agent_id, day, body)
        VALUES (${agentId}, ${day}, 'A second telling of the same day.')
      `,
      /duplicate key|unique/i,
      "UNIQUE (agent_id, day) rejects a second diary for the same day",
    );

    // Same agent, a different day: accepted.
    await sql`
      INSERT INTO ${sql(schema)}.${sql("diaries")} (agent_id, day, body)
      VALUES (${agentId}, '2026-07-27', 'The next day.')
    `;

    const [count] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.${sql("diaries")} WHERE agent_id = ${agentId}
    `;
    assert.equal(count?.n, 2, "two diaries survive for the same agent on two different days");
  });

  it("follows: (user, agent) PK rejects a duplicate; muted flips true without unfollowing", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const userId = await insertUser(schema, 2, "follower1");
    const agentId = await insertAgent(schema, "followedagent");

    await sql`
      INSERT INTO ${sql(schema)}.${sql("follows")} (user_id, agent_id)
      VALUES (${userId}, ${agentId})
    `;

    await assert.rejects(
      () => sql`
        INSERT INTO ${sql(schema)}.${sql("follows")} (user_id, agent_id)
        VALUES (${userId}, ${agentId})
      `,
      /duplicate key|unique/i,
      "a duplicate (user, agent) follow row must be rejected by the PK",
    );

    await sql`
      UPDATE ${sql(schema)}.${sql("follows")} SET muted = true
      WHERE user_id = ${userId} AND agent_id = ${agentId}
    `;

    const rows = await sql<{ muted: boolean }[]>`
      SELECT muted FROM ${sql(schema)}.${sql("follows")}
      WHERE user_id = ${userId} AND agent_id = ${agentId}
    `;
    assert.equal(rows.length, 1, "the follow row still exists after muting — mute is not unfollow");
    assert.equal(rows[0]?.muted, true, "muted flips to true in place");
  });

  it("diary_refs: a contribution ref inserts, and deleting the diary cascades the ref", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const agentId = await insertAgent(schema, "refagent");
    const contributionId = await insertContribution(schema, agentId, 2);

    const diaryRows = await sql<{ id: string }[]>`
      INSERT INTO ${sql(schema)}.${sql("diaries")} (agent_id, day, body)
      VALUES (${agentId}, '2026-07-26', 'Reviewed a contribution today.')
      RETURNING id
    `;
    const diaryId = diaryRows[0]?.id;
    assert.ok(diaryId, "diary insert must return an id");

    await sql`
      INSERT INTO ${sql(schema)}.${sql("diary_refs")} (diary_id, label, ref_type, ref_id)
      VALUES (${diaryId}, 'the contribution I made', 'contribution', ${contributionId})
    `;

    const [beforeCount] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.${sql("diary_refs")} WHERE diary_id = ${diaryId}
    `;
    assert.equal(beforeCount?.n, 1, "the ref is present before the diary is deleted");

    await sql`DELETE FROM ${sql(schema)}.${sql("diaries")} WHERE id = ${diaryId}`;

    const [afterCount] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.${sql("diary_refs")} WHERE diary_id = ${diaryId}
    `;
    assert.equal(afterCount?.n, 0, "ON DELETE CASCADE removes the ref along with its diary");
  });

  it("contribution_counters: inserts per contribution, and an increment persists", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const agentId = await insertAgent(schema, "counteragent");
    const contributionId = await insertContribution(schema, agentId, 3);

    await sql`
      INSERT INTO ${sql(schema)}.${sql("contribution_counters")} (contribution_id)
      VALUES (${contributionId})
    `;

    await sql`
      UPDATE ${sql(schema)}.${sql("contribution_counters")}
      SET well_made = well_made + 1
      WHERE contribution_id = ${contributionId}
    `;

    const rows = await sql<{ well_made: number; weak: number; replies: number }[]>`
      SELECT well_made, weak, replies FROM ${sql(schema)}.${sql("contribution_counters")}
      WHERE contribution_id = ${contributionId}
    `;
    assert.equal(rows.length, 1, "one counters row per contribution — it is the PK");
    assert.equal(rows[0]?.well_made, 1, "the increment persisted");
    assert.equal(rows[0]?.weak, 0, "weak stays at its default");
    assert.equal(rows[0]?.replies, 0, "replies stays at its default");
  });
});
