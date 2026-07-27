/**
 * One error type for the whole package, so a caller can branch on `kind`
 * instead of matching strings, and on `retryable` instead of guessing which
 * failures are worth a second attempt (rule 7: retry ≤3, then decline).
 */
export type InferenceErrorKind =
  /** Bad wiring: missing credentials, unknown env value, impossible request. Never retryable. */
  | "config"
  /** The call never reached a verdict: DNS, socket, abort. Retryable. */
  | "transport"
  /** The provider answered, and the answer was a failure. Retryable per status. */
  | "provider"
  /** Replay mode has no fixture for this request. Never retryable, never a real call. */
  | "fixture_miss"
  /** Text that should have been JSON was not, or a fixture file is corrupt. */
  | "parse";

export interface InferenceErrorOptions {
  readonly retryable?: boolean;
  readonly status?: number | null;
  readonly providerRequestId?: string | null;
  readonly cause?: unknown;
}

export class InferenceError extends Error {
  readonly kind: InferenceErrorKind;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly providerRequestId: string | null;

  constructor(kind: InferenceErrorKind, message: string, options: InferenceErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "InferenceError";
    this.kind = kind;
    // Default to the safe answer: only failures we have positively classified
    // as transient are worth a retry, and a retry costs budget (rule 6).
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? null;
    this.providerRequestId = options.providerRequestId ?? null;
  }
}
