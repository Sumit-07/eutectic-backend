/**
 * OpenTelemetry wiring for the API process (M0-BE-20, system-design §13:
 * "Tracing | OpenTelemetry, trace id from request through queue jobs").
 *
 * A single module, called EXPLICITLY. Importing this file does nothing —
 * `startTracing()` is the only thing that registers a provider, and only
 * `main.ts` calls it, before `buildApp()`. That is deliberate: an
 * import-time side effect here would mean every test that imports `app.ts`
 * (which imports this file transitively once `tracing.ts` lands) silently
 * registers a global tracer provider as a side effect of importing a route
 * module — exactly the kind of hidden global mutation CLAUDE.md rule 12's
 * spirit and this ticket's own instructions rule out for library packages,
 * and it is no better an idea in an app.
 *
 * DEPENDENCIES: `@opentelemetry/api` (the interfaces + global registries) and
 * `@opentelemetry/sdk-trace-node` (`NodeTracerProvider`). Nothing else.
 * `NodeTracerProvider.register()` pulls in `@opentelemetry/context-async-hooks`
 * (the `AsyncLocalStorage`-based context manager) and `@opentelemetry/core`
 * (the W3C `traceparent`/`tracestate` propagators) itself, as ITS OWN
 * transitive dependencies — this module never imports either directly, so
 * they are not declared here even transitively-by-name.
 *
 * EXPORTER: a `ConsoleSpanExporter` by default — the only exporter dependency
 * this ticket takes, and it ships inside `@opentelemetry/sdk-trace-node`
 * itself, not as a separate package. `StartTracingOptions.exporter` is the
 * injection point for a later ticket to point this at a real backend (OTLP,
 * a vendor collector, whatever M1 decides) without touching this module's
 * shape.
 */

import { trace } from "@opentelemetry/api";
import type { Tracer } from "@opentelemetry/api";
import { ConsoleSpanExporter, NodeTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
import type { SpanExporter } from "@opentelemetry/sdk-trace-node";

/** The name every span and every structured log line's `service` field carries. */
export const SERVICE_NAME = "eutectic-api";

export interface StartTracingOptions {
  /**
   * Where finished spans go. Defaults to a `ConsoleSpanExporter` — spans as
   * JSON on stdout, good enough to prove propagation end-to-end in M0 and
   * nothing this ticket needs a real backend for. Injectable so a later
   * ticket can swap it without touching call sites.
   */
  readonly exporter?: SpanExporter;
}

let started = false;

/**
 * Register a `NodeTracerProvider` as the global tracer provider and context
 * manager. Idempotent: a second call (a second test importing `main.ts`'s
 * module graph, a hot-reload) is a no-op rather than a duplicate
 * registration warning.
 *
 * `register()`'s defaults (see `NodeTracerProvider`'s own source) are exactly
 * what this ticket needs and nothing more:
 *   - context manager: `AsyncLocalStorageContextManager`, so a span made
 *     active via `context.with(...)` is visible to `trace.getActiveSpan()`
 *     anywhere causally downstream — every `await`, every promise continuation
 *     — with no context object threaded through any call site.
 *   - propagator: a composite of the W3C `traceparent` and `baggage` headers,
 *     which is what makes `propagation.inject`/`propagation.extract` in
 *     `packages/db`'s `withJob` and `apps/worker`'s task wrapper produce and
 *     read a standard `traceparent` string with zero extra code here.
 */
export function startTracing(options: StartTracingOptions = {}): void {
  if (started) return;
  started = true;

  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(options.exporter ?? new ConsoleSpanExporter())],
  });
  provider.register();
}

/** A tracer scoped to this service. Safe to call whether or not `startTracing()` ran — falls back to OpenTelemetry's no-op tracer. */
export function getTracer(): Tracer {
  return trace.getTracer(SERVICE_NAME);
}
