/**
 * Worker test for P-01: migration 0013 (contribution provenance, shadow mode,
 * pseudonymous identity, reserved handles, platform settings, avatar seeds,
 * bios, the votes profile index and the affinity soft-weight compression).
 *
 * Same conventions as `identity.test.ts`, `threads.test.ts` and `votes.test.ts`:
 * every test applies the *real* `migrations/` directory into a throwaway schema
 * (dropped in `after()`), so the suite never touches the dev database and is
 * safely rerunnable.
 *
 * Two of these tests need rows that existed BEFORE 0013 ran — the avatar-seed
 * backfill and the affinity compression are one-shot UPDATEs whose effect is
 * invisible against an empty database. `migrateThrough("0012")` copies
 * migrations 0000…0012 into a temp directory and applies only those; the
 * subsequent full run then finds identical checksums for what it already
 * applied and lands 0013 alone. That is also the shape the red-gate evidence
 * takes: against a database migrated only to 0012, every assertion here fails.
 *
 *   pnpm --filter @eutectic/db test
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import type { Sql } from "postgres";

import { createPool } from "../client.js";
import { requireDatabaseUrl } from "../env.js";
import { discoverMigrations, runSqlMigrations } from "../migrate.js";
import { MIGRATIONS_DIR } from "../paths.js";
import { BOOTSTRAP_PLATFORM_SETTINGS, syncPlatformSettings } from "../seed-data/platform-settings.js";
import { CORE_RESERVED_HANDLES, RESERVED_HANDLES, syncReservedHandles } from "../seed-data/reserved-handles.js";

const MIGRATION_ID = "0013_provenance_identity_settings";
const silent = (): void => {};

let sql: Sql;
const schemasToDrop: string[] = [];
const dirsToRemove: string[] = [];

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
  for (const dir of dirsToRemove) {
    await rm(dir, { recursive: true, force: true });
  }
});

function useScratchSchema(): string {
  const schema = `p01_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  schemasToDrop.push(schema);
  return schema;
}

async function migrate(schema: string): Promise<Awaited<ReturnType<typeof runSqlMigrations>>> {
  return runSqlMigrations({ dir: MIGRATIONS_DIR, schema, log: silent });
}

/** Apply migrations 0000…`last` only, from a temp copy of the real directory. */
async function migrateThrough(schema: string, last: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "eutectic-p01-"));
  dirsToRemove.push(dir);
  const migrations = await discoverMigrations(MIGRATIONS_DIR);
  for (const migration of migrations) {
    if (migration.sequence > last) continue;
    await copyFile(migration.path, join(dir, migration.filename));
  }
  await runSqlMigrations({ dir, schema, log: silent });
}

async function indexDefinition(schema: string, name: string): Promise<string | undefined> {
  const rows = await sql<{ indexdef: string }[]>`
    SELECT indexdef FROM pg_indexes WHERE schemaname = ${schema} AND indexname = ${name}
  `;
  return rows[0]?.indexdef;
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

async function insertChapter(schema: string, seed: number): Promise<string> {
  const userId = await insertUser(schema, seed, `poster${seed}`);
  const forums = await sql<{ id: string }[]>`
    INSERT INTO ${sql(schema)}.${sql("forums")} (slug, name, tone_policy)
    VALUES (${`validate${seed}`}, 'Validate', 'plain')
    RETURNING id
  `;
  const forumId = forums[0]?.id;
  assert.ok(forumId, "insertChapter must create a forum");

  const posts = await sql<{ id: string }[]>`
    INSERT INTO ${sql(schema)}.${sql("posts")}
      (author_user_id, surface, forum_id, body_idea, field_who, field_today)
    VALUES (${userId}, 'validate', ${forumId}, 'An idea.', 'Someone.', 'Something else.')
    RETURNING id
  `;
  const postId = posts[0]?.id;
  assert.ok(postId, "insertChapter must create a post");

  const threads = await sql<{ id: string }[]>`
    INSERT INTO ${sql(schema)}.${sql("threads")} (post_id, max_rounds, max_agent_responses, visibility)
    VALUES (${postId}, 3, 3, 'public')
    RETURNING id
  `;
  const threadId = threads[0]?.id;
  assert.ok(threadId, "insertChapter must create a thread");

  const chapters = await sql<{ id: string }[]>`
    INSERT INTO ${sql(schema)}.${sql("chapters")} (thread_id, chapter_no, closes_at)
    VALUES (${threadId}, 1, now() + interval '1 day')
    RETURNING id
  `;
  const id = chapters[0]?.id;
  assert.ok(id, "insertChapter must return an id");
  return id;
}

describe("migration 0013 — provenance, shadow, identity, settings, avatars", () => {
  it("applies the real migrations directory, and a second run is a no-op", async () => {
    const schema = useScratchSchema();

    const first = await migrate(schema);
    assert.ok(
      first.applied.includes(MIGRATION_ID),
      `expected ${MIGRATION_ID} among applied migrations: ${first.applied.join(", ")}`,
    );

    const second = await migrate(schema);
    assert.deepEqual([...second.applied], [], "second run applies nothing");
    assert.ok(second.skipped.includes(MIGRATION_ID), "second run recognises 0013 as already applied");
  });

  it("stamps every contribution with provenance defaults, so no row is ever unattributable", async () => {
    const schema = useScratchSchema();
    await migrate(schema);
    const agentId = await insertAgent(schema, "bricklayer");

    await sql`
      INSERT INTO ${sql(schema)}.${sql("contributions")}
        (source_type, author_type, agent_id, body, idempotency_key)
      VALUES ('post', 'agent', ${agentId}, 'A contribution.', 'p01-provenance-1')
    `;

    const rows = await sql<
      {
        persona_version: number;
        skill_version: number;
        prompt_version: number;
        model_id: string;
        validation_attempts: number;
        judge_score: number | null;
        self_check: unknown;
        selected_by: string;
      }[]
    >`
      SELECT persona_version, skill_version, prompt_version, model_id,
             validation_attempts, judge_score, self_check, selected_by
      FROM ${sql(schema)}.${sql("contributions")}
      WHERE idempotency_key = 'p01-provenance-1'
    `;

    const row = rows[0];
    assert.ok(row, "the contribution must exist");
    assert.equal(row.persona_version, 1);
    assert.equal(row.skill_version, 1);
    assert.equal(row.prompt_version, 1);
    assert.equal(row.model_id, "");
    assert.equal(row.validation_attempts, 1);
    assert.equal(row.judge_score, null, "judge_score is null until a judge runs");
    assert.equal(row.self_check, null, "self_check is null until a structured turn writes one");
    assert.equal(row.selected_by, "scored", "D-033's value set replaces this default in P-10");
  });

  it("stores self_check as a jsonb OBJECT and judge_score as a real", async () => {
    const schema = useScratchSchema();
    await migrate(schema);
    const agentId = await insertAgent(schema, "ledger");

    await sql`
      INSERT INTO ${sql(schema)}.${sql("contributions")}
        (source_type, author_type, agent_id, body, idempotency_key, self_check, judge_score, selected_by)
      VALUES ('post', 'agent', ${agentId}, 'A contribution.', 'p01-selfcheck-1',
              ${sql.json({ specific_criticism: "the retention curve is asserted, not measured" })}, 0.75, 'exploration')
    `;

    const rows = await sql<{ kind: string; criticism: string; judge_score: number; selected_by: string }[]>`
      SELECT jsonb_typeof(self_check) AS kind,
             self_check->>'specific_criticism' AS criticism,
             judge_score, selected_by
      FROM ${sql(schema)}.${sql("contributions")}
      WHERE idempotency_key = 'p01-selfcheck-1'
    `;

    assert.equal(rows[0]?.kind, "object", "self_check must land as an object, never a string scalar");
    assert.equal(rows[0]?.criticism, "the retention curve is asserted, not measured");
    assert.equal(rows[0]?.judge_score, 0.75);
    assert.equal(rows[0]?.selected_by, "exploration");
  });

  it("indexes contributions by (agent_id, persona_version, created_at DESC) — the eval attribution scan", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const def = await indexDefinition(schema, "contributions_persona_idx");
    assert.ok(def, "contributions_persona_idx must exist");
    assert.match(def, /agent_id/);
    assert.match(def, /persona_version/);
    assert.match(def, /created_at DESC/);
  });

  it("records shadow contributions that reference a real chapter and agent, and publishes nothing", async () => {
    const schema = useScratchSchema();
    await migrate(schema);
    const chapterId = await insertChapter(schema, 3101);
    const agentId = await insertAgent(schema, "sprout");

    await sql`
      INSERT INTO ${sql(schema)}.${sql("contributions_shadow")}
        (chapter_id, agent_id, round_no, persona_version, skill_version, prompt_version, model_id, body)
      VALUES (${chapterId}, ${agentId}, 1, 2, 1, 1, 'test-model', 'A shadow contribution.')
    `;

    const rows = await sql<{ declined: boolean; created_at: Date; body: string }[]>`
      SELECT declined, created_at, body FROM ${sql(schema)}.${sql("contributions_shadow")}
    `;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.declined, false, "declined defaults false");
    assert.ok(rows[0]?.created_at instanceof Date, "created_at is defaulted");

    // A shadow row is never a contribution: nothing landed in the published table.
    const published = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.${sql("contributions")}
    `;
    assert.equal(published[0]?.n, 0, "shadow mode must never publish");

    await assert.rejects(
      () => sql`
        INSERT INTO ${sql(schema)}.${sql("contributions_shadow")}
          (chapter_id, agent_id, round_no, persona_version, skill_version, prompt_version, model_id)
        VALUES (${randomUUID()}, ${agentId}, 1, 1, 1, 1, 'test-model')
      `,
      /foreign key/i,
      "a shadow row must reference a real chapter",
    );
  });

  it("indexes contributions_shadow the same way as contributions — the A/B is one query shape", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const def = await indexDefinition(schema, "contributions_shadow_agent_id_persona_version_created_at_idx");
    assert.ok(def, "the shadow persona index must exist");
    assert.match(def, /agent_id/);
    assert.match(def, /persona_version/);
    assert.match(def, /created_at DESC/);
  });

  it("defaults a new user to a private GitHub login, a never-changed handle and an uncomputed tier_would_be", async () => {
    const schema = useScratchSchema();
    await migrate(schema);
    await insertUser(schema, 3102, "octocat");

    const rows = await sql<
      { show_github_login: boolean; handle_changed_at: Date | null; tier_would_be: number | null; bio: string | null }[]
    >`
      SELECT show_github_login, handle_changed_at, tier_would_be, bio
      FROM ${sql(schema)}.${sql("users")} WHERE handle = 'octocat'
    `;
    assert.equal(rows[0]?.show_github_login, false, "D-029: the GitHub identity is private by default");
    assert.equal(rows[0]?.handle_changed_at, null, "NULL means the handle has never changed");
    assert.equal(rows[0]?.tier_would_be, null, "computed on login, not at insert");
    assert.equal(rows[0]?.bio, null);
  });

  it("backfills avatar seeds for rows that existed before 0013 — users from the id, agents from the slug", async () => {
    const schema = useScratchSchema();
    await migrateThrough(schema, "0012");

    const userId = await insertUser(schema, 3103, "monalisa");
    await insertAgent(schema, "vellum");

    await migrate(schema);

    const users = await sql<{ avatar_seed: string; handle_changed_at: Date | null }[]>`
      SELECT avatar_seed, handle_changed_at FROM ${sql(schema)}.${sql("users")} WHERE id = ${userId}
    `;
    assert.equal(users[0]?.avatar_seed, userId, "an existing user's seed backfills to its id");
    assert.equal(users[0]?.handle_changed_at, null, "handle_changed_at backfills NULL = never changed");

    const agents = await sql<{ avatar_seed: string }[]>`
      SELECT avatar_seed FROM ${sql(schema)}.${sql("agents")} WHERE slug = 'vellum'
    `;
    assert.equal(agents[0]?.avatar_seed, "vellum", "an existing agent's seed backfills to its slug");
  });

  it("compresses pre-existing affinity weights into 0.7–1.3 and defaults new rows to 1.0", async () => {
    const schema = useScratchSchema();
    await migrateThrough(schema, "0012");

    const agentId = await insertAgent(schema, "grouse");
    await sql`
      INSERT INTO ${sql(schema)}.${sql("agent_affinities")} (agent_id, scope, ref, weight)
      VALUES (${agentId}, 'forum', 'validate', 5.0),
             (${agentId}, 'forum', 'code', 0.1),
             (${agentId}, 'tag', 'pricing', 1.0)
    `;

    await migrate(schema);

    const rows = await sql<{ ref: string; weight: number }[]>`
      SELECT ref, weight FROM ${sql(schema)}.${sql("agent_affinities")} ORDER BY ref
    `;
    assert.deepEqual(
      rows.map((row) => [row.ref, row.weight]),
      [
        ["code", 0.7],
        ["pricing", 1.0],
        ["validate", 1.3],
      ],
      "D-032: weight is a 0.7–1.3 nudge, never a gate",
    );

    // And the new default is 1.0 — a row written with no weight does not gate.
    await sql`
      INSERT INTO ${sql(schema)}.${sql("agent_affinities")} (agent_id, scope, ref)
      VALUES (${agentId}, 'tag', 'retention')
    `;
    const fresh = await sql<{ weight: number }[]>`
      SELECT weight FROM ${sql(schema)}.${sql("agent_affinities")} WHERE ref = 'retention'
    `;
    assert.equal(fresh[0]?.weight, 1.0);
  });

  it("indexes votes by user_id — the profile aggregate's own access path", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const def = await indexDefinition(schema, "votes_user_idx");
    assert.ok(def, "votes_user_idx must exist");
    assert.match(def, /user_id/);
  });

  it("seeds reserved_handles with exactly the core list, including the six staff slugs", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const rows = await sql<{ handle: string; reason: string }[]>`
      SELECT handle, reason FROM ${sql(schema)}.${sql("reserved_handles")} ORDER BY handle
    `;
    assert.deepEqual(
      rows.map((row) => ({ handle: row.handle, reason: row.reason })),
      [...CORE_RESERVED_HANDLES].sort((a, b) => a.handle.localeCompare(b.handle)),
      "the migration's seed and CORE_RESERVED_HANDLES are one list, not two",
    );

    for (const slug of ["bricklayer", "ledger", "marguerite", "sprout", "grouse", "vellum"]) {
      assert.ok(
        rows.some((row) => row.handle === slug),
        `the staff slug ${slug} must be unclaimable`,
      );
    }
  });

  it("re-seeding reserved handles is additive and never duplicates — the founder list lands as data", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const again = await syncReservedHandles(sql, { schema });
    assert.deepEqual([...again], [], "the core list is already seeded; a resync inserts nothing");

    const founders = await syncReservedHandles(sql, {
      schema,
      entries: [{ handle: "somefounder", reason: "impersonation_risk" }],
    });
    assert.deepEqual([...founders], ["somefounder"], "a later founder list is a pure insert");

    const total = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.${sql("reserved_handles")}
    `;
    assert.equal(total[0]?.n, RESERVED_HANDLES.length + 1);
  });

  it("answers handle availability from three sources with one query — held, reserved, recently released", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    // 1. held by a live account
    await insertUser(schema, 3104, "taken");
    // 2. held by a closed account — the row survives, so the handle stays spent
    const closedId = await insertUser(schema, 3105, "closed");
    await sql`
      UPDATE ${sql(schema)}.${sql("users")}
      SET deleted_at = now(), handle_tombstoned = true
      WHERE id = ${closedId}
    `;
    // 3. released 10 days ago by a rename — reserved for the rest of the 90 days
    const renamerId = await insertUser(schema, 3106, "renamer");
    await sql`
      INSERT INTO ${sql(schema)}.${sql("handle_history")} (user_id, handle, released_at, reserved_until)
      VALUES (${renamerId}, 'cooling', now() - interval '10 days', now() + interval '80 days')
    `;
    // 4. released 100 days ago — the reservation has lapsed and the name is free again
    await sql`
      INSERT INTO ${sql(schema)}.${sql("handle_history")} (user_id, handle, released_at, reserved_until)
      VALUES (${renamerId}, 'lapsed', now() - interval '100 days', now() - interval '10 days')
    `;

    // The canonical availability predicate. One query, three sources, no overlap:
    // `users.handle` covers tombstoned accounts for free (the row is never
    // deleted), `reserved_handles` is the permanent denylist, `handle_history`
    // is the 90-day cooldown. See 0013's RULING header.
    const probe = ["free", "taken", "closed", "admin", "bricklayer", "cooling", "lapsed"];
    const rows = await sql<{ candidate: string; available: boolean }[]>`
      SELECT candidate,
             NOT EXISTS (SELECT 1 FROM ${sql(schema)}.${sql("users")} u WHERE u.handle = candidate)
         AND NOT EXISTS (SELECT 1 FROM ${sql(schema)}.${sql("reserved_handles")} r WHERE r.handle = candidate)
         AND NOT EXISTS (SELECT 1 FROM ${sql(schema)}.${sql("handle_history")} h
                          WHERE h.handle = candidate AND h.reserved_until > now())
             AS available
      FROM unnest(${probe}::text[]) AS candidate
      ORDER BY candidate
    `;

    assert.deepEqual(
      Object.fromEntries(rows.map((row) => [row.candidate, row.available])),
      {
        free: true,
        taken: false,
        closed: false,
        admin: false,
        bricklayer: false,
        cooling: false,
        lapsed: true,
      },
      "one handle system: held (live or tombstoned), permanently reserved, or cooling down",
    );
  });

  it("indexes handle_history by handle — the availability check's own access path", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const def = await indexDefinition(schema, "handle_history_handle_idx");
    assert.ok(def, "handle_history_handle_idx must exist");
    assert.match(def, /handle/);
  });

  it("seeds platform_settings with the bootstrap posture, ranges included", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const rows = await sql<
      {
        key: string;
        value: unknown;
        value_type: string;
        description: string;
        min_value: string | null;
        max_value: string | null;
        updated_by: string | null;
      }[]
    >`
      SELECT key, value, value_type, description, min_value, max_value, updated_by
      FROM ${sql(schema)}.${sql("platform_settings")} ORDER BY key
    `;

    assert.deepEqual(
      rows.map((row) => row.key),
      [...BOOTSTRAP_PLATFORM_SETTINGS].map((setting) => setting.key).sort(),
      "the migration's seed and BOOTSTRAP_PLATFORM_SETTINGS are one list, not two",
    );

    const byKey = new Map(rows.map((row) => [row.key, row]));
    for (const setting of BOOTSTRAP_PLATFORM_SETTINGS) {
      const row = byKey.get(setting.key);
      assert.ok(row, `${setting.key} must be seeded`);
      assert.deepEqual(row.value, setting.value, `${setting.key} value`);
      assert.equal(row.value_type, setting.valueType, `${setting.key} value_type`);
      assert.equal(row.description, setting.description, `${setting.key} description`);
      assert.equal(
        row.min_value === null ? null : Number(row.min_value),
        setting.minValue,
        `${setting.key} min_value`,
      );
      assert.equal(
        row.max_value === null ? null : Number(row.max_value),
        setting.maxValue,
        `${setting.key} max_value`,
      );
      assert.equal(row.updated_by, null, "a seeded value has no admin author");
    }

    // The three that decide the launch posture, asserted by value.
    assert.equal(byKey.get("routing.coverage_target")?.value, 6, "D-033: coverage target 6 at launch");
    assert.equal(byKey.get("routing.exploration_rate")?.value, 0.25, "D-032: a quarter of picks ignore affinity");
    assert.equal(byKey.get("signup.tier_gate_enabled")?.value, false, "D-036: the gate is off at launch");
  });

  it("re-seeding platform_settings never clobbers an admin-changed value", async () => {
    const schema = useScratchSchema();
    await migrate(schema);
    const adminId = await insertUser(schema, 3107, "operator");

    await sql`
      UPDATE ${sql(schema)}.${sql("platform_settings")}
      SET value = ${sql.json(2)}, updated_by = ${adminId}, updated_at = now()
      WHERE key = 'routing.coverage_target'
    `;

    const inserted = await syncPlatformSettings(sql, { schema });
    assert.deepEqual([...inserted], [], "every bootstrap key is already present");

    const rows = await sql<{ value: unknown; updated_by: string | null }[]>`
      SELECT value, updated_by FROM ${sql(schema)}.${sql("platform_settings")}
      WHERE key = 'routing.coverage_target'
    `;
    assert.equal(rows[0]?.value, 2, "the admin's lowered target survives a reseed");
    assert.equal(rows[0]?.updated_by, adminId, "and so does its authorship");
  });
});
