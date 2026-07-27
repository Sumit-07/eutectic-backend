import { InferenceError } from "../errors.js";
import type {
  CompleteOptions,
  InferenceRequest,
  InferenceResponse,
  InferenceStopReason,
  InferenceUsage,
  JsonValue,
  Provider,
} from "../types.js";

export const ANTHROPIC_PROVIDER_NAME = "anthropic";
export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";
export const ANTHROPIC_API_VERSION = "2023-06-01";

export interface ModelPricing {
  readonly inputMicroUsdPerMillionTokens: number;
  readonly outputMicroUsdPerMillionTokens: number;
  readonly cacheReadMicroUsdPerMillionTokens: number;
  readonly cacheWriteMicroUsdPerMillionTokens: number;
}

/**
 * List price in micro-USD per million tokens, with the published prompt-caching
 * multipliers (cache read 0.1x input, cache write 1.25x input).
 */
function listPrice(inputUsdPerMillion: number, outputUsdPerMillion: number): ModelPricing {
  const input = inputUsdPerMillion * 1_000_000;
  return {
    inputMicroUsdPerMillionTokens: input,
    outputMicroUsdPerMillionTokens: outputUsdPerMillion * 1_000_000,
    cacheReadMicroUsdPerMillionTokens: input * 0.1,
    cacheWriteMicroUsdPerMillionTokens: input * 1.25,
  };
}

/**
 * Published list price, current as of 2026-07. Two deliberate choices:
 *
 *   - Introductory or promotional rates are ignored in favour of list price, so
 *     a reported cost errs high. Overstating spend is recoverable; understating
 *     it walks into the budget ceiling (rule 6).
 *   - A model that is not in this table gets `costMicroUsd: null`, not an
 *     extrapolation. A null cost is a visible gap; a guessed one is not.
 *
 * `AnthropicProviderConfig.pricing` overrides this wholesale, which is how a
 * negotiated rate or a price change reaches production without a code change.
 */
export const ANTHROPIC_LIST_PRICING: Readonly<Record<string, ModelPricing>> = {
  "claude-fable-5": listPrice(10, 50),
  "claude-opus-5": listPrice(5, 25),
  "claude-opus-4-8": listPrice(5, 25),
  "claude-opus-4-7": listPrice(5, 25),
  "claude-opus-4-6": listPrice(5, 25),
  "claude-sonnet-5": listPrice(3, 15),
  "claude-sonnet-4-6": listPrice(3, 15),
  "claude-haiku-4-5": listPrice(1, 5),
};

export interface AnthropicProviderConfig {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly apiVersion?: string;
  readonly pricing?: Readonly<Record<string, ModelPricing>> | null;
  /** Injected transport. Tests pass a stub; production leaves it unset and gets native fetch. */
  readonly fetchImpl?: typeof fetch | null;
}

interface AnthropicUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
}

interface AnthropicContentBlock {
  readonly type: string;
  readonly text?: string;
}

interface AnthropicMessageResponse {
  readonly id?: string;
  readonly model?: string;
  readonly content?: readonly AnthropicContentBlock[];
  readonly stop_reason?: string | null;
  readonly usage?: AnthropicUsage;
}

interface AnthropicErrorResponse {
  readonly error?: { readonly type?: string; readonly message?: string };
  readonly request_id?: string;
}

/**
 * The Anthropic Messages API over native `fetch`. No SDK, no new runtime
 * dependency (rule 12).
 *
 * Three things this adapter deliberately does not send, because current models
 * reject them with a 400 rather than ignoring them:
 *
 *   - `temperature`, `top_p`, `top_k` — removed on the Opus 5 / Sonnet 5 /
 *     Opus 4.7+ family. They are not in `InferenceRequest` at all, so there is
 *     no way to ask for them.
 *   - `thinking.budget_tokens` — replaced by `{ type: "adaptive" }`.
 *   - `stream` — this package does not stream (rule 14).
 *
 * It is fully unit-testable without credentials: the transport is injected and
 * the constructor is the only place that needs a key.
 */
export class AnthropicProvider implements Provider {
  readonly name = ANTHROPIC_PROVIDER_NAME;

  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #apiVersion: string;
  readonly #pricing: Readonly<Record<string, ModelPricing>>;
  readonly #fetch: typeof fetch;

  constructor(config: AnthropicProviderConfig) {
    if (config.apiKey.trim() === "") {
      // Fail here, loudly, rather than at the first turn of the first agent of
      // the day with a 401 that looks like a provider outage.
      throw new InferenceError(
        "config",
        "AnthropicProvider requires an API key (ANTHROPIC_API_KEY); none was supplied.",
      );
    }

    this.#apiKey = config.apiKey;
    this.#baseUrl = (config.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#apiVersion = config.apiVersion ?? ANTHROPIC_API_VERSION;
    this.#pricing = config.pricing ?? ANTHROPIC_LIST_PRICING;
    this.#fetch = config.fetchImpl ?? globalThis.fetch;
  }

  async complete(request: InferenceRequest, options?: CompleteOptions): Promise<InferenceResponse> {
    const url = `${this.#baseUrl}/v1/messages`;
    const body: Record<string, JsonValue> = {
      model: request.model,
      max_tokens: request.maxOutputTokens,
      system: request.system,
      messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
    };

    if (request.stopSequences.length > 0) {
      body["stop_sequences"] = [...request.stopSequences];
    }
    if (request.responseFormat.kind === "json_schema") {
      body["output_config"] = { format: { type: "json_schema", schema: request.responseFormat.schema } };
    }
    if (request.reasoning !== null) {
      body["thinking"] = { type: request.reasoning.mode };
    }

    const signal = options?.signal ?? null;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.#apiKey,
          "anthropic-version": this.#apiVersion,
        },
        body: JSON.stringify(body),
        ...(signal === null ? {} : { signal }),
      });
    } catch (cause) {
      // The message is the transport's, never the request's: the headers we
      // just built carry the API key and must not reach a log line.
      throw new InferenceError(
        "transport",
        `Anthropic request did not complete: ${cause instanceof Error ? cause.message : String(cause)}`,
        { retryable: true, cause },
      );
    }

    const raw = await response.text();

    if (!response.ok) {
      throw this.#toProviderError(response, raw);
    }

    let parsed: AnthropicMessageResponse;
    try {
      parsed = JSON.parse(raw) as AnthropicMessageResponse;
    } catch (cause) {
      throw new InferenceError("provider", "Anthropic returned a 200 that was not JSON.", {
        retryable: true,
        status: response.status,
        cause,
      });
    }

    return this.#toInferenceResponse(request, parsed, response);
  }

  #toProviderError(response: Response, raw: string): InferenceError {
    let envelope: AnthropicErrorResponse = {};
    try {
      envelope = JSON.parse(raw) as AnthropicErrorResponse;
    } catch {
      // A non-JSON error body (a gateway page, usually) is still an error; the
      // status is the part that matters.
    }

    const status = response.status;
    const retryable = status === 408 || status === 409 || status === 429 || status >= 500;
    const type = envelope.error?.type ?? "unknown_error";
    const message = envelope.error?.message ?? raw.slice(0, 200);

    return new InferenceError("provider", `Anthropic ${status} ${type}: ${message}`, {
      retryable,
      status,
      providerRequestId: envelope.request_id ?? response.headers.get("request-id"),
    });
  }

  #toInferenceResponse(
    request: InferenceRequest,
    parsed: AnthropicMessageResponse,
    response: Response,
  ): InferenceResponse {
    const textBlocks = (parsed.content ?? []).filter(
      (block) => block.type === "text" && typeof block.text === "string",
    );

    if (textBlocks.length === 0) {
      throw new InferenceError(
        "provider",
        "Anthropic returned a message with no text block; there is no turn to hand back.",
        { retryable: true, status: response.status, providerRequestId: parsed.id ?? null },
      );
    }

    const usage = toUsage(parsed.usage ?? {});
    const model = parsed.model ?? request.model;

    return {
      provider: ANTHROPIC_PROVIDER_NAME,
      model,
      text: textBlocks.map((block) => block.text ?? "").join(""),
      stopReason: toStopReason(parsed.stop_reason ?? null),
      usage,
      costMicroUsd: costOf(this.#pricing[model] ?? null, usage),
      providerRequestId: parsed.id ?? response.headers.get("request-id"),
    };
  }
}

function toUsage(usage: AnthropicUsage): InferenceUsage {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

function toStopReason(wire: string | null): InferenceStopReason {
  switch (wire) {
    case "end_turn":
      return "end_turn";
    case "max_tokens":
      return "max_output_tokens";
    case "stop_sequence":
      return "stop_sequence";
    case "refusal":
      return "refusal";
    default:
      // tool_use, pause_turn, null, and anything added after this was written.
      return "other";
  }
}

function costOf(pricing: ModelPricing | null, usage: InferenceUsage): number | null {
  if (pricing === null) {
    return null;
  }

  const total =
    usage.inputTokens * pricing.inputMicroUsdPerMillionTokens +
    usage.outputTokens * pricing.outputMicroUsdPerMillionTokens +
    usage.cacheReadTokens * pricing.cacheReadMicroUsdPerMillionTokens +
    usage.cacheWriteTokens * pricing.cacheWriteMicroUsdPerMillionTokens;

  // Round up: a cost that is a fraction of a micro-dollar is still spend, and
  // the budget ledger must never be told it was free.
  return Math.ceil(total / 1_000_000);
}
