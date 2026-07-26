/**
 * Worker test for M0-BE-04: migration 0003 (forums, tags, posts, post_tags).
 *
 * Same conventions as `identity.test.ts`: every test applies the *real*
 * `migrations/` directory into a throwaway schema (dropped in `after()`), so the
 * suite never touches the dev database and is safely rerunnable.
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

const MIGRATION_ID = "0003_forums_tags_posts";
const silent = (): void => {};

// A post whose three structured fields each contribute a distinctive term, so a
// match proves the generated expression concatenated all three — not just the body.
const BODY_IDEA = "A rooftop greenhouse that sells photosynthesis as a subscription.";
const FIELD_WHO = "Allotment holders in Rotterdam.";
const FIELD_TODAY = "They queue at a garden centre every Saturday.";

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
  const schema = `m0be04_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
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

async function insertForum(schema: string, slug: string, tonePolicy: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO ${sql(schema)}.${sql("forums")} (slug, name, tone_policy)
    VALUES (${slug}, ${slug}, ${tonePolicy})
    RETURNING id
  `;
  const id = rows[0]?.id;
  assert.ok(id, "insertForum must return an id");
  return id;
}

async function insertPost(schema: string, authorUserId: string, forumId: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO ${sql(schema)}.${sql("posts")}
      (author_user_id, surface, forum_id, body_idea, field_who, field_today)
    VALUES (${authorUserId}, 'validate', ${forumId}, ${BODY_IDEA}, ${FIELD_WHO}, ${FIELD_TODAY})
    RETURNING id
  `;
  const id = rows[0]?.id;
  assert.ok(id, "insertPost must return an id");
  return id;
}

async function insertTag(schema: string, slug: string, canonicalTagId: string | null): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO ${sql(schema)}.${sql("tags")} (slug, canonical_tag_id)
    VALUES (${slug}, ${canonicalTagId})
    RETURNING id
  `;
  const id = rows[0]?.id;
  assert.ok(id, "insertTag must return an id");
  return id;
}

/** Ids of posts matching a websearch query, via the generated tsvector. */
async function search(schema: string, query: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    SELECT id
    FROM ${sql(schema)}.${sql("posts")}
    WHERE search_vector @@ websearch_to_tsquery('english', ${query})
  `;
  return rows.map((row) => row.id);
}

describe("migration 0003 — forums, tags, posts, post_tags", () => {
  it("applies the real migrations directory, and a second run is a no-op", async () => {
    const schema = useScratchSchema();

    const first = await migrate(schema);
    assert.ok(
      first.applied.includes(MIGRATION_ID),
      `expected ${MIGRATION_ID} among applied migrations: ${first.applied.join(", ")}`,
    );

    const second = await migrate(schema);
    assert.deepEqual([...second.applied], [], "second run applies nothing");
    assert.ok(second.skipped.includes(MIGRATION_ID), "second run recognises 0003 as already applied");
  });

  it("populates search_vector from all three structured fields, and matches via websearch_to_tsquery", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const userId = await insertUser(schema, 41, "greenfingers");
    const forumId = await insertForum(schema, "validate", "plain");
    const postId = await insertPost(schema, userId, forumId);

    const [row] = await sql<{ vector: string; lexemes: number }[]>`
      SELECT search_vector::text AS vector, length(search_vector) AS lexemes
      FROM ${sql(schema)}.${sql("posts")}
      WHERE id = ${postId}
    `;
    assert.ok(row, "the inserted post is readable");
    assert.ok(row.lexemes > 0, `search_vector must be populated, got ${JSON.stringify(row.vector)}`);
    // Stemmed lexemes with positions — proof Postgres generated it, not a cast of the raw text.
    assert.match(row.vector, /'photosynthesi':\d/, "body_idea contributes stemmed lexemes");
    assert.match(row.vector, /'rotterdam':\d/, "field_who contributes stemmed lexemes");
    assert.match(row.vector, /'saturday':\d/, "field_today contributes stemmed lexemes");

    assert.deepEqual(await search(schema, "photosynthesis"), [postId], "a body_idea term matches");
    assert.deepEqual(await search(schema, "Rotterdam"), [postId], "a field_who term matches");
    assert.deepEqual(await search(schema, "Saturday"), [postId], "a field_today term matches");
    assert.deepEqual(
      await search(schema, "greenhouse subscription"),
      [postId],
      "websearch AND-semantics across two present terms still matches",
    );
    assert.deepEqual(await search(schema, "zeppelin"), [], "an absent term matches nothing");
    assert.deepEqual(
      await search(schema, "photosynthesis zeppelin"),
      [],
      "websearch AND-semantics: one absent term excludes the post",
    );
  });

  it("regenerates search_vector when a structured field is updated", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const userId = await insertUser(schema, 42, "reviser");
    const forumId = await insertForum(schema, "validate", "plain");
    const postId = await insertPost(schema, userId, forumId);

    await sql`
      UPDATE ${sql(schema)}.${sql("posts")}
      SET field_today = 'They already pay a zeppelin subscription.'
      WHERE id = ${postId}
    `;

    assert.deepEqual(await search(schema, "zeppelin"), [postId], "the new term is searchable");
    assert.deepEqual(await search(schema, "Saturday"), [], "the replaced term is gone");
  });

  it("exposes a GIN index the planner uses for the websearch predicate", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const indexes = await sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = ${schema} AND tablename = 'posts' AND indexname = 'posts_search_idx'
    `;
    assert.equal(indexes.length, 1, "posts_search_idx exists on posts");
    assert.match(indexes[0]?.indexdef ?? "", /USING gin \(search_vector\)/, "it is a GIN index on search_vector");

    const userId = await insertUser(schema, 43, "planner");
    const forumId = await insertForum(schema, "validate", "plain");
    await insertPost(schema, userId, forumId);

    // Tiny tables always seqscan on cost, so disable it for the duration of one
    // transaction: the plan then proves the index is *usable*, not merely present.
    const plan = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL enable_seqscan = off");
      const rows = await tx.unsafe<{ "QUERY PLAN": string }[]>(
        `EXPLAIN SELECT id FROM "${schema}".posts
         WHERE search_vector @@ websearch_to_tsquery('english', 'photosynthesis')`,
      );
      return rows.map((row) => row["QUERY PLAN"]).join("\n");
    });

    assert.match(plan, /posts_search_idx/, `expected posts_search_idx in the plan:\n${plan}`);
    assert.doesNotMatch(plan, /Seq Scan on posts/, `expected no sequential scan:\n${plan}`);
  });

  it("defaults allowed_agent_classes to {staff,registry}", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const forumId = await insertForum(schema, "roastme", "roast");
    const [row] = await sql<{ allowed_agent_classes: string[]; tone_policy: string }[]>`
      SELECT allowed_agent_classes, tone_policy
      FROM ${sql(schema)}.${sql("forums")}
      WHERE id = ${forumId}
    `;
    assert.deepEqual(row?.allowed_agent_classes, ["staff", "registry"]);
    assert.equal(row?.tone_policy, "roast", "tone_policy is stored uninterpreted — no CHECK");
  });

  it("accepts a tag aliased to another tag (canonical_tag_id self-FK seam)", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const canonicalId = await insertTag(schema, "developer-tools", null);
    const aliasId = await insertTag(schema, "devtools", canonicalId);

    const [row] = await sql<{ canonical_tag_id: string | null }[]>`
      SELECT canonical_tag_id FROM ${sql(schema)}.${sql("tags")} WHERE id = ${aliasId}
    `;
    assert.equal(row?.canonical_tag_id, canonicalId, "the alias resolves to its canonical tag");

    await assert.rejects(
      () => insertTag(schema, "ghosts", randomUUID()),
      /foreign key/i,
      "canonical_tag_id must reference a real tag",
    );
  });

  it("rejects the same (post, tag) twice via the composite primary key", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const userId = await insertUser(schema, 44, "tagger");
    const forumId = await insertForum(schema, "validate", "plain");
    const postId = await insertPost(schema, userId, forumId);
    const tagId = await insertTag(schema, "hardware", null);

    const link = async (): Promise<void> => {
      await sql`
        INSERT INTO ${sql(schema)}.${sql("post_tags")} (post_id, tag_id)
        VALUES (${postId}, ${tagId})
      `;
    };

    await link();
    await assert.rejects(link, /duplicate key|unique/i, "the composite PK rejects a duplicate link");

    // Max 2 tags per post is deliberately NOT enforced here (SD §5): the service
    // layer owns it, so a third link is accepted by the schema.
    const secondTagId = await insertTag(schema, "climate", null);
    const thirdTagId = await insertTag(schema, "logistics", null);
    await sql`
      INSERT INTO ${sql(schema)}.${sql("post_tags")} (post_id, tag_id)
      VALUES (${postId}, ${secondTagId}), (${postId}, ${thirdTagId})
    `;
    const [count] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.${sql("post_tags")} WHERE post_id = ${postId}
    `;
    assert.equal(count?.n, 3, "the schema does not cap tags — the service layer does");
  });

  it("cascades post_tags on post delete, but protects tags in use", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const userId = await insertUser(schema, 45, "deleter");
    const forumId = await insertForum(schema, "validate", "plain");
    const postId = await insertPost(schema, userId, forumId);
    const tagId = await insertTag(schema, "robotics", null);

    await sql`
      INSERT INTO ${sql(schema)}.${sql("post_tags")} (post_id, tag_id)
      VALUES (${postId}, ${tagId})
    `;

    await assert.rejects(
      () => sql`DELETE FROM ${sql(schema)}.${sql("tags")} WHERE id = ${tagId}`,
      /foreign key/i,
      "deleting a tag with live links must fail — only post_id cascades",
    );

    await sql`DELETE FROM ${sql(schema)}.${sql("posts")} WHERE id = ${postId}`;
    const [remaining] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.${sql("post_tags")} WHERE post_id = ${postId}
    `;
    assert.equal(remaining?.n, 0, "deleting a post cascades its links away");
  });
});
