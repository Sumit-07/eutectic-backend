/**
 * Connection pool and Drizzle handle.
 *
 * Driver: postgres.js (`postgres`). One driver, one pool factory, one place that
 * reads DATABASE_URL.
 *
 * graphile-worker runs its own internal `pg` pool (see src/scripts/migrate.ts).
 * That is deliberate and costs nothing: transactional enqueue (system-design §3)
 * is done with `select graphile_worker.add_job(...)` inside *our* transaction, so
 * the queue never needs to share a connection object with us.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Options, PostgresType, Sql } from "postgres";

import { poolDefaults, requireDatabaseUrl } from "./env.js";
import * as schema from "./schema/index.js";

export type Schema = typeof schema;
export type Database = PostgresJsDatabase<Schema>;

/**
 * Re-exported so consumers (apps/api's M0-BE-18 cached entitlement wrapper is
 * the first) can type "the pool `createPool`/`getDb` hand back" without
 * declaring `postgres` as a direct dependency of their own — it is already
 * this package's dependency, and the pool IS this type.
 */
export type { Sql } from "postgres";

export interface PoolOptions {
  /** Connection string. Defaults to `process.env.DATABASE_URL`. */
  url?: string;
  /** Max connections held by this pool. Defaults to DATABASE_POOL_MAX or 10. */
  max?: number;
  /** Seconds before an idle connection is closed. Defaults to DATABASE_IDLE_TIMEOUT_SECONDS or 30. */
  idleTimeoutSeconds?: number;
  /** Seconds to wait for a connection before failing. Defaults to DATABASE_CONNECT_TIMEOUT_SECONDS or 10. */
  connectTimeoutSeconds?: number;
  /** Extra postgres.js options. Escape hatch for one-off callers (the migration runner pins max: 1). */
  extra?: Options<Record<string, PostgresType>>;
}

/**
 * Create a pool. Callers own the returned handle and must `await sql.end()` on
 * shutdown. Prefer {@link getDb} for long-lived processes.
 */
export function createPool(options: PoolOptions = {}): Sql {
  const url = options.url ?? requireDatabaseUrl();
  return postgres(url, {
    max: options.max ?? poolDefaults.max(),
    idle_timeout: options.idleTimeoutSeconds ?? poolDefaults.idleTimeoutSeconds(),
    connect_timeout: options.connectTimeoutSeconds ?? poolDefaults.connectTimeoutSeconds(),
    // Everything in this product is queued and short-lived; prepared statements
    // across a pool interact badly with connection poolers we may sit behind
    // later (system-design §14: stay portable).
    prepare: false,
    onnotice: () => {},
    ...options.extra,
  });
}

/** Wrap an existing pool in a Drizzle handle bound to the package schema. */
export function createDb(sql: Sql): Database {
  return drizzle(sql, { schema });
}

let sharedPool: Sql | undefined;
let sharedDb: Database | undefined;

/**
 * Process-wide pool + Drizzle handle, created on first use. One pool per
 * process; a second call returns the same instance.
 */
export function getDb(): { sql: Sql; db: Database } {
  if (sharedPool === undefined || sharedDb === undefined) {
    sharedPool = createPool();
    sharedDb = createDb(sharedPool);
  }
  return { sql: sharedPool, db: sharedDb };
}

/** Close the process-wide pool. Safe to call when nothing was ever opened. */
export async function closeDb(): Promise<void> {
  const pool = sharedPool;
  sharedPool = undefined;
  sharedDb = undefined;
  if (pool !== undefined) await pool.end();
}
