/**
 * Worker test for M0-BE-13, part 2: `writeEvent`.
 *
 * Same conventions as the `@eutectic/db` suite (`packages/db/src/__tests__`):
 * every test applies the REAL `migrations/` directory into a throwaway schema,
 * dropped in `after()`, so the suite never touches the dev database and is
 * safely rerunnable.
 *
 * What is worth testing here is not "does an INSERT insert". It is the four
 * things the reliability spine depends on and that fail silently:
 *
 *   - **The write is the caller's.** `writeEvent` joins a transaction it did
 *     not open and does not commit. Roll the caller's transaction back and the
 *     event must be gone with everything else (SD §3).
 *   - **A duplicate key is a no-op, not an error.** The acceptance criterion.
 *     Both paths that produce one are exercised: the fast-path probe (the key
 *     was committed earlier) and the savepoint path (a concurrent writer
 *     claimed the key while we were mid-insert).
 *   - **The enclosing transaction survives that no-op.** This is the whole
 *     reason migration 0011 specifies a SAVEPOINT instead of a bare catch: the
 *     contribution row and the queued job written in the same transaction must
 *     still commit. Every dedupe test writes more work afterwards and asserts
 *     it landed.
 *   - **Nothing else is swallowed.** A 23505 on some other constraint, or any
 *     other database error, propagates.
 *
 *   pnpm --filter @eutectic/events test
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, describe, it } from "node:test";

import { MIGRATIONS_DIR, createPool, requireDatabaseUrl, runSqlMigrations } from "@eutectic/db";
import type { Sql, TransactionSql } from "postgres";

import type { EventInput } from "../event.js";
import { writeEvent, type WriteEventResult } from "../write-event.js";

const silent = (): void => {};

let sql: Sql;
const schemasToDrop: string[] = [];

before(() => {
  // Fail with the actionable message rather than a connection timeout.
  requireDatabaseUrl();
  sql = createPool({ max: 6 });
});

after(async () => {
  for (const schema of schemasToDrop) {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
  await sql.end();
});

/** A migrated throwaway schema. Dropped in `after()`. */
async function scratchSchema(): Promise<string> {
  const schema = `m0be13_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  schemasToDrop.push(schema);
  await runSqlMigrations({ dir: MIGRATIONS_DIR, schema, log: silent });
  // Migration 0011 ships partitions for 2026-07 … 2026-09 and has no DEFAULT
  // partition, on purpose. Tests that let `occurred_at` default to `now()` would
  // therefore start failing the moment the wall clock leaves that window, which
  // is a calendar bomb, not a regression. Ensuring the current month (and the
  // next, for a test that runs across midnight on the 1st) is exactly what the
  // monthly scheduler job will do in production.
  await sql.unsafe(`SELECT "${schema}".events_ensure_partition(current_date)`);
  await sql.unsafe(
    `SELECT "${schema}".events_ensure_partition((current_date + interval '1 month')::date)`,
  );
  return schema;
}

/**
 * Run `fn` inside one transaction pinned to `schema`.
 *
 * `writeEvent` writes unqualified table names, resolved through `search_path` —
 * `public` in the app, a scratch schema here. `SET LOCAL` scopes that to the
 * transaction, so the pooled connection goes back clean.
 */
async function inTransaction<T>(
  schema: string,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL search_path TO "${schema}", pg_catalog`);
    return { value: await fn(tx) };
  });
  return (result as { value: T }).value;
}

function contributionCreated(overrides: Partial<EventInput> = {}): EventInput {
  return {
    event_type: "contribution.created",
    actor: { type: "agent", id: randomUUID() },
    subject: { type: "contribution", id: randomUUID() },
    ...overrides,
  } as EventInput;
}

interface EventRow {
  id: string;
  event_type: string;
  actor_type: string;
  actor_id: string | null;
  subject_type: string;
  subject_id: string;
  forum_id: string | null;
  payload: Record<string, unknown>;
  idempotency_key: string | null;
  occurred_at: Date;
  partition: string;
}

/**
 * Every event row in a schema, oldest first.
 *
 * Tagged template rather than `sql.unsafe`: postgres.js runs a parameterless
 * `unsafe` through the SIMPLE query protocol, which hands every column back as
 * text — `payload` would arrive as a JSON string and the jsonb assertions would
 * be comparing the wrong thing.
 */
async function readEvents(schema: string): Promise<EventRow[]> {
  return sql<EventRow[]>`
    SELECT id::text AS id, event_type, actor_type, actor_id::text AS actor_id,
           subject_type, subject_id::text AS subject_id, forum_id::text AS forum_id,
           payload, idempotency_key, occurred_at,
           tableoid::regclass::text AS partition
    FROM ${sql(schema)}.${sql("events")}
    ORDER BY id
  `;
}

async function countEvents(schema: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ${sql(schema)}.${sql("events")}
  `;
  return rows[0]?.n ?? 0;
}

async function countClaims(schema: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ${sql(schema)}.${sql("event_idempotency")}
  `;
  return rows[0]?.n ?? 0;
}

function assertWritten(result: WriteEventResult): asserts result is Extract<
  WriteEventResult,
  { written: true }
> {
  assert.equal(result.written, true, `expected a write, got ${JSON.stringify(result)}`);
}

function assertDeduplicated(result: WriteEventResult): asserts result is Extract<
  WriteEventResult,
  { written: false }
> {
  assert.equal(result.written, false, `expected a no-op, got ${JSON.stringify(result)}`);
}

describe("writeEvent — writing", () => {
  it("writes the row inside the caller's transaction, and it is there after commit", async () => {
    const schema = await scratchSchema();
    const actorId = randomUUID();
    const subjectId = randomUUID();
    const forumId = randomUUID();

    const result = await inTransaction(schema, (tx) =>
      writeEvent(tx, {
        event_type: "finding.state_changed",
        actor: { type: "agent", id: actorId },
        subject: { type: "finding", id: subjectId },
        forum_id: forumId,
        occurred_at: new Date("2026-08-14T09:30:00Z"),
        payload: { from_state: "open", to_state: "confirmed" },
      }),
    );

    assertWritten(result);
    assert.match(result.id, /^\d+$/, "id comes back as a decimal string (bigserial)");
    assert.equal(result.occurred_at.toISOString(), "2026-08-14T09:30:00.000Z");

    const rows = await readEvents(schema);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.ok(row);
    assert.equal(row.id, result.id, "the returned id is the row's id");
    assert.equal(row.event_type, "finding.state_changed");
    assert.equal(row.actor_type, "agent");
    assert.equal(row.actor_id, actorId);
    assert.equal(row.subject_type, "finding");
    assert.equal(row.subject_id, subjectId);
    assert.equal(row.forum_id, forumId);
    assert.deepEqual(row.payload, { from_state: "open", to_state: "confirmed" });
    assert.equal(row.idempotency_key, null, "no key supplied, no key stored");
    assert.equal(
      row.partition,
      `${schema}.events_2026_08`,
      "a supplied occurred_at routes the row to its own month",
    );
  });

  it("omits occurred_at so the column default applies, rather than minting a clock in Node", async () => {
    const schema = await scratchSchema();
    const before = new Date();

    const result = await inTransaction(schema, (tx) => writeEvent(tx, contributionCreated()));

    assertWritten(result);
    const after = new Date();
    assert.ok(
      result.occurred_at >= new Date(before.getTime() - 1000) && result.occurred_at <= after,
      `occurred_at ${result.occurred_at.toISOString()} should be the database's now()`,
    );

    const rows = await readEvents(schema);
    assert.equal(rows[0]?.occurred_at.getTime(), result.occurred_at.getTime());
  });

  it("stores an empty payload and a null actor_id for a system actor", async () => {
    const schema = await scratchSchema();

    await inTransaction(schema, (tx) =>
      writeEvent(tx, {
        event_type: "thread.chapter_closed",
        actor: { type: "system" },
        subject: { type: "thread", id: randomUUID() },
      }),
    );

    const row = (await readEvents(schema))[0];
    assert.ok(row);
    assert.equal(row.actor_type, "system");
    assert.equal(row.actor_id, null, "events.actor_id is nullable — the scheduler is nobody");
    assert.deepEqual(row.payload, {}, "the default payload is an empty object, never null");
  });

  it("writes several events in one transaction, in order", async () => {
    const schema = await scratchSchema();
    const threadId = randomUUID();

    // SD §8's posting flow: posts, post_tags, threads, chapters and THREE
    // events, all in one transaction.
    await inTransaction(schema, async (tx) => {
      const postId = randomUUID();
      await writeEvent(tx, {
        event_type: "post.created",
        actor: { type: "user", id: randomUUID() },
        subject: { type: "post", id: postId },
      });
      await writeEvent(tx, {
        event_type: "post.tagged",
        actor: { type: "user", id: randomUUID() },
        subject: { type: "post", id: postId },
      });
      await writeEvent(tx, {
        event_type: "thread.chapter_opened",
        actor: { type: "system" },
        subject: { type: "thread", id: threadId },
      });
    });

    const rows = await readEvents(schema);
    assert.deepEqual(
      rows.map((row) => row.event_type),
      ["post.created", "post.tagged", "thread.chapter_opened"],
    );
  });
});

describe("writeEvent — idempotency", () => {
  it("THE ACCEPTANCE: the same idempotency_key twice is a clean no-op, and the enclosing transaction still commits its other work", async () => {
    const schema = await scratchSchema();
    // SD §3: an agent turn's key is hash(agent_id, chapter_id, round_no).
    const key = "turn:9f1c:chapter-3:round-2";
    const subjectId = randomUUID();

    const first = await inTransaction(schema, (tx) =>
      writeEvent(tx, {
        ...contributionCreated({ subject: { type: "contribution", id: subjectId } }),
        idempotency_key: key,
      } as EventInput),
    );
    assertWritten(first);

    // The retry: a second transaction, minutes or days later, with a different
    // occurred_at in a DIFFERENT MONTH. This is the case the global dedupe table
    // exists for (migration 0011, Judgment 2).
    const retry = await inTransaction(schema, async (tx) => {
      const deduped = await writeEvent(tx, {
        event_type: "contribution.created",
        actor: { type: "agent", id: randomUUID() },
        subject: { type: "contribution", id: subjectId },
        occurred_at: new Date("2026-09-19T00:00:00Z"),
        idempotency_key: key,
      });

      // The work the savepoint exists to protect: in production this is the
      // contribution row and `graphile_worker.add_job`. If the duplicate had
      // poisoned the transaction, this statement would fail with 25P02 and the
      // whole retry would be lost.
      const alsoWritten = await writeEvent(tx, {
        event_type: "agent.budget_exhausted",
        actor: { type: "system" },
        subject: { type: "agent", id: randomUUID() },
      });

      return { deduped, alsoWritten };
    });

    assertDeduplicated(retry.deduped);
    assert.equal(retry.deduped.reason, "duplicate_idempotency_key");
    assert.equal(retry.deduped.idempotency_key, key);
    assert.equal(
      retry.deduped.existing?.id,
      first.id,
      "the committed claim points at the event that won the key",
    );
    assertWritten(retry.alsoWritten);

    const rows = await readEvents(schema);
    assert.equal(rows.length, 2, "one event per key, plus the unrelated one");
    assert.equal(
      rows.filter((row) => row.idempotency_key === key).length,
      1,
      "the retry wrote no second row",
    );
    assert.ok(
      rows.some((row) => row.event_type === "agent.budget_exhausted"),
      "the enclosing transaction committed the work that followed the no-op",
    );
  });

  it("dedupes a key written earlier in the SAME transaction", async () => {
    const schema = await scratchSchema();
    const key = "turn:same-tx";

    const { first, second, third } = await inTransaction(schema, async (tx) => {
      const a = await writeEvent(tx, { ...contributionCreated(), idempotency_key: key });
      const b = await writeEvent(tx, { ...contributionCreated(), idempotency_key: key });
      const c = await writeEvent(tx, contributionCreated());
      return { first: a, second: b, third: c };
    });

    assertWritten(first);
    assertDeduplicated(second);
    assert.equal(
      second.existing?.id,
      first.id,
      "our own uncommitted claim is visible to us, so the winner is reported",
    );
    assertWritten(third);
    assert.equal(await countEvents(schema), 2);
  });

  it("takes the SAVEPOINT path when a concurrent transaction claims the key first, and stays usable", async () => {
    const schema = await scratchSchema();
    const key = "turn:concurrent";

    // Transaction A opens, claims the key, and deliberately does not commit.
    // Transaction B's fast-path probe cannot see the uncommitted claim, so B
    // reaches the INSERT and blocks on the unique index. When A commits, B's
    // insert raises 23505 on event_idempotency_pkey inside the savepoint. This
    // is the ONLY path that produces `existing: null`, and the only one the
    // savepoint is strictly required for.
    let releaseA: () => void = () => {};
    const aHeld = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const a = inTransaction(schema, async (tx) => {
      const written = await writeEvent(tx, { ...contributionCreated(), idempotency_key: key });
      await aHeld;
      return written;
    });

    // Give A time to reach its INSERT before B starts probing.
    await delay(150);

    const b = inTransaction(schema, async (tx) => {
      const attempt = writeEvent(tx, { ...contributionCreated(), idempotency_key: key });
      // B is now blocked inside the savepoint, waiting on A's index entry.
      await delay(150);
      releaseA();
      const deduped = await attempt;
      // The savepoint rolled back; the transaction is clean and still ours.
      const alsoWritten = await writeEvent(tx, contributionCreated());
      return { deduped, alsoWritten };
    });

    const aResult = await a;
    const bResult = await b;

    assertWritten(aResult);
    assertDeduplicated(bResult.deduped);
    assert.equal(
      bResult.deduped.existing,
      null,
      "the winner was uncommitted when we collided, so there is no visible claim to report",
    );
    assertWritten(bResult.alsoWritten);

    const rows = await readEvents(schema);
    assert.equal(rows.length, 2, "A's keyed event and B's unrelated one — never a second keyed row");
    assert.equal(rows.filter((row) => row.idempotency_key === key).length, 1);
  });

  it("writes every event when the idempotency_key is omitted — an unkeyed event is never deduped", async () => {
    const schema = await scratchSchema();

    await inTransaction(schema, async (tx) => {
      await writeEvent(tx, contributionCreated());
      await writeEvent(tx, contributionCreated());
      await writeEvent(tx, {
        event_type: "thread.woke",
        actor: { type: "system" },
        subject: { type: "thread", id: randomUUID() },
      });
    });

    assert.equal(await countEvents(schema), 3, "SD makes the column nullable; most events carry no key");

    assert.equal(
      await countClaims(schema),
      0,
      "unkeyed events never enter the dedupe table (the trigger's WHEN clause)",
    );
  });
});

describe("writeEvent — failure is the caller's", () => {
  it("leaves no event behind when the caller's transaction rolls back", async () => {
    const schema = await scratchSchema();
    const key = "turn:rolled-back";

    await assert.rejects(
      () =>
        inTransaction(schema, async (tx) => {
          await writeEvent(tx, { ...contributionCreated(), idempotency_key: key });
          // The domain write that fails after the event was written — a
          // validation error, a constraint, a crash. SD §3: the event, the row
          // and the job commit together or not at all.
          throw new Error("domain write failed");
        }),
      /domain write failed/,
    );

    assert.equal(await countEvents(schema), 0, "the event went back with the transaction");

    assert.equal(await countClaims(schema), 0, "and so did its claim on the idempotency key");

    // Which means the key is free: the retry is a real write, not a no-op.
    const retry = await inTransaction(schema, (tx) =>
      writeEvent(tx, { ...contributionCreated(), idempotency_key: key }),
    );
    assertWritten(retry);
    assert.equal(await countEvents(schema), 1);
  });

  it("propagates a database error that is not a duplicate key", async () => {
    const schema = await scratchSchema();

    // Migration 0011 has no DEFAULT partition (Judgment 3): a timestamp no
    // partition covers is rejected loudly. `writeEvent` must not turn that into
    // a no-op — only `event_idempotency_pkey` means "already written".
    await assert.rejects(
      () =>
        inTransaction(schema, (tx) =>
          writeEvent(tx, {
            ...contributionCreated({ occurred_at: new Date("2019-01-01T00:00:00Z") }),
            idempotency_key: "turn:no-partition",
          } as EventInput),
        ),
      /no partition of relation/i,
      "an unroutable event is a loud failure, not a silent dedupe",
    );

    assert.equal(await countEvents(schema), 0);
  });
});
