import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { fixtureKey, requestToJson } from "../canonical.js";
import { InferenceError } from "../errors.js";
import {
  DEFAULT_FIXTURE_DIR,
  FIXTURE_FORMAT_VERSION,
  deserializeFixture,
  fixtureFileName,
  serializeFixture,
  type InferenceFixture,
} from "../fixtures.js";
import type { CompleteOptions, InferenceRequest, InferenceResponse, Provider } from "../types.js";

export type FakeProviderMode = "record" | "replay";

export interface FakeProviderConfig {
  readonly mode: FakeProviderMode;
  readonly fixtureDir?: string;
  /** The provider whose traffic these fixtures represent, e.g. `"anthropic"`. */
  readonly targetProvider: string;
  /** Required in record mode, forbidden in replay mode. */
  readonly delegate?: Provider | null;
  /** Injected clock, so a record-mode test is deterministic. */
  readonly now?: (() => Date) | null;
}

/**
 * Record/replay in front of a real provider.
 *
 * Replay is the mode CI runs in, and the invariant that matters is negative:
 * **a replay never reaches the network**. This class holds no HTTP client, and
 * in replay mode holds no delegate either — the constructor rejects one — so
 * there is no route to the wire to fall through to. A missing fixture throws;
 * it does not degrade into a real call that would spend budget and make a fast
 * test suite quietly non-deterministic.
 *
 * Record mode wraps a real adapter, captures the exchange, and writes it to a
 * fixture file named by the canonical request hash (see `canonical.ts`).
 */
export class FakeProvider implements Provider {
  readonly name = "fake";
  readonly mode: FakeProviderMode;
  readonly fixtureDir: string;
  readonly targetProvider: string;

  readonly #delegate: Provider | null;
  readonly #now: () => Date;

  constructor(config: FakeProviderConfig) {
    if (config.mode !== "record" && config.mode !== "replay") {
      throw new InferenceError(
        "config",
        `FakeProvider mode must be "record" or "replay", received ${String(config.mode)}.`,
      );
    }

    const delegate = config.delegate ?? null;

    if (config.mode === "record") {
      if (delegate === null) {
        throw new InferenceError(
          "config",
          "FakeProvider in record mode needs a delegate to record: there is nothing to capture without one.",
        );
      }
      if (delegate.name !== config.targetProvider) {
        throw new InferenceError(
          "config",
          `FakeProvider is recording ${config.targetProvider} but was given a ${delegate.name} delegate. ` +
            "Fixtures are keyed by provider; recording one under another's name makes the corpus lie.",
        );
      }
    } else if (delegate !== null) {
      throw new InferenceError(
        "config",
        "FakeProvider in replay mode must not be given a delegate. Replay is defined by having no route to the network.",
      );
    }

    this.mode = config.mode;
    this.targetProvider = config.targetProvider;
    this.fixtureDir = config.fixtureDir ?? DEFAULT_FIXTURE_DIR;
    this.#delegate = config.mode === "record" ? delegate : null;
    this.#now = config.now ?? (() => new Date());
  }

  async complete(request: InferenceRequest, options?: CompleteOptions): Promise<InferenceResponse> {
    const key = fixtureKey(this.targetProvider, request);
    const path = join(this.fixtureDir, fixtureFileName(this.targetProvider, key));

    if (this.mode === "replay") {
      return this.#replay(key, path);
    }

    return this.#record(request, key, path, options);
  }

  async #replay(key: string, path: string): Promise<InferenceResponse> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new InferenceError("parse", `Fixture ${path} could not be read.`, { cause });
      }
      throw new InferenceError(
        "fixture_miss",
        `No fixture for ${this.targetProvider} request ${key}.\n` +
          `  expected file : ${path}\n` +
          "  cause         : the request changed, or this exchange was never recorded.\n" +
          "  fix           : re-record it with\n" +
          `                  INFERENCE_PROVIDER=fake INFERENCE_FAKE_MODE=record INFERENCE_FIXTURE_DIR=${this.fixtureDir} \\\n` +
          "                  ANTHROPIC_API_KEY=... <the command that made this request>\n" +
          "  note          : replay never falls through to a real provider call.",
        { cause },
      );
    }

    const fixture = deserializeFixture(raw, path, key);
    return fixture.response;
  }

  async #record(
    request: InferenceRequest,
    key: string,
    path: string,
    options?: CompleteOptions,
  ): Promise<InferenceResponse> {
    const delegate = this.#delegate;
    if (delegate === null) {
      // Unreachable: the constructor guarantees a delegate in record mode.
      throw new InferenceError("config", "FakeProvider in record mode has no delegate.");
    }

    const response = await delegate.complete(request, options);

    const fixture: InferenceFixture = {
      fixture_version: FIXTURE_FORMAT_VERSION,
      key,
      provider: this.targetProvider,
      recorded_at: this.#now().toISOString(),
      request: requestToJson(request),
      response,
    };

    await mkdir(this.fixtureDir, { recursive: true });
    await writeFile(path, serializeFixture(fixture), "utf8");

    return response;
  }
}
