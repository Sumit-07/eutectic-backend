/**
 * @eutectic/inference — the only place in the backend that talks to a model
 * provider.
 *
 * What lives here:
 *
 *   - `Provider` — one queued, single-shot turn in, one complete response out.
 *     No streaming, no callbacks, no realtime (CLAUDE.md rule 14).
 *   - `FakeProvider` — record real traffic to committed fixtures, replay it
 *     byte-stable with zero network. CI runs in replay, so the fast suite does
 *     no real inference and spends nothing.
 *   - `AnthropicProvider` — the Messages API over native `fetch`. No SDK, no
 *     new runtime dependency (rule 12).
 *   - `createProviderFromEnv` — provider selection by environment, failing
 *     loudly on anything it does not recognise.
 *   - `parseAgentTurnOutput` — the thin `JSON.parse` step from raw model text
 *     to the contract type. Validation is P-05-BE's, in `packages/agents`.
 *
 * What does not live here: prompts, personas, budget accounting, retry policy,
 * and validation. This package makes a call and reports what came back.
 *
 * Explicit named exports only — no barrel re-export (CLAUDE.md §4).
 */

export {
  type CompleteOptions,
  type InferenceMessage,
  type InferenceRequest,
  type InferenceRequestInit,
  type InferenceResponse,
  type InferenceRole,
  type InferenceStopReason,
  type InferenceUsage,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
  type Provider,
  type ReasoningConfig,
  type ResponseFormat,
} from "./types.js";

export { InferenceError, type InferenceErrorKind, type InferenceErrorOptions } from "./errors.js";

export {
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_OUTPUT_TOKENS_WITHOUT_STREAMING,
  normalizeRequest,
} from "./request.js";

export { FIXTURE_KEY_VERSION, canonicalJson, fixtureKey, requestToJson } from "./canonical.js";

export {
  DEFAULT_FIXTURE_DIR,
  FIXTURE_FORMAT_VERSION,
  deserializeFixture,
  fixtureFileName,
  serializeFixture,
  type InferenceFixture,
} from "./fixtures.js";

export { FakeProvider, type FakeProviderConfig, type FakeProviderMode } from "./providers/fake.js";

export {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_LIST_PRICING,
  ANTHROPIC_PROVIDER_NAME,
  AnthropicProvider,
  type AnthropicProviderConfig,
  type ModelPricing,
} from "./providers/anthropic.js";

export {
  PROVIDER_NAMES,
  createAnthropicProviderFromEnv,
  createFakeProviderFromEnv,
  createProviderFromEnv,
  type Env,
  type ProviderName,
} from "./select.js";

export { parseAgentTurnOutput, type AgentTurnOutput } from "./parse.js";
