/**
 * The structured-output validator (P-05-BE; D-031, D-039, DIRECTIVE §6).
 *
 * The seam: `packages/inference` produces RAW MODEL TEXT. This turns that text
 * into either a validated `AgentTurnOutput` or a precise rejection. Nothing
 * here reads a database, opens a socket, or knows what a turn is for — the M1
 * turn worker owns retry, decline and persistence (`self_check` into 0013's
 * columns). Every decision below is mechanical: same input, same verdict, no
 * model call, no judge.
 *
 * ─── TWO REJECTION LAYERS, DELIBERATELY DISTINGUISHED ───────────────────────
 *
 *   `schema_violation`      the turn is not an `AgentTurnOutput`. Malformed
 *                           JSON, an unknown key, a missing key, a wrong
 *                           type, an out-of-range number, a cross-field
 *                           contradiction. Nothing about content.
 *   `mechanical_rejection`  the turn IS an `AgentTurnOutput` and is refused
 *                           anyway, because `self_check.specific_criticism`
 *                           is empty or generic. This is D-031's whole point:
 *                           slop is caught before a judge runs and before any
 *                           evaluation budget is spent.
 *
 * Both are rejections and both feed the same rule-7 path — retry ≤3, then
 * write a decline, NEVER a fragment. They are tagged apart because they mean
 * different things to the consumer: a `schema_violation` retry should repair
 * the shape ("your `call.confidence` was 7; it must be 1-5"), a
 * `mechanical_rejection` retry must change what the turn SAYS, and the two
 * rates want separate dashboards.
 *
 * ─── NEVER A FRAGMENT ───────────────────────────────────────────────────────
 *
 * There is no partially-valid return. `ok: true` carries a whole
 * `AgentTurnOutput` and `ok: false` carries no value at all — a caller cannot
 * reach a half-checked object even by trying, because one never exists.
 *
 * ─── WHAT IS DELIBERATELY *NOT* CHECKED HERE ────────────────────────────────
 *
 *   - Whether a ref RESOLVES. `AgentTurnRef.id` is checked for the contract's
 *     `Id` shape; whether that row exists and is visible needs the database,
 *     so it stays in the turn worker (system-design §7 step 6, rule 8).
 *   - Cosine dedupe against prior contributions in the chapter (§7 step 6):
 *     needs embeddings and the chapter, and is not mechanical in this sense.
 *   - Length ceilings and meta-commentary on `body`: house-style checks that
 *     belong with the persona pack, not with the schema.
 *   - Duplicate JSON keys. `JSON.parse` keeps the last and no reviver can see
 *     the earlier one; catching it would mean hand-rolling a JSON parser.
 *
 *   pnpm --filter @eutectic/agents test
 */

import {
  BANNED_PHRASES,
  findBannedPhrase,
  normalisePhrase,
  type BannedPhrase,
} from "./banned-phrases.js";
import {
  AGENT_TURN_ACTIONS,
  AGENT_TURN_CALL_KEYS,
  AGENT_TURN_OUTPUT_KEYS,
  AGENT_TURN_REF_KEYS,
  AGENT_TURN_SELF_CHECK_KEYS,
  CONFIDENCE_MAX,
  CONFIDENCE_MIN,
  HORIZON_DAYS_MIN,
  UUID_PATTERN,
  type AgentTurnOutput,
} from "./schema.js";

/**
 * Machine-usable rejection codes. Stable strings: they are logged, counted,
 * and branched on. Renaming one is a breaking change for whatever dashboard
 * or retry prompt reads it.
 */
export const REJECTION_REASONS = [
  /** The model's text was not JSON at all. */
  "malformed_json",
  /** Valid JSON, but not a JSON object where one was required. */
  "not_an_object",
  /** A key the schema does not declare (`additionalProperties: false`). */
  "unknown_key",
  /** A declared key absent. D-039: nullability is the only optionality. */
  "missing_key",
  /** Present, wrong JSON type. */
  "wrong_type",
  /** A number where the contract says integer. */
  "not_an_integer",
  /** An integer outside the contract's `minimum`/`maximum`. */
  "out_of_range",
  /** `action` was a string, but not one of the two. */
  "invalid_action",
  /** A string the contract types as an id is not shaped like one. */
  "invalid_id",
  /** A string that carries meaning was empty or whitespace. */
  "empty_string",
  /** `body`/`decline_reason` disagree with `action`. */
  "cross_field",
  /** MECHANICAL: `specific_criticism` normalises to nothing. */
  "self_check_empty",
  /** MECHANICAL: `specific_criticism` hit the banned-phrase list. */
  "self_check_generic",
] as const;

export type RejectionReason = (typeof REJECTION_REASONS)[number];

export type RejectionKind = "schema_violation" | "mechanical_rejection";

export interface ValidationAccepted {
  readonly ok: true;
  /** Whole, checked, never partial. */
  readonly value: AgentTurnOutput;
}

export interface ValidationRejected {
  readonly ok: false;
  readonly kind: RejectionKind;
  readonly reason: RejectionReason;
  /**
   * Dotted path to the offending value, `""` for the whole document. Separate
   * from `detail` on purpose: a retry prompt or a metric label wants the path
   * as a value, not as a substring to regex out of prose.
   */
  readonly path: string;
  /** One sentence, safe to log and to paste into a retry prompt. */
  readonly detail: string;
}

export type ValidationResult = ValidationAccepted | ValidationRejected;

export interface ValidationOptions {
  /**
   * The Layer-2 vocabulary the `self_check_generic` gate compares against.
   * Defaults to the shipped list, which D-042 item 2 requires to be EMPTY
   * until the human authors `testing-and-evals.md` §5 — so in production this
   * gate passes everything today, on purpose.
   *
   * Overridable because the mechanism must stay tested while the vocabulary is
   * empty, and because the M1 turn worker may one day want a per-agent list.
   * Never a way to relax the SCHEMA layer: nothing in these options can make
   * an invalid turn valid.
   */
  readonly bannedPhrases?: readonly BannedPhrase[];
}

/** The mechanical layer's own codes, for a caller that wants to count them. */
const MECHANICAL_REASONS: ReadonlySet<RejectionReason> = new Set<RejectionReason>([
  "self_check_empty",
  "self_check_generic",
]);

/** True when this rejection came from the content gate, not the shape gate. */
export function isMechanicalRejection(result: ValidationRejected): boolean {
  return MECHANICAL_REASONS.has(result.reason);
}

function reject(
  kind: RejectionKind,
  reason: RejectionReason,
  path: string,
  detail: string,
): ValidationRejected {
  return { ok: false, kind, reason, path, detail };
}

/** Every schema-layer rejection funnels through here. */
function violation(reason: RejectionReason, path: string, detail: string): ValidationRejected {
  return reject("schema_violation", reason, path, detail);
}

const at = (path: string): string => (path === "" ? "the turn" : `\`${path}\``);

/** What a value looks like in a message, without dumping the model's prose. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  const type = typeof value;
  if (type === "object") return "an object";
  if (type === "string") return "a string";
  if (type === "number") return Number.isInteger(value) ? "an integer" : "a fractional number";
  return type;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `additionalProperties: false` plus "every key required", in one pass, in a
 * fixed order: unknown keys first, then missing keys. Fixed because the reason
 * a caller logs must not depend on object key order.
 */
function checkKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): ValidationRejected | undefined {
  const known: ReadonlySet<string> = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      return violation(
        "unknown_key",
        path === "" ? key : `${path}.${key}`,
        `${at(path)} carries \`${key}\`, which the contract does not declare.`,
      );
    }
  }
  for (const key of keys) {
    // `undefined` counts as missing, not as present-and-null: `JSON.stringify`
    // drops an undefined value, so on the wire the two are the same thing, and
    // a caller handing us an object rather than raw text must not get a
    // different answer than the same turn serialised.
    if (!Object.hasOwn(value, key) || value[key] === undefined) {
      return violation(
        "missing_key",
        path === "" ? key : `${path}.${key}`,
        `${at(path)} is missing \`${key}\`. Every key is required — send null, not nothing.`,
      );
    }
  }
  return undefined;
}

function checkString(value: unknown, path: string): ValidationRejected | undefined {
  if (typeof value !== "string") {
    return violation("wrong_type", path, `${at(path)} must be a string; got ${describe(value)}.`);
  }
  return undefined;
}

function checkNonEmptyString(value: unknown, path: string): ValidationRejected | undefined {
  const wrongType = checkString(value, path);
  if (wrongType !== undefined) return wrongType;
  if ((value as string).trim().length === 0) {
    return violation("empty_string", path, `${at(path)} must not be empty or whitespace.`);
  }
  return undefined;
}

function checkBoundedInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum?: number,
): ValidationRejected | undefined {
  if (typeof value !== "number") {
    return violation("wrong_type", path, `${at(path)} must be an integer; got ${describe(value)}.`);
  }
  if (!Number.isInteger(value)) {
    return violation("not_an_integer", path, `${at(path)} must be an integer; got ${value}.`);
  }
  const range = maximum === undefined ? `at least ${minimum}` : `${minimum}-${maximum}`;
  if (value < minimum || (maximum !== undefined && value > maximum)) {
    return violation("out_of_range", path, `${at(path)} must be ${range}; got ${value}.`);
  }
  return undefined;
}

/** `AgentTurnCall`, or the reason it is not one. `null` is handled upstream. */
function checkCall(value: unknown): ValidationRejected | undefined {
  if (!isPlainObject(value)) {
    return violation("not_an_object", "call", `\`call\` must be an object or null; got ${describe(value)}.`);
  }

  const keys = checkKeys(value, AGENT_TURN_CALL_KEYS, "call");
  if (keys !== undefined) return keys;

  // `claim` and `claim_type` carry no `minLength` in the contract, so "" is
  // literally legal JSON Schema. Refused anyway: an empty claim is a call
  // that asserts nothing, and writing it would put a row in `calls` that can
  // never be resolved — rule 7's fragment, wearing a valid shape. Flagged for
  // the reviewer in the PR body as stricter than the letter of the contract.
  const claim = checkNonEmptyString(value["claim"], "call.claim");
  if (claim !== undefined) return claim;

  // Non-empty string and NOTHING ELSE. D-039 ruling 4: `claim_type` is an
  // OPEN vocabulary. Any list of accepted values here — even "the three
  // examples in the contract" — would mean a new claim kind needs a code
  // release, which is exactly what that ruling forbids.
  const claimType = checkNonEmptyString(value["claim_type"], "call.claim_type");
  if (claimType !== undefined) return claimType;

  const confidence = checkBoundedInteger(
    value["confidence"],
    "call.confidence",
    CONFIDENCE_MIN,
    CONFIDENCE_MAX,
  );
  if (confidence !== undefined) return confidence;

  return checkBoundedInteger(value["horizon_days"], "call.horizon_days", HORIZON_DAYS_MIN);
}

function checkRefs(value: unknown): ValidationRejected | undefined {
  if (!Array.isArray(value)) {
    return violation("wrong_type", "refs", `\`refs\` must be an array; got ${describe(value)}.`);
  }

  for (const [index, entry] of value.entries()) {
    const path = `refs[${index}]`;
    if (!isPlainObject(entry)) {
      return violation("not_an_object", path, `${at(path)} must be an object; got ${describe(entry)}.`);
    }

    const keys = checkKeys(entry, AGENT_TURN_REF_KEYS, path);
    if (keys !== undefined) return keys;

    // `kind` names a platform entity type and is an open vocabulary too — the
    // contract gives examples, not an enum. Non-empty string, no list.
    const kind = checkNonEmptyString(entry["kind"], `${path}.kind`);
    if (kind !== undefined) return kind;

    const id = checkString(entry["id"], `${path}.id`);
    if (id !== undefined) return id;
    if (!UUID_PATTERN.test(entry["id"] as string)) {
      return violation(
        "invalid_id",
        `${path}.id`,
        `${at(`${path}.id`)} must be a UUID. A ref names a row that exists; it cannot be invented.`,
      );
    }

    // `label` is what the ref is CALLED, and an unlabelled ref is unrenderable
    // in a diary or a citation line. Non-empty, same ruling as `claim`.
    const label = checkNonEmptyString(entry["label"], `${path}.label`);
    if (label !== undefined) return label;
  }

  return undefined;
}

/**
 * The schema layer for `self_check` only — both keys present, both strings.
 * The CONTENT gate (empty, generic) is separate and runs later, because it is
 * a mechanical rejection rather than a schema violation and because it is
 * scoped to contributions.
 */
function checkSelfCheckShape(value: unknown): ValidationRejected | undefined {
  if (!isPlainObject(value)) {
    return violation("not_an_object", "self_check", `\`self_check\` must be an object; got ${describe(value)}.`);
  }

  const keys = checkKeys(value, AGENT_TURN_SELF_CHECK_KEYS, "self_check");
  if (keys !== undefined) return keys;

  for (const key of AGENT_TURN_SELF_CHECK_KEYS) {
    const wrongType = checkString(value[key], `self_check.${key}`);
    if (wrongType !== undefined) return wrongType;
  }
  return undefined;
}

/**
 * `action` decides which of `body` and `decline_reason` is null, and the
 * contract says "exactly when" in both directions — so a contribute that also
 * carries a decline reason is as wrong as a decline that carries a body. Both
 * halves are checked; a turn that hedges by filling in both is refused.
 */
function checkCrossFields(value: Record<string, unknown>): ValidationRejected | undefined {
  const action = value["action"];
  const body = value["body"];
  const declineReason = value["decline_reason"];

  if (action === "contribute") {
    if (body === null) {
      return violation("cross_field", "body", "`body` must be a string when `action` is `contribute`.");
    }
    const bodyType = checkString(body, "body");
    if (bodyType !== undefined) return bodyType;
    // An empty body IS the fragment rule 7 names: a contribution that
    // publishes nothing. Stricter than the contract's bare `string`, and
    // called out for the reviewer.
    if ((body as string).trim().length === 0) {
      return violation("empty_string", "body", "`body` must not be empty when `action` is `contribute`.");
    }
    if (declineReason !== null) {
      return violation(
        "cross_field",
        "decline_reason",
        "`decline_reason` must be null when `action` is `contribute`; it is non-null exactly when the turn declines.",
      );
    }
    return undefined;
  }

  // action === "decline"
  if (body !== null) {
    return violation("cross_field", "body", "`body` must be null when `action` is `decline`.");
  }
  if (declineReason === null) {
    return violation(
      "cross_field",
      "decline_reason",
      "`decline_reason` must be a string when `action` is `decline`.",
    );
  }
  const reasonType = checkString(declineReason, "decline_reason");
  if (reasonType !== undefined) return reasonType;
  if ((declineReason as string).trim().length === 0) {
    return violation(
      "empty_string",
      "decline_reason",
      "`decline_reason` must not be empty when `action` is `decline`.",
    );
  }
  return undefined;
}

/**
 * D-031's mechanical gate. Runs only after the whole turn is schema-valid, so
 * it can trust that `specific_criticism` is a string.
 *
 * ─── SCOPED TO CONTRIBUTIONS, AND WHY ───────────────────────────────────────
 *
 * A DECLINE is not put through this gate. Three reasons, and the reviewer
 * should push back if any of them is wrong:
 *
 *   1. The gate exists to catch slop "before you spend anything on
 *      evaluation" (DIRECTIVE §6). A decline has no body to evaluate — there
 *      is no contribution for the criticism to be the falsifiable claim IN.
 *   2. Rejecting a decline costs up to three more inference calls to arrive
 *      at a decline anyway. That is spend with no possible change in outcome,
 *      against a hard per-agent budget ceiling.
 *   3. A decline already does not count toward the coverage target (D-033),
 *      so nothing downstream is protected by refusing it a second time.
 *
 * The SHAPE of `self_check` is still enforced on a decline, and it is still
 * persisted (D-030) — only the content gate is scoped.
 *
 * ─── HALF OF THIS GATE IS DORMANT TODAY (D-042 item 2) ──────────────────────
 *
 * `self_check_empty` works now: emptiness is decided by normalisation and owes
 * nothing to a vocabulary. `self_check_generic` cannot fire in production,
 * because the shipped phrase list is empty by ruling until the human writes
 * `testing-and-evals.md` §5. The code below is reserved rather than removed —
 * populating the data file must start it firing with no release.
 */
function checkSelfCheckContent(
  value: Record<string, unknown>,
  bannedPhrases: readonly BannedPhrase[],
): ValidationRejected | undefined {
  if (value["action"] !== "contribute") return undefined;

  const selfCheck = value["self_check"] as Record<string, unknown>;
  const criticism = selfCheck["specific_criticism"] as string;
  const path = "self_check.specific_criticism";

  if (normalisePhrase(criticism).length === 0) {
    return reject(
      "mechanical_rejection",
      "self_check_empty",
      path,
      `${at(path)} is empty. Name the one falsifiable claim this contribution makes.`,
    );
  }

  const banned: BannedPhrase | undefined = findBannedPhrase(criticism, bannedPhrases);
  if (banned !== undefined) {
    return reject(
      "mechanical_rejection",
      "self_check_generic",
      path,
      `${at(path)} is generic: it hits the banned phrase "${banned.phrase}" (${banned.note}, ${banned.match} match). Name a specific, falsifiable claim.`,
    );
  }

  return undefined;
}

/**
 * Validate an already-parsed value. Use this when the JSON came from
 * somewhere other than raw model text — a replayed fixture, a stored turn.
 */
export function validateTurnOutputValue(
  value: unknown,
  options: ValidationOptions = {},
): ValidationResult {
  if (!isPlainObject(value)) {
    return violation("not_an_object", "", `A turn must be a JSON object; got ${describe(value)}.`);
  }

  const keys = checkKeys(value, AGENT_TURN_OUTPUT_KEYS, "");
  if (keys !== undefined) return keys;

  const actionType = checkString(value["action"], "action");
  if (actionType !== undefined) return actionType;
  if (!(AGENT_TURN_ACTIONS as readonly string[]).includes(value["action"] as string)) {
    return violation(
      "invalid_action",
      "action",
      `\`action\` must be one of ${AGENT_TURN_ACTIONS.map((a) => `\`${a}\``).join(", ")}.`,
    );
  }

  const crossFields = checkCrossFields(value);
  if (crossFields !== undefined) return crossFields;

  if (value["call"] !== null) {
    const call = checkCall(value["call"]);
    if (call !== undefined) return call;
  }

  const refs = checkRefs(value["refs"]);
  if (refs !== undefined) return refs;

  const selfCheckShape = checkSelfCheckShape(value["self_check"]);
  if (selfCheckShape !== undefined) return selfCheckShape;

  // Schema layer clean from here down. Only now does the content gate run —
  // a mechanical rejection is a statement about a well-formed turn.
  const content = checkSelfCheckContent(value, options.bannedPhrases ?? BANNED_PHRASES);
  if (content !== undefined) return content;

  // Every key checked, no key unchecked: the cast asserts what the code above
  // proved. It is the ONE cast in this file, and it is why `checkKeys` runs
  // against the same table the compiler binds to `keyof AgentTurnOutput`.
  return { ok: true, value: value as unknown as AgentTurnOutput };
}

/**
 * The entry point the turn worker calls: raw model text in, a validated
 * `AgentTurnOutput` or a precise rejection out.
 */
export function validateTurnOutput(raw: string, options: ValidationOptions = {}): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return violation("malformed_json", "", `The turn was not valid JSON: ${message}`);
  }
  return validateTurnOutputValue(parsed, options);
}
