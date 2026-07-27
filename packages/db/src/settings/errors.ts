/**
 * The three ways a platform-settings call can fail, as TYPES rather than as
 * strings a caller has to pattern-match (P-09).
 *
 * `apps/api` maps each to a contract status, and the mapping is total — there
 * is no fourth case and no bare `Error` path that a handler would have to
 * guess about:
 *
 *   {@link SettingNotFoundError}   → `404 not_found`     unknown key
 *   {@link SettingValueError}      → `422 unprocessable` the SUBMITTED value is bad
 *   {@link SettingDataError}       → `500 internal`      the STORED row is bad
 *
 * The last one is the important distinction and the reason there are three
 * classes rather than two. A row whose `value_type` is not one of
 * `bool|int|float`, or whose stored `value` does not match its own
 * `value_type`, is a CORRUPT DATABASE — the ticket's words: "treat an
 * unrecognized value_type or a value that fails coercion as a hard error,
 * never a silent passthrough". Nobody's request caused it and nobody's request
 * can fix it, so it is not a `422`; and it must not be answered by shrugging
 * and handing back the raw JSON, because the caller downstream is a routing
 * job about to multiply it by a budget. D-013 put validity in the service
 * layer instead of a CHECK constraint precisely so this check has somewhere to
 * live — this is that place, and it fails loud.
 */

/** One machine-readable complaint about a submitted value. Shaped for `ErrorDetail`. */
export interface SettingIssue {
  /**
   * The field of the request body at fault. Always `"value"` today —
   * `PlatformSettingUpdate` has exactly one property — but named rather than
   * implied so the `422` envelope needs no assembly in the handler.
   */
  readonly field: string;
  /**
   * Machine-readable reason, matching `ErrorDetail.issue`'s "e.g. `word_count`"
   * convention. One of `type_mismatch` or `out_of_range`.
   */
  readonly issue: SettingIssueCode;
  /** Human-readable elaboration. Safe to show an operator; never a stack trace. */
  readonly detail: string;
}

export type SettingIssueCode = "type_mismatch" | "out_of_range";

/**
 * The key does not exist. NEVER an upsert (D-040: "settings are seeded by
 * migration and never created through this API — an unknown key is a `404`").
 *
 * Carries the key because the key came from the URL and is already public; it
 * is not a secret and an operator staring at a 404 wants to see which one.
 */
export class SettingNotFoundError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`no platform setting with key ${key}`);
    this.name = "SettingNotFoundError";
    this.key = key;
  }
}

/**
 * The submitted value is the wrong type for the row's `value_type`, or falls
 * outside its inclusive `min_value`/`max_value` bounds. A `422`.
 *
 * `issues` is a list rather than a single reason so the envelope can carry
 * more than one complaint if a later setting grows a second constraint; today
 * a value fails on exactly one of type or range (a value that is not a number
 * cannot also be out of range), and the list has one entry.
 */
export class SettingValueError extends Error {
  readonly key: string;
  readonly issues: readonly SettingIssue[];

  constructor(key: string, issues: readonly SettingIssue[]) {
    super(`platform setting ${key} rejected the submitted value`);
    this.name = "SettingValueError";
    this.key = key;
    this.issues = issues;
  }
}

/**
 * The STORED row is unusable: an unrecognized `value_type`, a `value` that
 * does not match the `value_type` the same row declares, or a bound that is
 * not a number. A `500`, and a loud one.
 *
 * This is deliberately not recoverable-by-ignoring. Returning the raw jsonb
 * and letting the caller sort it out is exactly the "silent passthrough" the
 * ticket forbids: `routing.coverage_target` arriving as the string `"6"`
 * instead of the number `6` would multiply through a budget calculation and
 * come out somewhere strange, hours later, with nothing in the logs pointing
 * back here.
 */
export class SettingDataError extends Error {
  readonly key: string;

  constructor(key: string, reason: string) {
    super(`platform setting ${key} is not usable: ${reason}`);
    this.name = "SettingDataError";
    this.key = key;
  }
}

/** Narrowing helpers. `instanceof` across module realms is not worth trusting (`apps/api/src/errors.ts`). */
export function isSettingNotFoundError(value: unknown): value is SettingNotFoundError {
  return value instanceof SettingNotFoundError;
}

export function isSettingValueError(value: unknown): value is SettingValueError {
  return value instanceof SettingValueError;
}

export function isSettingDataError(value: unknown): value is SettingDataError {
  return value instanceof SettingDataError;
}
