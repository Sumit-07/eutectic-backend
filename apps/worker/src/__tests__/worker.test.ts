/**
 * Worker test for M0-BE-14: the typed task list and the bootstrap.
 *
 * Two halves.
 *
 * 1. TYPE-LEVEL. The exhaustiveness claim in `tasks.ts` — a registry name with
 *    no handler, or a handler with no registry name, must not compile — is a
 *    claim about the BUILD, so the assertions live in the types below and the
 *    test is that this file compiles at all. There is no runtime form of it.
 *    (Verified from the other side too, by hand, before this file was written:
 *    adding a name to `JOB_NAMES` without a handler fails with TS2741, and
 *    adding a handler that is not in `JOB_NAMES` fails with TS2353.)
 *
 * 2. RUNTIME SMOKE. A real runner, against a throwaway queue schema, processing
 *    one real job and stopping cleanly. This never touches the shared
 *    `graphile_worker` schema — a test worker polling the dev queue would eat
 *    jobs belonging to a real one.
 *
 *   pnpm --filter @eutectic/worker test
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { createPool, JOB_NAMES, requireDatabaseUrl, withJob } from "@eutectic/db";
import type { JobName } from "@eutectic/db";
import type { TaskList } from "graphile-worker";

import type { DatabasePool } from "../context.js";
import { buildTaskList, buildTaskRegistry, type TaskRegistry } from "../tasks.js";
import { startWorker, type WorkerHandle } from "../worker.js";

// ---------------------------------------------------------------------------
// 1. Type-level exhaustiveness
// ---------------------------------------------------------------------------

type Assert<T extends true> = T;
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** The registry covers the job names exactly — no extras, no gaps. */
type RegistryCoversJobNames = Assert<Exact<keyof TaskRegistry, JobName>>;

/** And what we hand graphile-worker is a `TaskList`, with no cast in between. */
type RegistryIsATaskList = Assert<TaskRegistry extends TaskList ? true : false>;

// Referenced so the aliases are not dead code to a linter; they are checked by
// the compiler either way.
export type WorkerTypeAssertions = [RegistryCoversJobNames, RegistryIsATaskList];

// ---------------------------------------------------------------------------
// 2. Runtime
// ---------------------------------------------------------------------------

const silent = (): void => {};
const suffix = (): string => randomUUID().replace(/-/g, "").slice(0, 12);

let url: string;
let sql: DatabasePool;
let queueSchema: string;
let worker: WorkerHandle | undefined;

before(() => {
  url = requireDatabaseUrl();
  queueSchema = `gw_m0be14w_${suffix()}`;
  sql = createPool({ url, max: 2 });
});

after(async () => {
  if (worker !== undefined) await worker.stop("test teardown");
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${queueSchema}" CASCADE`);
  await sql.end();
});

async function pendingJobs(): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ${sql(queueSchema)}.${sql("_private_jobs")}
  `;
  return rows[0]?.n ?? 0;
}

/** Poll until the queue drains, or give up loudly. */
async function waitForDrain(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await pendingJobs()) === 0) return;
    if (Date.now() > deadline) {
      assert.fail(`queue did not drain within ${timeoutMs}ms`);
    }
    await delay(50);
  }
}

describe("task registry", () => {
  it("has exactly one handler per registry name, and no others", () => {
    const registry = buildTaskRegistry({ sql });
    assert.deepEqual(Object.keys(registry).sort(), [...JOB_NAMES].sort());
    for (const name of JOB_NAMES) {
      assert.equal(typeof registry[name], "function", `${name} has no handler`);
    }
  });

  it("buildTaskList produces the same names", () => {
    assert.deepEqual(Object.keys(buildTaskList({ sql })).sort(), [...JOB_NAMES].sort());
  });
});

describe("worker smoke test", () => {
  it("bootstraps, processes a transactionally-enqueued job, and stops cleanly", async () => {
    worker = await startWorker({
      url,
      schema: queueSchema,
      concurrency: 1,
      // The default is 2000ms and the runner only polls on an idle queue;
      // 50ms keeps the test honest without making it flaky.
      pollIntervalMs: 50,
      log: silent,
    });

    // startWorker's own bootstrap created the schema — nothing else did.
    assert.equal(await pendingJobs(), 0);

    // Enqueued the way real code enqueues: inside a transaction, through
    // `withJob`, on a pool that is not the runner's.
    const contributionId = randomUUID();
    const enqueued = await sql.begin(async (tx) =>
      withJob(tx, "projection.contribution", { contribution_id: contributionId }, {
        schema: queueSchema,
      }),
    );
    assert.ok(enqueued.id);

    // graphile-worker DELETES a job that completes successfully, so an empty
    // table is proof the handler ran and returned — not merely that a row was
    // written and forgotten.
    await waitForDrain();

    await worker.stop("test");
    const stopped = worker;
    worker = undefined;

    // `stop()` is idempotent: the second call must not throw, because SIGTERM
    // followed by SIGINT is an ordinary way for a container to die.
    await stopped.stop("test again");

    // No dangling pool. postgres.js rejects on a handle that has been ended.
    await assert.rejects(() => stopped.ctx.sql`SELECT 1`);
  });
});
