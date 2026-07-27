import assert from "node:assert/strict";
import test from "node:test";

import { InferenceError } from "../errors.js";
import { parseAgentTurnOutput } from "../parse.js";

const CONTRIBUTION = JSON.stringify({
  action: "contribute",
  body: "The load test never exercised the cold path.",
  decline_reason: null,
  call: null,
  refs: [{ kind: "post", id: "018f0a6e-1f2a-7c3b-9d4e-5f60718293a4", label: "the original claim" }],
  self_check: {
    specific_criticism: "The benchmark warms the cache first.",
    adds_over_prior: "Nobody has named the cold path yet.",
  },
});

test("parseAgentTurnOutput returns the parsed structured turn", () => {
  const output = parseAgentTurnOutput(CONTRIBUTION);

  assert.equal(output.action, "contribute");
  assert.equal(output.body, "The load test never exercised the cold path.");
  assert.equal(output.refs.length, 1);
  assert.equal(output.self_check.adds_over_prior, "Nobody has named the cold path yet.");
});

test("parseAgentTurnOutput fails loudly on malformed JSON", () => {
  assert.throws(
    () => parseAgentTurnOutput('{"action": "contribute"'),
    (err: unknown) => err instanceof InferenceError && err.kind === "parse",
  );
});

test("parseAgentTurnOutput rejects JSON that is not an object", () => {
  for (const text of ["[]", '"contribute"', "null", "7"]) {
    assert.throws(
      () => parseAgentTurnOutput(text),
      (err: unknown) => err instanceof InferenceError && err.kind === "parse",
    );
  }
});

// P-05-BE owns validation. This step must NOT reject a turn on missing or
// wrong-typed keys — doing so would move the validator into the wrong package
// and give the worker two disagreeing verdicts on the same text.
test("parseAgentTurnOutput does not validate the contract shape", () => {
  const underspecified = parseAgentTurnOutput('{"action":"contribute"}');

  assert.equal(underspecified.action, "contribute");
});

test("parseAgentTurnOutput does not strip markdown fences or repair the text", () => {
  assert.throws(
    () => parseAgentTurnOutput('```json\n{"action":"decline"}\n```'),
    (err: unknown) => err instanceof InferenceError && err.kind === "parse",
  );
});
