import { fileURLToPath } from "node:url";

import { InferenceError } from "./errors.js";
import type { InferenceResponse, JsonObject } from "./types.js";

export const FIXTURE_FORMAT_VERSION = 1;

/**
 * A recorded exchange, committed to the repo and meant to be read in a diff.
 *
 * `recorded_at` is provenance only — it is never part of the key and never
 * affects replay, so re-recording an unchanged exchange produces a fixture that
 * differs in one line and nothing else.
 */
export interface InferenceFixture {
  readonly fixture_version: number;
  readonly key: string;
  readonly provider: string;
  readonly recorded_at: string;
  readonly request: JsonObject;
  readonly response: InferenceResponse;
}

/**
 * The committed corpus lives at `<package>/fixtures`.
 *
 * Resolved from the compiled module's own URL, not from `process.cwd()`: tests
 * and workers both run from `dist/`, and a cwd-relative path would find the
 * corpus in one and miss it in the other. This file compiles to `dist/fixtures.js`,
 * so the package root is one level up.
 */
export const DEFAULT_FIXTURE_DIR = fileURLToPath(new URL("../fixtures", import.meta.url));

export function fixtureFileName(providerName: string, key: string): string {
  return `${providerName}-${key}.json`;
}

export function serializeFixture(fixture: InferenceFixture): string {
  // Two-space indent and a trailing newline: these files are reviewed by humans
  // and diffed by git, so they are formatted like source, not like a payload.
  return `${JSON.stringify(fixture, null, 2)}\n`;
}

/**
 * Loads a fixture and refuses anything it cannot vouch for. A fixture that is
 * malformed, from a future format, or keyed for a different request is a hard
 * failure — replaying it would answer a question nobody asked.
 */
export function deserializeFixture(raw: string, path: string, expectedKey: string): InferenceFixture {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (cause) {
    throw new InferenceError("parse", `Fixture ${path} is not valid JSON.`, { cause });
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InferenceError("parse", `Fixture ${path} must be a JSON object.`);
  }

  const fixture = parsed as Partial<InferenceFixture>;

  if (fixture.fixture_version !== FIXTURE_FORMAT_VERSION) {
    throw new InferenceError(
      "parse",
      `Fixture ${path} has fixture_version ${String(fixture.fixture_version)}, expected ${FIXTURE_FORMAT_VERSION}. Re-record it.`,
    );
  }

  if (fixture.key !== expectedKey) {
    throw new InferenceError(
      "parse",
      `Fixture ${path} carries key ${String(fixture.key)} but was loaded for ${expectedKey}. ` +
        "The file was renamed or hand-edited; re-record rather than patching it.",
    );
  }

  if (fixture.response === undefined || typeof fixture.response !== "object" || fixture.response === null) {
    throw new InferenceError("parse", `Fixture ${path} has no response object.`);
  }

  return fixture as InferenceFixture;
}
