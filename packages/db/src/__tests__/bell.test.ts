/**
 * Worker test for M0-BE-10: migration 0009 (commitments, bell_state,
 * bell_messages, distress_flags — Bell's island).
 *
 * Same conventions as `identity.test.ts`, `calls.test.ts` and `votes.test.ts`:
 * every test applies the *real* `migrations/` directory into a throwaway
 * schema (dropped in `after()`), so the suite never touches the dev database
 * and is safely rerunnable.
 *
 * The case that matters most is the acceptance test itself — schema
 * isolation (CAP §12, "private by default"): no Bell table may reference any
 * content table. It is written generically over the four table names, over
 * `pg_constraint`, so a future FK addition to any of these tables fails this
 * suite loudly instead of silently breaching the island.
 *
 * This branch's migrations 0007 and 0008 (M0-BE-08, M0-BE-09) are in flight
 * on sibling worktrees and are not present here, so the applied set has a
 * gap at 0007-0008 — deliberate per D-011 and this ticket's brief. This suite
 * only asserts that 0009 lands; the overall shipped-migrations contiguity
 * check belongs to `migrate.test.ts` and is expected to fail on this branch
 * alone.
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

const MIGRATION_ID = "0009_bell";
const silent = (): void => {};

// The four tables this migration owns — Bell's island, kept as one list so
// the isolation test below is provably over all of them, not a hand-picked
// subset.
const BELL_TABLES = ["commitments", "bell_state", "bell_messages", "distress_flags"] as const;

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
  const schema = `m0be10_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
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

describe("migration 0009 — commitments, bell_state, bell_messages, distress_flags", () => {
  it("applies the real migrations directory, and a second run is a no-op", async () => {
    const schema = useScratchSchema();

    const first = await migrate(schema);
    assert.ok(
      first.applied.includes(MIGRATION_ID),
      `expected ${MIGRATION_ID} among applied migrations: ${first.applied.join(", ")}`,
    );

    const second = await migrate(schema);
    assert.deepEqual([...second.applied], [], "second run applies nothing");
    assert.ok(second.skipped.includes(MIGRATION_ID), "second run recognises 0009 as already applied");
    // Deliberately not asserting overall contiguity here — this branch has a
    // gap at 0007-0008 (M0-BE-08, M0-BE-09, in flight on sibling worktrees per
    // D-011), and that overall check is migrate.test.ts's job, not this
    // file's.
  });

  it(
    "THE ACCEPTANCE TEST: schema isolation — no Bell table references any content table",
    async () => {
      const schema = useScratchSchema();
      await migrate(schema);

      // Walk pg_constraint for every FK whose source (conrelid) is one of the
      // four Bell tables, and resolve what it references (confrelid). The
      // island invariant: that referenced-table set must be a subset of
      // {users}. Written generically over BELL_TABLES so a future FK added to
      // any of these four tables — to a content table or otherwise — is
      // caught here without editing this test.
      const rows = await sql<{ source_table: string; referenced_table: string }[]>`
        SELECT
          src.relname AS source_table,
          ref.relname AS referenced_table
        FROM pg_constraint con
        JOIN pg_class src ON src.oid = con.conrelid
        JOIN pg_class ref ON ref.oid = con.confrelid
        JOIN pg_namespace ns ON ns.oid = src.relnamespace
        WHERE con.contype = 'f'
          AND ns.nspname = ${schema}
          AND src.relname IN ${sql([...BELL_TABLES])}
      `;

      assert.ok(rows.length > 0, "expected at least one FK from the Bell tables (each has a user_id FK)");

      const referencedTables = new Set(rows.map((row) => row.referenced_table));
      assert.deepEqual(
        [...referencedTables],
        ["users"],
        `every FK from a Bell table must reference only users; found references to: ${[...referencedTables].join(", ")}`,
      );

      // And confirm each of the four tables is actually represented — the
      // island invariant is proved over the whole set, not merely one table.
      const sourceTables = new Set(rows.map((row) => row.source_table));
      for (const table of BELL_TABLES) {
        assert.ok(sourceTables.has(table), `expected a FK originating from ${table}`);
      }
    },
  );

  it("bell_state: PK user_id rejects a second row for the same user; mutates in place", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const userId = await insertUser(schema, 1, "bellsubject1");

    await sql`
      INSERT INTO ${sql(schema)}.${sql("bell_state")}
        (user_id, send_at_local, timezone)
      VALUES (${userId}, '08:00:00', 'America/New_York')
    `;

    await assert.rejects(
      () => sql`
        INSERT INTO ${sql(schema)}.${sql("bell_state")}
          (user_id, send_at_local, timezone)
        VALUES (${userId}, '09:00:00', 'America/Chicago')
      `,
      /duplicate key|unique/i,
      "a second bell_state row for the same user must be rejected by the PK",
    );

    await sql`
      UPDATE ${sql(schema)}.${sql("bell_state")}
      SET consecutive_silent_days = 3, tone_level = 1, paused_until = '2026-08-01'
      WHERE user_id = ${userId}
    `;

    const rows = await sql<{ consecutive_silent_days: number; tone_level: number; paused_until: Date }[]>`
      SELECT consecutive_silent_days, tone_level, paused_until
      FROM ${sql(schema)}.${sql("bell_state")}
      WHERE user_id = ${userId}
    `;
    assert.equal(rows.length, 1, "exactly one bell_state row for the user");
    assert.equal(rows[0]?.consecutive_silent_days, 3, "consecutive_silent_days mutated in place");
    assert.equal(rows[0]?.tone_level, 1, "tone_level mutated in place (Bell's circuit-breaker substrate)");
    assert.equal(
      rows[0]?.paused_until.toISOString().slice(0, 10),
      "2026-08-01",
      "paused_until mutated in place",
    );
  });

  it("commitments: state transitions via UPDATE, the row survives", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const userId = await insertUser(schema, 2, "bellsubject2");

    const rows = await sql<{ id: string }[]>`
      INSERT INTO ${sql(schema)}.${sql("commitments")}
        (user_id, text, due_on, source)
      VALUES (${userId}, 'Call the customer who went quiet.', '2026-07-27', 'user')
      RETURNING id
    `;
    const id = rows[0]?.id;
    assert.ok(id, "commitment insert must return an id");

    const inserted = await sql<{ state: string }[]>`
      SELECT state FROM ${sql(schema)}.${sql("commitments")} WHERE id = ${id}
    `;
    assert.equal(inserted[0]?.state, "open", "state defaults to 'open'");

    await sql`UPDATE ${sql(schema)}.${sql("commitments")} SET state = 'done' WHERE id = ${id}`;

    const after_ = await sql<{ id: string; state: string }[]>`
      SELECT id, state FROM ${sql(schema)}.${sql("commitments")} WHERE id = ${id}
    `;
    assert.equal(after_.length, 1, "the commitment row survives the transition");
    assert.equal(after_[0]?.state, "done", "state advanced to 'done' — no CHECK stands in the way");
  });

  it("distress_flags: inserts with action_taken, reviewed_by is set by UPDATE", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const subjectId = await insertUser(schema, 3, "bellsubject3");
    const reviewerId = await insertUser(schema, 4, "bellreviewer1");

    const rows = await sql<{ id: string }[]>`
      INSERT INTO ${sql(schema)}.${sql("distress_flags")}
        (user_id, signal, action_taken)
      VALUES (${subjectId}, 'message suggested real distress', 'paused')
      RETURNING id
    `;
    const id = rows[0]?.id;
    assert.ok(id, "distress_flags insert must return an id");

    const beforeReview = await sql<{ reviewed_by: string | null }[]>`
      SELECT reviewed_by FROM ${sql(schema)}.${sql("distress_flags")} WHERE id = ${id}
    `;
    assert.equal(beforeReview[0]?.reviewed_by, null, "reviewed_by starts unset");

    await sql`
      UPDATE ${sql(schema)}.${sql("distress_flags")}
      SET reviewed_by = ${reviewerId}
      WHERE id = ${id}
    `;

    const afterReview = await sql<{ reviewed_by: string }[]>`
      SELECT reviewed_by FROM ${sql(schema)}.${sql("distress_flags")} WHERE id = ${id}
    `;
    assert.equal(afterReview[0]?.reviewed_by, reviewerId, "reviewed_by set in place by UPDATE");

    await assert.rejects(
      () => sql`
        INSERT INTO ${sql(schema)}.${sql("distress_flags")}
          (user_id, signal, action_taken, reviewed_by)
        VALUES (${subjectId}, 'another signal', 'escalated', ${randomUUID()})
      `,
      /foreign key/i,
      "reviewed_by must reference a real user",
    );
  });

  it("bell_messages: inserts, replied_at is set by UPDATE, sent_at and created_at can differ", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const userId = await insertUser(schema, 5, "bellsubject4");

    // A message the scheduler wrote now but will actually send an hour from
    // now — created_at and sent_at legitimately differ (see migration
    // comment).
    const futureSentAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const rows = await sql<{ id: string }[]>`
      INSERT INTO ${sql(schema)}.${sql("bell_messages")}
        (user_id, body, kind, sent_at)
      VALUES (${userId}, 'You said Tuesday, it is Thursday.', 'nudge', ${futureSentAt}::timestamptz)
      RETURNING id
    `;
    const id = rows[0]?.id;
    assert.ok(id, "bell_messages insert must return an id");

    const inserted = await sql<{ replied_at: string | null }[]>`
      SELECT replied_at FROM ${sql(schema)}.${sql("bell_messages")} WHERE id = ${id}
    `;
    assert.equal(inserted[0]?.replied_at, null, "replied_at starts unset");

    await sql`
      UPDATE ${sql(schema)}.${sql("bell_messages")}
      SET replied_at = now()
      WHERE id = ${id}
    `;

    const after_ = await sql<{ replied_at: string | null }[]>`
      SELECT replied_at FROM ${sql(schema)}.${sql("bell_messages")} WHERE id = ${id}
    `;
    assert.ok(after_[0]?.replied_at, "replied_at set in place by UPDATE");
  });
});
