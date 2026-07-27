/**
 * The provider surface: one queued, single-shot turn in, one complete response
 * out.
 *
 * Two things shape every type in this file.
 *
 *   1. Rule 14 — everything is queued. There is no streaming, no callback, no
 *      partial delivery and no event emitter anywhere in this package. A turn
 *      is a function call that resolves once, with the whole answer.
 *   2. D-039 strictness — `AgentTurnOutput` requires every key and uses
 *      nullability as the only optionality. The types here follow the same
 *      discipline: `InferenceRequest` and `InferenceResponse` have no optional
 *      properties, so a request always hashes to the same fixture key and a
 *      response never has a field that is "sometimes there". Optionality lives
 *      in `InferenceRequestInit`, which `normalizeRequest` closes over.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type InferenceRole = "user" | "assistant";

export interface InferenceMessage {
  readonly role: InferenceRole;
  readonly content: string;
}

/**
 * How the model is asked to shape its answer. D-031 turns use `json_schema`;
 * the schema is supplied by the caller (`packages/agents`) because this package
 * does not know, and must not learn, what a turn is supposed to contain.
 */
export type ResponseFormat =
  | { readonly kind: "text" }
  | { readonly kind: "json_schema"; readonly schema: JsonObject };

/**
 * `disabled` is explicit rather than absent so that "we thought about thinking
 * and said no" and "we never set it" are different states in the fixture key.
 */
export interface ReasoningConfig {
  readonly mode: "adaptive" | "disabled";
}

/** A fully normalised request. Every key present; nullability is the only optionality. */
export interface InferenceRequest {
  readonly model: string;
  readonly system: string;
  readonly messages: readonly InferenceMessage[];
  readonly maxOutputTokens: number;
  readonly stopSequences: readonly string[];
  readonly responseFormat: ResponseFormat;
  readonly reasoning: ReasoningConfig | null;
}

/** What a caller writes. `normalizeRequest` turns this into an `InferenceRequest`. */
export interface InferenceRequestInit {
  readonly model: string;
  readonly system: string;
  readonly messages: readonly InferenceMessage[];
  readonly maxOutputTokens?: number;
  readonly stopSequences?: readonly string[];
  readonly responseFormat?: ResponseFormat;
  readonly reasoning?: ReasoningConfig | null;
}

/**
 * Normalised across providers.
 *
 *   - `max_output_tokens` means the answer was truncated. The text will not
 *     parse as a turn, and the caller's retry/decline path (rule 7) owns that.
 *   - `refusal` means the provider stopped the model itself.
 *   - `other` is the honest bucket for wire values this package has not been
 *     taught, rather than a guess that flattens them into `end_turn`.
 */
export type InferenceStopReason =
  | "end_turn"
  | "max_output_tokens"
  | "stop_sequence"
  | "refusal"
  | "other";

export interface InferenceUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface InferenceResponse {
  readonly provider: string;
  readonly model: string;
  /**
   * The raw model text, exactly as returned. This package never repairs,
   * unwraps or validates it — `parseAgentTurnOutput` does the one `JSON.parse`
   * and P-05-BE in `packages/agents` does the validating.
   */
  readonly text: string;
  readonly stopReason: InferenceStopReason;
  readonly usage: InferenceUsage;
  /**
   * Integer micro-USD (1e-6 USD), never a float: money that round-trips through
   * a fixture file must come back byte-identical. `null` when the provider has
   * no listed price for the model — a null cost is honest, a guessed one is not.
   */
  readonly costMicroUsd: number | null;
  readonly providerRequestId: string | null;
}

export interface CompleteOptions {
  readonly signal: AbortSignal | null;
}

/**
 * Every provider — real, fake, or a test stub — is this and nothing more.
 * One method, one round trip, no lifecycle.
 */
export interface Provider {
  readonly name: string;
  complete(request: InferenceRequest, options?: CompleteOptions): Promise<InferenceResponse>;
}
