/**
 * The `AgentTurnOutput` family's shape, transcribed as data (P-05-BE, D-031,
 * D-039, DIRECTIVE-pre-M1 §6).
 *
 * Why a hand-written table rather than a schema library: CLAUDE.md rule 12.
 * The schema is four closed objects with fourteen keys between them; a
 * validator library would be a new runtime dependency to check something a
 * `for` loop over this table checks exactly.
 *
 * Three things keep it honest, and all three are cheap:
 *
 *   1. `as const satisfies` binds every entry to the generated
 *      `@eutectic/contracts` type, so a misspelled key is a COMPILE error —
 *      `pnpm --filter @eutectic/agents build` fails before any test runs.
 *   2. The `…KeysAreExhaustive` assertions below prove the binding in the
 *      other direction too: a key ADDED to the contract and not to a table
 *      here is also a compile error, which `satisfies` alone would miss.
 *   3. `__tests__/contract-drift.test.ts` parses `openapi.yaml` itself and
 *      compares it to these tables, so a contract change that never reaches
 *      the generated types (a stale `dist/`, a generator bug) still screams.
 *
 * D-039's invariant is the reason `required` and `properties` are ONE table
 * per schema instead of two: every key is required, nullability is the only
 * optionality, and a missing key is a validation failure, not a maybe. The
 * drift test asserts that property of the contract directly — if the contract
 * ever grows an optional key, this file stops being expressible and the test
 * says so rather than the validator quietly accepting a partial turn.
 */

import type { Schemas } from "@eutectic/contracts";

export type AgentTurnOutput = Schemas["AgentTurnOutput"];
export type AgentTurnCall = Schemas["AgentTurnCall"];
export type AgentTurnRef = Schemas["AgentTurnRef"];
export type AgentTurnSelfCheck = Schemas["AgentTurnSelfCheck"];

/** `A extends true` in argument position: the failure lands on the alias. */
type Assert<T extends true> = T;

/** Invariant type equality — `keyof X` vs a tuple's member union, both ways. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/**
 * Every key `AgentTurnOutput` declares. Also every key it requires: they are
 * the same list, and that is the D-039 ruling, not an accident of authoring.
 */
export const AGENT_TURN_OUTPUT_KEYS = [
  "action",
  "body",
  "decline_reason",
  "call",
  "refs",
  "self_check",
] as const satisfies readonly (keyof AgentTurnOutput)[];

export const AGENT_TURN_CALL_KEYS = [
  "claim",
  "claim_type",
  "confidence",
  "horizon_days",
] as const satisfies readonly (keyof AgentTurnCall)[];

export const AGENT_TURN_REF_KEYS = [
  "kind",
  "id",
  "label",
] as const satisfies readonly (keyof AgentTurnRef)[];

export const AGENT_TURN_SELF_CHECK_KEYS = [
  "specific_criticism",
  "adds_over_prior",
] as const satisfies readonly (keyof AgentTurnSelfCheck)[];

export type AgentTurnOutputKeysAreExhaustive = Assert<
  Equals<(typeof AGENT_TURN_OUTPUT_KEYS)[number], keyof AgentTurnOutput>
>;
export type AgentTurnCallKeysAreExhaustive = Assert<
  Equals<(typeof AGENT_TURN_CALL_KEYS)[number], keyof AgentTurnCall>
>;
export type AgentTurnRefKeysAreExhaustive = Assert<
  Equals<(typeof AGENT_TURN_REF_KEYS)[number], keyof AgentTurnRef>
>;
export type AgentTurnSelfCheckKeysAreExhaustive = Assert<
  Equals<(typeof AGENT_TURN_SELF_CHECK_KEYS)[number], keyof AgentTurnSelfCheck>
>;

/** `action`'s closed enum. The ONLY closed vocabulary in the family. */
export const AGENT_TURN_ACTIONS = [
  "contribute",
  "decline",
] as const satisfies readonly AgentTurnOutput["action"][];

export type AgentTurnActionsAreExhaustive = Assert<
  Equals<(typeof AGENT_TURN_ACTIONS)[number], AgentTurnOutput["action"]>
>;

/**
 * `claim_type` deliberately has NO table here. D-039 ruling 4: it is an open
 * vocabulary with documented examples, never a closed enum, because a new
 * claim kind must not need a contract release. Anything that looks like a
 * `CLAIM_TYPES` const in this package is a bug — the validator checks that it
 * is a non-empty string and stops there.
 */

/** `AgentTurnCall.confidence`, inclusive, straight off the contract. */
export const CONFIDENCE_MIN = 1;
export const CONFIDENCE_MAX = 5;

/** `AgentTurnCall.horizon_days`, inclusive lower bound; no upper bound. */
export const HORIZON_DAYS_MIN = 1;

/**
 * `AgentTurnRef.id` is `#/components/schemas/Id` — `type: string, format:
 * uuid`. OpenAPI does not say which UUID version, and neither do we: this
 * matches the canonical 8-4-4-4-12 hex layout case-insensitively without
 * pinning the version or variant nibbles.
 *
 * Deliberate leniency. These ids name rows that Postgres minted, and
 * Postgres's own `uuid` type accepts any 32 hex digits in this layout — so a
 * stricter regex here could reject an id the database considers perfectly
 * valid (a v7 id, say, if a future table ever wants time-ordered keys). The
 * check exists to catch a model INVENTING a ref id, and an invented id fails
 * the layout long before it fails a version nibble.
 */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
