/**
 * @eutectic/api — the HTTP surface (system-design §2).
 *
 * Explicit named exports only — no barrel re-export (CLAUDE.md §4). Importing
 * this module starts nothing; the executable is `src/main.ts`.
 */

export { buildApp, type AdminAppOptions, type BuildAppOptions } from "./app.js";

/**
 * The `/v1/admin/*` family (P-09). The handler factory is exported; the admin
 * user SERIALIZER still is not — see the note further down.
 */
export { createAdminHandlers, type AdminHandlerOptions } from "./admin/handlers.js";

export {
  actingAdmin,
  requireActingAdmin,
  runAsActingAdmin,
  type ActingAdmin,
} from "./auth/admin-context.js";

export {
  adminOperations,
  isAdminPath,
  registerAdminGate,
  type AdminGateOptions,
} from "./auth/admin-gate.js";

export {
  ADMIN_USER_IDS_ENV,
  AdminAllowlistError,
  adminAllowlistFromEnv,
  isAllowlistedAdmin,
  parseAdminAllowlist,
} from "./auth/allowlist.js";

export {
  hashSessionToken,
  readCookie,
  resolveSession,
  SESSION_COOKIE_NAME,
} from "./auth/session.js";

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

export {
  createHandlers,
  notImplemented,
  stubHandlers,
  type HandlerRegistry,
} from "./handlers.js";

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

// The ADMIN user serializer is STILL deliberately not re-exported here, even
// now that P-09 has wired its route. `user-serializer.test.ts`'s containment
// guard used to require that NOTHING under `src/` named it; P-09 narrowed that
// to "admin handler code only", which is a narrowing of the exception, not of
// the invariant — this file is not admin handler code, and putting the admin
// shape on the package surface would make it importable by anything that
// depends on `@eutectic/api` without a reviewer noticing. The guard is a text
// search on purpose, which is why this comment still does not spell the name:
// a reviewer should not have to decide whether a mention is "only" a comment.
export {
  serializePublicUser,
  type PublicUserRecord,
  type PublicUserWire,
} from "./serializers/user.js";

export { installRequestTracing, tracingMixin } from "./tracing.js";

export { acceptsApiMediaType, API_MEDIA_TYPE, API_PREFIX } from "./versioning.js";
