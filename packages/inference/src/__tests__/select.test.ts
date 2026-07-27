import assert from "node:assert/strict";
import test from "node:test";

import { InferenceError } from "../errors.js";
import { FakeProvider } from "../providers/fake.js";
import { AnthropicProvider } from "../providers/anthropic.js";
import { createProviderFromEnv } from "../select.js";

test("an unset INFERENCE_PROVIDER fails loudly instead of defaulting", () => {
  assert.throws(
    () => createProviderFromEnv({}),
    (err: unknown) =>
      err instanceof InferenceError && err.kind === "config" && /INFERENCE_PROVIDER/.test(err.message),
  );
});

test("an unknown INFERENCE_PROVIDER names the values that would work", () => {
  assert.throws(
    () => createProviderFromEnv({ INFERENCE_PROVIDER: "openai" }),
    (err: unknown) => {
      assert.ok(err instanceof InferenceError);
      assert.equal(err.kind, "config");
      assert.match(err.message, /openai/);
      assert.match(err.message, /fake/);
      assert.match(err.message, /anthropic/);
      return true;
    },
  );
});

test("INFERENCE_PROVIDER=anthropic builds the real adapter from env", () => {
  const provider = createProviderFromEnv({
    INFERENCE_PROVIDER: "anthropic",
    ANTHROPIC_API_KEY: "sk-ant-test",
  });

  assert.ok(provider instanceof AnthropicProvider);
  assert.equal(provider.name, "anthropic");
});

test("INFERENCE_PROVIDER=anthropic without a key fails at construction", () => {
  assert.throws(
    () => createProviderFromEnv({ INFERENCE_PROVIDER: "anthropic" }),
    (err: unknown) =>
      err instanceof InferenceError && err.kind === "config" && /ANTHROPIC_API_KEY/.test(err.message),
  );
});

test("INFERENCE_PROVIDER=fake defaults to replay and needs no credentials", () => {
  const provider = createProviderFromEnv({ INFERENCE_PROVIDER: "fake" });

  assert.ok(provider instanceof FakeProvider);
  assert.equal(provider.mode, "replay");
  assert.equal(provider.targetProvider, "anthropic");
});

test("record mode requires the credentials of the provider being recorded", () => {
  assert.throws(
    () => createProviderFromEnv({ INFERENCE_PROVIDER: "fake", INFERENCE_FAKE_MODE: "record" }),
    (err: unknown) =>
      err instanceof InferenceError && err.kind === "config" && /ANTHROPIC_API_KEY/.test(err.message),
  );

  const provider = createProviderFromEnv({
    INFERENCE_PROVIDER: "fake",
    INFERENCE_FAKE_MODE: "record",
    ANTHROPIC_API_KEY: "sk-ant-test",
  });
  assert.ok(provider instanceof FakeProvider);
  assert.equal(provider.mode, "record");
});

test("an unknown INFERENCE_FAKE_MODE fails loudly", () => {
  assert.throws(
    () => createProviderFromEnv({ INFERENCE_PROVIDER: "fake", INFERENCE_FAKE_MODE: "passthrough" }),
    (err: unknown) => err instanceof InferenceError && err.kind === "config",
  );
});

test("the fixture directory is overridable by env", () => {
  const provider = createProviderFromEnv({
    INFERENCE_PROVIDER: "fake",
    INFERENCE_FIXTURE_DIR: "/tmp/eutectic-fixtures",
  });

  assert.ok(provider instanceof FakeProvider);
  assert.equal(provider.fixtureDir, "/tmp/eutectic-fixtures");
});

test("env values are trimmed, but an empty value is still a failure", () => {
  assert.throws(() => createProviderFromEnv({ INFERENCE_PROVIDER: "" }));
  assert.throws(() => createProviderFromEnv({ INFERENCE_PROVIDER: "   " }));
  assert.ok(createProviderFromEnv({ INFERENCE_PROVIDER: " fake " }) instanceof FakeProvider);
});
