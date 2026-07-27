import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson, fixtureKey, requestToJson } from "../canonical.js";
import { normalizeRequest } from "../request.js";

const BASE = normalizeRequest({
  model: "claude-opus-5",
  system: "You are Bell.",
  messages: [{ role: "user", content: "Round 1. Respond as AgentTurnOutput." }],
});

test("canonicalJson sorts object keys and emits no whitespace", () => {
  const a = canonicalJson({ b: 1, a: 2, c: { z: true, y: null } });
  const b = canonicalJson({ c: { y: null, z: true }, a: 2, b: 1 });

  assert.equal(a, '{"a":2,"b":1,"c":{"y":null,"z":true}}');
  assert.equal(a, b);
});

test("canonicalJson preserves array order — order is meaning, not layout", () => {
  assert.equal(canonicalJson([3, 1, 2]), "[3,1,2]");
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});

test("canonicalJson refuses values that cannot be hashed stably", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => canonicalJson(bad),
      (err: unknown) => err instanceof Error && /not stably serialisable|non-finite/i.test(err.message),
    );
  }
  assert.throws(() => canonicalJson({ a: undefined }));
});

test("fixtureKey is stable across key insertion order", () => {
  const reordered = normalizeRequest({
    messages: [{ content: "Round 1. Respond as AgentTurnOutput.", role: "user" }],
    system: "You are Bell.",
    model: "claude-opus-5",
  });

  assert.equal(fixtureKey("anthropic", BASE), fixtureKey("anthropic", reordered));
});

// Canonicalisation stability: this hash is derived independently from the
// documented scheme (sha256 of {"v":1,"provider":...,"request":...} with keys
// sorted by UTF-16 code unit, no whitespace). If it ever changes, the fixture
// corpus is invalidated and FIXTURE_KEY_VERSION must be bumped in the same PR.
test("fixtureKey matches the pinned golden hash", () => {
  assert.equal(
    fixtureKey("anthropic", BASE),
    "edaa1dc7a38f1cff21deddda401578530c22ed9f8f0b7be0b1a397da9c8edef1",
  );
});

test("fixtureKey changes when any hashed field changes", () => {
  const base = fixtureKey("anthropic", BASE);

  const mutations = [
    normalizeRequest({ ...requestInit(), model: "claude-sonnet-5" }),
    normalizeRequest({ ...requestInit(), system: "You are Ada." }),
    normalizeRequest({ ...requestInit(), messages: [{ role: "user", content: "Round 2." }] }),
    normalizeRequest({ ...requestInit(), maxOutputTokens: 2048 }),
    normalizeRequest({ ...requestInit(), stopSequences: ["\n\n"] }),
    normalizeRequest({
      ...requestInit(),
      responseFormat: { kind: "json_schema", schema: { type: "object" } },
    }),
    normalizeRequest({ ...requestInit(), reasoning: { mode: "adaptive" } }),
  ];

  for (const mutated of mutations) {
    assert.notEqual(fixtureKey("anthropic", mutated), base);
  }
});

test("fixtureKey is namespaced by provider", () => {
  assert.notEqual(fixtureKey("anthropic", BASE), fixtureKey("openai", BASE));
});

test("requestToJson carries every request field into the hashed payload", () => {
  assert.deepEqual(Object.keys(requestToJson(BASE)).sort(), [
    "maxOutputTokens",
    "messages",
    "model",
    "reasoning",
    "responseFormat",
    "stopSequences",
    "system",
  ]);
});

function requestInit() {
  return {
    model: "claude-opus-5",
    system: "You are Bell.",
    messages: [{ role: "user" as const, content: "Round 1. Respond as AgentTurnOutput." }],
  };
}
