/**
 * @eutectic/api — the HTTP surface (system-design §2).
 *
 * Explicit named exports only — no barrel re-export (CLAUDE.md §4). Importing
 * this module starts nothing; the executable is `src/main.ts`.
 */

export { buildApp, type BuildAppOptions } from "./app.js";

export {
  bustEntitlement,
  ENTITLEMENT_CACHE_TTL_SECONDS,
  FREE_PLAN_DEFAULTS,
  resolveEntitlementCached,
  type ResolvedEntitlement,
} from "./entitlements.js";

export {
  ApiFailure,
  errorEnvelope,
  isApiFailure,
  type ApiFailureOptions,
  type ErrorCode,
  type ErrorDetail,
  type ErrorEnvelope,
} from "./errors.js";

export { notImplemented, stubHandlers, type HandlerRegistry } from "./handlers.js";

export { registerHealthRoutes, type HealthCheckOptions } from "./health.js";

export {
  ANONYMOUS_SCOPE,
  canonicalize,
  fingerprintRequest,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  IDEMPOTENT_REPLAY_HEADER,
  registerIdempotency,
  type IdempotencyOptions,
  type IdempotencyTuning,
} from "./idempotency.js";

export {
  createIdempotencyStore,
  type ClaimOutcome,
  type ClaimRequest,
  type IdempotencyPool,
  type IdempotencyStore,
  type RecordedResponse,
} from "./idempotency-store.js";

export { getTracer, SERVICE_NAME, startTracing, type StartTracingOptions } from "./instrumentation.js";

export { REQUEST_ID_HEADER, REQUEST_ID_LOG_LABEL, sanitizeRequestId } from "./request-id.js";

export {
  ACCEPT_EXEMPT_OPERATIONS,
  contractRoutes,
  operationIds,
  registerContractRoutes,
  toFastifyPath,
  toFastifyUrl,
  type ContractRouteConfig,
  type RegisteredRoute,
} from "./routes.js";

// The ADMIN user serializer is deliberately NOT re-exported here. It lands on
// the package surface with P-09's `/v1/admin/*` routes; until then the admin
// shape is reachable only by its own module path, and `user-serializer.test.ts`
// fails if anything under `src/` names it — including, as it happens, a comment
// like this one. The guard is a text search on purpose: a reviewer should not
// have to decide whether a mention is "only" a comment.
export {
  serializePublicUser,
  type PublicUserRecord,
  type PublicUserWire,
} from "./serializers/user.js";

export { installRequestTracing, tracingMixin } from "./tracing.js";

export { acceptsApiMediaType, API_MEDIA_TYPE, API_PREFIX } from "./versioning.js";
