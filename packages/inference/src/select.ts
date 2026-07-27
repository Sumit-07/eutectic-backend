import { InferenceError } from "./errors.js";
import { AnthropicProvider, ANTHROPIC_PROVIDER_NAME } from "./providers/anthropic.js";
import { FakeProvider, type FakeProviderMode } from "./providers/fake.js";
import type { Provider } from "./types.js";

export type Env = Readonly<Record<string, string | undefined>>;

export const PROVIDER_NAMES = ["fake", ANTHROPIC_PROVIDER_NAME] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

/**
 * Which provider a process talks to is an environment decision, never a code
 * decision — that is what makes "fast CI runs with zero real inference" a
 * property of the deployment rather than a promise in a comment.
 *
 *   INFERENCE_PROVIDER   fake | anthropic          (required, no default)
 *   INFERENCE_FAKE_MODE  record | replay           (fake only, default replay)
 *   INFERENCE_FIXTURE_DIR                          (fake only, default <package>/fixtures)
 *   INFERENCE_FAKE_TARGET                          (fake only, default anthropic)
 *   ANTHROPIC_API_KEY                              (required for anthropic, and for fake+record)
 *   ANTHROPIC_BASE_URL                             (optional)
 *
 * Every unknown or empty value throws. There is no fallback provider: silently
 * defaulting to a real provider is how a test suite starts spending money.
 */
export function createProviderFromEnv(env: Env = process.env): Provider {
  const selected = read(env, "INFERENCE_PROVIDER");

  if (selected === null) {
    throw new InferenceError(
      "config",
      `INFERENCE_PROVIDER is not set. Set it to one of: ${PROVIDER_NAMES.join(", ")}. ` +
        "There is no default: the provider a process talks to is never implicit.",
    );
  }

  switch (selected) {
    case "fake":
      return createFakeProviderFromEnv(env);
    case ANTHROPIC_PROVIDER_NAME:
      return createAnthropicProviderFromEnv(env);
    default:
      throw new InferenceError(
        "config",
        `INFERENCE_PROVIDER="${selected}" is not a provider this build knows. Valid values: ${PROVIDER_NAMES.join(", ")}.`,
      );
  }
}

export function createAnthropicProviderFromEnv(env: Env = process.env): AnthropicProvider {
  const apiKey = read(env, "ANTHROPIC_API_KEY");
  if (apiKey === null) {
    throw new InferenceError("config", "ANTHROPIC_API_KEY is not set; the Anthropic provider cannot start.");
  }

  const baseUrl = read(env, "ANTHROPIC_BASE_URL");
  return new AnthropicProvider({ apiKey, ...(baseUrl === null ? {} : { baseUrl }) });
}

export function createFakeProviderFromEnv(env: Env = process.env): FakeProvider {
  const rawMode = read(env, "INFERENCE_FAKE_MODE") ?? "replay";
  if (rawMode !== "record" && rawMode !== "replay") {
    throw new InferenceError(
      "config",
      `INFERENCE_FAKE_MODE="${rawMode}" is not valid. Valid values: record, replay.`,
    );
  }
  const mode: FakeProviderMode = rawMode;

  const targetProvider = read(env, "INFERENCE_FAKE_TARGET") ?? ANTHROPIC_PROVIDER_NAME;
  const fixtureDir = read(env, "INFERENCE_FIXTURE_DIR");

  if (mode === "replay") {
    return new FakeProvider({
      mode,
      targetProvider,
      ...(fixtureDir === null ? {} : { fixtureDir }),
    });
  }

  if (targetProvider !== ANTHROPIC_PROVIDER_NAME) {
    throw new InferenceError(
      "config",
      `INFERENCE_FAKE_TARGET="${targetProvider}" cannot be recorded: this build has no adapter for it.`,
    );
  }

  return new FakeProvider({
    mode,
    targetProvider,
    delegate: createAnthropicProviderFromEnv(env),
    ...(fixtureDir === null ? {} : { fixtureDir }),
  });
}

/** Trims — leading whitespace in an env value is an editing accident, not intent. */
function read(env: Env, key: string): string | null {
  const value = env[key];
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
