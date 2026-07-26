/**
 * Worker test for M0-BE-14: `withJob`, the transactional enqueue helper.
 *
 * The acceptance criterion is one sentence and it is the whole reason the queue
 * lives in Postgres (SD §3): **a crash between the domain write and COMMIT
 * leaves neither the row nor the job; a COMMIT leaves both.** Everything else in
 * this file supports that claim or guards a way of getting it silently wrong.
 *
 * Isolation, and why there are TWO throwaway schemas:
 *
 *   - a domain schema (`m0be14_*`), carrying the real `migrations/` directory,
 *     exactly like every other suite in this package;
 *   - a queue schema (`gw_m0be14_*`), bootstrapped with graphile-worker's own
 *     migrator. This one matters: the shared dev database has a real
 *     `graphile_worker` schema, and a test that enqueued into it would leave
 *     live jobs behind for a real worker to pick up. `withJob`'s `schema`
 *     option exists for this.
 *
 * Both are dropped in `after()`.
 *
 *   pnpm --filter @eutectic/db test
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { Sql, TransactionSql } from "postgres";

import { createPool } from "../client.js";
import { requireDatabaseUrl } from "../env.js";
import { JOB_NAMES, withJob } from "../jobs.js";
import { runSqlMigrations } from "../migrate.js";
import { MIGRATIONS_DIR } from "../paths.js";
import { bootstrapQueue, DEFAULT_QUEUE_SCHEMA, resolveQueueSchema } from "../queue.js";

const silent = (): void => {};
const suffix = (): string => randomUUID().replace(/-/g, "").slice(0, 12);

let sql: Sql;
let domainSchema: string;
let queueSchema: string;

before(async () => {
  // Fail with the actionable message rather than a connection timeout.
  const url = requireDatabaseUrl();
  sql = createPool({ max: 4 });

  domainSchema = `m0be14_${suffix()}`;
  queueSchema = `gw_m0be14_${suffix()}`;

  await runSqlMigrations({ dir: MIGRATIONS_DIR, schema: domainSchema, log: silent });
  await bootstrapQueue({ url, schema: queueSchema, log: silent });
});

after(async () => {
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${domainSchema}" CASCADE`);
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${queueSchema}" CASCADE`);
  await sql.end();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The domain half of the atomic write.
 *
 * `forums` is used because it is the simplest table in the schema with no
 * foreign keys of its own (migration 0003) — the test is about the transaction,
 * not about assembling a valid contribution graph.
 */
async function insertForum(tx: TransactionSql, slug: string): Promise<string> {
  const rows = await tx<{ id: string }[]>`
    INSERT INTO ${tx(domainSchema)}.${tx("forums")} (slug, name, tone_policy)
    VALUES (${slug}, ${"Test forum"}, ${"plain"})
    RETURNING id
  `;
  const row = rows[0];
  assert.ok(row, "insertForum: RETURNING produced no row");
  return row.id;
}

async function forumExists(slug: string): Promise<boolean> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ${sql(domainSchema)}.${sql("forums")} WHERE slug = ${slug}
  `;
  return (rows[0]?.n ?? 0) > 0;
}

interface JobRow {
  readonly id: string;
  readonly task_identifier: string;
  readonly job_key: string | null;
  readonly run_at: Date;
  /** `json_typeof` of the stored payload — `object` unless the binding is wrong. */
  readonly payload_kind: string;
  readonly payload_text: string;
}

/**
 * Read jobs straight out of graphile-worker's tables.
 *
 * Not from its `jobs` VIEW: that view (sql/000017.sql) projects id, key,
 * run_at, task_identifier and more — but NOT `payload`. Half of what this file
 * asserts is that the payload round-trips as an object, so the join to
 * `_private_tasks` is written out by hand.
 */
async function readJobs(jobKey?: string): Promise<JobRow[]> {
  return sql<JobRow[]>`
    SELECT
      j.id::text            AS id,
      t.identifier          AS task_identifier,
      j.key                 AS job_key,
      j.run_at              AS run_at,
      json_typeof(j.payload) AS payload_kind,
      j.payload::text       AS payload_text
    FROM ${sql(queueSchema)}.${sql("_private_jobs")} AS j
    JOIN ${sql(queueSchema)}.${sql("_private_tasks")} AS t ON t.id = j.task_id
    ${jobKey === undefined ? sql`` : sql`WHERE j.key = ${jobKey}`}
    ORDER BY j.id
  `;
}

// ---------------------------------------------------------------------------
// The acceptance criterion
// ---------------------------------------------------------------------------

describe("withJob — one transaction, or neither half", () => {
  it("leaves NEITHER the row nor the job when the transaction aborts before commit", async () => {
    const slug = `rollback-${suffix()}`;
    const jobKey = `rollback-${suffix()}`;

    await assert.rejects(
      () =>
        sql.begin(async (tx) => {
          const forumId = await insertForum(tx, slug);
          const enqueued = await withJob(
            tx,
            "projection.contribution",
            { contribution_id: forumId },
            { schema: queueSchema, jobKey },
          );
          // Both halves are genuinely written and visible INSIDE the
          // transaction. Without this the test would pass just as well against
          // a `withJob` that did nothing at all.
          assert.ok(enqueued.id);
          const inFlight = await tx<{ n: number }[]>`
            SELECT count(*)::int AS n
            FROM ${tx(queueSchema)}.${tx("_private_jobs")} WHERE key = ${jobKey}
          `;
          assert.equal(inFlight[0]?.n, 1);

          // The crash. Anything that throws out of the callback makes
          // postgres.js issue ROLLBACK.
          throw new Error("crash before commit");
        }),
      /crash before commit/,
    );

    assert.equal(await forumExists(slug), false, "domain row survived the rollback");
    // `.length`, not `deepEqual(..., [])`: postgres.js returns a `Result`, an
    // Array SUBCLASS, and `deepStrictEqual` compares prototypes — an empty
    // Result is not deep-strict-equal to an empty Array.
    assert.equal((await readJobs(jobKey)).length, 0, "queued job survived the rollback");
  });

  it("leaves BOTH when the transaction commits, with the payload intact", async () => {
    const slug = `commit-${suffix()}`;
    const jobKey = `commit-${suffix()}`;

    const { forumId, enqueued } = await sql.begin(async (tx) => {
      const id = await insertForum(tx, slug);
      const job = await withJob(
        tx,
        "projection.contribution",
        { contribution_id: id },
        { schema: queueSchema, jobKey },
      );
      return { forumId: id, enqueued: job };
    });

    assert.equal(await forumExists(slug), true, "domain row did not commit");

    const jobs = await readJobs(jobKey);
    assert.equal(jobs.length, 1);
    const job = jobs[0];
    assert.ok(job);
    assert.equal(job.id, enqueued.id, "returned id does not match the committed row");
    assert.equal(job.task_identifier, "projection.contribution");
    assert.equal(job.job_key, jobKey);
    assert.equal(enqueued.job_name, "projection.contribution");
    assert.equal(enqueued.job_key, jobKey);

    // The `${JSON.stringify(x)}::json` trap lands here as `string`, not
    // `object`, and every `payload->>'...'` below would silently be null.
    assert.equal(job.payload_kind, "object", "payload was not stored as a JSON object");
    assert.deepEqual(JSON.parse(job.payload_text), { contribution_id: forumId });

    const probed = await sql<{ v: string | null }[]>`
      SELECT j.payload->>'contribution_id' AS v
      FROM ${sql(queueSchema)}.${sql("_private_jobs")} AS j WHERE j.key = ${jobKey}
    `;
    assert.equal(probed[0]?.v, forumId, "payload key is not readable from SQL");
  });

  it("stores an empty payload as an empty object, not null", async () => {
    const jobKey = `empty-${suffix()}`;
    await sql.begin(async (tx) => {
      await withJob(tx, "partition.ensure_ahead", {}, { schema: queueSchema, jobKey });
    });

    const job = (await readJobs(jobKey))[0];
    assert.ok(job);
    assert.equal(job.task_identifier, "partition.ensure_ahead");
    assert.equal(job.payload_kind, "object");
    assert.deepEqual(JSON.parse(job.payload_text), {});
  });
});

// ---------------------------------------------------------------------------
// The options surface
// ---------------------------------------------------------------------------

describe("withJob — options", () => {
  it("dedupes on jobKey: two enqueues leave one job, carrying the LATER payload", async () => {
    const jobKey = `dedupe-${suffix()}`;
    const first = randomUUID();
    const second = randomUUID();

    // Separate transactions on purpose — deduping within one transaction would
    // be a weaker claim than deduping across two committed writes, which is the
    // case the queue actually meets.
    await sql.begin(async (tx) => {
      await withJob(
        tx,
        "projection.contribution",
        { contribution_id: first },
        { schema: queueSchema, jobKey },
      );
    });
    await sql.begin(async (tx) => {
      await withJob(
        tx,
        "projection.contribution",
        { contribution_id: second },
        { schema: queueSchema, jobKey },
      );
    });

    const jobs = await readJobs(jobKey);
    assert.equal(jobs.length, 1, "jobKey did not dedupe");
    // graphile-worker's default `job_key_mode` is 'replace': the pending job is
    // overwritten rather than the new enqueue being dropped. Asserted rather
    // than assumed, because "one job" is true under both modes and only this
    // distinguishes them — and it is the behaviour JobOptions.jobKey documents.
    assert.deepEqual(JSON.parse(jobs[0]?.payload_text ?? "null"), { contribution_id: second });
  });

  it("passes runAt through, and defaults it to now", async () => {
    const scheduledKey = `runat-${suffix()}`;
    const immediateKey = `now-${suffix()}`;
    const runAt = new Date(Date.now() + 3_600_000);

    const scheduled = await sql.begin(async (tx) =>
      withJob(tx, "partition.ensure_ahead", {}, { schema: queueSchema, jobKey: scheduledKey, runAt }),
    );
    const immediate = await sql.begin(async (tx) =>
      withJob(tx, "partition.ensure_ahead", {}, { schema: queueSchema, jobKey: immediateKey }),
    );

    assert.equal(scheduled.run_at.getTime(), runAt.getTime());
    // Not `<= Date.now()`: run_at defaults to the DATABASE's now(), and the two
    // clocks are not the same clock. A wide window is the honest assertion.
    assert.ok(Math.abs(immediate.run_at.getTime() - Date.now()) < 60_000);
    assert.equal(immediate.job_key, immediateKey);
  });

  it("returns job_key null when none was given", async () => {
    const enqueued = await sql.begin(async (tx) =>
      withJob(tx, "partition.ensure_ahead", {}, { schema: queueSchema }),
    );
    assert.equal(enqueued.job_key, null);
    assert.ok(enqueued.id);
  });

  it("propagates a database error instead of swallowing it, aborting the caller", async () => {
    const slug = `failure-${suffix()}`;
    await assert.rejects(
      () =>
        sql.begin(async (tx) => {
          await insertForum(tx, slug);
          // A schema that does not exist: `add_job` cannot resolve.
          await withJob(
            tx,
            "partition.ensure_ahead",
            {},
            { schema: `gw_missing_${suffix()}` },
          );
        }),
      (error: unknown) => error instanceof Error,
    );
    assert.equal(await forumExists(slug), false, "domain row survived a failed enqueue");
  });
});

// ---------------------------------------------------------------------------
// The registry and the schema resolver
// ---------------------------------------------------------------------------

describe("job registry", () => {
  it("has no duplicate names", () => {
    assert.equal(new Set(JOB_NAMES).size, JOB_NAMES.length);
  });

  it("is minimal and additive — every name is enqueueable today", async () => {
    // The registry's own rule: a name lands when its handler lands. This asserts
    // the weaker half that a test can assert — that every name currently in the
    // registry is a name `add_job` accepts — so that adding a name without
    // wiring it is caught here as well as in apps/worker's type check.
    for (const name of JOB_NAMES) {
      const jobKey = `registry-${name}-${suffix()}`;
      await sql.begin(async (tx) => {
        // `{}` satisfies both current payloads structurally at runtime; the
        // compile-time constraint is exercised by the call sites above.
        await withJob(tx, name, {} as never, { schema: queueSchema, jobKey });
      });
      const job = (await readJobs(jobKey))[0];
      assert.ok(job, `${name} did not enqueue`);
      assert.equal(job.task_identifier, name);
    }
  });
});

describe("resolveQueueSchema", () => {
  const original = process.env.GRAPHILE_WORKER_SCHEMA;

  after(() => {
    if (original === undefined) delete process.env.GRAPHILE_WORKER_SCHEMA;
    else process.env.GRAPHILE_WORKER_SCHEMA = original;
  });

  it("prefers the explicit argument", () => {
    process.env.GRAPHILE_WORKER_SCHEMA = "from_env";
    assert.equal(resolveQueueSchema("explicit"), "explicit");
  });

  it("falls back to GRAPHILE_WORKER_SCHEMA, then to the default", () => {
    process.env.GRAPHILE_WORKER_SCHEMA = "from_env";
    assert.equal(resolveQueueSchema(), "from_env");
    delete process.env.GRAPHILE_WORKER_SCHEMA;
    assert.equal(resolveQueueSchema(), DEFAULT_QUEUE_SCHEMA);
  });

  it("treats an empty string as unset — graphile-worker does", () => {
    process.env.GRAPHILE_WORKER_SCHEMA = "";
    assert.equal(resolveQueueSchema(), DEFAULT_QUEUE_SCHEMA);
    assert.equal(resolveQueueSchema(""), DEFAULT_QUEUE_SCHEMA);
  });
});
