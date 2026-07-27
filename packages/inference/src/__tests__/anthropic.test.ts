import assert from "node:assert/strict";
import test from "node:test";

import { InferenceError } from "../errors.js";
import { AnthropicProvider, ANTHROPIC_API_VERSION } from "../providers/anthropic.js";
import { normalizeRequest } from "../request.js";
import type { InferenceRequestInit } from "../types.js";

interface Captured {
  url: string;
  init: RequestInit;
}

function stubFetch(
  captured: Captured[],
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): typeof fetch {
  return (async (url: unknown, init: unknown) => {
    captured.push({ url: String(url), init: (init ?? {}) as RequestInit });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  }) as typeof fetch;
}

const OK_BODY = {
  id: "msg_01ABC",
  type: "message",
  role: "assistant",
  model: "claude-opus-5",
  content: [
    { type: "thinking", thinking: "…" },
    { type: "text", text: '{"action":"decline"}' },
  ],
  stop_reason: "end_turn",
  stop_details: null,
  usage: {
    input_tokens: 1200,
    output_tokens: 300,
    cache_read_input_tokens: 400,
    cache_creation_input_tokens: 100,
  },
};

function provider(fetchImpl: typeof fetch): AnthropicProvider {
  return new AnthropicProvider({ apiKey: "sk-ant-test", fetchImpl });
}

function request(overrides: Partial<InferenceRequestInit> = {}) {
  return normalizeRequest({
    model: "claude-opus-5",
    system: "You are Bell.",
    messages: [{ role: "user", content: "Round 1." }],
    ...overrides,
  });
}

test("the adapter fails at construction without credentials", () => {
  for (const apiKey of ["", "   "]) {
    assert.throws(
      () => new AnthropicProvider({ apiKey }),
      (err: unknown) =>
        err instanceof InferenceError && err.kind === "config" && /ANTHROPIC_API_KEY/.test(err.message),
    );
  }
});

test("the adapter posts to the Messages API with the required headers", async () => {
  const captured: Captured[] = [];
  await provider(stubFetch(captured, 200, OK_BODY)).complete(request());

  const call = captured[0];
  assert.ok(call);
  assert.equal(call.url, "https://api.anthropic.com/v1/messages");
  assert.equal(call.init.method, "POST");

  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], "sk-ant-test");
  assert.equal(headers["anthropic-version"], ANTHROPIC_API_VERSION);
  assert.equal(headers["content-type"], "application/json");
});

test("the request body never carries sampling parameters current models reject", async () => {
  const captured: Captured[] = [];
  await provider(stubFetch(captured, 200, OK_BODY)).complete(
    request({ maxOutputTokens: 2048, stopSequences: ["\n\nHuman:"] }),
  );

  const body = JSON.parse(String(captured[0]?.init.body)) as Record<string, unknown>;
  for (const banned of ["temperature", "top_p", "top_k", "stream", "output_format"]) {
    assert.ok(!(banned in body), `${banned} must not be sent`);
  }
  assert.equal(body["model"], "claude-opus-5");
  assert.equal(body["max_tokens"], 2048);
  assert.equal(body["system"], "You are Bell.");
  assert.deepEqual(body["messages"], [{ role: "user", content: "Round 1." }]);
  assert.deepEqual(body["stop_sequences"], ["\n\nHuman:"]);
});

test("empty optional fields are omitted rather than sent empty", async () => {
  const captured: Captured[] = [];
  await provider(stubFetch(captured, 200, OK_BODY)).complete(request());

  const body = JSON.parse(String(captured[0]?.init.body)) as Record<string, unknown>;
  assert.ok(!("stop_sequences" in body));
  assert.ok(!("output_config" in body));
  assert.ok(!("thinking" in body));
});

test("a json_schema response format maps to output_config.format", async () => {
  const captured: Captured[] = [];
  const schema = { type: "object", additionalProperties: false, properties: {} };
  await provider(stubFetch(captured, 200, OK_BODY)).complete(
    request({ responseFormat: { kind: "json_schema", schema } }),
  );

  const body = JSON.parse(String(captured[0]?.init.body)) as Record<string, unknown>;
  assert.deepEqual(body["output_config"], { format: { type: "json_schema", schema } });
});

test("reasoning maps to the adaptive thinking shape, never to budget_tokens", async () => {
  const captured: Captured[] = [];
  await provider(stubFetch(captured, 200, OK_BODY)).complete(
    request({ reasoning: { mode: "adaptive" } }),
  );

  const body = JSON.parse(String(captured[0]?.init.body)) as Record<string, unknown>;
  assert.deepEqual(body["thinking"], { type: "adaptive" });
  assert.ok(!JSON.stringify(body).includes("budget_tokens"));
});

test("the response maps text blocks, usage and cost", async () => {
  const response = await provider(stubFetch([], 200, OK_BODY)).complete(request());

  assert.equal(response.provider, "anthropic");
  assert.equal(response.text, '{"action":"decline"}');
  assert.equal(response.stopReason, "end_turn");
  assert.equal(response.providerRequestId, "msg_01ABC");
  assert.deepEqual(response.usage, {
    inputTokens: 1200,
    outputTokens: 300,
    cacheReadTokens: 400,
    cacheWriteTokens: 100,
  });
  // claude-opus-5 list price, $5 / $25 per Mtok, cache read 0.1x and cache
  // write 1.25x input: 1200*5 + 300*25 + 400*0.5 + 100*6.25 micro-USD.
  assert.equal(response.costMicroUsd, 14_325);
});

test("cost is null rather than guessed for a model with no listed price", async () => {
  const response = await provider(stubFetch([], 200, { ...OK_BODY, model: "claude-unlisted-9" })).complete(
    request({ model: "claude-unlisted-9" }),
  );

  assert.equal(response.costMicroUsd, null);
});

test("stop reasons are normalised, including refusal and truncation", async () => {
  const cases: [string, string][] = [
    ["end_turn", "end_turn"],
    ["max_tokens", "max_output_tokens"],
    ["stop_sequence", "stop_sequence"],
    ["refusal", "refusal"],
    ["pause_turn", "other"],
  ];

  for (const [wire, expected] of cases) {
    const response = await provider(stubFetch([], 200, { ...OK_BODY, stop_reason: wire })).complete(
      request(),
    );
    assert.equal(response.stopReason, expected);
  }
});

test("HTTP errors become InferenceError with the right retryability", async () => {
  const cases: [number, string, boolean][] = [
    [400, "invalid_request_error", false],
    [401, "authentication_error", false],
    [429, "rate_limit_error", true],
    [500, "api_error", true],
    [529, "overloaded_error", true],
  ];

  for (const [status, type, retryable] of cases) {
    const body = { type: "error", error: { type, message: "boom" }, request_id: "req_x" };
    await assert.rejects(
      () => provider(stubFetch([], status, body)).complete(request()),
      (err: unknown) => {
        assert.ok(err instanceof InferenceError);
        assert.equal(err.kind, "provider");
        assert.equal(err.status, status);
        assert.equal(err.retryable, retryable);
        assert.match(err.message, /boom/);
        return true;
      },
    );
  }
});

test("a transport failure is retryable and never leaks the api key", async () => {
  const exploding = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;

  await assert.rejects(
    () => provider(exploding).complete(request()),
    (err: unknown) => {
      assert.ok(err instanceof InferenceError);
      assert.equal(err.kind, "transport");
      assert.equal(err.retryable, true);
      assert.ok(!err.message.includes("sk-ant-test"));
      return true;
    },
  );
});

test("a response with no text block is a provider error, not an empty turn", async () => {
  await assert.rejects(
    () => provider(stubFetch([], 200, { ...OK_BODY, content: [] })).complete(request()),
    (err: unknown) => err instanceof InferenceError && err.kind === "provider",
  );
});
