/**
 * Structured JSON logging for the worker process (M0-BE-20, system-design
 * §13: "Logs | Structured JSON, no PII in logs").
 *
 * graphile-worker's own logging is pluggable through a `LogFunctionFactory` —
 * `run({ logger })` takes a `Logger` built from one — rather than through any
 * hook we would otherwise have to monkey-patch. `LogScope` (the shape scope
 * carries: `label`, `workerId`, `taskIdentifier`, `jobId`) is not exported
 * from graphile-worker's package root, but `LogFunctionFactory` IS, fixed to
 * exactly that scope type — so `structuredLogFactory` below gets `scope`'s
 * shape inferred structurally, with no need to name `LogScope` at all.
 *
 * One JSON line per call on stdout (stderr for `error`), carrying whatever
 * `scope` graphile-worker supplied (job name is `scope.taskIdentifier`, job id
 * is `scope.jobId` — "job name, job id... when present" from this ticket's
 * acceptance criteria) plus whatever `meta` the caller passed — which is how
 * `tracing.ts`'s task wrapper attaches `trace_id`/`span_id` per call, without
 * this factory needing to know OpenTelemetry exists.
 */

import { Logger } from "graphile-worker";
import type { LogFunctionFactory } from "graphile-worker";

const SERVICE_NAME = "eutectic-worker";

const structuredLogFactory: LogFunctionFactory = (scope) => (level, message, meta) => {
  const line = {
    ts: new Date().toISOString(),
    level,
    service: SERVICE_NAME,
    message,
    ...scope,
    ...meta,
  };
  const serialized = JSON.stringify(line);
  if (level === "error") process.stderr.write(`${serialized}\n`);
  else process.stdout.write(`${serialized}\n`);
};

/** A fresh `Logger` wired to the structured factory above. One per `run({ logger })` call. */
export function createWorkerLogger(): Logger {
  return new Logger(structuredLogFactory);
}
