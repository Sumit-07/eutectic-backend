/**
 * Worker test for M0-BE-05: migration 0004 (threads, chapters, contributions).
 *
 * Same conventions as `identity.test.ts` and `posts.test.ts`: every test applies
 * the *real* `migrations/` directory into a throwaway schema (dropped in
 * `after()`), so the suite never touches the dev database and is safely
 * rerunnable.
 *
 * The cases that matter are the seam's guarantees, not its shape:
 *   - `idempotency_key` UNIQUE — the substrate of invariant 1, "never write a
 *     partial contribution": a retried turn collides instead of duplicating.
 *   - the authorship biconditional, tested in *both* directions, because a
 *     one-directional CHECK would let a user-authored row carry an agent id and
 *     silently pollute standing, calibration and the diary.
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

const MIGRATION_ID = "0004_threads_chapters_contributions";
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
  const schema = `m0be05_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
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

interface ContributionInput {
  readonly chapterId?: string | null;
  readonly threadId?: string | null;
  readonly sourceType?: string;
  readonly sourceRef?: string | null;
  readonly authorType: string;
  readonly agentId?: string | null;
  readonly userId?: string | null;
  readonly roundNo?: number | null;
  readonly body?: string | null;
  readonly declined?: boolean;
  readonly declineReason?: string | null;
  readonly disagreesWith?: string | null;
  readonly parentId?: string | null;
  readonly reviewState?: string | null;
  readonly idempotencyKey: string;
  /**
   * D-043: no default since 0013, and conditional on `authorType` — an agent
   * row must name its routing pass, a human row must be NULL. Defaulted below
   * so a fixture only says it when the pass matters.
   */
  readonly selectedBy?: string | null;
}

async function insertContribution(schema: string, input: ContributionInput): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO ${sql(schema)}.${sql("contributions")}
      (chapter_id, thread_id, source_type, source_ref, author_type, agent_id, user_id,
       round_no, body, declined, decline_reason, disagrees_with, parent_id,
       review_state, idempotency_key, selected_by)
    VALUES (
      ${input.chapterId ?? null}, ${input.threadId ?? null}, ${input.sourceType ?? "post"},
      ${input.sourceRef ?? null}, ${input.authorType}, ${input.agentId ?? null},
      ${input.userId ?? null}, ${input.roundNo ?? null}, ${input.body ?? null},
      ${input.declined ?? false}, ${input.declineReason ?? null},
      ${input.disagreesWith ?? null}, ${input.parentId ?? null},
      ${input.reviewState ?? "live"}, ${input.idempotencyKey},
      ${"selectedBy" in input ? input.selectedBy ?? null : input.authorType === "agent" ? "coverage" : null}
    )
    RETURNING id
  `;
  const id = rows[0]?.id;
  assert.ok(id, "insertContribution must return an id");
  return id;
}

/** Post → thread → chapter, plus one agent, in a freshly migrated schema. */
async function fixture(
  schema: string,
  seed: number,
): Promise<{ postId: string; threadId: string; chapterId: string; agentId: string; userId: string }> {
  const postId = await insertPost(schema, seed);
  const threadId = await insertThread(schema, postId);
  const chapterId = await insertChapter(schema, threadId, 1);
  const agentId = await insertAgent(schema, `agent${seed}`);
  const userId = await insertUser(schema, seed + 1000, `reader${seed}`);
  return { postId, threadId, chapterId, agentId, userId };
}

describe("migration 0004 — threads, chapters, contributions", () => {
  it("applies the real migrations directory, and a second run is a no-op", async () => {
    const schema = useScratchSchema();

    const first = await migrate(schema);
    assert.ok(
      first.applied.includes(MIGRATION_ID),
      `expected ${MIGRATION_ID} among applied migrations: ${first.applied.join(", ")}`,
    );

    const second = await migrate(schema);
    assert.deepEqual([...second.applied], [], "second run applies nothing");
    assert.ok(second.skipped.includes(MIGRATION_ID), "second run recognises 0004 as already applied");
  });

  it("rejects a duplicate idempotency_key — invariant 1's substrate", async () => {
    const schema = useScratchSchema();
    await migrate(schema);
    const { threadId, chapterId, agentId } = await fixture(schema, 10);

    // The turn worker's key: hash(agent_id, chapter_id, round_no). A retried or
    // double-delivered job presents the same key.
    const key = `turn:${agentId}:${chapterId}:1`;
    const write = async (): Promise<string> =>
      insertContribution(schema, {
        chapterId,
        threadId,
        authorType: "agent",
        agentId,
        roundNo: 1,
        body: "Your unit economics assume a retention curve you have not measured.",
        idempotencyKey: key,
      });

    const firstId = await write();
    await assert.rejects(write, /duplicate key|unique/i, "a replayed turn must collide, not duplicate");

    const [count] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.${sql("contributions")}
      WHERE idempotency_key = ${key}
    `;
    assert.equal(count?.n, 1, "exactly one row survives the replay");

    // A *different* turn by the same agent in the same chapter is a different key.
    const secondId = await insertContribution(schema, {
      chapterId,
      threadId,
      authorType: "agent",
      agentId,
      roundNo: 2,
      body: "Second round.",
      idempotencyKey: `turn:${agentId}:${chapterId}:2`,
    });
    assert.notEqual(secondId, firstId, "a distinct key writes a distinct row");
  });

  it("rejects a NULL idempotency_key", async () => {
    const schema = useScratchSchema();
    await migrate(schema);
    const { threadId, chapterId, agentId } = await fixture(schema, 11);

    await assert.rejects(
      () => sql`
        INSERT INTO ${sql(schema)}.${sql("contributions")}
          (chapter_id, thread_id, source_type, author_type, agent_id, round_no, body, selected_by)
        VALUES (${chapterId}, ${threadId}, 'post', 'agent', ${agentId}, 1, 'No key.', 'coverage')
      `,
      // selected_by is supplied so the only missing NOT NULL column is the one
      // under test — otherwise this passes for the wrong reason (D-042).
      (error: { code?: string; column_name?: string }) => {
        assert.equal(error.code, "23502");
        assert.equal(error.column_name, "idempotency_key");
        return true;
      },
      "idempotency_key is NOT NULL — there is no unkeyed write path",
    );
  });

  it("enforces the author CHECK in both directions", async () => {
    const schema = useScratchSchema();
    await migrate(schema);
    const { threadId, chapterId, agentId, userId } = await fixture(schema, 12);

    const base = { chapterId, threadId, roundNo: 1, body: "..." } as const;

    // (a) author_type='agent' with agent_id NULL → rejected.
    await assert.rejects(
      () =>
        insertContribution(schema, {
          ...base,
          authorType: "agent",
          agentId: null,
          idempotencyKey: "check-a",
        }),
      /violates check constraint/i,
      "an agent-authored contribution without an agent_id must be rejected",
    );

    // (b) author_type='user' with agent_id set → rejected. This is the direction
    // a one-sided CHECK would miss, and the one that would pollute standing.
    await assert.rejects(
      () =>
        insertContribution(schema, {
          ...base,
          authorType: "user",
          agentId,
          userId,
          idempotencyKey: "check-b",
        }),
      /violates check constraint/i,
      "a user-authored contribution carrying an agent_id must be rejected",
    );

    // (c) author_type='agent' with agent_id set → accepted.
    const agentContributionId = await insertContribution(schema, {
      ...base,
      authorType: "agent",
      agentId,
      idempotencyKey: "check-c",
    });

    // (d) author_type='user' with user_id set and agent_id NULL → accepted.
    const userContributionId = await insertContribution(schema, {
      ...base,
      authorType: "user",
      userId,
      agentId: null,
      idempotencyKey: "check-d",
    });

    const rows = await sql<{ author_type: string; agent_id: string | null; user_id: string | null }[]>`
      SELECT author_type, agent_id, user_id
      FROM ${sql(schema)}.${sql("contributions")}
      WHERE id IN (${agentContributionId}, ${userContributionId})
      ORDER BY author_type
    `;
    assert.deepEqual(
      rows.map((row) => [row.author_type, row.agent_id === null, row.user_id === null]),
      [
        ["agent", false, true],
        ["user", true, false],
      ],
      "both accepted rows kept exactly the authorship they were given",
    );
  });

  it("defaults review_state to 'live' and lets it move to 'held'/'removed'", async () => {
    const schema = useScratchSchema();
    await migrate(schema);
    const { threadId, chapterId, agentId } = await fixture(schema, 13);

    const id = await insertContribution(schema, {
      chapterId,
      threadId,
      authorType: "agent",
      agentId,
      roundNo: 1,
      body: "First of ten.",
      idempotencyKey: "review-state",
    });

    const [inserted] = await sql<{ review_state: string; declined: boolean }[]>`
      SELECT review_state, declined FROM ${sql(schema)}.${sql("contributions")} WHERE id = ${id}
    `;
    assert.equal(inserted?.review_state, "live", "review_state defaults to 'live'");
    assert.equal(inserted?.declined, false, "declined defaults to false");

    // 'held' is the human-review gate for an agent's first 10 contributions.
    await sql`
      UPDATE ${sql(schema)}.${sql("contributions")} SET review_state = 'held' WHERE id = ${id}
    `;
    const [held] = await sql<{ review_state: string }[]>`
      SELECT review_state FROM ${sql(schema)}.${sql("contributions")} WHERE id = ${id}
    `;
    assert.equal(held?.review_state, "held", "review_state mutates in place — no CHECK stands in the way");
  });

  it("stores a decline instead of a fragment (declined + decline_reason, null body)", async () => {
    const schema = useScratchSchema();
    await migrate(schema);
    const { threadId, chapterId, agentId } = await fixture(schema, 14);

    const id = await insertContribution(schema, {
      chapterId,
      threadId,
      authorType: "agent",
      agentId,
      roundNo: 1,
      body: null,
      declined: true,
      declineReason: "validation failed after 3 retries",
      idempotencyKey: "decline",
    });

    const [row] = await sql<{ declined: boolean; decline_reason: string | null; body: string | null }[]>`
      SELECT declined, decline_reason, body
      FROM ${sql(schema)}.${sql("contributions")} WHERE id = ${id}
    `;
    assert.equal(row?.declined, true);
    assert.equal(row?.decline_reason, "validation failed after 3 retries");
    assert.equal(row?.body, null, "a decline carries no partial body — invariant 1");
  });

  it("carries the SD §1 seam: source_type is open, source_ref is free", async () => {
    const schema = useScratchSchema();
    await migrate(schema);
    const { postId, threadId, chapterId, agentId } = await fixture(schema, 15);

    const fromPost = await insertContribution(schema, {
      chapterId,
      threadId,
      sourceType: "post",
      sourceRef: postId,
      authorType: "agent",
      agentId,
      roundNo: 1,
      body: "A Validate round.",
      idempotencyKey: "seam-post",
    });
    const [row] = await sql<{ source_type: string; source_ref: string | null }[]>`
      SELECT source_type, source_ref FROM ${sql(schema)}.${sql("contributions")} WHERE id = ${fromPost}
    `;
    assert.equal(row?.source_type, "post");
    assert.equal(row?.source_ref, postId);

    // No CHECK on source_type (deliberate): a surface that does not exist yet —
    // and one nobody has named — must not need a migration.
    for (const [i, sourceType] of ["pr_review", "session", "argument", "bell", "surface_not_yet_invented"].entries()) {
      await insertContribution(schema, {
        sourceType,
        sourceRef: randomUUID(), // not an FK: the referent lives in another table
        authorType: "agent",
        agentId,
        body: `From ${sourceType}.`,
        idempotencyKey: `seam-${i}`,
      });
    }

    const [count] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.${sql("contributions")} WHERE chapter_id IS NULL
    `;
    assert.equal(count?.n, 5, "a contribution needs no chapter — off-thread surfaces produce them too");
  });

  it("accepts self-references for disagrees_with and parent_id, and rejects dangling ones", async () => {
    const schema = useScratchSchema();
    await migrate(schema);
    const { threadId, chapterId, agentId } = await fixture(schema, 16);
    const otherAgentId = await insertAgent(schema, "agent16b");

    const firstId = await insertContribution(schema, {
      chapterId,
      threadId,
      authorType: "agent",
      agentId,
      roundNo: 1,
      body: "This will work.",
      idempotencyKey: "self-1",
    });

    const replyId = await insertContribution(schema, {
      chapterId,
      threadId,
      authorType: "agent",
      agentId: otherAgentId,
      roundNo: 2,
      body: "It will not, and here is the number.",
      disagreesWith: firstId,
      parentId: firstId,
      idempotencyKey: "self-2",
    });

    const [row] = await sql<{ disagrees_with: string | null; parent_id: string | null }[]>`
      SELECT disagrees_with, parent_id FROM ${sql(schema)}.${sql("contributions")} WHERE id = ${replyId}
    `;
    assert.equal(row?.disagrees_with, firstId, "disagreement is a first-class edge");
    assert.equal(row?.parent_id, firstId, "parent_id is the reply tree");

    await assert.rejects(
      () =>
        insertContribution(schema, {
          chapterId,
          threadId,
          authorType: "agent",
          agentId,
          disagreesWith: randomUUID(),
          idempotencyKey: "self-dangling-disagrees",
        }),
      /foreign key/i,
      "disagrees_with must reference a real contribution",
    );

    await assert.rejects(
      () =>
        insertContribution(schema, {
          chapterId,
          threadId,
          authorType: "agent",
          agentId,
          parentId: randomUUID(),
          idempotencyKey: "self-dangling-parent",
        }),
      /foreign key/i,
      "parent_id must reference a real contribution",
    );
  });

  it("rejects a duplicate chapter_no within one thread, but not across threads", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const threadId = await insertThread(schema, await insertPost(schema, 17));
    await insertChapter(schema, threadId, 1);

    await assert.rejects(
      () => insertChapter(schema, threadId, 1),
      /duplicate key|unique/i,
      "UNIQUE (thread_id, chapter_no) makes chapter numbering a name, not a guess",
    );

    await insertChapter(schema, threadId, 2); // next chapter of the same thread

    const otherThreadId = await insertThread(schema, await insertPost(schema, 18));
    await insertChapter(schema, otherThreadId, 1); // chapter 1 of another thread

    const [count] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.${sql("chapters")}
    `;
    assert.equal(count?.n, 3);
  });

  it("rejects a second thread on the same post, and defaults the thread's own columns", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const postId = await insertPost(schema, 19);
    const threadId = await insertThread(schema, postId);

    await assert.rejects(
      () => insertThread(schema, postId),
      /duplicate key|unique/i,
      "one thread per post — threads.post_id is UNIQUE",
    );

    const [row] = await sql<
      { state: string; current_chapter_no: number; max_rounds: number; visibility: string }[]
    >`
      SELECT state, current_chapter_no, max_rounds, visibility
      FROM ${sql(schema)}.${sql("threads")} WHERE id = ${threadId}
    `;
    assert.equal(row?.state, "open", "state defaults to 'open'");
    assert.equal(row?.current_chapter_no, 1, "current_chapter_no defaults to 1");
    assert.equal(row?.max_rounds, 3, "the entitlement is denormalised onto the thread, not joined");
    assert.equal(row?.visibility, "public");
  });

  it("exposes both SD §5 indexes, and the planner uses each", async () => {
    const schema = useScratchSchema();
    await migrate(schema);
    const { threadId, chapterId, agentId } = await fixture(schema, 20);

    const indexes = await sql<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = ${schema} AND tablename = 'contributions'
      ORDER BY indexname
    `;
    const byName = new Map(indexes.map((row) => [row.indexname, row.indexdef]));
    assert.match(
      byName.get("contributions_chapter_id_round_no_created_at_idx") ?? "",
      /\(chapter_id, round_no, created_at\)/,
      "the chapter render index is (chapter_id, round_no, created_at)",
    );
    assert.match(
      byName.get("contributions_agent_id_created_at_idx") ?? "",
      /\(agent_id, created_at DESC\)/,
      "the agent history index is (agent_id, created_at DESC) — newest first",
    );

    await insertContribution(schema, {
      chapterId,
      threadId,
      authorType: "agent",
      agentId,
      roundNo: 1,
      body: "Indexed.",
      idempotencyKey: "index-1",
    });

    // Tiny tables always seqscan on cost, so disable it for one transaction: the
    // plan then proves each index is *usable*, not merely present.
    const plans = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL enable_seqscan = off");
      const chapterPlan = await tx.unsafe<{ "QUERY PLAN": string }[]>(
        `EXPLAIN SELECT id FROM "${schema}".contributions
         WHERE chapter_id = '${chapterId}' ORDER BY round_no, created_at`,
      );
      const agentPlan = await tx.unsafe<{ "QUERY PLAN": string }[]>(
        `EXPLAIN SELECT id FROM "${schema}".contributions
         WHERE agent_id = '${agentId}' ORDER BY created_at DESC`,
      );
      return {
        chapter: chapterPlan.map((row) => row["QUERY PLAN"]).join("\n"),
        agent: agentPlan.map((row) => row["QUERY PLAN"]).join("\n"),
      };
    });

    assert.match(plans.chapter, /contributions_chapter_id_round_no_created_at_idx/, plans.chapter);
    assert.match(plans.agent, /contributions_agent_id_created_at_idx/, plans.agent);
  });
});
