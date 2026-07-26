/**
 * Per-request tracing and the log/trace correlation it makes possible
 * (M0-BE-20, system-design §13).
 *
 * ONE SPAN PER HTTP REQUEST, made the ACTIVE OpenTelemetry context for that
 * request's entire lifetime — not merely attached to `request` for callers
 * that know to look it up. That distinction is the whole mechanism: it is
 * what lets `packages/db`'s `withJob` pick up the request's trace and inject
 * a `traceparent` into an enqueued job with NO parameter threaded through
 * route handler → domain code → `withJob`'s call site. "Automatic, not
 * per-call-site" (the ticket's own words) requires that by the time a route
 * handler calls into `withJob`, `trace.getActiveSpan()` already answers with
 * this request's span — which is exactly what "active context" means.
 *
 * HOW ONE `onRequest` HOOK MAKES THE WHOLE REQUEST LIFECYCLE SEE THE SPAN
 *
 * `context.with(ctx, fn)` only wraps the SYNCHRONOUS extent of `fn` — but
 * `AsyncLocalStorage` (which `NodeTracerProvider.register()` installs as
 * OpenTelemetry's context manager, see `instrumentation.ts`) does not track
 * lexical scope, it tracks ASYNC CAUSALITY: every promise a callback starts,
 * and every continuation of it, inherits the same store regardless of where
 * later code that reacts to it was defined. Fastify's own dispatcher awaits
 * each hook's completion before moving to the next one (or to the route
 * handler); calling this hook's `done()` from INSIDE `context.with(...)` means
 * the promise fastify is awaiting resolves inside the traced context, so
 * every hook, the handler, and everything they `await`, downstream of that
 * resolution, are causally inside it too. This is the standard technique
 * every Node APM library uses to make context "ambient" across a framework's
 * own dispatch loop without patching the framework itself, and it needs
 * nothing beyond `@opentelemetry/api`.
 *
 * The span ends in `onResponse` (so it covers the whole request, error
 * responses included) and records an exception in `onError` when the error
 * handler runs.
 */

import { context, propagation, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
import type { FastifyInstance } from "fastify";

import { getTracer } from "./instrumentation.js";

declare module "fastify" {
  interface FastifyRequest {
    /** The request-lifetime span. Set by `installRequestTracing`'s `onRequest` hook; read by its `onResponse`/`onError` hooks. Not part of the public app surface. */
    otelSpan?: Span;
  }
}

/**
 * Installs the request-span hooks on `app`. Call once, before any hook whose
 * own log lines should carry `trace_id`/`span_id` — this app registers it
 * first, ahead of the request-id echo and Accept-negotiation hooks in
 * `app.ts`, so both are inside the traced context too.
 */
export function installRequestTracing(app: FastifyInstance): void {
  const tracer = getTracer();

  app.addHook("onRequest", (request, _reply, done) => {
    const span = tracer.startSpan(`${request.method} ${request.routeOptions.url ?? request.url}`, {
      kind: SpanKind.SERVER,
      attributes: {
        "http.method": request.method,
        "http.target": request.url,
      },
    });
    request.otelSpan = span;

    const activeContext = trace.setSpan(context.active(), span);
    // See the module doc comment: everything fastify does after `done()`
    // resolves — every remaining hook, the route handler, everything they
    // `await` — inherits `activeContext` through AsyncLocalStorage's causal
    // tracking, not through anything passed explicitly.
    context.with(activeContext, () => {
      done();
    });
  });

  app.addHook("onResponse", async (request, reply) => {
    const span = request.otelSpan;
    if (span === undefined) return;
    span.setAttribute("http.status_code", reply.statusCode);
    if (reply.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
  });

  app.addHook("onError", async (request, _reply, error) => {
    request.otelSpan?.recordException(error);
  });
}

/**
 * Pino `mixin()`: adds `trace_id`/`span_id` to every log line while a span is
 * active, and nothing when it is not (a maintenance script, a test that never
 * called `startTracing()`). Additive — see `withTracingMixin` in `app.ts`,
 * which composes this with whatever `mixin` a caller already configured
 * rather than replacing it, per this ticket's instruction not to rip out the
 * existing pino config.
 */
export function tracingMixin(): Record<string, string> {
  const span = trace.getActiveSpan();
  if (span === undefined) return {};

  const spanContext = span.spanContext();
  if (!trace.isSpanContextValid(spanContext)) return {};

  return { trace_id: spanContext.traceId, span_id: spanContext.spanId };
}

// `propagation` is imported for its side-effect-free re-export surface used by
// `packages/db` and `apps/worker`; nothing in THIS file calls it directly, but
// keeping the import here (rather than only in those packages) documents that
// the same `@opentelemetry/api` instance's global propagator — registered by
// `instrumentation.ts`'s `startTracing()` — is what request-span creation here
// and job-payload injection there both read from and write to.
void propagation;
