import type { Schemas } from "@eutectic/contracts/server";

import { InferenceError } from "./errors.js";

export type AgentTurnOutput = Schemas["AgentTurnOutput"];

/**
 * The thin step between raw model text and the contract type. It does exactly
 * two things: one `JSON.parse`, and one check that the result is a JSON object
 * rather than an array, a null or a scalar.
 *
 * It is deliberately NOT a validator. `packages/agents` (P-05-BE) owns
 * validation of `AgentTurnOutput` — every required key, every enum, the
 * decline/body invariant. Duplicating any of that here would give the turn
 * worker two verdicts on one piece of text, and the day they disagree is the
 * day a contribution is written that nothing approved.
 *
 * It also does no repair. No fence stripping, no "find the first {", no
 * trailing-comma tolerance. A model that wrapped its answer in prose did not
 * follow the structured-output contract (D-031), and the retry-then-decline
 * path (rule 7) is the correct response to that — not a heuristic that makes a
 * malformed turn look well-formed.
 */
export function parseAgentTurnOutput(text: string): AgentTurnOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new InferenceError(
      "parse",
      `Model output was not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InferenceError(
      "parse",
      `Model output parsed as ${parsed === null ? "null" : Array.isArray(parsed) ? "an array" : typeof parsed}, ` +
        "but an AgentTurnOutput is a JSON object.",
    );
  }

  // The one cast in this package. Its whole justification is the paragraph
  // above: the shape is checked downstream, by the package that owns the rules.
  return parsed as AgentTurnOutput;
}
