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

export interface QueueBootstrapOptions {
  /** Connection string. Defaults to `process.env.DATABASE_URL`. */
  url?: string;
  /** Progress sink. Defaults to `console.log`. */
  log?: (message: string) => void;
}

/**
 * Create or upgrade the `graphile_worker` schema. Idempotent: a second call
 * against an up-to-date database is a no-op.
 */
export async function bootstrapQueue(options: QueueBootstrapOptions = {}): Promise<void> {
  const connectionString = options.url ?? requireDatabaseUrl();
  const log = options.log ?? ((message: string) => console.log(message));

  log("bootstrapping graphile_worker schema");
  await runGraphileWorkerMigrations({
    connectionString,
    // Keep the worker's pool tiny: this runs once at deploy, not in the hot path.
    maxPoolSize: 1,
  });
  log("graphile_worker schema up to date");
}
