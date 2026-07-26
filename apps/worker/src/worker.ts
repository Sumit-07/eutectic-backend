/**
 * THE WORKER PROCESS — system-design §2 ("worker · queues") and §3.
 *
 * One process, one queue, one pool, one shutdown path.
 *
 * WHY THE RUNNER DOES NOT SHARE OUR POOL
 *
 * The acceptance criterion says "runner wired to packages/db pool", and the
 * honest reading is: wired to the same DATABASE and the same env contract, not
 * to the same pool OBJECT. It cannot be the same object. graphile-worker speaks
 * `pg` (node-postgres) and `@eutectic/db` speaks `postgres` (postgres.js); its
 * `pgPool` option takes a `pg.Pool`, which a postgres.js handle is not.
 * `packages/db/src/client.ts` already says this out loud and calls it
 * deliberate, and it costs nothing precisely because of SD §3: transactional
 * enqueue happens with `select add_job(...)` inside OUR transaction, so the
 * queue never needs to share a connection with us. Two pools, one database, one
 * `requireDatabaseUrl()` — the single place a connection string is read.
 *
 * WHAT STARTUP DOES, IN ORDER
 *
 *   1. Resolve DATABASE_URL through `@eutectic/db` (throws a named, actionable
 *      error if it is missing, rather than a connection timeout 10s later).
 *   2. Bootstrap the queue schema, exactly once. `bootstrapQueue` is idempotent,
 *      so this is a no-op on every deploy after the first.
 *   3. Open the domain pool.
 *   4. Start the runner on the typed task list.
 *
 * If any of those throws, the ones that already succeeded are unwound before
 * the error leaves — a half-started worker must not leave a pool open.
 */

import { bootstrapQueue, createPool, resolveQueueSchema, requireDatabaseUrl } from "@eutectic/db";
import { run } from "graphile-worker";
import type { Runner } from "graphile-worker";

import type { WorkerContext } from "./context.js";
import { buildTaskList } from "./tasks.js";

export interface WorkerOptions {
  /** Connection string. Defaults to `DATABASE_URL` via `@eutectic/db`. */
  readonly url?: string;
  /**
   * Queue schema. Defaults to `GRAPHILE_WORKER_SCHEMA` or `graphile_worker`,
   * resolved by `@eutectic/db` so the bootstrap, the runner and every `withJob`
   * call agree on one string. Present so tests can run against a throwaway
   * queue schema instead of the shared one.
   */
  readonly schema?: string;
  /** Jobs handled at once. Defaults to 1 — M0 has no throughput problem. */
  readonly concurrency?: number;
  /** Milliseconds between polls when idle. Defaults to graphile-worker's 2000. */
  readonly pollIntervalMs?: number;
  /** Progress sink. Defaults to `console.log`. */
  readonly log?: (message: string) => void;
}

/** A started worker. `stop()` is idempotent. */
export interface WorkerHandle {
  readonly runner: Runner;
  readonly ctx: WorkerContext;
  /** Resolves when the runner has stopped, for any reason. */
  readonly promise: Promise<void>;
  /** Stop the runner, then close the pool. Safe to call more than once. */
  stop(reason?: string): Promise<void>;
}

/**
 * Start the worker. Returns as soon as it is polling.
 *
 * Signals are NOT handled here — see {@link main}. A library function that
 * installs process-wide signal handlers cannot be used twice, and the smoke
 * test starts one of these inside a test runner that has its own opinions about
 * SIGINT.
 */
export async function startWorker(options: WorkerOptions = {}): Promise<WorkerHandle> {
  const url = options.url ?? requireDatabaseUrl();
  const schema = resolveQueueSchema(options.schema);
  const log = options.log ?? ((message: string) => console.log(message));

  await bootstrapQueue({ url, schema, log });

  const sql = createPool({ url });
  const ctx: WorkerContext = { sql };

  let runner: Runner;
  try {
    runner = await run({
      connectionString: url,
      schema,
      taskList: buildTaskList(ctx),
      concurrency: options.concurrency ?? 1,
      // Cron is a different deployable (SD §2: worker and scheduler are separate
      // processes). An empty list is passed explicitly so the runner never goes
      // looking for a `crontab` file relative to whatever cwd it was started in.
      parsedCronItems: [],
      // We own SIGINT/SIGTERM (see `main`), because the pool has to close after
      // the runner does and graphile-worker knows nothing about the pool.
      noHandleSignals: true,
      ...(options.pollIntervalMs === undefined ? {} : { pollInterval: options.pollIntervalMs }),
    });
  } catch (error) {
    // The runner never started, so nothing will ever close the pool we just
    // opened. Unwind before rethrowing.
    await sql.end();
    throw error;
  }

  log(`worker running · schema=${schema} · concurrency=${options.concurrency ?? 1}`);

  let stopping: Promise<void> | undefined;
  const stop = (reason?: string): Promise<void> => {
    // Idempotent by memoising the first call's promise: SIGTERM immediately
    // followed by SIGINT is normal, and a second `runner.stop()` throws.
    stopping ??= (async () => {
      log(`worker stopping${reason === undefined ? "" : ` · ${reason}`}`);
      try {
        await runner.stop(reason);
      } finally {
        // `finally`, not `then`: a runner that failed to stop cleanly must not
        // also leak the pool.
        await sql.end();
      }
      log("worker stopped");
    })();
    return stopping;
  };

  return { runner, ctx, promise: runner.promise, stop };
}

/**
 * Process entry point: start, wait, shut down on a signal, exit with a code.
 *
 * @returns the process exit code. 0 on a clean shutdown, 1 on any failure.
 *          Returned rather than passed to `process.exit` so that the caller
 *          decides when the process dies — `process.exit` inside a shutdown
 *          path is how half-flushed logs happen.
 */
export async function main(options: WorkerOptions = {}): Promise<number> {
  let handle: WorkerHandle;
  try {
    handle = await startWorker(options);
  } catch (error) {
    console.error("worker failed to start", error);
    return 1;
  }

  const onSignal = (signal: string): void => {
    // Deliberately not awaited: a signal handler that returns a promise is a
    // promise nobody is holding. `stop()` is idempotent and `handle.promise`
    // below is what the process actually waits on.
    void handle.stop(signal).catch((error: unknown) => {
      console.error("worker failed to stop cleanly", error);
    });
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  try {
    await handle.promise;
    // A signal-driven shutdown resolves `promise` first; awaiting `stop()` here
    // is what guarantees the pool is closed before we return, so the process can
    // exit on its own with no dangling handles.
    await handle.stop();
    return 0;
  } catch (error) {
    console.error("worker crashed", error);
    await handle.stop("crash").catch(() => {});
    return 1;
  }
}
