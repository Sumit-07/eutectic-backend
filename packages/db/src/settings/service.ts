/**
 * The platform-settings service (P-09, DIRECTIVE §3; D-036, D-040).
 *
 * "One generic, admin-controlled, audited key-value store. Not three one-off
 * feature flags" — the directive's opening line, and the shape of this module:
 * two reads and one write, over a table whose contents are data.
 *
 * WHAT THE DIRECTIVE ASKS FOR, AND WHERE EACH PIECE IS
 *
 *   "Every write appends to `admin_audit` with before and after values"
 *        → {@link updatePlatformSetting}, inside the SAME transaction as the
 *          value change. A settings write that is not audited does not happen.
 *   "Cached in Redis, 60s TTL, busted on write"
 *        → `cache.ts`'s injected seam; TTL and key are constants there, the
 *          bust is the last step of the write and runs only after COMMIT.
 *   "Range-validated against `min_value`/`max_value`"
 *        → `value.ts`, inclusive on both ends, `422`-shaped when it fails.
 *   "Read once per routing job, never per agent"
 *        → one snapshot key, one query, whole table.
 *
 * TWO FAILURE POSTURES, AND THEY POINT IN OPPOSITE DIRECTIONS. The cache FAILS
 * OPEN: a `get` that throws, times out or returns junk is treated as a miss
 * and the read goes to Postgres, because a Redis outage must never stop the
 * routing job. Validation NEVER fails open: an unrecognized `value_type`, a
 * stored value that does not match it, or a bound that is not a number all
 * raise (`value.ts`, `errors.ts`). The asymmetry is deliberate — the cache is
 * an optimisation and correctness does not depend on it (D-001: "Redis
 * degrades latency/staleness, never correctness"), while the coercion is the
 * only thing standing between a `text`-typed vocabulary (D-013: no CHECK) and
 * a spend control read as a string.
 *
 * `now` IS ALWAYS AN EXPLICIT PARAMETER on the write (D-014's discipline, the
 * same rule `../entitlements.ts` follows): no `Date.now()` and no bare SQL
 * `now()` for `updated_at`. The caller supplies the instant, so the audit row
 * and the settings row cannot disagree about when the change happened, and a
 * test can assert an exact timestamp instead of a window.
 */

import type { ISql, Sql } from "postgres";

import type { PlatformSettingValueType } from "../seed-data/platform-settings.js";
import {
  PLATFORM_SETTINGS_CACHE_KEY,
  PLATFORM_SETTINGS_CACHE_TTL_SECONDS,
  type SettingsCache,
} from "./cache.js";
import { SettingDataError, SettingNotFoundError } from "./errors.js";
import {
  coerceBound,
  coerceStoredValue,
  isPlatformSettingValueType,
  validateSubmittedValue,
} from "./value.js";

/**
 * One `platform_settings` row as this service hands it out: camelCase, coerced,
 * and safe to serialise.
 *
 * `updatedAt` IS AN ISO STRING, NOT A `Date`, and the reason is the cache.
 * `../entitlements.ts` learned this the hard way and wrote it down: the cache
 * codec is `JSON.stringify`/`JSON.parse` with no reviver, so a `Date` survives
 * the write and comes back a string. A record that changes TYPE depending on
 * whether the read hit the cache is a bug waiting for the first cache-warm
 * test run to hide it. Converting once, here, means every caller sees the same
 * shape — and it happens to be exactly what the contract's `Timestamp` wants.
 */
export interface PlatformSettingRecord {
  readonly key: string;
  /** Coerced per {@link valueType}: `bool` → boolean, `int`/`float` → number. */
  readonly value: boolean | number;
  readonly valueType: PlatformSettingValueType;
  readonly description: string;
  /** Inclusive lower bound, `null` where a bound makes no sense (every boolean). */
  readonly minValue: number | null;
  /** Inclusive upper bound, `null` where a bound makes no sense. */
  readonly maxValue: number | null;
  /** `null` for a row no admin has ever touched — the seeded state (D-040). */
  readonly updatedBy: string | null;
  /** ISO 8601. See the type note above for why this is not a `Date`. */
  readonly updatedAt: string;
}

/** Optional collaborators. Omit `cache` and every read goes straight to Postgres. */
export interface PlatformSettingsOptions {
  /**
   * A cache view, already namespaced by the caller (`apps/api` passes
   * `cache.namespace("settings")`). This module never spells a namespace: a
   * caller composing several stays in charge of that composition, exactly as
   * `../entitlements.ts`'s wrapper does.
   */
  readonly cache?: SettingsCache;
}

/** The raw column shape postgres.js hands back — snake_case, as the DDL names them. */
interface PlatformSettingRowSql {
  key: string;
  value: unknown;
  value_type: string;
  description: string;
  /** `numeric` — a STRING from this driver. See `coerceBound`. */
  min_value: unknown;
  max_value: unknown;
  updated_by: string | null;
  updated_at: Date;
}

function toRecord(row: PlatformSettingRowSql): PlatformSettingRecord {
  const key = row.key;
  const value = coerceStoredValue(key, row.value_type, row.value);
  // `coerceStoredValue` already rejected anything else; this narrows the type
  // without a second round of validation.
  const valueType = row.value_type as PlatformSettingValueType;

  return {
    key,
    value,
    valueType,
    description: row.description,
    minValue: coerceBound(key, "min_value", row.min_value),
    maxValue: coerceBound(key, "max_value", row.max_value),
    updatedBy: row.updated_by,
    updatedAt: toIsoTimestamp(key, row.updated_at),
  };
}

function toIsoTimestamp(key: string, value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new SettingDataError(key, "updated_at is not a valid timestamp");
  }
  return date.toISOString();
}

/**
 * Every setting, ordered by key.
 *
 * ORDERED BECAUSE THE OUTPUT IS A LIST A HUMAN READS. `GET /admin/settings` is
 * unpaginated by design (D-040) and renders straight into the settings page;
 * an unordered result would reshuffle the page every time Postgres felt like
 * returning rows in a different order, which is a worse experience than any
 * particular ordering and makes the cached snapshot pointlessly
 * non-deterministic. `key` is also the primary key, so the sort is free.
 *
 * Reads the cache first and falls through on ANY problem — miss, outage,
 * junk. Writes the snapshot back on a miss, ignoring the result: a failed
 * cache write means the next read misses again, which is the same outcome as
 * not having a cache at all.
 *
 * @throws {SettingDataError} if any row in the table is unusable.
 */
export async function listPlatformSettings(
  sql: ISql,
  options: PlatformSettingsOptions = {},
): Promise<readonly PlatformSettingRecord[]> {
  const cache = options.cache;

  if (cache !== undefined) {
    const cached = await readSnapshot(cache);
    if (cached !== undefined) return cached;
  }

  const rows = await sql<PlatformSettingRowSql[]>`
    SELECT key, value, value_type, description, min_value, max_value, updated_by, updated_at
    FROM platform_settings
    ORDER BY key
  `;
  // Mapped BEFORE the cache write, so a corrupt row throws instead of being
  // cached in its broken form for the next 60 seconds.
  const records = rows.map(toRecord);

  if (cache !== undefined) await writeSnapshot(cache, records);
  return records;
}

/**
 * One setting by key, or `null` if there is none.
 *
 * `null` RATHER THAN A THROW, unlike the write path. A read is a question
 * ("is this key set?") and "no" is a legitimate answer a caller may want to
 * branch on — the same posture `resolveEntitlement` takes in
 * `../entitlements.ts`. The WRITE path throws {@link SettingNotFoundError}
 * instead, because there "no" is not an answer, it is a refusal: D-040 makes
 * an unknown key a `404` and forbids the upsert that would otherwise be the
 * tempting alternative.
 *
 * Served from the same whole-table snapshot as {@link listPlatformSettings}
 * rather than a `WHERE key = ...` query, so a point read and a list read can
 * never disagree, and so the cache has one key to bust rather than N+1.
 *
 * @throws {SettingDataError} if any row in the table is unusable.
 */
export async function getPlatformSetting(
  sql: ISql,
  key: string,
  options: PlatformSettingsOptions = {},
): Promise<PlatformSettingRecord | null> {
  const settings = await listPlatformSettings(sql, options);
  return settings.find((setting) => setting.key === key) ?? null;
}

/** What {@link updatePlatformSetting} needs. Every field required — none of these has a safe default. */
export interface UpdatePlatformSettingInput {
  readonly key: string;
  /** The submitted value, straight off the request body. Validated, never trusted. */
  readonly value: unknown;
  /**
   * `users.id` of the acting admin. Written to BOTH `platform_settings.updated_by`
   * and `admin_audit.admin_user_id` — the settings row answers "who last
   * touched this", the audit row answers "who made this specific change", and
   * they are the same person by construction because they are the same
   * parameter.
   */
  readonly adminUserId: string;
  /** The instant of the change. Explicit, never read from a clock in here (D-014). */
  readonly now: Date;
}

/**
 * `admin_audit.action` for this operation. A dotted, past-tense name so the
 * audit log reads as a list of things that happened; a later admin operation
 * adds its own constant rather than reusing this one.
 */
export const PLATFORM_SETTING_UPDATED_ACTION = "platform_setting.updated";

/**
 * Change one setting's value. Update-by-key only — NEVER an upsert.
 *
 * ONE TRANSACTION, TWO WRITES, AND THE AUDIT IS NOT OPTIONAL. DIRECTIVE §3:
 * "every write appends to `admin_audit` with before and after values". Both
 * statements run inside a single `sql.begin`, so a failed audit insert rolls
 * the value change back — an unaudited settings change cannot exist, not even
 * as a race. The row is locked `FOR UPDATE` on the way in, so two admins
 * changing the same key serialise and the `before` value in each audit row is
 * genuinely the value that admin saw.
 *
 * ORDER OF OPERATIONS, all of it load-bearing:
 *   1. `SELECT ... FOR UPDATE` — the `before` value, locked.
 *   2. No row → {@link SettingNotFoundError}. This is the "never an upsert"
 *      guarantee (D-040), and it is a `SELECT` that decides it, not an
 *      `ON CONFLICT` clause that could be edited into one later.
 *   3. Validate the submitted value against the row's own `value_type` and
 *      bounds → {@link SettingValueError} (`422`) if it fails.
 *   4. `UPDATE` value / `updated_by` / `updated_at`.
 *   5. `INSERT` the audit row carrying key, before AND after.
 *   6. COMMIT — and only then bust the cache.
 *
 * THE BUST IS AFTER COMMIT, NOT INSIDE THE TRANSACTION. Busting inside would
 * open a window where the transaction later rolls back and the cache has
 * already been cleared — harmless — but far worse, it would leave the OLD
 * value cacheable again by any read that lands between the bust and the
 * commit, which is the one ordering that leaves a stale value behind with no
 * TTL bound. A failed bust is tolerated (the value is stale for at most the
 * 60s TTL, never longer); a failed write is not.
 *
 * @throws {SettingNotFoundError} the key does not exist (`404`).
 * @throws {SettingValueError} wrong type or out of the inclusive range (`422`).
 * @throws {SettingDataError} the STORED row is unusable (`500`).
 */
export async function updatePlatformSetting(
  sql: Sql,
  input: UpdatePlatformSettingInput,
  options: PlatformSettingsOptions = {},
): Promise<PlatformSettingRecord> {
  const { key, adminUserId, now } = input;

  const updated = await sql.begin(async (tx) => {
    const existing = await tx<PlatformSettingRowSql[]>`
      SELECT key, value, value_type, description, min_value, max_value, updated_by, updated_at
      FROM platform_settings
      WHERE key = ${key}
      FOR UPDATE
    `;

    const before = existing[0];
    if (before === undefined) throw new SettingNotFoundError(key);

    // Coerce the CURRENT row before touching anything: a corrupt row must not
    // be quietly repaired by an admin write, because the repair would hide
    // whatever wrote it wrong. `before.value` in the audit row is therefore
    // always a value this service vouches for.
    const beforeRecord = toRecord(before);

    const value = validateSubmittedValue(
      {
        key,
        valueType: beforeRecord.valueType,
        minValue: beforeRecord.minValue,
        maxValue: beforeRecord.maxValue,
      },
      input.value,
    );

    const rows = await tx<PlatformSettingRowSql[]>`
      UPDATE platform_settings
      SET value = ${tx.json(value)}, updated_by = ${adminUserId}, updated_at = ${now}
      WHERE key = ${key}
      RETURNING key, value, value_type, description, min_value, max_value, updated_by, updated_at
    `;
    const row = rows[0];
    // The row was locked two statements ago; if it is gone now, something
    // outside this service is deleting settings and the write must not be
    // reported as having succeeded.
    if (row === undefined) throw new SettingNotFoundError(key);

    // `sql.json` binds a real jsonb parameter. Never
    // `${JSON.stringify(payload)}` piped into a `::jsonb` cast — that lands a
    // jsonb STRING SCALAR and every `payload->>'...'` read comes back null
    // (D-016 item 6a; `jsonb-double-encode-guard.test.ts` enforces it).
    await tx`
      INSERT INTO admin_audit (admin_user_id, action, payload, created_at)
      VALUES (
        ${adminUserId},
        ${PLATFORM_SETTING_UPDATED_ACTION},
        ${tx.json({ key, before: beforeRecord.value, after: value })},
        ${now}
      )
    `;

    return toRecord(row);
  });

  const cache = options.cache;
  if (cache !== undefined) {
    // Best-effort, after COMMIT. A bust that fails leaves a value stale for at
    // most `PLATFORM_SETTINGS_CACHE_TTL_SECONDS` — bounded, never unbounded.
    try {
      await cache.del(PLATFORM_SETTINGS_CACHE_KEY);
    } catch {
      // Deliberately swallowed: the write is committed and audited, and
      // refusing to report that because Redis is down would be a lie in the
      // other direction. See `cache.ts` on failing open.
    }
  }

  return updated;
}

/** Reads the snapshot, tolerating every way a cache can disappoint. */
async function readSnapshot(
  cache: SettingsCache,
): Promise<readonly PlatformSettingRecord[] | undefined> {
  let cached: unknown;
  try {
    cached = await cache.get<unknown>(PLATFORM_SETTINGS_CACHE_KEY);
  } catch {
    // An injected cache is somebody else's code and is allowed to throw;
    // `@eutectic/cache` does not, but this module does not get to assume that.
    return undefined;
  }

  if (cached === undefined || cached === null) return undefined;
  // A cached payload is UNTRUSTED INPUT: it may have been written by an older
  // build of this service, or truncated, or be somebody else's key collision.
  // A malformed snapshot is treated as a MISS rather than as corruption — the
  // authority on whether the data is bad is Postgres, and the re-read either
  // succeeds or raises `SettingDataError` from the real row. That is how this
  // stays "fail open on cache errors, never on validation" at the same time.
  return isSnapshot(cached) ? cached : undefined;
}

async function writeSnapshot(
  cache: SettingsCache,
  records: readonly PlatformSettingRecord[],
): Promise<void> {
  try {
    await cache.set(PLATFORM_SETTINGS_CACHE_KEY, records, PLATFORM_SETTINGS_CACHE_TTL_SECONDS);
  } catch {
    // Same posture as the bust: a cache that cannot be written to is a cache
    // that misses next time, which is not an error a caller can act on.
  }
}

/** Structural check on a decoded cache payload. Cheap — the table is a few dozen rows. */
function isSnapshot(value: unknown): value is readonly PlatformSettingRecord[] {
  return Array.isArray(value) && value.every(isRecord);
}

function isRecord(value: unknown): value is PlatformSettingRecord {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<PlatformSettingRecord>;
  return (
    typeof candidate.key === "string" &&
    isPlatformSettingValueType(candidate.valueType) &&
    (candidate.valueType === "bool"
      ? typeof candidate.value === "boolean"
      : typeof candidate.value === "number" && Number.isFinite(candidate.value)) &&
    typeof candidate.description === "string" &&
    (candidate.minValue === null || typeof candidate.minValue === "number") &&
    (candidate.maxValue === null || typeof candidate.maxValue === "number") &&
    (candidate.updatedBy === null || typeof candidate.updatedBy === "string") &&
    typeof candidate.updatedAt === "string"
  );
}
