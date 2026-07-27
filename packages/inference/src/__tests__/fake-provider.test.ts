import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalJson, fixtureKey } from "../canonical.js";
import { InferenceError } from "../errors.js";
import { DEFAULT_FIXTURE_DIR } from "../fixtures.js";
import { FakeProvider } from "../providers/fake.js";
import { normalizeRequest } from "../request.js";
import type { InferenceRequest, InferenceResponse, Provider } from "../types.js";

const REQUEST = normalizeRequest({
  model: "claude-opus-5",
  system: "You are Bell.",
  messages: [{ role: "user", content: "Round 1. Respond as AgentTurnOutput." }],
  responseFormat: { kind: "json_schema", schema: { type: "object" } },
});

/** Stands in for a real adapter. Never touches the network. */
class StubProvider implements Provider {
  readonly name: string;
  calls = 0;

  constructor(name = "anthropic", private readonly text = '{"action":"decline"}') {
    this.name = name;
  }

  async complete(request: InferenceRequest): Promise<InferenceResponse> {
    this.calls += 1;
    return {
      provider: this.name,
      model: request.model,
      text: this.text,
      stopReason: "end_turn",
      usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costMicroUsd: 230,
      providerRequestId: "req_stub_0001",
    };
  }
}

async function tempFixtureDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "eutectic-inference-"));
}

function recorder(fixtureDir: string, delegate: Provider): FakeProvider {
  return new FakeProvider({
    mode: "record",
    fixtureDir,
    targetProvider: delegate.name,
    delegate,
    now: () => new Date("2026-07-27T00:00:00.000Z"),
  });
}

function replayer(fixtureDir: string, targetProvider = "anthropic"): FakeProvider {
  return new FakeProvider({ mode: "replay", fixtureDir, targetProvider });
}

test("record captures the delegate's traffic, replay serves it back byte-stable", async () => {
  const dir = await tempFixtureDir();
  const stub = new StubProvider();

  const recorded = await recorder(dir, stub).complete(REQUEST);
  const first = await replayer(dir).complete(REQUEST);
  const second = await replayer(dir).complete(REQUEST);

  assert.equal(stub.calls, 1, "replay must not reach the delegate");
  assert.equal(canonicalJson(first), canonicalJson(recorded));
  assert.equal(canonicalJson(second), canonicalJson(first));
});

test("the fixture file is human-readable, key-named, and holds the request that produced it", async () => {
  const dir = await tempFixtureDir();
  await recorder(dir, new StubProvider()).complete(REQUEST);

  const names = await readdir(dir);
  const key = fixtureKey("anthropic", REQUEST);
  assert.deepEqual(names, [`anthropic-${key}.json`]);

  const raw = await readFile(join(dir, names[0] as string), "utf8");
  assert.ok(raw.endsWith("\n"), "fixtures end with a newline so diffs stay clean");
  assert.ok(raw.includes("\n  "), "fixtures are indented for review, not minified");

  const fixture = JSON.parse(raw) as Record<string, unknown>;
  assert.equal(fixture["key"], key);
  assert.equal(fixture["provider"], "anthropic");
  assert.equal(fixture["recorded_at"], "2026-07-27T00:00:00.000Z");
  assert.equal(typeof fixture["fixture_version"], "number");
  assert.deepEqual((fixture["request"] as Record<string, unknown>)["model"], "claude-opus-5");
});

test("replay round-trips text byte-for-byte, including unicode and newlines", async () => {
  const dir = await tempFixtureDir();
  const text = '{"body":"line one\nline two — “quoted”\t\\u0000 ünïcode 🜂"}';

  await recorder(dir, new StubProvider("anthropic", text)).complete(REQUEST);
  const replayed = await replayer(dir).complete(REQUEST);

  assert.equal(replayed.text, text);
});

test("a fixture miss throws loudly and names the key, the path and the fix", async () => {
  const dir = await tempFixtureDir();

  await assert.rejects(
    () => replayer(dir).complete(REQUEST),
    (err: unknown) => {
      assert.ok(err instanceof InferenceError);
      assert.equal(err.kind, "fixture_miss");
      assert.match(err.message, new RegExp(fixtureKey("anthropic", REQUEST)));
      assert.match(err.message, /record/);
      assert.match(err.message, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    },
  );
});

test("a fixture miss never falls through to a real call", async () => {
  const dir = await tempFixtureDir();
  const realFetch = globalThis.fetch;
  let networkAttempts = 0;
  globalThis.fetch = (() => {
    networkAttempts += 1;
    throw new Error("network is unreachable in tests");
  }) as typeof fetch;

  try {
    await assert.rejects(() => replayer(dir).complete(REQUEST));
    await recorder(dir, new StubProvider()).complete(REQUEST);
    await replayer(dir).complete(REQUEST);
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(networkAttempts, 0, "replay must run with the network unreachable");
});

test("a corrupt or hand-edited fixture is a hard failure, not a silent replay", async () => {
  const dir = await tempFixtureDir();
  await recorder(dir, new StubProvider()).complete(REQUEST);
  const path = join(dir, `anthropic-${fixtureKey("anthropic", REQUEST)}.json`);

  await writeFile(path, "{ not json", "utf8");
  await assert.rejects(
    () => replayer(dir).complete(REQUEST),
    (err: unknown) => err instanceof InferenceError && err.kind === "parse",
  );

  await writeFile(path, JSON.stringify({ fixture_version: 1, key: "wrong" }), "utf8");
  await assert.rejects(
    () => replayer(dir).complete(REQUEST),
    (err: unknown) => err instanceof InferenceError && err.kind === "parse",
  );
});

test("record mode without a delegate fails at construction", () => {
  assert.throws(
    () =>
      new FakeProvider({
        mode: "record",
        fixtureDir: "/tmp/nowhere",
        targetProvider: "anthropic",
        delegate: null,
      }),
    (err: unknown) => err instanceof InferenceError && err.kind === "config",
  );
});

test("record mode refuses a delegate that is not the provider being recorded", () => {
  assert.throws(
    () =>
      new FakeProvider({
        mode: "record",
        fixtureDir: "/tmp/nowhere",
        targetProvider: "anthropic",
        delegate: new StubProvider("openai"),
      }),
    (err: unknown) => err instanceof InferenceError && err.kind === "config",
  );
});

test("replay mode refuses a delegate — a replay provider may not hold a route to the wire", () => {
  assert.throws(
    () =>
      new FakeProvider({
        mode: "replay",
        fixtureDir: "/tmp/nowhere",
        targetProvider: "anthropic",
        delegate: new StubProvider(),
      }),
    (err: unknown) => err instanceof InferenceError && err.kind === "config",
  );
});

test("the committed fixture corpus replays from the package fixture directory", async () => {
  const provider = replayer(DEFAULT_FIXTURE_DIR);
  const response = await provider.complete(
    normalizeRequest({
      model: "claude-opus-5",
      system: "You are a resident of Eutectic. Answer only as AgentTurnOutput.",
      messages: [{ role: "user", content: "P-03 smoke fixture. Decline this turn." }],
      maxOutputTokens: 1024,
      responseFormat: { kind: "json_schema", schema: { type: "object" } },
    }),
  );

  assert.equal(response.provider, "anthropic");
  assert.equal(JSON.parse(response.text).action, "decline");
});
