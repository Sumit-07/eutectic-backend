/**
 * Queue bootstrap.
 *
 * The queue lives in Postgres (system-design §3) — the single most important
 * reliability decision in this system, because it makes
 *
 *     BEGIN;
 *       INSERT INTO contributions ...;
 *       INSERT INTO events ...;
 *       SELECT graphile_worker.add_job(...);
 *     COMMIT;
 *
 * atomic by construction. Redis is cache, counters and rate limiting only.
 *
 * graphile-worker owns the `graphile_worker` schema and its own migration
 * history. We call its programmatic migrator rather than copying its SQL into
 * `migrations/0000` — hand-copied vendor SQL drifts the moment the dependency is
 * upgraded, and its ledger, not ours, is the one it consults.
 */

import { runMigrations as runGraphileWorkerMigrations } from "graphile-worker";

import { requireDatabaseUrl } from "./env.js";

/** The schema graphile-worker installs into when nothing says otherwise. */
export const DEFAULT_QUEUE_SCHEMA = "graphile_worker";

/**
 * Where the queue lives, resolved the same way for every caller.
 *
 * This mirrors graphile-worker's own resolution order (dist/config.js:
 * `process.env.GRAPHILE_WORKER_SCHEMA || "graphile_worker"`) deliberately.
 * Three things have to agree on this string or the system is quietly broken:
 * the bootstrap that creates the schema, the runner that polls it, and
 * `withJob`, which qualifies `add_job` by name because it runs on the caller's
 * connection and cannot rely on a `search_path` set for the application's own
 * tables. If they disagree, enqueues land in a schema nothing polls: no error,
 * no jobs, no clue.
 *
 * The `||` rather than `??` is not an accident — an empty
 * `GRAPHILE_WORKER_SCHEMA` means "unset", which is how graphile-worker reads it.
 */
export function resolveQueueSchema(explicit?: string): string {
  return explicit || process.env.GRAPHILE_WORKER_SCHEMA || DEFAULT_QUEUE_SCHEMA;
}

export interface QueueBootstrapOptions {
  /** Connection string. Defaults to `process.env.DATABASE_URL`. */
  url?: string;
  /**
   * Schema to install into. Defaults to {@link resolveQueueSchema}.
   *
   * Application code should not pass this. It exists so tests can bootstrap a
   * throwaway queue schema instead of migrating the shared dev database.
   */
  schema?: string;
  /** Progress sink. Defaults to `console.log`. */
  log?: (message: string) => void;
}

/**
 * Create or upgrade the queue schema. Idempotent: a second call against an
 * up-to-date database is a no-op.
 */
export async function bootstrapQueue(options: QueueBootstrapOptions = {}): Promise<void> {
  const connectionString = options.url ?? requireDatabaseUrl();
  const schema = resolveQueueSchema(options.schema);
  const log = options.log ?? ((message: string) => console.log(message));

  log(`bootstrapping ${schema} schema`);
  await runGraphileWorkerMigrations({
    connectionString,
    schema,
    // Keep the worker's pool tiny: this runs once at deploy, not in the hot path.
    maxPoolSize: 1,
  });
  log(`${schema} schema up to date`);
}
