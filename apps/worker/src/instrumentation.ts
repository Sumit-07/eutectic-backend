/**
 * OpenTelemetry wiring for the worker process (M0-BE-20, system-design §13).
 *
 * Mirrors `apps/api/src/instrumentation.ts` exactly, service name aside — see
 * that file's doc comment for why this is a separate, explicitly-called
 * module rather than an import-time side effect, why the dependency set stops
 * at `@opentelemetry/api` + `@opentelemetry/sdk-trace-node`, and why the
 * default exporter is a `ConsoleSpanExporter` with an injection point for a
 * real backend later.
 *
 * `main.ts` calls `startTracing()` before `startWorker()`, so a
 * `NodeTracerProvider` (and the W3C propagator `apps/worker/src/tracing.ts`'s
 * task wrapper reads through `propagation.extract`) is registered before the
 * first job is ever picked up.
 */

import { trace } from "@opentelemetry/api";
import type { Tracer } from "@opentelemetry/api";
import { ConsoleSpanExporter, NodeTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
import type { SpanExporter } from "@opentelemetry/sdk-trace-node";

export const SERVICE_NAME = "eutectic-worker";

export interface StartTracingOptions {
  readonly exporter?: SpanExporter;
}

let started = false;

/** Idempotent — see `apps/api/src/instrumentation.ts`'s `startTracing` for why. */
export function startTracing(options: StartTracingOptions = {}): void {
  if (started) return;
  started = true;

  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(options.exporter ?? new ConsoleSpanExporter())],
  });
  provider.register();
}

/** A tracer scoped to this service. Safe to call whether or not `startTracing()` ran. */
export function getTracer(): Tracer {
  return trace.getTracer(SERVICE_NAME);
}
