/**
 * End-to-end trace propagation, the HTTP half (M0-BE-20, system-design §13):
 * a request's span is active all the way from `onRequest` through a route
 * handler's own `withJob` call, with NO parameter threaded through either —
 * see `../tracing.ts`'s doc comment for the causality argument this proves in
 * practice, and `packages/db/src/jobs.ts` / `apps/worker/src/tracing.ts` for
 * the enqueue/dequeue halves this test connects.
 *
 *   pnpm --filter @eutectic/api test
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { bootstrapQueue, createPool, requireDatabaseUrl, withJob } from "@eutectic/db";
import type { Sql } from "@eutectic/db";

import { buildApp } from "../app.js";
import { stubHandlers } from "../handlers.js";
import { startTracing } from "../instrumentation.js";
import { API_MEDIA_TYPE, API_PREFIX } from "../index.js";

const silent = (): void => {};
const suffix = (): string => randomUUID().replace(/-/g, "").slice(0, 12);

let sql: Sql;
let queueSchema: string;

before(async () => {
  const url = requireDatabaseUrl();
  sql = createPool({ url, max: 2 });
  queueSchema = `gw_m0be20api_${suffix()}`;
  await bootstrapQueue({ url, schema: queueSchema, log: silent });

  // Without this, `installRequestTracing`'s `tracer.startSpan(...)` produces
  // OpenTelemetry's no-op span — a real `SpanContext` with `isRemote`/ids
  // needs a registered provider, exactly as `apps/worker`'s equivalent test
  // needs its own `startTracing()`. Idempotent.
  startTracing();
});

after(async () => {
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${queueSchema}" CASCADE`);
  await sql.end();
});

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

describe("request span → withJob (M0-BE-20)", () => {
  it("a job enqueued from inside a route handler carries the request's trace id, and the same id appears on the request's own log lines", async () => {
    let enqueuedId: string | undefined;
    const lines: string[] = [];

    const app = buildApp({
      logger: {
        level: "info",
        stream: {
          write(line: string): void {
            lines.push(line);
          },
        },
      },
      handlers: {
        ...stubHandlers,
        getFeed: async () => {
          const contributionId = randomUUID();
          // No trace/span argument anywhere in this call — see
          // `withJob`'s doc comment on `currentTraceCarrier`. The route
          // handler has no idea tracing exists.
          const enqueued = await sql.begin((tx) =>
            withJob(tx, "projection.contribution", { contribution_id: contributionId }, {
              schema: queueSchema,
            }),
          );
          enqueuedId = enqueued.id;
          return { items: [], page: { next_cursor: null, has_more: false } };
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: `${API_PREFIX}/feed`,
      headers: { accept: API_MEDIA_TYPE },
    });
    assert.equal(response.statusCode, 200);
    assert.ok(enqueuedId, "the handler never enqueued a job");

    const raw = await readPayload(enqueuedId);
    const carrier = raw["_trace"] as { traceparent?: string } | undefined;
    assert.ok(carrier?.traceparent, "job row carries no _trace.traceparent");

    const records = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => typeof record["trace_id"] === "string");
    assert.ok(records.length > 0, "no request log line carried a trace_id");

    const traceId = records[0]?.["trace_id"] as string;
    assert.ok(
      carrier.traceparent.includes(traceId),
      `traceparent ${carrier.traceparent} does not carry the request's trace id ${traceId}`,
    );

    // Every log line for this request agrees on the trace id — it is the
    // SAME active span throughout, not a new one per hook.
    for (const record of records) {
      assert.equal(record["trace_id"], traceId, JSON.stringify(record));
    }
  });
});
