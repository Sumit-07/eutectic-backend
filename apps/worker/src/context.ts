/**
 * What a job handler is given besides its payload.
 *
 * One object, created once per process, closed once on shutdown. Handlers never
 * open their own pool: a pool per handler is a connection leak waiting for the
 * first job that throws.
 */

import type { createPool } from "@eutectic/db";

/**
 * The `@eutectic/db` pool handle.
 *
 * Typed off `createPool` rather than importing `Sql` from `postgres` directly,
 * so this app depends on the database package's surface and not on its driver.
 * If the driver is ever swapped (SD §14: no proprietary primitive on any
 * critical path), nothing in `apps/worker` names the old one.
 */
export type DatabasePool = ReturnType<typeof createPool>;

export interface WorkerContext {
  /**
   * The process-wide pool. Handlers open their own TRANSACTION on it
   * (`ctx.sql.begin(...)`) and use `writeEvent` / `withJob` inside — the same
   * atomic-write contract the API side uses (SD §3). Work done by a handler is
   * as transactional as the work that enqueued it.
   */
  readonly sql: DatabasePool;
}
