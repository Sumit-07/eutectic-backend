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
  type ISql,
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
 * The admin-only user projection (P-09). Its column names live on this side of
 * the package boundary on purpose — see `admin-users.ts`'s module doc for the
 * D-029 guard that makes that placement load-bearing rather than stylistic.
 */
export { findAdminUser, type AdminUserRow } from "./admin-users.js";

/**
 * The platform-settings service (P-09, DIRECTIVE §3). The cache is INJECTED
 * through `SettingsCache` — this package gains no cache dependency, and
 * `apps/api` hands in `cache.namespace("settings")`.
 */
export {
  PLATFORM_SETTINGS_CACHE_KEY,
  PLATFORM_SETTINGS_CACHE_TTL_SECONDS,
  type SettingsCache,
} from "./settings/cache.js";

export {
  isSettingDataError,
  isSettingNotFoundError,
  isSettingValueError,
  SettingDataError,
  SettingNotFoundError,
  SettingValueError,
  type SettingIssue,
  type SettingIssueCode,
} from "./settings/errors.js";

export {
  getPlatformSetting,
  listPlatformSettings,
  PLATFORM_SETTING_UPDATED_ACTION,
  updatePlatformSetting,
  type PlatformSettingRecord,
  type PlatformSettingsOptions,
  type UpdatePlatformSettingInput,
} from "./settings/service.js";

export {
  coerceBound,
  coerceStoredValue,
  isPlatformSettingValueType,
  PLATFORM_SETTING_VALUE_TYPES,
  validateSubmittedValue,
  type ValueConstraints,
} from "./settings/value.js";

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
