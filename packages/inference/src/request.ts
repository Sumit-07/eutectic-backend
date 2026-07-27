import { InferenceError } from "./errors.js";
import type { InferenceRequest, InferenceRequestInit } from "./types.js";

export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/**
 * Above roughly this many output tokens the Messages API requires streaming.
 * This package does not stream (rule 14), so a request that would need it is a
 * configuration error caught here rather than a 400 caught in production.
 */
export const MAX_OUTPUT_TOKENS_WITHOUT_STREAMING = 16_000;

/**
 * Closes every optional key so the request that gets hashed into a fixture key
 * is total. Without this, `{}` and `{ stopSequences: undefined }` and
 * `{ stopSequences: [] }` would be three different keys for one intention.
 *
 * Idempotent: normalising an already-normalised request returns the same shape.
 */
export function normalizeRequest(init: InferenceRequestInit): InferenceRequest {
  const model = init.model.trim();
  if (model === "") {
    throw new InferenceError("config", "InferenceRequest.model is required and must not be blank.");
  }

  if (init.messages.length === 0) {
    throw new InferenceError(
      "config",
      "InferenceRequest.messages must contain at least one message; a turn with no prompt is not a turn.",
    );
  }

  const maxOutputTokens = init.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new InferenceError(
      "config",
      `InferenceRequest.maxOutputTokens must be a positive integer, received ${String(maxOutputTokens)}.`,
    );
  }
  if (maxOutputTokens > MAX_OUTPUT_TOKENS_WITHOUT_STREAMING) {
    throw new InferenceError(
      "config",
      `InferenceRequest.maxOutputTokens ${maxOutputTokens} exceeds ${MAX_OUTPUT_TOKENS_WITHOUT_STREAMING}, ` +
        "which the provider only serves over a stream. This package does not stream (CLAUDE.md rule 14): " +
        "split the work into smaller queued turns instead.",
    );
  }

  return {
    model,
    system: init.system,
    messages: init.messages.map((message) => ({ role: message.role, content: message.content })),
    maxOutputTokens,
    stopSequences: init.stopSequences === undefined ? [] : [...init.stopSequences],
    responseFormat: init.responseFormat ?? { kind: "text" },
    reasoning: init.reasoning ?? null,
  };
}
