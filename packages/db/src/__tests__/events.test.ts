/**
 * Worker test for M0-BE-12: migration 0011 (events, partitioned;
 * event_idempotency; feed_entries).
 *
 * Same conventions as `identity.test.ts`, `posts.test.ts`, `threads.test.ts`
 * and `calls.test.ts`: every test applies the *real* `migrations/` directory
 * into a throwaway schema (dropped in `after()`), so the suite never touches
 * the dev database and is safely rerunnable.
 *
 * What is worth testing here is not the shape of two tables — it is the four
 * things that break silently:
 *
 *   - **Routing.** A row lands in the partition its `occurred_at` belongs to,
 *     and a row outside every partition is REJECTED rather than pooled in a
 *     default partition (the migration's Judgment 3).
 *   - **Global idempotency.** The same `idempotency_key` reused with a
 *     different `occurred_at` in a DIFFERENT MONTH is rejected. This is the
 *     test that proves SD §3's invariant survived partitioning — the naive
 *     `UNIQUE (occurred_at, idempotency_key)` shape passes every other test in
 *     this file and fails this one. A NULL key, twice, must still be fine.
 *   - **Pruning.** A single-month `occurred_at` range scans exactly one
 *     partition, and the plan does not so much as mention the others.
 *   - **The partial indexes.** `WHERE visibility='public'` is what every feed
 *     read filters on, proved *usable* by an EXPLAIN with `enable_seqscan`
 *     disabled, not merely present.
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

const MIGRATION_ID = "0011_events_feed_entries";
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
  const schema = `m0be12_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  schemasToDrop.push(schema);
  return schema;
}

async function migrate(schema: string): Promise<Awaited<ReturnType<typeof runSqlMigrations>>> {
  return runSqlMigrations({ dir: MIGRATIONS_DIR, schema, log: silent });
}

interface EventInput {
  readonly occurredAt: string;
  readonly actorType?: string;
  readonly actorId?: string | null;
  readonly eventType?: string;
  readonly subjectType?: string;
  readonly subjectId?: string;
  readonly forumId?: string | null;
  readonly payload?: Readonly<Record<string, string | number | boolean>>;
  readonly idempotencyKey?: string | null;
}

/** Insert one event, returning its id and the partition the row actually landed in. */
async function insertEvent(
  schema: string,
  input: EventInput,
): Promise<{ id: string; partition: string }> {
  const rows = await sql<{ id: string; partition: string }[]>`
    INSERT INTO ${sql(schema)}.${sql("events")}
      (occurred_at, actor_type, actor_id, event_type, subject_type, subject_id, forum_id, payload, idempotency_key)
    VALUES (
      ${input.occurredAt}::timestamptz,
      ${input.actorType ?? "agent"},
      ${input.actorId ?? null},
      ${input.eventType ?? "contribution.created"},
      ${input.subjectType ?? "contribution"},
      ${input.subjectId ?? randomUUID()},
      ${input.forumId ?? null},
      ${JSON.stringify(input.payload ?? {})}::jsonb,
      ${input.idempotencyKey ?? null}
    )
    RETURNING id::text AS id, tableoid::regclass::text AS partition
  `;
  const row = rows[0];
  assert.ok(row, "insertEvent must return a row");
  return row;
}

async function insertFeedEntry(
  schema: string,
  entityType: string,
  entityId: string,
  overrides: { surface?: string; visibility?: string; rankScore?: number; activityAt?: string } = {},
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO ${sql(schema)}.${sql("feed_entries")}
      (entity_type, entity_id, surface, visibility, activity_at, rank_score)
    VALUES (
      ${entityType}, ${entityId},
      ${overrides.surface ?? "validate"},
      ${overrides.visibility ?? "public"},
      ${overrides.activityAt ?? new Date().toISOString()}::timestamptz,
      ${overrides.rankScore ?? 0}
    )
    RETURNING id
  `;
  const id = rows[0]?.id;
  assert.ok(id, "insertFeedEntry must return an id");
  return id;
}

/** EXPLAIN with seqscan penalised, so a tiny table still proves an index is usable. */
async function explainWithoutSeqscan(query: string): Promise<string> {
  return sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL enable_seqscan = off");
    const rows = await tx.unsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN ${query}`);
    return rows.map((row) => row["QUERY PLAN"]).join("\n");
  });
}

describe("migration 0011 — events (partitioned), event_idempotency, feed_entries", () => {
  it("applies the real migrations directory, and a second run is a no-op", async () => {
    const schema = useScratchSchema();

    const first = await migrate(schema);
    assert.ok(
      first.applied.includes(MIGRATION_ID),
      `expected ${MIGRATION_ID} among applied migrations: ${first.applied.join(", ")}`,
    );

    const second = await migrate(schema);
    assert.deepEqual([...second.applied], [], "second run applies nothing");
    assert.ok(
      second.skipped.includes(MIGRATION_ID),
      "second run recognises 0011 as already applied",
    );
  });

  it("routes each row to the partition its occurred_at belongs to", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const july = await insertEvent(schema, { occurredAt: "2026-07-15T10:00:00Z" });
    const august = await insertEvent(schema, { occurredAt: "2026-08-01T00:00:00Z" });
    const september = await insertEvent(schema, { occurredAt: "2026-09-30T23:59:59Z" });

    assert.equal(july.partition, `${schema}.events_2026_07`);
    assert.equal(august.partition, `${schema}.events_2026_08`, "a lower bound belongs to its own month — ranges are [FROM, TO)");
    assert.equal(september.partition, `${schema}.events_2026_09`);

    // The parent is queried as one table; partitioning is invisible to readers.
    const [count] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.${sql("events")}
    `;
    assert.equal(count?.n, 3, "all three rows are visible through the parent");
  });

  it("rejects a row no partition covers, rather than pooling it (no DEFAULT partition)", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    await assert.rejects(
      () => insertEvent(schema, { occurredAt: "2027-03-01T00:00:00Z" }),
      /no partition of relation/i,
      "a month with no partition must fail loudly — a silent default partition would hide a stalled scheduler",
    );
  });

  it("enforces idempotency_key GLOBALLY — across partitions, across months", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const key = "agentturn:c0ffee:chapter-1:round-2";
    const first = await insertEvent(schema, {
      occurredAt: "2026-07-20T09:00:00Z",
      idempotencyKey: key,
    });
    assert.equal(first.partition, `${schema}.events_2026_07`);

    // THE case the invariant exists for (SD §3): a retry arriving later, with a
    // different occurred_at, in a different MONTH and therefore a different
    // partition. `UNIQUE (occurred_at, idempotency_key)` would let this through.
    await assert.rejects(
      () => insertEvent(schema, { occurredAt: "2026-09-02T11:30:00Z", idempotencyKey: key }),
      /duplicate key|unique/i,
      "the same idempotency_key in a different month must be rejected",
    );

    // ...and same-month reuse is caught too, of course.
    await assert.rejects(
      () => insertEvent(schema, { occurredAt: "2026-07-20T09:00:01Z", idempotencyKey: key }),
      /duplicate key|unique/i,
      "the same idempotency_key at a different instant in the same month must be rejected",
    );

    const [count] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.${sql("events")}
      WHERE idempotency_key = ${key}
    `;
    assert.equal(count?.n, 1, "exactly one event survives per key");

    // The dedupe row points back at the event that claimed the key.
    const [claim] = await sql<{ event_id: string }[]>`
      SELECT event_id::text AS event_id FROM ${sql(schema)}.${sql("event_idempotency")}
      WHERE idempotency_key = ${key}
    `;
    assert.equal(claim?.event_id, first.id, "the claim records the event that won");
  });

  it("leaves the enclosing transaction usable when a duplicate is rolled back to a savepoint", async () => {
    // This is the pattern packages/events (M0-BE-13) uses to turn a duplicate
    // into a clean no-op without losing the contribution row and the queued job
    // written in the same transaction.
    const schema = useScratchSchema();
    await migrate(schema);
    const key = "turn:savepoint";
    await insertEvent(schema, { occurredAt: "2026-08-10T00:00:00Z", idempotencyKey: key });

    const survived = await sql.begin(async (tx) => {
      let deduped = false;
      try {
        await tx.savepoint(async (sp) => {
          await sp.unsafe(
            `INSERT INTO "${schema}".events
               (occurred_at, actor_type, event_type, subject_type, subject_id, idempotency_key)
             VALUES ('2026-09-10T00:00:00Z', 'agent', 'contribution.created', 'contribution',
                     gen_random_uuid(), '${key}')`,
          );
        });
      } catch {
        deduped = true;
      }
      const rows = await tx.unsafe<{ ok: string }[]>(`SELECT 'still usable' AS ok`);
      return { deduped, ok: rows[0]?.ok };
    });

    assert.equal(survived.deduped, true, "the duplicate insert failed");
    assert.equal(survived.ok, "still usable", "the enclosing transaction survived the rollback");

    const [count] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.${sql("events")} WHERE idempotency_key = ${key}
    `;
    assert.equal(count?.n, 1, "still exactly one event for the key");
  });

  it("allows any number of events with a NULL idempotency_key", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    await insertEvent(schema, { occurredAt: "2026-07-01T00:00:00Z", idempotencyKey: null });
    await insertEvent(schema, { occurredAt: "2026-07-01T00:00:00Z", idempotencyKey: null });
    await insertEvent(schema, { occurredAt: "2026-08-05T00:00:00Z", idempotencyKey: null });

    const [events] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.${sql("events")} WHERE idempotency_key IS NULL
    `;
    assert.equal(events?.n, 3, "not every event carries a key — SD makes the column nullable");

    const [claims] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.${sql("event_idempotency")}
    `;
    assert.equal(claims?.n, 0, "unkeyed events never touch the dedupe table (the trigger's WHEN clause)");
  });

  it("events_ensure_partition creates the month ahead, and a second call is a no-op", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const ensure = async (day: string): Promise<string> => {
      const rows = await sql.unsafe<{ events_ensure_partition: string }[]>(
        `SELECT "${schema}".events_ensure_partition('${day}'::date)`,
      );
      const name = rows[0]?.events_ensure_partition;
      assert.ok(name, "events_ensure_partition must return the partition name");
      return name;
    };

    const partitionsNamed = async (name: string): Promise<number> => {
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ${schema} AND c.relname = ${name} AND c.relkind = 'r'
      `;
      return row?.n ?? 0;
    };

    assert.equal(await partitionsNamed("events_2026_10"), 0, "October does not exist yet");
    assert.equal(await ensure("2026-10-01"), "events_2026_10");
    assert.equal(await partitionsNamed("events_2026_10"), 1);

    // Idempotent: called again, and called with a mid-month date that truncates
    // to the same month, it creates nothing and does not raise.
    assert.equal(await ensure("2026-10-01"), "events_2026_10");
    assert.equal(await ensure("2026-10-17"), "events_2026_10");
    assert.equal(await partitionsNamed("events_2026_10"), 1, "still exactly one October partition");

    // The new partition is a real, usable partition of the parent...
    const october = await insertEvent(schema, { occurredAt: "2026-10-09T12:00:00Z" });
    assert.equal(october.partition, `${schema}.events_2026_10`);

    // ...and inherited all three SD §4 indexes plus the primary key, because
    // they were declared on the partitioned parent.
    const [indexes] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_indexes
      WHERE schemaname = ${schema} AND tablename = 'events_2026_10'
    `;
    assert.equal(indexes?.n, 4, "the new partition inherits PK + the three SD §4 indexes");
  });

  it("prunes to a single partition on an occurred_at range query", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    for (const occurredAt of [
      "2026-07-10T00:00:00Z",
      "2026-08-10T00:00:00Z",
      "2026-08-20T00:00:00Z",
      "2026-09-10T00:00:00Z",
    ]) {
      await insertEvent(schema, { occurredAt });
    }

    const plan = await explainWithoutSeqscan(
      `SELECT id FROM "${schema}".events
       WHERE occurred_at >= '2026-08-01T00:00:00Z' AND occurred_at < '2026-09-01T00:00:00Z'`,
    );

    assert.match(plan, /events_2026_08/, `expected the August partition in the plan:\n${plan}`);
    for (const excluded of ["events_2026_07", "events_2026_09"]) {
      assert.ok(
        !plan.includes(excluded),
        `expected ${excluded} to be pruned out of the plan entirely:\n${plan}`,
      );
    }

    const rows = await sql<{ id: string }[]>`
      SELECT id::text AS id FROM ${sql(schema)}.${sql("events")}
      WHERE occurred_at >= '2026-08-01T00:00:00Z'::timestamptz
        AND occurred_at <  '2026-09-01T00:00:00Z'::timestamptz
    `;
    assert.equal(rows.length, 2, "and the pruned scan still returns both August rows");
  });

  it("enforces feed_entries UNIQUE (entity_type, entity_id) — one row per entity", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const threadId = randomUUID();
    await insertFeedEntry(schema, "thread", threadId);

    await assert.rejects(
      () => insertFeedEntry(schema, "thread", threadId, { surface: "build" }),
      /duplicate key|unique/i,
      "a second feed entry for the same entity must be rejected — the projection holds one row per entity",
    );

    // The seam: the same uuid under a different entity_type is a different
    // entity, and is allowed.
    await insertFeedEntry(schema, "diary", threadId);
    const [count] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.${sql("feed_entries")} WHERE entity_id = ${threadId}
    `;
    assert.equal(count?.n, 2, "(entity_type, entity_id) is the key, not entity_id alone");
  });

  it("serves the ranked-insert and forum-feed reads from the partial visibility='public' indexes", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    // Enough rows, and statistics, for the planner to prefer an index scan over
    // a sort of the whole table.
    await sql.unsafe(`
      INSERT INTO "${schema}".feed_entries
        (entity_type, entity_id, surface, visibility, activity_at, rank_score)
      SELECT 'thread', gen_random_uuid(), 'validate',
             CASE WHEN g % 5 = 0 THEN 'private' ELSE 'public' END,
             now() - (g || ' minutes')::interval, g::real
      FROM generate_series(1, 400) g
    `);
    await sql.unsafe(`ANALYZE "${schema}".feed_entries`);

    const rankedPlan = await explainWithoutSeqscan(
      `SELECT id FROM "${schema}".feed_entries
       WHERE visibility = 'public' ORDER BY rank_score DESC LIMIT 3`,
    );
    assert.match(
      rankedPlan,
      /feed_entries_rank_score_public_idx/,
      `expected the ranked-insert query to use the partial rank_score index:\n${rankedPlan}`,
    );
    assert.ok(
      !/\bSort\b/.test(rankedPlan),
      `the partial index should supply the ordering, not a sort:\n${rankedPlan}`,
    );

    const surfacePlan = await explainWithoutSeqscan(
      `SELECT id FROM "${schema}".feed_entries
       WHERE visibility = 'public' AND surface = 'validate' ORDER BY activity_at DESC LIMIT 3`,
    );
    assert.match(
      surfacePlan,
      /feed_entries_surface_activity_at_public_idx/,
      `expected the surface feed query to use its partial index:\n${surfacePlan}`,
    );

    // And the partial index is genuinely partial: private rows are not in it,
    // so the ranked read can never return one.
    const top = await sql<{ visibility: string }[]>`
      SELECT visibility FROM ${sql(schema)}.${sql("feed_entries")}
      WHERE visibility = 'public' ORDER BY rank_score DESC LIMIT 10
    `;
    assert.ok(
      top.every((row) => row.visibility === "public"),
      "the ranked-insert set is public-only",
    );
  });

  it("keeps the two SD §5 foreign keys and nothing else", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    await assert.rejects(
      () => sql`
        INSERT INTO ${sql(schema)}.${sql("feed_entries")}
          (entity_type, entity_id, surface, visibility, activity_at, author_agent_id)
        VALUES ('thread', ${randomUUID()}, 'validate', 'public', now(), ${randomUUID()})
      `,
      /foreign key/i,
      "author_agent_id must reference a real agent",
    );

    await assert.rejects(
      () => sql`
        INSERT INTO ${sql(schema)}.${sql("feed_entries")}
          (entity_type, entity_id, surface, visibility, activity_at, author_user_id)
        VALUES ('thread', ${randomUUID()}, 'validate', 'public', now(), ${randomUUID()})
      `,
      /foreign key/i,
      "author_user_id must reference a real user",
    );

    // forum_id is deliberately unreferenced (SD §5 writes no REFERENCES on it),
    // and the event log has no foreign keys at all — a log outlives its
    // subjects.
    await insertFeedEntry(schema, "thread", randomUUID());
    await sql`
      UPDATE ${sql(schema)}.${sql("feed_entries")} SET forum_id = ${randomUUID()}
    `;
    await insertEvent(schema, {
      occurredAt: "2026-07-05T00:00:00Z",
      actorId: randomUUID(),
      forumId: randomUUID(),
    });

    const [fks] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = ${schema} AND c.contype = 'f' AND t.relname IN ('events', 'event_idempotency')
    `;
    assert.equal(fks?.n, 0, "events and event_idempotency carry no foreign keys — partitions must stay detachable");
  });

  it("has no entitlement column on feed_entries — premium never buys reach (rule 9)", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const columns = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${schema} AND table_name = 'feed_entries'
    `;
    const names = columns.map((row) => row.column_name);
    for (const forbidden of ["entitlement", "entitlement_id", "tier", "plan", "boost", "premium"]) {
      assert.ok(
        !names.includes(forbidden),
        `feed_entries must not carry a ${forbidden} column: rank_score may never read entitlements`,
      );
    }
    assert.ok(names.includes("rank_score"), "sanity: rank_score is present");
  });
});
