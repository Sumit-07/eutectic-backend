import assert from "node:assert/strict";
import test from "node:test";

import { InferenceError } from "../errors.js";
import { MAX_OUTPUT_TOKENS_WITHOUT_STREAMING, normalizeRequest } from "../request.js";

const MINIMAL = {
  model: "claude-opus-5",
  system: "You are Bell.",
  messages: [{ role: "user" as const, content: "Round 1." }],
};

test("normalizeRequest fills every optional key — the hashed request has no absent fields", () => {
  const request = normalizeRequest(MINIMAL);

  assert.deepEqual(Object.keys(request).sort(), [
    "maxOutputTokens",
    "messages",
    "model",
    "reasoning",
    "responseFormat",
    "stopSequences",
    "system",
  ]);
  assert.deepEqual(request.stopSequences, []);
  assert.deepEqual(request.responseFormat, { kind: "text" });
  assert.equal(request.reasoning, null);
  assert.equal(typeof request.maxOutputTokens, "number");
});

test("normalizeRequest rejects an empty conversation", () => {
  assert.throws(
    () => normalizeRequest({ ...MINIMAL, messages: [] }),
    (err: unknown) => err instanceof InferenceError && err.kind === "config",
  );
});

test("normalizeRequest rejects a blank model id", () => {
  assert.throws(
    () => normalizeRequest({ ...MINIMAL, model: "  " }),
    (err: unknown) => err instanceof InferenceError && err.kind === "config",
  );
});

test("normalizeRequest rejects max output tokens beyond the non-streaming ceiling (rule 14)", () => {
  assert.throws(
    () =>
      normalizeRequest({
        ...MINIMAL,
        maxOutputTokens: MAX_OUTPUT_TOKENS_WITHOUT_STREAMING + 1,
      }),
    (err: unknown) =>
      err instanceof InferenceError && err.kind === "config" && /stream/i.test(err.message),
  );

  for (const bad of [0, -1, 1.5]) {
    assert.throws(
      () => normalizeRequest({ ...MINIMAL, maxOutputTokens: bad }),
      (err: unknown) => err instanceof InferenceError && err.kind === "config",
    );
  }
});

test("normalizeRequest is idempotent — normalising twice is byte-identical", () => {
  const once = normalizeRequest(MINIMAL);
  const twice = normalizeRequest(once);

  assert.deepEqual(twice, once);
});
