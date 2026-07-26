/**
 * Worker test for M0-BE-06: migration 0005 (calls, call_checkpoints,
 * agent_calibration).
 *
 * Same conventions as `identity.test.ts`, `posts.test.ts` and
 * `threads.test.ts`: every test applies the *real* `migrations/` directory into
 * a throwaway schema (dropped in `after()`), so the suite never touches the
 * dev database and is safely rerunnable.
 *
 * The cases that matter are the seam's guarantees, not its shape:
 *   - `calls.contribution_id` UNIQUE — the SD §1 seam: a call attaches to a
 *     contribution, never a post, and a contribution makes at most one claim.
 *   - `confidence` CHECK (1..5) — the domain SD §5 fixes verbatim, because it
 *     is `agent_calibration`'s bucket key.
 *   - the partial index on `call_checkpoints (due_at) WHERE answered_at IS
 *     NULL` — invariant 3's substrate, proved *usable* by an EXPLAIN with
 *     `enable_seqscan` disabled, not merely present.
 *   - `agent_calibration` PK (agent_id, confidence).
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

const MIGRATION_ID = "0005_calls";
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
  const schema = `m0be06_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
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

async function insertThread(schema: string, postId: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO ${sql(schema)}.${sql("threads")}
      (post_id, max_rounds, max_agent_responses, visibility)
    VALUES (${postId}, 3, 3, 'public')
    RETURNING id
  `;
  const id = rows[0]?.id;
  assert.ok(id, "insertThread must return an id");
  return id;
}

async function insertChapter(schema: string, threadId: string, chapterNo: number): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO ${sql(schema)}.${sql("chapters")} (thread_id, chapter_no, closes_at)
    VALUES (${threadId}, ${chapterNo}, now() + interval '1 day')
    RETURNING id
  `;
  const id = rows[0]?.id;
  assert.ok(id, "insertChapter must return an id");
  return id;
}

async function insertContribution(
  schema: string,
  chapterId: string,
  threadId: string,
  agentId: string,
  idempotencyKey: string,
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO ${sql(schema)}.${sql("contributions")}
      (chapter_id, thread_id, source_type, author_type, agent_id, round_no, body, idempotency_key)
    VALUES (${chapterId}, ${threadId}, 'post', 'agent', ${agentId}, 1, 'A checkable claim.', ${idempotencyKey})
    RETURNING id
  `;
  const id = rows[0]?.id;
  assert.ok(id, "insertContribution must return an id");
  return id;
}

/** Post → thread → chapter → agent → contribution, in a freshly migrated schema. */
async function fixture(
  schema: string,
  seed: number,
): Promise<{ contributionId: string; agentId: string; userId: string }> {
  const postId = await insertPost(schema, seed);
  const threadId = await insertThread(schema, postId);
  const chapterId = await insertChapter(schema, threadId, 1);
  const agentId = await insertAgent(schema, `agent${seed}`);
  const contributionId = await insertContribution(schema, chapterId, threadId, agentId, `turn:${seed}`);
  const userId = await insertUser(schema, seed + 1000, `reader${seed}`);
  return { contributionId, agentId, userId };
}

interface CallInput {
  readonly contributionId: string;
  readonly agentId: string;
  readonly claim?: string;
  readonly claimType?: string;
  readonly confidence: number;
  readonly horizonDays?: number;
  readonly state?: string;
}

async function insertCall(schema: string, input: CallInput): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO ${sql(schema)}.${sql("calls")}
      (contribution_id, agent_id, claim, claim_type, confidence, horizon_days, state)
    VALUES (
      ${input.contributionId}, ${input.agentId}, ${input.claim ?? "This will not ship on time."},
      ${input.claimType ?? "wont_ship"}, ${input.confidence}, ${input.horizonDays ?? 30},
      ${input.state ?? "open"}
    )
    RETURNING id
  `;
  const id = rows[0]?.id;
  assert.ok(id, "insertCall must return an id");
  return id;
}

async function insertCheckpoint(
  schema: string,
  callId: string,
  dueAt: string,
  answeredAt: string | null,
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO ${sql(schema)}.${sql("call_checkpoints")} (call_id, due_at, answered_at)
    VALUES (${callId}, ${dueAt}::timestamptz, ${answeredAt}::timestamptz)
    RETURNING id
  `;
  const id = rows[0]?.id;
  assert.ok(id, "insertCheckpoint must return an id");
  return id;
}

describe("migration 0005 — calls, call_checkpoints, agent_calibration", () => {
  it("applies the real migrations directory, and a second run is a no-op", async () => {
    const schema = useScratchSchema();

    const first = await migrate(schema);
    assert.ok(
      first.applied.includes(MIGRATION_ID),
      `expected ${MIGRATION_ID} among applied migrations: ${first.applied.join(", ")}`,
    );

    const second = await migrate(schema);
    assert.deepEqual([...second.applied], [], "second run applies nothing");
    assert.ok(second.skipped.includes(MIGRATION_ID), "second run recognises 0005 as already applied");
  });

  it("rejects a second call on the same contribution — the SD §1 seam", async () => {
    const schema = useScratchSchema();
    await migrate(schema);
    const { contributionId, agentId } = await fixture(schema, 10);

    await insertCall(schema, { contributionId, agentId, confidence: 4 });

    await assert.rejects(
      () => insertCall(schema, { contributionId, agentId, confidence: 3, claim: "A second claim." }),
      /duplicate key|unique/i,
      "a contribution makes at most one claim — contribution_id is UNIQUE",
    );

    const [count] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.${sql("calls")}
      WHERE contribution_id = ${contributionId}
    `;
    assert.equal(count?.n, 1, "exactly one call survives per contribution");
  });

  it("enforces confidence CHECK (1..5): 0 and 6 rejected, 1 and 5 accepted", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    for (const confidence of [0, 6]) {
      const { contributionId, agentId } = await fixture(schema, 20 + confidence);
      await assert.rejects(
        () => insertCall(schema, { contributionId, agentId, confidence }),
        /violates check constraint/i,
        `confidence=${confidence} must be rejected`,
      );
    }

    for (const confidence of [1, 5]) {
      const { contributionId, agentId } = await fixture(schema, 30 + confidence);
      const id = await insertCall(schema, { contributionId, agentId, confidence });
      const [row] = await sql<{ confidence: number }[]>`
        SELECT confidence FROM ${sql(schema)}.${sql("calls")} WHERE id = ${id}
      `;
      assert.equal(row?.confidence, confidence, `confidence=${confidence} must be accepted`);
    }
  });

  it("defaults state to 'open' and lets it advance to a resolution state", async () => {
    const schema = useScratchSchema();
    await migrate(schema);
    const { contributionId, agentId } = await fixture(schema, 40);

    const id = await insertCall(schema, { contributionId, agentId, confidence: 3 });
    const [inserted] = await sql<{ state: string }[]>`
      SELECT state FROM ${sql(schema)}.${sql("calls")} WHERE id = ${id}
    `;
    assert.equal(inserted?.state, "open", "state defaults to 'open'");

    // No CHECK on state (deliberate, same reasoning as claim_type): a new
    // resolution state must not require a migration.
    await sql`UPDATE ${sql(schema)}.${sql("calls")} SET state = 'held_up' WHERE id = ${id}`;
    const [held] = await sql<{ state: string }[]>`
      SELECT state FROM ${sql(schema)}.${sql("calls")} WHERE id = ${id}
    `;
    assert.equal(held?.state, "held_up", "state mutates in place — no CHECK stands in the way");
  });

  it(
    "uses the partial index for the unanswered-and-due query, and returns only those rows",
    async () => {
      const schema = useScratchSchema();
      await migrate(schema);
      const { contributionId, agentId, userId } = await fixture(schema, 50);
      const callId = await insertCall(schema, { contributionId, agentId, confidence: 4 });

      // A mix: due-and-unanswered (should surface), future-and-unanswered
      // (should not, due_at filter), and answered (should never surface, no
      // matter how overdue — invariant 3 excludes it by construction).
      const overdueUnanswered = await insertCheckpoint(
        schema,
        callId,
        new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        null,
      );
      const futureUnanswered = await insertCheckpoint(
        schema,
        callId,
        new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        null,
      );
      const overdueAnswered = await insertCheckpoint(
        schema,
        callId,
        new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
        new Date().toISOString(),
      );
      await sql`
        UPDATE ${sql(schema)}.${sql("call_checkpoints")}
        SET resolver_id = ${userId}, outcome = 'held_up'
        WHERE id = ${overdueAnswered}
      `;

      // Tiny tables always seqscan on cost, so disable it for one transaction:
      // the plan then proves the partial index is *usable*, not merely present.
      const plan = await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL enable_seqscan = off");
        const rows = await tx.unsafe<{ "QUERY PLAN": string }[]>(
          `EXPLAIN SELECT id FROM "${schema}".call_checkpoints
           WHERE answered_at IS NULL AND due_at <= now() ORDER BY due_at`,
        );
        return rows.map((row) => row["QUERY PLAN"]).join("\n");
      });
      assert.match(
        plan,
        /call_checkpoints_due_at_unanswered_idx/,
        `expected the unanswered-queue query to use the partial index:\n${plan}`,
      );

      const dueRows = await sql<{ id: string }[]>`
        SELECT id FROM ${sql(schema)}.${sql("call_checkpoints")}
        WHERE answered_at IS NULL AND due_at <= now() ORDER BY due_at
      `;
      assert.deepEqual(
        dueRows.map((row) => row.id),
        [overdueUnanswered],
        "only the overdue, unanswered checkpoint is returned — not the future one, not the answered one",
      );
      // futureUnanswered and overdueAnswered exist only to prove the query
      // excludes them; reference them so linting doesn't flag unused values.
      assert.ok(futureUnanswered && overdueAnswered);
    },
  );

  it("rejects a dangling call_id and a dangling resolver_id on call_checkpoints", async () => {
    const schema = useScratchSchema();
    await migrate(schema);
    const { contributionId, agentId } = await fixture(schema, 60);
    const callId = await insertCall(schema, { contributionId, agentId, confidence: 2 });

    await assert.rejects(
      () => insertCheckpoint(schema, randomUUID(), new Date().toISOString(), null),
      /foreign key/i,
      "call_id must reference a real call",
    );

    await assert.rejects(
      () => sql`
        INSERT INTO ${sql(schema)}.${sql("call_checkpoints")} (call_id, due_at, resolver_id)
        VALUES (${callId}, now(), ${randomUUID()})
      `,
      /foreign key/i,
      "resolver_id must reference a real user",
    );
  });

  it("enforces agent_calibration PK (agent_id, confidence)", async () => {
    const schema = useScratchSchema();
    await migrate(schema);
    const agentId = await insertAgent(schema, "calibrated-agent");

    await sql`
      INSERT INTO ${sql(schema)}.${sql("agent_calibration")} (agent_id, confidence, resolved, held_up)
      VALUES (${agentId}, 4, 10, 7)
    `;

    await assert.rejects(
      () => sql`
        INSERT INTO ${sql(schema)}.${sql("agent_calibration")} (agent_id, confidence, resolved, held_up)
        VALUES (${agentId}, 4, 1, 1)
      `,
      /duplicate key|unique/i,
      "the same (agent_id, confidence) pair must be rejected",
    );

    // A different confidence bucket for the same agent is a distinct row —
    // the curve, not the number.
    await sql`
      INSERT INTO ${sql(schema)}.${sql("agent_calibration")} (agent_id, confidence, resolved, held_up)
      VALUES (${agentId}, 5, 2, 2)
    `;

    const rows = await sql<{ confidence: number; resolved: number; held_up: number }[]>`
      SELECT confidence, resolved, held_up FROM ${sql(schema)}.${sql("agent_calibration")}
      WHERE agent_id = ${agentId} ORDER BY confidence
    `;
    assert.deepEqual(
      rows.map((row) => [row.confidence, row.resolved, row.held_up]),
      [
        [4, 10, 7],
        [5, 2, 2],
      ],
      "two rows for the same agent at different confidence buckets both survive",
    );
  });
});
