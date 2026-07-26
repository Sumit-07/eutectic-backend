/**
 * The worker-side half of trace propagation through the queue (M0-BE-20,
 * system-design §13).
 *
 * MECHANISM (see `packages/db/src/jobs.ts`'s doc comment for the enqueue
 * side): `withJob` merges a reserved `_trace: { traceparent }` field into the
 * JSON payload it writes, automatically, whenever a span is active at the
 * call site — no per-call-site code, and the field is entirely absent when
 * nothing was tracing. graphile-worker hands that raw payload straight to
 * whichever handler `taskList[jobName]` names; `traced()` below sits between
 * the two:
 *
 *   1. `splitTraceCarrier` (from `@eutectic/db`, the one function that knows
 *      the reserved field's name) strips `_trace` off the raw payload the
 *      handler was ABOUT to receive.
 *   2. If a carrier was present, `propagation.extract` turns its
 *      `traceparent` string back into a `Context` carrying a remote
 *      `SpanContext` — the same `@opentelemetry/api` global propagator
 *      `NodeTracerProvider.register()` installed, used in reverse.
 *   3. A new span for this job is started AS A CHILD of that remote context
 *      (or as a root span, if the job was enqueued with no trace active —
 *      "jobs enqueued outside a trace still work" is exactly this branch).
 *   4. The real handler runs with the CLEAN, stripped payload — its declared
 *      type (`JobPayloadMap[N]`) never mentions `_trace`, and now its runtime
 *      shape does not either.
 *
 * `tasks.ts` wraps every handler in `buildTaskRegistry` with this, so nothing
 * about an individual handler's body needs to know tracing exists.
 *
 * RETENTION (system-design §13, quoted verbatim): "Output only. Prompt hashes
 * and token counts, not full reasoning traces." This wrapper logs job
 * lifecycle events (start/complete/fail) and trace ids — never a job's
 * payload contents, and it must stay that way once a real handler exists here.
 * The seam where inference logging will hook is `projection.contribution`'s
 * real handler (`tasks.ts`, still a stub as of this ticket): when that handler
 * calls the model, whatever logs the prompt/response is the place the same
 * rule applies — a hash and a token count, never the reasoning text itself.
 * This wrapper cannot enforce that (it never sees inside the handler's body),
 * so it is noted here, at the one seam every job passes through, rather than
 * silently assumed.
 */

import { splitTraceCarrier } from "@eutectic/db";
import type { JobName, JobPayloadMap, TracedPayload } from "@eutectic/db";
import { propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { JobHelpers, Task } from "graphile-worker";

import { getTracer } from "./instrumentation.js";

/**
 * Wrap one handler so it (a) receives a payload with `_trace` already
 * stripped, and (b) runs inside a span linked to the enqueueing request's
 * trace when one existed.
 */
export function traced<N extends JobName>(name: N, handler: Task<N>): Task<N> {
  return async (rawPayload, helpers: JobHelpers) => {
    const { payload, trace: carrier } = splitTraceCarrier(
      rawPayload as TracedPayload<JobPayloadMap[N]>,
    );

    const parentContext =
      carrier === undefined ? ROOT_CONTEXT : propagation.extract(ROOT_CONTEXT, carrier);

    const tracer = getTracer();
    await tracer.startActiveSpan(name, { kind: SpanKind.CONSUMER }, parentContext, async (span) => {
      const spanContext = span.spanContext();
      const fields = trace.isSpanContextValid(spanContext)
        ? { trace_id: spanContext.traceId, span_id: spanContext.spanId }
        : {};

      helpers.logger.info(`${name}: started`, { ...fields });
      try {
        // `payload`'s inferred type (`JobPayloadMap[N]`, from `splitTraceCarrier`'s
        // own generic) and `handler`'s declared parameter type (`Task<N>`'s
        // `N extends keyof Tasks ? Tasks[N] : unknown`) are the SAME type by
        // construction — `GraphileWorker.Tasks` is augmented to equal
        // `JobPayloadMap` in `tasks.ts` — but TypeScript cannot reduce a
        // conditional type over a still-generic `N`, so it sees two opaque
        // types it cannot prove equal. The cast asserts what the module
        // augmentation already guarantees.
        await handler(payload as Parameters<typeof handler>[0], helpers);
        helpers.logger.info(`${name}: completed`, { ...fields });
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        helpers.logger.error(`${name}: failed`, {
          ...fields,
          err: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        span.end();
      }
    });
  };
}
