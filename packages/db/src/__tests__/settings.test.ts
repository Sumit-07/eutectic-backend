/**
 * Worker tests for P-09's platform-settings service (DIRECTIVE §3, D-013,
 * D-040).
 *
 * Same conventions as `entitlements.test.ts` and `identity.test.ts`: the REAL
 * `migrations/` directory is applied into a throwaway schema, dropped in
 * `after()`, so this suite never touches the dev database and is safely
 * rerunnable. The migration runs ONCE for the whole suite — thirteen
 * migrations per test would dominate the runtime — and each test resets
 * `platform_settings` and `admin_audit` to exactly the fixtures it needs.
 *
 * `updatePlatformSetting` takes the POOL type (`Sql`) because it opens its own
 * transaction, so the scratch schema is pinned as a connection STARTUP
 * parameter rather than with a per-transaction `SET` — the same technique, and
 * the same reason, as `apps/api/src/__tests__/entitlements.test.ts`.
 *
 * THE CACHE IS A FAKE, AND ONLY THE CACHE IS. `packages/db` declares no cache
 * dependency (see `settings/cache.ts`), so there is no Redis to point at from
 * here; the injected `SettingsCache` is the whole seam and a fake exercises
 * every branch of it — including the two a real Redis cannot be asked to
 * perform on demand: throwing, and returning junk.
 *
 *   pnpm --filter @eutectic/db test
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

import type { Sql } from "postgres";

import { createPool } from "../client.js";
import { requireDatabaseUrl } from "../env.js";
import { runSqlMigrations } from "../migrate.js";
import { MIGRATIONS_DIR } from "../paths.js";
import { BOOTSTRAP_PLATFORM_SETTINGS } from "../seed-data/platform-settings.js";
import {
  PLATFORM_SETTINGS_CACHE_KEY,
  PLATFORM_SETTINGS_CACHE_TTL_SECONDS,
  type SettingsCache,
} from "../settings/cache.js";
import {
  isSettingDataError,
  isSettingNotFoundError,
  isSettingValueError,
  type SettingValueError,
} from "../settings/errors.js";
import {
  getPlatformSetting,
  listPlatformSettings,
  PLATFORM_SETTING_UPDATED_ACTION,
  updatePlatformSetting,
  type PlatformSettingRecord,
} from "../settings/service.js";

const silent = (): void => {};

const NOW = new Date("2026-07-27T09:15:00.000Z");

let cleanupSql: Sql;
let sql: Sql;
let schema: string;
let adminUserId: string;

before(async () => {
  requireDatabaseUrl();
  cleanupSql = createPool({ max: 1 });
  schema = `p09settings_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await runSqlMigrations({ dir: MIGRATIONS_DIR, schema, log: silent });
  sql = createPool({
    max: 2,
    extra: { connection: { search_path: `${schema}, public` } },
  });
  adminUserId = await insertUser("root-admin", 900001);
});

after(async () => {
  await sql.end();
  await cleanupSql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await cleanupSql.end();
});

async function insertUser(handle: string, githubId: number): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (github_id, github_login, github_created_at, handle)
    VALUES (${githubId}, ${handle}, now(), ${handle})
    RETURNING id
  `;
  const id = rows[0]?.id;
  assert.ok(id, "insertUser must return an id");
  return id;
}

interface SettingFixture {
  key: string;
  value: unknown;
  valueType: string;
  description?: string;
  minValue?: number | null;
  maxValue?: number | null;
  updatedBy?: string | null;
  updatedAt?: Date;
}

/**
 * Inserts a row with NO validation in the way — the point of several tests
 * below is a row this service would never have written itself. D-013 removed
 * the CHECK constraints precisely so a corrupt row is possible; this helper is
 * how the suite produces one.
 */
async function seedSetting(fixture: SettingFixture): Promise<void> {
  await sql`
    INSERT INTO platform_settings (key, value, value_type, description, min_value, max_value, updated_by, updated_at)
    VALUES (
      ${fixture.key},
      ${sql.json(fixture.value as never)},
      ${fixture.valueType},
      ${fixture.description ?? "a setting"},
      ${fixture.minValue ?? null},
      ${fixture.maxValue ?? null},
      ${fixture.updatedBy ?? null},
      ${fixture.updatedAt ?? new Date("2026-01-01T00:00:00.000Z")}
    )
  `;
}

async function resetSettings(): Promise<void> {
  await sql`DELETE FROM admin_audit`;
  await sql`DELETE FROM platform_settings`;
}

interface AuditRow {
  admin_user_id: string;
  action: string;
  payload: { key?: unknown; before?: unknown; after?: unknown };
  created_at: Date;
}

async function auditRows(): Promise<AuditRow[]> {
  const rows = await sql<AuditRow[]>`
    SELECT admin_user_id, action, payload, created_at FROM admin_audit ORDER BY created_at
  `;
  // postgres.js hands back a `Result`, an Array SUBCLASS — `deepStrictEqual`
  // compares prototypes and would reject it against a plain `[]`. Copied here
  // so the assertions below read as assertions about audit rows rather than
  // about the driver.
  return [...rows];
}

async function rawValue(key: string): Promise<unknown> {
  const rows = await sql<{ value: unknown }[]>`
    SELECT value FROM platform_settings WHERE key = ${key}
  `;
  return rows[0]?.value;
}

/** A `SettingsCache` that records every call. Never throws unless told to. */
interface FakeCache extends SettingsCache {
  readonly store: Map<string, unknown>;
  readonly calls: string[];
  failOn: Set<"get" | "set" | "del">;
}

function fakeCache(): FakeCache {
  const store = new Map<string, unknown>();
  const calls: string[] = [];
  const failOn = new Set<"get" | "set" | "del">();

  return {
    store,
    calls,
    failOn,
    async get<T>(key: string): Promise<T | undefined> {
      calls.push(`get:${key}`);
      if (failOn.has("get")) throw new Error("redis is down");
      // Round-trips through JSON exactly as `@eutectic/cache`'s codec does, so
      // the `Date`-becomes-a-string trap `settings/service.ts` documents is
      // reproduced here rather than papered over by an in-memory reference.
      const raw = store.get(key);
      return raw === undefined ? undefined : (JSON.parse(JSON.stringify(raw)) as T);
    },
    async set<T>(key: string, value: T, ttlSeconds: number): Promise<unknown> {
      calls.push(`set:${key}:${ttlSeconds}`);
      if (failOn.has("set")) throw new Error("redis is down");
      store.set(key, value);
      return true;
    },
    async del(key: string): Promise<unknown> {
      calls.push(`del:${key}`);
      if (failOn.has("del")) throw new Error("redis is down");
      return store.delete(key);
    },
  };
}

function byKey(records: readonly PlatformSettingRecord[], key: string): PlatformSettingRecord {
  const found = records.find((record) => record.key === key);
  assert.ok(found, `expected a record for ${key}`);
  return found;
}

// ---------------------------------------------------------------------------

describe("listPlatformSettings — coercion per value_type", () => {
  beforeEach(resetSettings);

  it("reads the real seeded table with every value coerced to its declared type", async () => {
    // The migration's own rows, restored: this is the shape production reads.
    for (const setting of BOOTSTRAP_PLATFORM_SETTINGS) {
      await seedSetting({
        key: setting.key,
        value: setting.value,
        valueType: setting.valueType,
        description: setting.description,
        minValue: setting.minValue,
        maxValue: setting.maxValue,
      });
    }

    const settings = await listPlatformSettings(sql);
    assert.equal(settings.length, BOOTSTRAP_PLATFORM_SETTINGS.length);

    assert.equal(byKey(settings, "routing.discretionary_enabled").value, true);
    assert.equal(byKey(settings, "signup.tier_gate_enabled").value, false);
    assert.equal(byKey(settings, "routing.coverage_target").value, 6);
    assert.equal(byKey(settings, "routing.exploration_rate").value, 0.25);

    for (const record of settings) {
      const expected = record.valueType === "bool" ? "boolean" : "number";
      assert.equal(typeof record.value, expected, `${record.key} coerced to ${expected}`);
    }
  });

  it("returns bounds as numbers, not as the driver's numeric strings", async () => {
    await seedSetting({ key: "a.int", value: 5, valueType: "int", minValue: 0, maxValue: 50 });
    await seedSetting({ key: "a.bool", value: true, valueType: "bool" });

    const settings = await listPlatformSettings(sql);
    const int = byKey(settings, "a.int");
    assert.equal(typeof int.minValue, "number");
    assert.equal(typeof int.maxValue, "number");
    assert.equal(int.minValue, 0);
    assert.equal(int.maxValue, 50);

    const bool = byKey(settings, "a.bool");
    assert.equal(bool.minValue, null, "a boolean has no bound to compare against");
    assert.equal(bool.maxValue, null);
  });

  it("orders by key, so the settings page never reshuffles", async () => {
    await seedSetting({ key: "z.last", value: 1, valueType: "int" });
    await seedSetting({ key: "a.first", value: 1, valueType: "int" });
    await seedSetting({ key: "m.middle", value: 1, valueType: "int" });

    const keys = (await listPlatformSettings(sql)).map((record) => record.key);
    assert.deepStrictEqual(keys, ["a.first", "m.middle", "z.last"]);
  });

  it("hands back updated_at as an ISO string, not a Date", async () => {
    await seedSetting({
      key: "a.int",
      value: 1,
      valueType: "int",
      updatedAt: new Date("2026-03-04T05:06:07.000Z"),
    });
    const record = byKey(await listPlatformSettings(sql), "a.int");
    assert.equal(record.updatedAt, "2026-03-04T05:06:07.000Z");
    assert.equal(typeof record.updatedAt, "string");
  });
});

describe("listPlatformSettings — a bad row is a hard error, never a passthrough", () => {
  beforeEach(resetSettings);

  it("rejects an unrecognized value_type", async () => {
    await seedSetting({ key: "a.weird", value: "x", valueType: "duration" });
    await assert.rejects(
      () => listPlatformSettings(sql),
      (error: unknown) => {
        assert.ok(isSettingDataError(error), `expected SettingDataError, got ${String(error)}`);
        assert.equal(error.key, "a.weird");
        assert.match(error.message, /value_type "duration" is not one of bool\|int\|float/);
        return true;
      },
    );
  });

  it("rejects a stored value that does not match its own value_type", async () => {
    // The exact corruption the ticket names: a spend-shaped number stored as a
    // string. Returning it would multiply through a budget three hours later.
    await seedSetting({ key: "budget.daily_cents_per_agent", value: "500", valueType: "int" });
    await assert.rejects(
      () => listPlatformSettings(sql),
      (error: unknown) => isSettingDataError(error) && /is not a finite number/.test(error.message),
    );
  });

  it("rejects a float stored in an int setting", async () => {
    await seedSetting({ key: "a.int", value: 2.5, valueType: "int" });
    await assert.rejects(
      () => listPlatformSettings(sql),
      (error: unknown) => isSettingDataError(error) && /is not an integer/.test(error.message),
    );
  });

  it("rejects a number stored in a bool setting", async () => {
    await seedSetting({ key: "a.bool", value: 1, valueType: "bool" });
    await assert.rejects(
      () => listPlatformSettings(sql),
      (error: unknown) => isSettingDataError(error) && /is not a boolean/.test(error.message),
    );
  });
});

describe("getPlatformSetting", () => {
  beforeEach(resetSettings);

  it("returns one setting by key", async () => {
    await seedSetting({ key: "a.int", value: 7, valueType: "int", minValue: 0, maxValue: 10 });
    const record = await getPlatformSetting(sql, "a.int");
    assert.ok(record);
    assert.equal(record.value, 7);
    assert.equal(record.valueType, "int");
  });

  it("returns null for a key that does not exist — a read is a question", async () => {
    assert.equal(await getPlatformSetting(sql, "nope.not.here"), null);
  });
});

describe("updatePlatformSetting — update by key only, NEVER an upsert (D-040)", () => {
  beforeEach(resetSettings);

  it("rejects an unknown key and creates nothing", async () => {
    await assert.rejects(
      () =>
        updatePlatformSetting(sql, {
          key: "routing.invented_by_a_client",
          value: 3,
          adminUserId,
          now: NOW,
        }),
      (error: unknown) => {
        assert.ok(isSettingNotFoundError(error));
        assert.equal(error.key, "routing.invented_by_a_client");
        return true;
      },
    );

    const rows = await sql<{ count: string }[]>`SELECT count(*)::text AS count FROM platform_settings`;
    assert.equal(rows[0]?.count, "0", "an unknown key must not become a row");
    assert.deepStrictEqual(await auditRows(), [], "a refused write is not an audited write");
  });

  it("writes the value, the author and the instant", async () => {
    await seedSetting({
      key: "routing.coverage_target",
      value: 6,
      valueType: "int",
      minValue: 0,
      maxValue: 50,
    });

    const updated = await updatePlatformSetting(sql, {
      key: "routing.coverage_target",
      value: 4,
      adminUserId,
      now: NOW,
    });

    assert.equal(updated.value, 4);
    assert.equal(updated.updatedBy, adminUserId);
    assert.equal(updated.updatedAt, NOW.toISOString());

    // And the same, read back from the table rather than from the return value.
    const reread = await getPlatformSetting(sql, "routing.coverage_target");
    assert.equal(reread?.value, 4);
    assert.equal(reread?.updatedBy, adminUserId);
    assert.equal(reread?.updatedAt, NOW.toISOString());
  });

  it("stores the value as real jsonb, not a jsonb string scalar", async () => {
    // The D-016 item 6a trap, asserted at the type level Postgres sees.
    await seedSetting({ key: "a.int", value: 1, valueType: "int" });
    await updatePlatformSetting(sql, { key: "a.int", value: 9, adminUserId, now: NOW });

    const rows = await sql<{ kind: string }[]>`
      SELECT jsonb_typeof(value) AS kind FROM platform_settings WHERE key = 'a.int'
    `;
    assert.equal(rows[0]?.kind, "number");
  });

  it("accepts a boolean flip", async () => {
    await seedSetting({ key: "signup.tier_gate_enabled", value: false, valueType: "bool" });
    const updated = await updatePlatformSetting(sql, {
      key: "signup.tier_gate_enabled",
      value: true,
      adminUserId,
      now: NOW,
    });
    assert.equal(updated.value, true);
  });
});

describe("updatePlatformSetting — type validation (422 material)", () => {
  beforeEach(async () => {
    await resetSettings();
    await seedSetting({
      key: "routing.coverage_target",
      value: 6,
      valueType: "int",
      minValue: 0,
      maxValue: 50,
    });
    await seedSetting({ key: "routing.exploration_rate", value: 0.25, valueType: "float", minValue: 0, maxValue: 1 });
    await seedSetting({ key: "signup.tier_gate_enabled", value: false, valueType: "bool" });
  });

  async function expectValueError(
    key: string,
    value: unknown,
    issue: "type_mismatch" | "out_of_range",
  ): Promise<SettingValueError> {
    let captured: SettingValueError | undefined;
    await assert.rejects(
      () => updatePlatformSetting(sql, { key, value, adminUserId, now: NOW }),
      (error: unknown) => {
        assert.ok(isSettingValueError(error), `expected SettingValueError, got ${String(error)}`);
        captured = error;
        assert.ok(
          error.issues.some((entry) => entry.issue === issue),
          `expected a ${issue} issue, got ${JSON.stringify(error.issues)}`,
        );
        assert.ok(error.issues.every((entry) => entry.field === "value"));
        return true;
      },
    );
    assert.ok(captured);
    return captured;
  }

  it("rejects a float for an int", async () => {
    await expectValueError("routing.coverage_target", 2.5, "type_mismatch");
  });

  it("rejects a string for a bool", async () => {
    await expectValueError("signup.tier_gate_enabled", "true", "type_mismatch");
  });

  it("rejects 1 for a bool — JSON has a boolean and this setting wants it", async () => {
    await expectValueError("signup.tier_gate_enabled", 1, "type_mismatch");
  });

  it("rejects a bool for an int", async () => {
    await expectValueError("routing.coverage_target", true, "type_mismatch");
  });

  it("rejects a numeric string for an int", async () => {
    await expectValueError("routing.coverage_target", "4", "type_mismatch");
  });

  it("rejects null and undefined", async () => {
    await expectValueError("routing.coverage_target", null, "type_mismatch");
    await expectValueError("routing.coverage_target", undefined, "type_mismatch");
  });

  it("accepts an integer-valued float for an int (4.0 IS 4 in JSON)", async () => {
    const updated = await updatePlatformSetting(sql, {
      key: "routing.coverage_target",
      value: 4.0,
      adminUserId,
      now: NOW,
    });
    assert.equal(updated.value, 4);
  });

  it("accepts an integer for a float — every int is a float", async () => {
    const updated = await updatePlatformSetting(sql, {
      key: "routing.exploration_rate",
      value: 1,
      adminUserId,
      now: NOW,
    });
    assert.equal(updated.value, 1);
  });

  it("leaves the stored value untouched when validation fails", async () => {
    await expectValueError("routing.coverage_target", 2.5, "type_mismatch");
    assert.equal(await rawValue("routing.coverage_target"), 6);
    assert.deepStrictEqual(await auditRows(), []);
  });
});

describe("updatePlatformSetting — inclusive range validation", () => {
  beforeEach(async () => {
    await resetSettings();
    await seedSetting({
      key: "routing.exploration_rate",
      value: 0.25,
      valueType: "float",
      minValue: 0,
      maxValue: 1,
    });
    await seedSetting({ key: "a.unbounded", value: 5, valueType: "int" });
  });

  it("accepts both boundaries — inclusive means inclusive", async () => {
    // `0` and `1` are the two most useful values `exploration_rate` has
    // ("never explore" / "always explore"); an exclusive bound would forbid
    // exactly them.
    for (const value of [0, 1]) {
      const updated = await updatePlatformSetting(sql, {
        key: "routing.exploration_rate",
        value,
        adminUserId,
        now: NOW,
      });
      assert.equal(updated.value, value);
    }
  });

  it("rejects just below the minimum and just above the maximum", async () => {
    for (const value of [-0.0001, 1.0001]) {
      await assert.rejects(
        () =>
          updatePlatformSetting(sql, {
            key: "routing.exploration_rate",
            value,
            adminUserId,
            now: NOW,
          }),
        (error: unknown) =>
          isSettingValueError(error) && error.issues[0]?.issue === "out_of_range",
        `${value} must be out of range`,
      );
    }
    assert.equal(await rawValue("routing.exploration_rate"), 0.25);
  });

  it("applies no bound where the row declares none", async () => {
    const updated = await updatePlatformSetting(sql, {
      key: "a.unbounded",
      value: -999999,
      adminUserId,
      now: NOW,
    });
    assert.equal(updated.value, -999999);
  });

  it("reports the bound it enforced, so an operator can act on the 422", async () => {
    await assert.rejects(
      () =>
        updatePlatformSetting(sql, {
          key: "routing.exploration_rate",
          value: 4,
          adminUserId,
          now: NOW,
        }),
      (error: unknown) => {
        assert.ok(isSettingValueError(error));
        assert.match(error.issues[0]?.detail ?? "", /inclusive maximum of 1/);
        return true;
      },
    );
  });
});

describe("updatePlatformSetting — the audit trail (DIRECTIVE §3)", () => {
  beforeEach(async () => {
    await resetSettings();
    await seedSetting({
      key: "routing.coverage_target",
      value: 6,
      valueType: "int",
      minValue: 0,
      maxValue: 50,
    });
  });

  it("appends one audit row carrying key, BEFORE and AFTER", async () => {
    await updatePlatformSetting(sql, {
      key: "routing.coverage_target",
      value: 4,
      adminUserId,
      now: NOW,
    });

    const rows = await auditRows();
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.ok(row);
    assert.equal(row.admin_user_id, adminUserId, "the acting admin, not a service account");
    assert.equal(row.action, PLATFORM_SETTING_UPDATED_ACTION);
    assert.deepStrictEqual(row.payload, {
      key: "routing.coverage_target",
      before: 6,
      after: 4,
    });
    assert.equal(row.created_at.toISOString(), NOW.toISOString());
  });

  it("records the payload as real jsonb, so payload->>'key' is readable", async () => {
    await updatePlatformSetting(sql, {
      key: "routing.coverage_target",
      value: 4,
      adminUserId,
      now: NOW,
    });
    const rows = await sql<{ key: string | null; kind: string }[]>`
      SELECT payload->>'key' AS key, jsonb_typeof(payload) AS kind FROM admin_audit
    `;
    assert.equal(rows[0]?.key, "routing.coverage_target");
    assert.equal(rows[0]?.kind, "object");
  });

  it("keeps a full history — three changes, three rows, each before matching the last after", async () => {
    for (const [index, value] of [4, 2, 0].entries()) {
      await updatePlatformSetting(sql, {
        key: "routing.coverage_target",
        value,
        adminUserId,
        now: new Date(NOW.getTime() + index * 1000),
      });
    }
    const payloads = (await auditRows()).map((row) => [row.payload.before, row.payload.after]);
    assert.deepStrictEqual(payloads, [
      [6, 4],
      [4, 2],
      [2, 0],
    ]);
  });

  it("records a boolean before/after honestly, not as 0/1", async () => {
    await seedSetting({ key: "signup.tier_gate_enabled", value: false, valueType: "bool" });
    await updatePlatformSetting(sql, {
      key: "signup.tier_gate_enabled",
      value: true,
      adminUserId,
      now: NOW,
    });
    const row = (await auditRows()).at(-1);
    assert.deepStrictEqual(row?.payload, {
      key: "signup.tier_gate_enabled",
      before: false,
      after: true,
    });
  });
});

describe("updatePlatformSetting — the value change and the audit row are ONE transaction", () => {
  beforeEach(async () => {
    await resetSettings();
    await seedSetting({
      key: "routing.coverage_target",
      value: 6,
      valueType: "int",
      minValue: 0,
      maxValue: 50,
    });
  });

  it("rolls the value change back when the audit insert fails", async () => {
    // A trigger is the only honest way to fail the SECOND write specifically:
    // an invalid `admin_user_id` would break the UPDATE's own `updated_by` FK
    // first and prove nothing about ordering. This makes `admin_audit` refuse
    // the insert with the settings UPDATE already applied inside the same
    // transaction — exactly the window an unaudited settings change would slip
    // through, if there were one.
    await sql.unsafe(
      `CREATE FUNCTION "${schema}".refuse_audit() RETURNS trigger AS $refuse$ ` +
        `BEGIN RAISE EXCEPTION 'audit sink is refusing writes'; END; ` +
        `$refuse$ LANGUAGE plpgsql`,
    );
    await sql.unsafe(
      `CREATE TRIGGER refuse_audit_trigger BEFORE INSERT ON "${schema}".admin_audit ` +
        `FOR EACH ROW EXECUTE FUNCTION "${schema}".refuse_audit()`,
    );

    try {
      await assert.rejects(
        () =>
          updatePlatformSetting(sql, {
            key: "routing.coverage_target",
            value: 4,
            adminUserId,
            now: NOW,
          }),
        /audit sink is refusing writes/,
      );

      assert.equal(
        await rawValue("routing.coverage_target"),
        6,
        "an unaudited settings change must not exist, not even for a moment",
      );
      const record = await getPlatformSetting(sql, "routing.coverage_target");
      assert.equal(record?.updatedBy, null, "updated_by rolled back too");
      assert.deepStrictEqual(await auditRows(), []);
    } finally {
      await sql.unsafe(`DROP TRIGGER refuse_audit_trigger ON "${schema}".admin_audit`);
      await sql.unsafe(`DROP FUNCTION "${schema}".refuse_audit()`);
    }
  });
});

describe("the cache — 60s TTL, busted on write, and failing open on every outage", () => {
  beforeEach(async () => {
    await resetSettings();
    await seedSetting({
      key: "routing.coverage_target",
      value: 6,
      valueType: "int",
      minValue: 0,
      maxValue: 50,
    });
  });

  it("populates the snapshot under one key with the directive's TTL", async () => {
    const cache = fakeCache();
    await listPlatformSettings(sql, { cache });
    assert.deepStrictEqual(cache.calls, [
      `get:${PLATFORM_SETTINGS_CACHE_KEY}`,
      `set:${PLATFORM_SETTINGS_CACHE_KEY}:${PLATFORM_SETTINGS_CACHE_TTL_SECONDS}`,
    ]);
    assert.equal(PLATFORM_SETTINGS_CACHE_TTL_SECONDS, 60, "DIRECTIVE §3 says 60s");
  });

  it("serves the second read from the cache without touching Postgres", async () => {
    const cache = fakeCache();
    await listPlatformSettings(sql, { cache });

    // Change the row behind the service's back. A cached read must not see it.
    await sql`UPDATE platform_settings SET value = ${sql.json(99)} WHERE key = 'routing.coverage_target'`;

    const second = await listPlatformSettings(sql, { cache });
    assert.equal(byKey(second, "routing.coverage_target").value, 6, "served from the snapshot");
  });

  it("busts the snapshot on write, so the next read is never stale", async () => {
    const cache = fakeCache();
    await listPlatformSettings(sql, { cache });
    assert.equal(cache.store.size, 1);

    await updatePlatformSetting(
      sql,
      { key: "routing.coverage_target", value: 4, adminUserId, now: NOW },
      { cache },
    );

    assert.equal(cache.store.size, 0, "the write deleted the snapshot");
    assert.ok(cache.calls.includes(`del:${PLATFORM_SETTINGS_CACHE_KEY}`));

    const after = await listPlatformSettings(sql, { cache });
    assert.equal(byKey(after, "routing.coverage_target").value, 4, "re-read, not replayed");
  });

  it("a point read goes through the same snapshot as the list read", async () => {
    const cache = fakeCache();
    await getPlatformSetting(sql, "routing.coverage_target", { cache });
    assert.equal(cache.store.size, 1, "one key for the whole table");
  });

  it("FAILS OPEN when the cache read throws — a Redis outage never stops a settings read", async () => {
    const cache = fakeCache();
    cache.failOn.add("get");
    const settings = await listPlatformSettings(sql, { cache });
    assert.equal(byKey(settings, "routing.coverage_target").value, 6);
  });

  it("FAILS OPEN when the cache write throws", async () => {
    const cache = fakeCache();
    cache.failOn.add("set");
    const settings = await listPlatformSettings(sql, { cache });
    assert.equal(byKey(settings, "routing.coverage_target").value, 6);
  });

  it("FAILS OPEN when the bust throws — the write is committed and must be reported as such", async () => {
    const cache = fakeCache();
    cache.failOn.add("del");
    const updated = await updatePlatformSetting(
      sql,
      { key: "routing.coverage_target", value: 4, adminUserId, now: NOW },
      { cache },
    );
    assert.equal(updated.value, 4);
    assert.equal(await rawValue("routing.coverage_target"), 4, "committed regardless of Redis");
  });

  it("treats a junk snapshot as a miss and re-reads Postgres", async () => {
    const cache = fakeCache();
    // Every shape a stale build, a truncation or a key collision could leave.
    for (const junk of [
      "not an array",
      [{ key: "routing.coverage_target" }],
      [{ key: "x", value: 1, valueType: "duration", description: "", minValue: null, maxValue: null, updatedBy: null, updatedAt: "z" }],
      [{ key: "x", value: "6", valueType: "int", description: "", minValue: null, maxValue: null, updatedBy: null, updatedAt: "z" }],
      [{ key: "x", value: 1, valueType: "bool", description: "", minValue: null, maxValue: null, updatedBy: null, updatedAt: "z" }],
    ]) {
      cache.store.set(PLATFORM_SETTINGS_CACHE_KEY, junk);
      const settings = await listPlatformSettings(sql, { cache });
      assert.equal(
        byKey(settings, "routing.coverage_target").value,
        6,
        `junk snapshot ${JSON.stringify(junk).slice(0, 40)} must not be served`,
      );
    }
  });

  it("NEVER fails open on validation, cache or no cache", async () => {
    // The asymmetry stated in the module doc, proven: the same outage that is
    // survivable for a cache read is not survivable for a corrupt row.
    await seedSetting({ key: "a.broken", value: "x", valueType: "duration" });
    const cache = fakeCache();
    cache.failOn.add("get");
    await assert.rejects(() => listPlatformSettings(sql, { cache }), (error: unknown) =>
      isSettingDataError(error),
    );
  });
});
