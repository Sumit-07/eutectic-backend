/**
 * THE JOB REGISTRY AND `withJob` — system-design §3.
 *
 * SD §3 calls the Postgres-backed queue "the single most important reliability
 * decision here", and writes out the shape it exists to make possible:
 *
 *     BEGIN;
 *       INSERT INTO contributions (...);
 *       INSERT INTO events (...);
 *       SELECT graphile_worker.add_job('projection.contribution', ...);
 *     COMMIT;
 *
 * The domain row, the event and the queued job commit together or not at all.
 * With Redis as the queue that is two systems and you get orphaned events, lost
 * jobs and phantom work — a job that fires for a row that was rolled back, or a
 * row that commits with nothing ever scheduled to project it. With the queue in
 * Postgres those failures are not handled, they are *impossible by
 * construction*, and `withJob` is the only reason that stays true: it takes the
 * CALLER'S transaction handle and never opens a connection of its own.
 *
 * This is the enqueue half of the same contract `writeEvent` (@eutectic/events)
 * implements for the event half, and it is deliberately written in the same
 * shape.
 *
 * WHY THE REGISTRY LIVES HERE
 *
 * `packages/db` owns the `graphile-worker` dependency and `bootstrapQueue`.
 * Both sides of the queue import the registry from this one place: `apps/api`
 * enqueues, `apps/worker` handles. A name is a wire format the moment a row
 * carrying it is committed — a job sitting in the table outlives the deploy that
 * wrote it — so the name and its payload type have to be agreed in a package
 * both deployables depend on, not in either of them.
 */

import { context, propagation } from "@opentelemetry/api";
import type { JSONValue, TransactionSql } from "postgres";

import { resolveQueueSchema } from "./queue.js";

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * Every job name this system can enqueue.
 *
 * DELIBERATELY MINIMAL, AND ADDITIVE.
 *
 * **A job name lands in this list when its worker handler lands, and not
 * before.** A name here with no handler is a job that will be enqueued, retried
 * twenty-five times and then sit in the table failing forever; the compile-time
 * check in `apps/worker` exists precisely so that cannot happen, and it only
 * works if this list is grown one ticket at a time. Do not pre-populate this
 * with the M1/M2 catalogue "so it is ready" — an unhandled name is worse than a
 * missing one, because the missing one is a compile error at the call site.
 *
 * The two seeded here are the two M0 has a reason for:
 *
 *   - `projection.contribution` — SD §3 writes this one by name in its own
 *     example of transactional enqueue. It is the canonical shape: a
 *     contribution is written, and its projection work is scheduled in the same
 *     transaction.
 *   - `partition.ensure_ahead` — migration 0011 creates
 *     `events_ensure_partition(month_start date)` and says "a monthly scheduler
 *     job will call it some months ahead (that job is a later ticket)". This is
 *     that job's name. `events` has no DEFAULT partition by design (0011,
 *     Judgment 3), so an event whose month has no partition is REJECTED — the
 *     partition runway running out is an outage, not a degradation, which is
 *     why the maintenance job gets a name in M0 rather than waiting.
 *
 * Names are added, never renamed and never removed, for the same reason event
 * names are not (SD §4): a queued job row already carries the old string.
 *
 * `as const` makes this a readonly tuple of string literals, so {@link JobName}
 * is derived from it and the two can never disagree.
 */
export const JOB_NAMES = ["projection.contribution", "partition.ensure_ahead"] as const;

/** A job name. Anything else does not typecheck at the enqueue site. */
export type JobName = (typeof JOB_NAMES)[number];

/**
 * Payload for `projection.contribution`.
 *
 * One field, and it is the one without which the job is meaningless: the worker
 * has to know which contribution it is projecting. Everything else it needs it
 * reads from the row — by the time the job runs the row is committed, which is
 * the whole point of enqueueing inside the transaction, so copying columns into
 * the payload would only create a second, staler copy of them.
 *
 * `contributions.id` is `uuid` (migration 0004); it travels as its text form.
 */
export interface ProjectionContributionPayload {
  readonly contribution_id: string;
}

/**
 * Payload for `partition.ensure_ahead`.
 *
 * Empty on purpose. This is a maintenance tick: how many months of runway to
 * keep is the worker's configuration, not per-job data — putting it in the
 * payload would mean the answer is whatever the scheduler happened to think
 * three months ago, frozen in a row. `Record<string, never>` and not `{}`
 * because `{}` accepts any object at all, which would let a caller smuggle
 * untyped fields into a committed queue row (same reasoning as
 * `EmptyPayload` in @eutectic/events).
 */
export type PartitionEnsureAheadPayload = Record<string, never>;

/**
 * Job name → payload type.
 *
 * Every job gets its OWN exported type, even when it is empty. That is the
 * extension point: a later ticket adds a field to one interface and nothing
 * else in the codebase moves.
 *
 * Every shape here must survive `JSON.stringify` → json → `JSON.parse`: no
 * `Date`, no `bigint`, no `undefined` nested inside. Timestamps go in as ISO
 * strings.
 */
export interface JobPayloadMap {
  "projection.contribution": ProjectionContributionPayload;
  "partition.ensure_ahead": PartitionEnsureAheadPayload;
}

/**
 * Compile-time exhaustiveness, both directions.
 *
 * A name in {@link JOB_NAMES} with no entry in {@link JobPayloadMap}, or an
 * entry in the map that is not in the list, makes `Exact<...>` resolve to
 * `false`, and `Assert<false>` is an error. There is no way to add half a job.
 */
type Assert<T extends true> = T;
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export type JobPayloadMapCoversRegistry = Assert<Exact<keyof JobPayloadMap, JobName>>;

// ---------------------------------------------------------------------------
// withJob
// ---------------------------------------------------------------------------

/**
 * The knobs `graphile_worker.add_job` exposes that are worth exposing now.
 *
 * `add_job` takes nine arguments. This surface deliberately forwards three of
 * them, because every option is a promise: an option that reaches a committed
 * job row is an option whose semantics we own from then on.
 *
 *   - `queue_name` is omitted: it serialises jobs and graphile-worker's own
 *     docs warn that high-cardinality queue names degrade the whole pool. When
 *     something genuinely needs serialisation it should arrive with the ticket
 *     that needs it, and with a decision about cardinality.
 *   - `max_attempts` / `priority` are omitted: the defaults (25 attempts,
 *     priority 0) are uniform across every job we have, and a per-call retry
 *     policy is a thing to decide per job *type*, in the handler's ticket, not
 *     per call site.
 *   - `flags` is omitted: it is the rate-limiting/forbidden-flags mechanism and
 *     nothing in M0 has a rate limit to express.
 *   - `job_key_mode` is omitted, which pins it to graphile-worker's default,
 *     `'replace'` — see {@link JobOptions.jobKey}.
 */
export interface JobOptions {
  /**
   * Deduplication key. Two enqueues with the same `jobKey` leave ONE job.
   *
   * The mode is graphile-worker's default `'replace'`: the second enqueue
   * overwrites the pending job's payload and reschedules it, rather than being
   * dropped. That is the right default for the work this queue carries —
   * projections are idempotent recomputations where the latest input wins, so
   * collapsing a burst of edits into one job with the newest payload is exactly
   * what is wanted, and dropping the newest payload would leave a stale
   * projection.
   *
   * Note the boundary: `'replace'` only replaces a job that has NOT started.
   * Once a job is locked by a worker, a same-key enqueue creates a new job — so
   * dedupe is a throughput optimisation, never a correctness guarantee. Handlers
   * must be idempotent regardless (SD §3).
   */
  readonly jobKey?: string;
  /** Earliest time the job may run. Omitted means now. */
  readonly runAt?: Date;
  /**
   * The schema graphile-worker was installed into. Defaults to
   * `GRAPHILE_WORKER_SCHEMA` or `graphile_worker`, exactly as
   * {@link bootstrapQueue} and graphile-worker's own runner resolve it.
   *
   * Present so tests can isolate onto a throwaway queue schema. Application
   * code should not pass it.
   */
  readonly schema?: string;
}

// ---------------------------------------------------------------------------
// Trace propagation (M0-BE-20, system-design §13)
// ---------------------------------------------------------------------------

/**
 * THE PROPAGATION MECHANISM.
 *
 * graphile-worker jobs carry only a payload column — there is no metadata
 * channel alongside it — so the only place a trace id started at the HTTP
 * request can ride into the queue is inside that same JSON payload. `withJob`
 * injects it AUTOMATICALLY: it never takes a trace/span argument, and no call
 * site anywhere in this codebase needs to change. Instead, it reads whatever
 * OpenTelemetry span is active on the CALLER's ambient context
 * (`propagation.inject(context.active(), ...)`) at the moment it runs, and, if
 * one exists, writes a standard W3C `traceparent` string under this one
 * reserved key.
 *
 * `TRACE_FIELD` is a value outside {@link JobPayloadMap}'s vocabulary on
 * purpose — every payload interface stays exactly what its own ticket declared
 * — so the wire shape actually committed is `payload & { _trace?: TraceCarrier
 * }`, never surfaced to a handler's typed `payload` parameter.
 * `apps/worker`'s task wrapper (`tracing.ts`) is the only reader of this key
 * anywhere in the system: it strips it before the registered handler ever
 * sees the object.
 *
 * OPTIONAL, ALWAYS. A caller with no active span — a maintenance script, a
 * test that never registered a tracer provider, any enqueue that predates
 * this ticket — gets a payload with no `_trace` key at all:
 * `propagation.inject` on the default (unregistered) global propagator is a
 * documented no-op, so `currentTraceCarrier()` returns `undefined` and the
 * committed payload is byte-for-byte what it always was. Nothing about
 * enqueueing requires a tracer to be running anywhere.
 */
export const TRACE_FIELD = "_trace" as const;

/** The one field `_trace` ever carries: a W3C `traceparent` header value. */
export interface TraceCarrier {
  readonly traceparent: string;
}

/** The wire shape `withJob` actually commits: the caller's payload, plus the reserved trace key when a span was active. */
export type TracedPayload<T> = T & { readonly [TRACE_FIELD]?: TraceCarrier };

/**
 * Split a raw job payload (as `apps/worker` reads it back off a job row) into
 * the caller's own typed shape and the trace carrier, if any. The ONLY code
 * that should call this is the worker-side task wrapper — application
 * handlers receive the already-split `payload` and never see `_trace`.
 */
export function splitTraceCarrier<T extends object>(
  raw: TracedPayload<T>,
): { payload: T; trace: TraceCarrier | undefined } {
  const { [TRACE_FIELD]: trace, ...rest } = raw;
  return { payload: rest as T, trace };
}

/**
 * The active span's W3C `traceparent`, via whatever propagator is globally
 * registered — `undefined` when no span is active (including when no
 * `NodeTracerProvider` has ever been registered in this process, which is the
 * case for every existing test and for any caller that runs before
 * `apps/api`'s `instrumentation.ts` starts tracing).
 */
function currentTraceCarrier(): TraceCarrier | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  const traceparent = carrier["traceparent"];
  return typeof traceparent === "string" && traceparent.length > 0 ? { traceparent } : undefined;
}

/** What `add_job` gave back. Enough to log and to assert on; not the whole row. */
export interface EnqueuedJob {
  /**
   * The job id, as text. graphile-worker's `id` is `bigint`; postgres.js returns
   * int8 as a string, and this is cast in SQL so the shape does not change if
   * the pool is ever configured to parse bigints.
   */
  readonly id: string;
  /** Echoed back so a log line has the name without the caller repeating it. */
  readonly job_name: JobName;
  /** The time the row actually carries — `now()` when `runAt` was omitted. */
  readonly run_at: Date;
  /** The dedupe key, or `null` when none was given. */
  readonly job_key: string | null;
}

interface AddJobRow {
  readonly id: string;
  readonly run_at: Date;
  readonly job_key: string | null;
}

/**
 * The one widening in this module, kept to one line so it can be audited.
 *
 * Every payload in {@link JobPayloadMap} is a plain JSON object by construction
 * — no `Date`, no `bigint`, no symbol — but they are declared as INTERFACES, and
 * TypeScript gives an implicit index signature to type aliases only. So a
 * perfectly JSON-safe interface is not assignable to postgres.js's `JSONValue`
 * even though every value it can hold is. Nothing is unchecked here except that
 * structural technicality: the payload types are still enforced at every call
 * site. (Same widening, same reason, as `asJsonValue` in @eutectic/events.)
 */
function asJsonValue(payload: object): JSONValue {
  return payload as JSONValue;
}

/**
 * Enqueue one job inside the caller's transaction.
 *
 * @param tx  A transaction handle — the `sql` given to `sql.begin(...)`, or a
 *            savepoint handle inside one. NOT a pool. A pool handle would run
 *            `add_job` on some other connection, which commits the job
 *            independently of the domain write and reintroduces exactly the
 *            orphaned-job class of bug this function exists to make impossible.
 *            The type is the guard: `TransactionSql` is what `sql.begin` hands
 *            its callback and a plain `Sql` is not assignable to it.
 * @param jobName  A registry name. `payload` is constrained by it.
 * @param payload  The job's payload, typed by {@link JobPayloadMap}.
 * @param opts     See {@link JobOptions}.
 *
 * @returns The queued job's id, run time and key. Throws on any database error —
 *          nothing is swallowed. A failed enqueue MUST abort the caller's
 *          transaction; that is the contract, not a regrettable side effect.
 *
 * @example
 * await sql.begin(async (tx) => {
 *   const [row] = await tx`INSERT INTO contributions (...) RETURNING id`;
 *   await writeEvent(tx, { event_type: "contribution.created", ... });
 *   await withJob(tx, "projection.contribution", { contribution_id: row.id });
 * });
 */
export async function withJob<N extends JobName>(
  tx: TransactionSql,
  jobName: N,
  payload: JobPayloadMap[N],
  opts: JobOptions = {},
): Promise<EnqueuedJob> {
  const schema = resolveQueueSchema(opts.schema);

  // See "THE PROPAGATION MECHANISM" above `TRACE_FIELD`: automatic, optional,
  // and the only reason this function ever imports `@opentelemetry/api`.
  const traceCarrier = currentTraceCarrier();
  const wirePayload: object =
    traceCarrier === undefined ? payload : { ...payload, [TRACE_FIELD]: traceCarrier };

  // `add_job` is called in the FROM clause rather than the select list. It
  // returns a whole `_private_jobs` composite, and
  // `SELECT (add_job(...)).id, (add_job(...)).run_at` would call the function
  // once per projected field — enqueueing the job two or three times. In FROM it
  // is evaluated exactly once and its columns are addressable.
  //
  // Arguments are NAMED (`identifier :=`) so every argument we do not pass takes
  // the function's own default. Positional arguments would pin us to the
  // nine-argument order of one graphile-worker version; the names are stable
  // across all of them.
  //
  // Verified against graphile-worker 0.17.3, sql/000018.sql:
  //   add_job(identifier text, payload json DEFAULT NULL, queue_name text
  //   DEFAULT NULL, run_at timestamptz DEFAULT NULL, max_attempts integer
  //   DEFAULT NULL, job_key text DEFAULT NULL, priority integer DEFAULT NULL,
  //   flags text[] DEFAULT NULL, job_key_mode text DEFAULT 'replace')
  //   RETURNS graphile_worker._private_jobs
  //
  // THE PAYLOAD BINDING. `tx.json(...)::json`, and both halves are load-bearing.
  //
  //   - `tx.json(x)` binds the value as a typed parameter (postgres.js
  //     src/index.js: `new Parameter(x, 3802)`), JSON-encoded exactly once.
  //     `${JSON.stringify(x)}::json` does NOT work and fails silently, which is
  //     the trap @eutectic/events documents on its own insert: postgres.js sends
  //     an untyped parameter, the server replies with the type it inferred from
  //     the cast (connection.js `ParameterDescription` back-fills
  //     `statement.types[i]`), and postgres.js then serialises with the handler
  //     for that type — JSON-encoding the ALREADY-encoded string. The job lands
  //     with a json *string scalar* payload, `json_typeof` says `string`, every
  //     `payload->>'contribution_id'` returns null, and nothing complains until a
  //     handler quietly reads nothing. Reproduced against this database before
  //     this line was written.
  //   - The `::json` cast is REQUIRED, not decoration. `tx.json` binds jsonb
  //     (3802) and `add_job`'s parameter is `json` (114). There is no implicit
  //     jsonb → json coercion, so without the cast the call does not resolve at
  //     all: `function graphile_worker.add_job(identifier => unknown, payload =>
  //     jsonb, ...) does not exist`. Loud, at least — but the cast is free and
  //     the failure is avoidable.
  const rows = await tx<AddJobRow[]>`
    SELECT j.id::text AS id, j.run_at, j.key AS job_key
    FROM ${tx(schema)}.add_job(
      identifier := ${jobName},
      payload    := ${tx.json(asJsonValue(wirePayload))}::json,
      run_at     := ${opts.runAt ?? null},
      job_key    := ${opts.jobKey ?? null}
    ) AS j
  `;

  const row = rows[0];
  if (row === undefined) {
    // Unreachable: `add_job` returns a composite, never zero rows, and any
    // failure inside it raises. Guarded because `noUncheckedIndexedAccess` is on
    // and a silent `undefined` in the reliability spine is not a thing to shrug
    // at.
    throw new Error(`withJob: add_job('${jobName}') produced no row`);
  }

  return { id: row.id, job_name: jobName, run_at: row.run_at, job_key: row.job_key };
}
