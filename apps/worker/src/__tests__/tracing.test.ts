/**
 * End-to-end trace propagation (M0-BE-20, system-design §13): a span active at
 * enqueue → `withJob`'s automatic `_trace` field → the job row, as actually
 * committed by Postgres → `traced()`'s extraction, on the worker side.
 *
 * Three things are proven, against a real throwaway queue schema (never the
 * shared `graphile_worker` one — see `packages/db`'s `jobs.test.ts` for why):
 *
 *   1. Enqueueing WITH an active span writes a `_trace.traceparent` carrying
 *      that span's trace id into the row's `payload` column — read back with
 *      raw SQL, exactly the way `apps/worker`'s real runner would see it.
 *   2. Feeding that raw row payload through `traced()` reconstructs a span
 *      whose trace id matches the ORIGINAL request's, and the wrapped
 *      handler receives a payload with `_trace` already stripped — its shape
 *      is exactly what `ProjectionContributionPayload` declares, nothing more.
 *   3. Enqueueing with NO active span (the case for every caller that
 *      predates this ticket) round-trips with no `_trace` key at all, and
 *      `traced()` still runs the handler — inside a fresh root span, not a
 *      crash and not a skipped job. "Optional, always" (jobs.ts) means both
 *      directions work, not only the traced one.
 *
 *   pnpm --filter @eutectic/worker test
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { bootstrapQueue, createPool, requireDatabaseUrl, withJob } from "@eutectic/db";
import type { Sql } from "@eutectic/db";
import { context, trace } from "@opentelemetry/api";
import type { JobHelpers } from "graphile-worker";

import { getTracer, startTracing } from "../instrumentation.js";
import { traced } from "../tracing.js";

const silent = (): void => {};
const suffix = (): string => randomUUID().replace(/-/g, "").slice(0, 12);

let sql: Sql;
let queueSchema: string;

before(async () => {
  const url = requireDatabaseUrl();
  sql = createPool({ url, max: 2 });
  queueSchema = `gw_m0be20_${suffix()}`;
  await bootstrapQueue({ url, schema: queueSchema, log: silent });

  // Registers the global tracer provider + W3C propagator this whole test
  // relies on. Idempotent — a no-op if some earlier test in the same process
  // already called it.
  startTracing();
});

after(async () => {
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${queueSchema}" CASCADE`);
  await sql.end();
});

/** Reads a job row's payload back exactly as the worker's runner would see it — raw JSON, no typed narrowing. */
async function readPayload(jobId: string): Promise<Record<string, unknown>> {
  const rows = await sql<{ payload_text: string }[]>`
    SELECT j.payload::text AS payload_text
    FROM ${sql(queueSchema)}.${sql("_private_jobs")} AS j
    WHERE j.id = ${jobId}::bigint
  `;
  const row = rows[0];
  assert.ok(row, `no job row for id ${jobId}`);
  return JSON.parse(row.payload_text) as Record<string, unknown>;
}

/** Enough of `JobHelpers` for `traced()` and a test handler to run — both only ever touch `.logger`. */
function fakeHelpers(): JobHelpers {
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  return { logger } as unknown as JobHelpers;
}

describe("trace propagation — withJob → job row", () => {
  it("writes _trace.traceparent carrying the active span's trace id", async () => {
    const tracer = getTracer();
    const span = tracer.startSpan("test-request");
    const activeContext = trace.setSpan(context.active(), span);
    const contributionId = randomUUID();

    const enqueued = await context.with(activeContext, () =>
      sql.begin((tx) =>
        withJob(tx, "projection.contribution", { contribution_id: contributionId }, {
          schema: queueSchema,
        }),
      ),
    );
    span.end();

    const raw = await readPayload(enqueued.id);
    const carrier = raw["_trace"] as { traceparent?: string } | undefined;
    assert.ok(carrier?.traceparent, "job row carries no _trace.traceparent");

    const spanContext = span.spanContext();
    // W3C traceparent: "00-<32 hex trace id>-<16 hex span id>-<2 hex flags>".
    assert.ok(
      carrier.traceparent.includes(spanContext.traceId),
      `traceparent ${carrier.traceparent} does not carry trace id ${spanContext.traceId}`,
    );
  });

  it("round-trips with no _trace key when no span was active", async () => {
    const contributionId = randomUUID();
    const enqueued = await sql.begin((tx) =>
      withJob(tx, "projection.contribution", { contribution_id: contributionId }, {
        schema: queueSchema,
      }),
    );

    const raw = await readPayload(enqueued.id);
    assert.equal(raw["_trace"], undefined);
    assert.deepEqual(raw, { contribution_id: contributionId });
  });
});

describe("trace propagation — traced() on the worker side", () => {
  it("reconstructs the enqueuing span's trace id and strips _trace before the handler runs", async () => {
    const tracer = getTracer();
    const requestSpan = tracer.startSpan("test-request-2");
    const requestContext = trace.setSpan(context.active(), requestSpan);
    const contributionId = randomUUID();

    const enqueued = await context.with(requestContext, () =>
      sql.begin((tx) =>
        withJob(tx, "projection.contribution", { contribution_id: contributionId }, {
          schema: queueSchema,
        }),
      ),
    );
    const requestTraceId = requestSpan.spanContext().traceId;
    requestSpan.end();

    const rawPayload = await readPayload(enqueued.id);

    let seenPayload: unknown;
    let seenTraceId: string | undefined;
    const handler = traced("projection.contribution", async (payload) => {
      seenPayload = payload;
      seenTraceId = trace.getActiveSpan()?.spanContext().traceId;
    });

    // Exactly what graphile-worker's runner would hand the registered task:
    // the raw row payload, untyped, `_trace` and all.
    await handler(rawPayload as never, fakeHelpers());

    assert.deepEqual(seenPayload, { contribution_id: contributionId });
    assert.equal(seenTraceId, requestTraceId, "handler did not run inside the request's trace");
  });

  it("still runs the handler, inside a fresh root span, when the job carried no trace", async () => {
    const contributionId = randomUUID();
    const enqueued = await sql.begin((tx) =>
      withJob(tx, "projection.contribution", { contribution_id: contributionId }, {
        schema: queueSchema,
      }),
    );
    const rawPayload = await readPayload(enqueued.id);
    assert.equal(rawPayload["_trace"], undefined);

    let seenPayload: unknown;
    let sawValidSpan = false;
    const handler = traced("projection.contribution", async (payload) => {
      seenPayload = payload;
      const spanContext = trace.getActiveSpan()?.spanContext();
      sawValidSpan = spanContext !== undefined && trace.isSpanContextValid(spanContext);
    });

    await handler(rawPayload as never, fakeHelpers());

    assert.deepEqual(seenPayload, { contribution_id: contributionId });
    assert.ok(sawValidSpan, "traced() must start its own span even with no incoming trace");
  });
});
