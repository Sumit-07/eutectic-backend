/**
 * The one error envelope (M0-BE-15).
 *
 * `openapi.yaml`'s `Error` schema is the shape of EVERY non-2xx response in
 * this API — there is no second error shape and no bare string body anywhere.
 * The types below are read out of the contract rather than re-declared, so a
 * change to the envelope is a compile error here, not a runtime surprise for a
 * client switching on `error.code`.
 *
 * `ApiFailure` is the only way to produce a non-2xx from application code.
 * Throw it; `app.ts`'s error handler serialises it. Nothing else in this app
 * writes a status code by hand.
 */

import type { Schemas } from "@eutectic/contracts";

/** `components.schemas.Error` — the envelope itself. */
export type ErrorEnvelope = Schemas["Error"];

/** `components.schemas.ErrorCode` — the closed enum clients switch on. */
export type ErrorCode = Schemas["ErrorCode"];

/** `components.schemas.ErrorDetail` — field-level detail, empty for the rest. */
export type ErrorDetail = Schemas["ErrorDetail"];

export interface ApiFailureOptions {
  /** Field-level detail. Omitted means `[]`, which is what the spec examples show. */
  readonly details?: readonly ErrorDetail[];
  /**
   * Response headers the contract requires alongside this status — today only
   * `Retry-After` on `429`, which the rate limiter (M0-BE-19) will set. Kept
   * here so a limiter cannot ship a 429 that violates the spec by omission.
   */
  readonly headers?: Readonly<Record<string, string>>;
  /** Underlying cause, for the log line only. Never serialised to a client. */
  readonly cause?: unknown;
}

/**
 * A failure that already knows its contract-declared status and code.
 *
 * `message` goes to the client verbatim, so it obeys the spec's rule for the
 * field: human-readable, lowercase, no trailing period, never a stack trace.
 */
export class ApiFailure extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: readonly ErrorDetail[];
  readonly headers: Readonly<Record<string, string>>;

  constructor(status: number, code: ErrorCode, message: string, options: ApiFailureOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ApiFailure";
    this.status = status;
    this.code = code;
    this.details = options.details ?? [];
    this.headers = options.headers ?? {};
  }
}

/** Narrowing helper — `instanceof` across module realms is not worth trusting. */
export function isApiFailure(value: unknown): value is ApiFailure {
  return value instanceof ApiFailure;
}

/**
 * Builds the wire body. `request_id` is required by the schema, which is the
 * contract's way of saying every error a user sees is traceable in the logs.
 */
export function errorEnvelope(
  code: ErrorCode,
  message: string,
  requestId: string,
  details: readonly ErrorDetail[] = [],
): ErrorEnvelope {
  return {
    error: {
      code,
      message,
      // Always present, always an array: every example in openapi.yaml carries
      // `details: []` rather than omitting the key, and clients read `.length`.
      details: [...details],
      request_id: requestId,
    },
  };
}
