/**
 * Value typing for `platform_settings` (P-09, D-013).
 *
 * `value` is `jsonb` and `value_type` is a plain `text` column with a comment
 * and no CHECK — D-013's ratified convention: "enum-like text columns get
 * comments, validity lives in the service layer". This file IS that service
 * layer for the one column the convention most obviously applies to.
 *
 * TWO DIRECTIONS, DELIBERATELY DIFFERENT IN SEVERITY
 * -------------------------------------------------------------------------
 * READING a row (`coerceStoredValue`, `coerceBound`) checks the DATABASE.
 * A failure here is corruption — the row was written by a migration or by this
 * service, both of which are supposed to have got it right — so it raises
 * {@link SettingDataError}, which `apps/api` renders as a `500`. There is no
 * "return it anyway" branch: a silent passthrough is precisely what turns a
 * `"6"` into a wrong budget three hours later.
 *
 * WRITING a row (`validateSubmittedValue`) checks a HUMAN. A failure here is
 * an admin typing `2.5` into an integer field or `9999999` into a bounded one,
 * so it raises {@link SettingValueError} carrying structured issues, which
 * `apps/api` renders as the contract's `422` with `details`.
 *
 * BOUNDS ARE INCLUSIVE, per the ticket, and per the only reading that makes
 * the seeded data work: `routing.exploration_rate` is bounded `0..1` and 0 and
 * 1 are both meaningful settings ("never explore" / "always explore"); an
 * exclusive bound would forbid the two most useful values it has.
 */

import type { PlatformSettingValueType } from "../seed-data/platform-settings.js";
import { SettingDataError, SettingValueError, type SettingIssue } from "./errors.js";

/**
 * The vocabulary, as one array so the type guard and any error message that
 * wants to list the legal values read from the same place. Mirrors
 * `PlatformSettingValueType` in `../seed-data/platform-settings.ts`; the
 * `satisfies` below is what keeps the two from drifting apart silently.
 */
export const PLATFORM_SETTING_VALUE_TYPES = [
  "bool",
  "int",
  "float",
] as const satisfies readonly PlatformSettingValueType[];

export function isPlatformSettingValueType(value: unknown): value is PlatformSettingValueType {
  return (
    typeof value === "string" &&
    (PLATFORM_SETTING_VALUE_TYPES as readonly string[]).includes(value)
  );
}

/**
 * A stored `value` (already JSON-parsed by the driver — `jsonb` comes back as
 * a JS value, not a string) checked against the row's own `value_type`.
 *
 * @throws {SettingDataError} on an unrecognized `value_type`, or on a value
 *         that does not match the one it declares.
 */
export function coerceStoredValue(
  key: string,
  valueType: unknown,
  raw: unknown,
): boolean | number {
  if (!isPlatformSettingValueType(valueType)) {
    throw new SettingDataError(
      key,
      `value_type ${describe(valueType)} is not one of ${PLATFORM_SETTING_VALUE_TYPES.join("|")}`,
    );
  }

  const problem = typeProblem(valueType, raw);
  if (problem !== undefined) {
    throw new SettingDataError(key, `stored value ${describe(raw)} ${problem}`);
  }
  return raw as boolean | number;
}

/**
 * A stored `min_value`/`max_value` as a number, or `null`.
 *
 * The column is `numeric`, which postgres.js hands back as a STRING — it will
 * not silently round a value that does not fit a double, which is the right
 * default for a money-shaped type and an inconvenience here. Both forms are
 * accepted, and anything that is neither is corruption rather than a shrug:
 * a bound that cannot be compared is a bound that is not enforcing anything,
 * and a settings service whose range check quietly stops running is worse than
 * one that stops.
 *
 * @throws {SettingDataError} on a non-null bound that is not a finite number.
 */
export function coerceBound(key: string, field: string, raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) throw new SettingDataError(key, `${field} is not finite`);
    return raw;
  }
  if (typeof raw === "string") {
    // `Number("")` is 0, which would turn an empty bound into a real one.
    const trimmed = raw.trim();
    const parsed = trimmed.length === 0 ? Number.NaN : Number(trimmed);
    if (!Number.isFinite(parsed)) {
      throw new SettingDataError(key, `${field} ${describe(raw)} is not a number`);
    }
    return parsed;
  }
  throw new SettingDataError(key, `${field} ${describe(raw)} is not a number`);
}

/** What {@link validateSubmittedValue} needs to know about the row being written. */
export interface ValueConstraints {
  readonly key: string;
  readonly valueType: PlatformSettingValueType;
  /** Inclusive lower bound, or `null` for "unbounded below" (and for every boolean). */
  readonly minValue: number | null;
  /** Inclusive upper bound, or `null`. */
  readonly maxValue: number | null;
}

/**
 * A value from an admin's request, checked against the row it is about to
 * overwrite. Returns the value narrowed to what the column may hold.
 *
 * Type first, then range — and range is not checked when the type already
 * failed, because "2.5 is not an integer AND is out of range 0..1" is two
 * complaints about one mistake, and the second one is noise.
 *
 * Bounds are ignored for `bool`, rather than treated as corruption if some
 * future row carries them: `min_value` on a boolean has no meaning to compare
 * against, and refusing to serve the row over an unused column would take the
 * settings page down for a field nobody reads.
 *
 * @throws {SettingValueError} with at least one {@link SettingIssue}.
 */
export function validateSubmittedValue(
  constraints: ValueConstraints,
  raw: unknown,
): boolean | number {
  const { key, valueType } = constraints;

  const problem = typeProblem(valueType, raw);
  if (problem !== undefined) {
    throw new SettingValueError(key, [
      {
        field: "value",
        issue: "type_mismatch",
        detail: `${key} is ${valueType}; ${describe(raw)} ${problem}`,
      },
    ]);
  }

  if (valueType === "bool") return raw as boolean;

  const value = raw as number;
  const issues: SettingIssue[] = [];
  const { minValue, maxValue } = constraints;

  // Inclusive on both ends: `<` / `>`, never `<=` / `>=`.
  if (minValue !== null && value < minValue) {
    issues.push({
      field: "value",
      issue: "out_of_range",
      detail: `${key} has an inclusive minimum of ${minValue}`,
    });
  }
  if (maxValue !== null && value > maxValue) {
    issues.push({
      field: "value",
      issue: "out_of_range",
      detail: `${key} has an inclusive maximum of ${maxValue}`,
    });
  }

  if (issues.length > 0) throw new SettingValueError(key, issues);
  return value;
}

/**
 * The one type check, shared by both directions so a stored value and a
 * submitted value can never disagree about what `int` means. Returns
 * `undefined` when the value is acceptable, or a phrase completing the
 * sentence "the value <phrase>".
 */
function typeProblem(valueType: PlatformSettingValueType, raw: unknown): string | undefined {
  if (valueType === "bool") {
    // `1`/`0` are NOT accepted as booleans. JSON has a boolean; a setting that
    // accepts both spellings is a setting whose stored form depends on which
    // client wrote it last, and the admin UI renders a checkbox either way.
    return typeof raw === "boolean" ? undefined : "is not a boolean";
  }

  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    // `typeof NaN === "number"`, and NaN survives JSON only as `null`; both it
    // and Infinity are caught here rather than reaching a comparison that
    // would silently answer `false` to every bound.
    return "is not a finite number";
  }
  if (valueType === "int" && !Number.isInteger(raw)) {
    return "is not an integer";
  }
  return undefined;
}

/**
 * A value rendered for an error message. Short, quoted where ambiguous, and
 * never a whole object — these strings reach an operator through a `422`
 * envelope and a log line, so they are bounded on purpose.
 */
function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value.slice(0, 40));
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return `a ${typeof value}`;
}
