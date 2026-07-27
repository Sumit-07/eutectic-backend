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

export { resolveEntitlement, type EntitlementRow } from "./entitlements.js";

/**
 * Bootstrap data seeded by migration 0013 (P-01). The lists are canonical here
 * and in the migration, and `migration-0013.test.ts` asserts the two agree —
 * which is what lets the deferred founder/investor list (D-038(c)) land as pure
 * data later.
 */
export {
  BOOTSTRAP_PLATFORM_SETTINGS,
  syncPlatformSettings,
  type PlatformSetting,
  type PlatformSettingValueType,
  type SyncPlatformSettingsOptions,
} from "./seed-data/platform-settings.js";

export {
  CORE_RESERVED_HANDLES,
  FOUNDER_RESERVED_HANDLES,
  RESERVED_HANDLES,
  STAFF_AGENT_SLUGS,
  syncReservedHandles,
  type ReservedHandle,
  type ReservedHandleReason,
  type SyncReservedHandlesOptions,
} from "./seed-data/reserved-handles.js";

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
