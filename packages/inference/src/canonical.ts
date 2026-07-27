import { createHash } from "node:crypto";

import { InferenceError } from "./errors.js";
import type { InferenceRequest, JsonObject, JsonValue } from "./types.js";

/**
 * Bump when the canonicalisation below changes in any way that moves a hash.
 * The version is part of the hashed payload, so a bump invalidates every
 * fixture key at once instead of silently replaying a stale answer for a
 * request that no longer means the same thing.
 */
export const FIXTURE_KEY_VERSION = 1;

/**
 * Canonical JSON — the exact rules, because a fixture key is only as stable as
 * the text it hashes:
 *
 *   1. Object keys are sorted ascending by UTF-16 code unit. Insertion order
 *      carries no meaning, so it must not carry a hash.
 *   2. Array order is preserved. Order in a message list *is* meaning.
 *   3. No whitespace anywhere — no spaces after `:` or `,`, no newlines.
 *   4. Strings are escaped by `JSON.stringify`, so the escaping is whatever V8
 *      does and not a hand-rolled table.
 *   5. `undefined`, functions, symbols and non-finite numbers throw. Every one
 *      of them either disappears or mutates under `JSON.stringify`, and a value
 *      that can vanish must never sit between a request and its fixture.
 *
 * This is deliberately not `JSON.stringify` with a replacer: `stringify` drops
 * `undefined` object values silently, which is precisely the failure this
 * function exists to prevent.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);

    case "number":
      if (!Number.isFinite(value)) {
        throw new InferenceError(
          "config",
          `The non-finite number ${String(value)} is not stably serialisable and cannot be part of a fixture key.`,
        );
      }
      return JSON.stringify(value);

    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
      }
      const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      );
      return `{${entries
        .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
        .join(",")}}`;
    }

    default:
      throw new InferenceError(
        "config",
        `A value of type ${typeof value} is not stably serialisable and cannot be part of a fixture key.`,
      );
  }
}

/**
 * The hashed projection of a request.
 *
 * Typed as a total map over `keyof InferenceRequest`, so adding a field to the
 * request without deciding whether it belongs in the key is a compile error
 * rather than a fixture corpus that quietly stops distinguishing two requests.
 *
 * Every field participates. There is no "excluded from the key" bucket and no
 * free-form metadata field — if it can change the answer, it changes the key.
 */
export function requestToJson(request: InferenceRequest): JsonObject {
  const projection: Record<keyof InferenceRequest, JsonValue> = {
    model: request.model,
    system: request.system,
    messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
    maxOutputTokens: request.maxOutputTokens,
    stopSequences: [...request.stopSequences],
    responseFormat:
      request.responseFormat.kind === "text"
        ? { kind: "text" }
        : { kind: "json_schema", schema: request.responseFormat.schema },
    reasoning: request.reasoning === null ? null : { mode: request.reasoning.mode },
  };

  return projection;
}

/**
 * `sha256(canonicalJson({ v, provider, request }))`, lowercase hex.
 *
 * The provider name is inside the hash rather than only in the filename, so a
 * fixture recorded against one provider can never be renamed into service for
 * another: the key check on load would fail.
 */
export function fixtureKey(providerName: string, request: InferenceRequest): string {
  const payload = canonicalJson({
    v: FIXTURE_KEY_VERSION,
    provider: providerName,
    request: requestToJson(request),
  });

  return createHash("sha256").update(payload, "utf8").digest("hex");
}
