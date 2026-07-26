/**
 * @eutectic/api — the HTTP surface (system-design §2).
 *
 * Explicit named exports only — no barrel re-export (CLAUDE.md §4). Importing
 * this module starts nothing; the executable is `src/main.ts`.
 */

export { buildApp, type BuildAppOptions } from "./app.js";

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

export { REQUEST_ID_HEADER, REQUEST_ID_LOG_LABEL, sanitizeRequestId } from "./request-id.js";

export {
  ACCEPT_EXEMPT_OPERATIONS,
  contractRoutes,
  operationIds,
  registerContractRoutes,
  SUCCESS_STATUS,
  toFastifyPath,
  toFastifyUrl,
  type ContractRouteConfig,
  type RegisteredRoute,
} from "./routes.js";

export { acceptsApiMediaType, API_MEDIA_TYPE, API_PREFIX } from "./versioning.js";
