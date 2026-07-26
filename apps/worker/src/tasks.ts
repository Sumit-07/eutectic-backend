/**
 * THE TASK LIST — the handling half of the job registry in `@eutectic/db`.
 *
 * `withJob` constrains what can be ENQUEUED. This file constrains what can be
 * HANDLED, and the two are held together at compile time: {@link TaskRegistry}
 * is a mapped type over `JobName`, so
 *
 *   - a name added to `JOB_NAMES` with no handler here fails to compile
 *     ("property 'x' is missing"), and
 *   - a handler here whose name is not in `JOB_NAMES` fails to compile
 *     ("object literal may only specify known properties").
 *
 * That is the point. An enqueueable name with no handler is not a missing
 * feature, it is a job row that retries twenty-five times and then sits in the
 * table forever; the failure has to happen at build time or it happens in
 * production at 3am.
 *
 * M0 SCOPE. Every handler below is a STUB: it logs and completes. The real
 * implementations are later tickets — `projection.contribution` belongs to the
 * feed/projection ticket, `partition.ensure_ahead` to the scheduler ticket that
 * calls `events_ensure_partition()` (migration 0011 names it and says so). What
 * lands here now is the seam and the compile-time contract, not the work.
 */

import type { JobName, JobPayloadMap } from "@eutectic/db";
import type { JobHelpers, Task, TaskList } from "graphile-worker";

import type { WorkerContext } from "./context.js";

/**
 * Teach graphile-worker our payload types.
 *
 * graphile-worker exposes `GraphileWorker.Tasks` as the module-augmentation
 * point for exactly this (its `Task<TName>` and `TaskList` both read it). With
 * the augmentation in place, `Task<"projection.contribution">` IS
 * `(payload: ProjectionContributionPayload, helpers) => ...`, so the handlers
 * below get their payloads typed with no cast anywhere in this file — nothing
 * is asserted, it is derived.
 *
 * The types are honest because `withJob` is the only writer: a payload column
 * in the queue was produced by a compile-time-checked `withJob` call, so the
 * shape a handler receives is the shape the map declares. The one way that
 * stops being true is somebody hand-inserting a job row, which is why nothing
 * in this codebase calls `add_job` directly.
 */
declare global {
  namespace GraphileWorker {
    interface Tasks extends JobPayloadMap {}
  }
}

/**
 * Exactly one handler per registry name. Not `Partial`, not indexed by string —
 * `TaskList` itself is optional in every key, which is precisely the hole this
 * type exists to close.
 */
export type TaskRegistry = { readonly [N in JobName]: Task<N> };

/**
 * Build the handlers, closing over the worker's context.
 *
 * A factory rather than a module-level constant because handlers need the
 * database pool, and a pool created at import time is a pool that outlives
 * nothing and is closed by no one. Passing it in keeps the process's single
 * `@eutectic/db` pool the same object the shutdown path ends.
 */
export function buildTaskRegistry(ctx: WorkerContext): TaskRegistry {
  return {
    // The projection job SD §3 names in its own transactional-enqueue example.
    // The real handler recomputes feed_entries and the derived counters for one
    // contribution; it lands with the projection ticket, and it will read
    // `ctx.sql`.
    "projection.contribution": async (payload, helpers) => {
      stub(helpers, "projection.contribution", { contribution_id: payload.contribution_id });
    },

    // Extends the `events` partition runway. `events` has no DEFAULT partition
    // by design (migration 0011, Judgment 3), so a month with no partition is a
    // hard INSERT failure, not a slow query — this job is what keeps that from
    // happening. The real handler calls `events_ensure_partition()`; it lands
    // with the scheduler ticket.
    "partition.ensure_ahead": async (_payload, helpers) => {
      stub(helpers, "partition.ensure_ahead", {});
    },
  };
}

/**
 * What an M0 handler does: say what it would have done, and complete.
 *
 * Completing rather than throwing is deliberate. A stub that threw would burn
 * twenty-five retries per job and fill `last_error` with noise, and the queue
 * would look broken during M0 for a reason that has nothing to do with the
 * queue.
 */
function stub(helpers: JobHelpers, name: JobName, detail: Record<string, unknown>): void {
  helpers.logger.info(`[stub] ${name} — no handler implemented yet (M0)`, detail);
}

/**
 * The registry in the shape graphile-worker's runner wants.
 *
 * Assignable with no cast: with the `GraphileWorker.Tasks` augmentation above,
 * `TaskRegistry` is `TaskList` minus the optionality.
 */
export function buildTaskList(ctx: WorkerContext): TaskList {
  return buildTaskRegistry(ctx);
}
