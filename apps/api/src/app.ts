/**
 * The Fastify app (M0-BE-15, system-design §2 and §9).
 *
 * `buildApp()` returns a configured, un-listening instance. Importing this
 * module starts nothing — the executable is `main.ts`, same split as
 * `apps/worker`, so tests can `inject()` without a port and the smoke test of
 * an import never leaves a socket behind.
 *
 * Four cross-cutting concerns live here and nowhere else:
 *
 *   1. request id   — honoured inbound, generated otherwise, echoed and logged
 *   2. Accept       — `application/vnd.staffroom.v1+json` or `406`
 *   3. errors       — one envelope, one exit, including 404s and body failures
 *   4. idempotency  — `Idempotency-Key` on every mutating route (M0-BE-16),
 *                     delegated to `idempotency.ts`
 *   5. route binding — delegated to `routes.ts`, driven by the contract
 *
 * NODE TYPES, disclosed rather than assumed: this package declares no
 * `@types/node` (CLAUDE.md rule 12; D-010 defers the question to M0-SH-05).
 * It typechecks because `pino-std-serializers`, a runtime dependency of
 * fastify, carries `/// <reference types="node" />`, and pnpm's virtual store
 * has `@types/node` in it because other packages in this repo depend on it.
 * That is honest but fragile — it is a property of the whole workspace's
 * install, not of this package's manifest. `packages/events` hand-declares its
 * Node surface for the same reason (D-016 item 4); this app cannot, because a
 * hand-declared `node:crypto` would collide with the ambient one already in
 * the program. M0-SH-05 approving `@types/node` workspace-wide settles it.
 */

import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import type { FastifyInstance, FastifyServerOptions } from "fastify";

import { ApiFailure, errorEnvelope, isApiFailure } from "./errors.js";
import type { ErrorCode, ErrorDetail } from "./errors.js";
import { stubHandlers } from "./handlers.js";
import type { HandlerRegistry } from "./handlers.js";
import { registerIdempotency } from "./idempotency.js";
import type { IdempotencyTuning } from "./idempotency.js";
import { createIdempotencyStore } from "./idempotency-store.js";
import type { IdempotencyPool } from "./idempotency-store.js";
import { REQUEST_ID_HEADER, REQUEST_ID_LOG_LABEL, sanitizeRequestId } from "./request-id.js";
import { registerContractRoutes } from "./routes.js";
import type { ContractRouteConfig, RegisteredRoute } from "./routes.js";
import { acceptsApiMediaType, API_MEDIA_TYPE } from "./versioning.js";

export interface BuildAppOptions {
  /**
   * Passed straight to fastify. Defaults to pino at `info` on stdout —
   * structured JSON, request id on every line. Observability polish (trace
   * ids, redaction, sampling) is M0-BE-20's, not this ticket's.
   */
  readonly logger?: FastifyServerOptions["logger"];
  /**
   * The operation implementations. Defaults to `stubHandlers` — every route
   * `501`. Injectable so later tickets can bind real handlers, and so a test
   * can prove the adapter's success path without inventing a route.
   */
  readonly handlers?: HandlerRegistry;
  /**
   * The Postgres pool the `Idempotency-Key` store runs on (M0-BE-16).
   *
   * Injected rather than opened here, for the same reason handlers are: a test
   * hands in a pool pinned to a throwaway schema, `main.ts` hands in the
   * process pool, and this module owns no connection lifecycle.
   *
   * Omitting it is legal and means "no store": every read still works, and
   * every MUTATING route fails closed with a `500`. Serving mutations without
   * deduplication because a pool was forgotten is the one outcome this ticket
   * exists to prevent, so it is not on the menu.
   */
  readonly pool?: IdempotencyPool;
  /** Wait, poll and takeover windows for the idempotency middleware. Defaults are in `idempotency.ts`. */
  readonly idempotency?: IdempotencyTuning;
}

/**
 * The statuses the contract declares, mapped to the `ErrorCode` it declares
 * with them. Anything a framework throws that is not in this table is coerced
 * rather than passed through: a status the contract does not document is a
 * status a client has no code branch for.
 */
const STATUS_TO_CODE: ReadonlyMap<number, ErrorCode> = new Map<number, ErrorCode>([
  [400, "bad_request"],
  [401, "unauthorized"],
  [403, "forbidden"],
  [404, "not_found"],
  [406, "not_acceptable"],
  [409, "idempotency_conflict"],
  [422, "unprocessable"],
  [429, "rate_limited"],
  [500, "internal"],
]);

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? true,

    // Fastify's own header handling is disabled so an inbound id passes
    // `sanitizeRequestId` first. An unchecked client value goes into a
    // response header and a log line; neither tolerates a newline.
    requestIdHeader: false,
    // FSTDEP024 marks this deprecated in favour of `logController`. Kept
    // anyway, deliberately: fastify 5.10's `logController` option is typed as
    // a class but validated at runtime with `instanceof`, so the replacement
    // does not typecheck and the class form throws. The option works
    // correctly in fastify 5; migrating belongs to the fastify 6 upgrade, or
    // to M0-BE-20, whichever comes first.
    requestIdLogLabel: REQUEST_ID_LOG_LABEL,
    genReqId: (request) => sanitizeRequestId(request.headers[REQUEST_ID_HEADER]) ?? randomUUID(),
  });

  // ---------------------------------------------------------------------
  // The observed route surface (system-design §2)
  // ---------------------------------------------------------------------
  // Registered before any route so the hook sees all of them, including
  // anything a later ticket adds by hand — which is the drift the test
  // downstream of this array is looking for.
  const registeredRoutes: RegisteredRoute[] = [];
  app.decorate("registeredRoutes", registeredRoutes);
  app.addHook("onRoute", (route) => {
    // Fastify expands a single registration into one entry per method, and
    // adds a HEAD for every GET. HEAD is not a contract operation; it is
    // fastify serving GET's headers, so it is not part of the surface.
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === "HEAD") continue;
      registeredRoutes.push({ method, url: route.url });
    }
  });

  // ---------------------------------------------------------------------
  // Request id: echoed on every response, error responses included
  // ---------------------------------------------------------------------
  app.addHook("onRequest", async (request, reply) => {
    void reply.header(REQUEST_ID_HEADER, request.id);
  });

  // ---------------------------------------------------------------------
  // Accept negotiation (system-design §2)
  // ---------------------------------------------------------------------
  app.addHook("onRequest", async (request) => {
    // Read defensively: fastify types `config` as always present, but the
    // 404 path has no route and therefore nothing to have configured.
    const config = request.routeOptions.config as ContractRouteConfig | undefined;
    // No operationId means this is not a contract route — the 404 handler, or
    // an operational endpoint outside the spec. Nothing to negotiate.
    if (config?.operationId === undefined) return;
    if (config.acceptExempt) return;
    if (acceptsApiMediaType(request.headers.accept)) return;

    throw new ApiFailure(406, "not_acceptable", `send accept ${API_MEDIA_TYPE}`);
  });

  // ---------------------------------------------------------------------
  // The single error exit
  // ---------------------------------------------------------------------
  app.setNotFoundHandler((request, reply) => {
    void reply
      .code(404)
      .type(API_MEDIA_TYPE)
      .send(errorEnvelope("not_found", "no such route", request.id));
  });

  app.setErrorHandler((error, request, reply) => {
    const failure = toFailure(error);

    if (failure.status >= 500) {
      request.log.error({ err: error, status: failure.status }, "request failed");
    } else {
      request.log.info({ status: failure.status, code: failure.code }, "request rejected");
    }

    for (const [name, value] of Object.entries(failure.headers)) {
      void reply.header(name, value);
    }

    // Served as the v1 media type even when the caller asked for something
    // else: `openapi.yaml` declares the `406` body under this media type, so
    // answering "I only speak v1" in v1 is the contract, not an oversight.
    void reply
      .code(failure.status)
      .type(API_MEDIA_TYPE)
      .send(errorEnvelope(failure.code, failure.message, request.id, failure.details));
  });

  // ---------------------------------------------------------------------
  // Idempotency (system-design §3)
  // ---------------------------------------------------------------------
  // Registered before the routes, not as a style preference: fastify snapshots
  // an instance's hooks when each route is registered, so a hook added after
  // `registerContractRoutes` would silently apply to nothing.
  registerIdempotency(app, {
    store: options.pool === undefined ? undefined : createIdempotencyStore(options.pool),
    tuning: options.idempotency,
  });

  registerContractRoutes(app, options.handlers ?? stubHandlers);

  return app;
}

/**
 * Everything that can be thrown at us, reduced to the envelope's vocabulary.
 *
 * Three sources: our own `ApiFailure`, fastify's schema validation, and
 * everything else. The third case never leaks its message — the contract says
 * `message` is "never a stack trace", and an unexpected error's message is
 * where internals get printed.
 */
function toFailure(error: unknown): ApiFailure {
  if (isApiFailure(error)) return error;

  const candidate = error as {
    statusCode?: number;
    validation?: readonly { instancePath?: string; params?: unknown; message?: string }[];
    message?: string;
  };

  // Schema validation. No route declares a schema yet — deriving them from
  // `openapi.yaml` belongs to the tickets that need them (M0-BE-16, M0-BE-18)
  // — so this branch is wired ahead of its first user, on purpose: the day a
  // schema lands, its rejections are already contract-shaped.
  if (Array.isArray(candidate.validation)) {
    return new ApiFailure(400, "bad_request", "request failed validation", {
      details: candidate.validation.map(toDetail),
      cause: error,
    });
  }

  const status = typeof candidate.statusCode === "number" ? candidate.statusCode : 500;
  const code = STATUS_TO_CODE.get(status);
  if (code !== undefined) {
    // A framework 4xx the contract documents — a malformed JSON body is the
    // common one — keeps its own message, which fastify writes for humans.
    const message =
      status < 500 ? toContractMessage(candidate.message, "request rejected") : "unexpected error";
    return new ApiFailure(status, code, message, { cause: error });
  }

  // A status the contract does not document (415, 413, and fastify's other
  // transport errors). Collapse rather than invent: client-side faults become
  // `400`, everything else becomes `500`.
  if (status >= 400 && status < 500) {
    return new ApiFailure(400, "bad_request", toContractMessage(candidate.message, "request rejected"), {
      cause: error,
    });
  }
  return new ApiFailure(500, "internal", "unexpected error", { cause: error });
}

/**
 * Fastify writes sentence-case messages with trailing punctuation; the
 * contract writes `message` as "human-readable, lowercase, no trailing
 * period". Rather than replace a framework message with something vaguer —
 * "body is not valid JSON but content-type is set to 'application/json'" is
 * genuinely the most useful thing to tell a caller — restyle it. Only the
 * first character is touched, so identifiers inside the message survive.
 */
function toContractMessage(message: string | undefined, fallback: string): string {
  const trimmed = message?.trim().replace(/\.+$/, "");
  if (trimmed === undefined || trimmed.length === 0) return fallback;
  return `${trimmed.charAt(0).toLowerCase()}${trimmed.slice(1)}`;
}

function toDetail(issue: {
  instancePath?: string;
  params?: unknown;
  message?: string;
}): ErrorDetail {
  const missing = (issue.params as { missingProperty?: string } | undefined)?.missingProperty;
  const field = missing ?? issue.instancePath?.replace(/^\//, "") ?? "";
  return { field, issue: issue.message ?? "invalid" };
}
