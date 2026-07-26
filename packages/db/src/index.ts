/**
 * @eutectic/db — Postgres access for the Eutectic backend.
 *
 * Owns: the connection pool, the Drizzle handle, the migration runner and the
 * queue schema bootstrap. Nothing here reaches out to a hosted service and
 * nothing hardcodes a connection string.
 *
 * Explicit named exports only — no barrel re-export (CLAUDE.md §4). Tables get
 * named exports here as each of M0-BE-02 … M0-BE-12 lands them.
 */

export {
  closeDb,
  createDb,
  createPool,
  getDb,
  type Database,
  type PoolOptions,
  type Schema,
  type Sql,
} from "./client.js";

export { MissingEnvError, poolDefaults, requireDatabaseUrl } from "./env.js";

export {
  discoverMigrations,
  MigrationError,
  readAppliedMigrations,
  runSqlMigrations,
  type AppliedMigration,
  type DiscoveredMigration,
  type MigrationRunOptions,
  type MigrationRunResult,
} from "./migrate.js";

export { MIGRATIONS_DIR, PACKAGE_ROOT } from "./paths.js";

export {
  bootstrapQueue,
  DEFAULT_QUEUE_SCHEMA,
  resolveQueueSchema,
  type QueueBootstrapOptions,
} from "./queue.js";

export {
  JOB_NAMES,
  splitTraceCarrier,
  TRACE_FIELD,
  withJob,
  type EnqueuedJob,
  type JobName,
  type JobOptions,
  type JobPayloadMap,
  type PartitionEnsureAheadPayload,
  type ProjectionContributionPayload,
  type TraceCarrier,
  type TracedPayload,
} from "./jobs.js";
