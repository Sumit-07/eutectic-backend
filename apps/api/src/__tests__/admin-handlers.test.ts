/**
 * The three `/v1/admin/*` handlers (P-09, D-029, D-040, DIRECTIVE §3 and §5).
 *
 * Driven through the REAL SERVER — `app.inject` over a real pool, a real
 * session and a real allowlist — rather than by calling the handler functions
 * with hand-built arguments. Two of the acceptance criteria are only true of
 * the assembled thing: `updated_by` comes from the gate's AsyncLocalStorage
 * context (a directly-called handler has no context and raises), and the PUT
 * replay behaviour is the idempotency middleware's, which a direct call skips
 * entirely. A unit test of the handler function would pass with the gate
 * unwired.
 *
 * THE WIRE SHAPES ARE CHECKED AGAINST `openapi.yaml`, NOT AGAINST A LIST
 * WRITTEN HERE. `expectedShape` reads `components.schemas.X.properties` out of
 * the spec with the same parser the D-029 leak gate uses, so adding a field to
 * `AdminUser` in the contract without serving it fails here, and serving a
 * field the contract does not declare fails here too (both admin schemas are
 * `additionalProperties: false` with every property required). Restating the
 * field list in this file would only prove the file agrees with itself.
 *
 *   pnpm --filter @eutectic/api test
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  BOOTSTRAP_PLATFORM_SETTINGS,
  createPool,
  MIGRATIONS_DIR,
  runSqlMigrations,
  type Sql,
} from "@eutectic/db";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../app.js";
import { hashSessionToken, SESSION_COOKIE_NAME } from "../auth/session.js";
import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENT_REPLAY_HEADER } from "../idempotency.js";
import { API_MEDIA_TYPE, API_PREFIX } from "../index.js";
import { isMapping, parseYamlFile, type YamlMapping } from "./openapi-document.js";
import { openapiPath } from "./openapi-scan.js";

const V1 = { accept: API_MEDIA_TYPE };
const SETTINGS = `${API_PREFIX}/admin/settings`;
const USERS = `${API_PREFIX}/admin/users`;
const NOW = new Date("2026-07-28T09:30:00.000Z");

/** A key whose bounds this suite leans on: int, 0..50, seeded at 6. */
const COVERAGE = "routing.coverage_target";
/** A bool, so "null bounds" and "a number is not a boolean" have a subject. */
const AFFINITY = "routing.affinity_enabled";

let pool: Sql;
let schema: string;
let app: FastifyInstance;
/** The allowlisted admin, and a live session token for them. */
let adminId: string;
let adminToken: string;

const document = parseYamlFile(openapiPath());

/** Every property name `components.schemas.<name>` declares, from the spec. */
function expectedShape(name: string): string[] {
  const schemas = document["components"];
  assert.ok(isMapping(schemas), "openapi.yaml has no components block");
  const all = schemas["schemas"];
  assert.ok(isMapping(all), "openapi.yaml has no components.schemas block");
  const schemaNode: YamlMapping | undefined = isMapping(all[name]) ? all[name] : undefined;
  assert.ok(schemaNode, `openapi.yaml declares no ${name} schema`);
  const properties = schemaNode["properties"];
  assert.ok(isMapping(properties), `${name} declares no properties`);
  // Both admin schemas require every property and forbid extras, so "declared"
  // and "must be present" are the same set. Asserted, not assumed.
  const required = schemaNode["required"];
  assert.ok(Array.isArray(required), `${name} declares no required list`);
  assert.equal(schemaNode["additionalProperties"], false, `${name} must be closed`);
  assert.deepStrictEqual([...required].sort(), Object.keys(properties).sort());
  return Object.keys(properties).sort();
}

const PLATFORM_SETTING_SHAPE = expectedShape("PlatformSetting");
const ADMIN_USER_SHAPE = expectedShape("AdminUser");

before(async () => {
  schema = `p09handlers_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await runSqlMigrations({ dir: MIGRATIONS_DIR, schema, log: () => {} });
  pool = createPool({ max: 6, extra: { connection: { search_path: `${schema}, public` } } });

  adminId = await insertUser({ handle: "root-admin" });
  adminToken = await insertSession(adminId);

  app = buildApp({
    logger: false,
    pool,
    // No cache: this suite is about handler behaviour, and `settings.test.ts`
    // in packages/db owns the cache contract. An injected cache here would put
    // a 60s TTL between a write and the read that checks it.
    admin: { sql: pool, allowlist: new Set([adminId]), now: () => NOW },
  });
});

after(async () => {
  await pool.end();
  const admin = createPool({ max: 1 });
  await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
});

/**
 * Back to the seeded posture before each test. The settings table is seeded by
 * migration 0013 and this suite writes to it; `admin_audit` is emptied so a
 * test can count the rows IT caused.
 */
beforeEach(async () => {
  for (const setting of BOOTSTRAP_PLATFORM_SETTINGS) {
    await pool`
      UPDATE platform_settings
      SET value = ${pool.json(setting.value)}, updated_by = NULL, updated_at = now()
      WHERE key = ${setting.key}
    `;
  }
  await pool`DELETE FROM admin_audit`;
});

let githubCounter = 800000;

interface UserOptions {
  handle: string;
  deletedAt?: Date | null;
  showGithubLogin?: boolean;
  tierWouldBe?: number | null;
}

async function insertUser(options: UserOptions): Promise<string> {
  githubCounter += 1;
  const rows = await pool<{ id: string }[]>`
    INSERT INTO users (
      github_id, github_login, github_created_at, github_public_repos,
      handle, tier, tier_would_be, show_github_login, deleted_at
    )
    VALUES (
      ${githubCounter},
      ${`gh-${options.handle}`},
      ${new Date("2021-03-04T05:06:07.000Z")},
      ${17},
      ${options.handle},
      ${1},
      ${options.tierWouldBe ?? null},
      ${options.showGithubLogin ?? false},
      ${options.deletedAt ?? null}
    )
    RETURNING id
  `;
  const id = rows[0]?.id;
  assert.ok(id);
  return id;
}

async function insertSession(userId: string): Promise<string> {
  const token = `tok_${randomUUID()}${randomUUID()}`;
  await pool`
    INSERT INTO sessions (user_id, token_hash, expires_at)
    VALUES (${userId}, ${hashSessionToken(token)}, ${new Date(NOW.getTime() + 86_400_000)})
  `;
  return token;
}

function asAdmin(extra: Record<string, string> = {}): Record<string, string> {
  return { ...V1, cookie: `${SESSION_COOKIE_NAME}=${adminToken}`, ...extra };
}

function body(payload: string): Record<string, unknown> {
  return JSON.parse(payload) as Record<string, unknown>;
}

function errorOf(payload: string): { code: string; details?: unknown[] } {
  return (JSON.parse(payload) as { error: { code: string; details?: unknown[] } }).error;
}

/** A PUT as the allowlisted admin, with a fresh idempotency key unless told otherwise. */
async function put(
  key: string,
  value: unknown,
  idempotencyKey: string = `key-${randomUUID()}`,
): Promise<{ statusCode: number; payload: string; headers: Record<string, unknown> }> {
  const response = await app.inject({
    method: "PUT",
    url: `${SETTINGS}/${key}`,
    headers: asAdmin({ [IDEMPOTENCY_KEY_HEADER]: idempotencyKey }),
    payload: { value },
  });
  return { statusCode: response.statusCode, payload: response.payload, headers: response.headers };
}

async function auditCount(): Promise<number> {
  const rows = await pool<{ n: string }[]>`SELECT count(*)::text AS n FROM admin_audit`;
  return Number(rows[0]?.n);
}

// ---------------------------------------------------------------------------

describe("GET /admin/settings", () => {
  it("returns the whole seeded table, unpaginated, in the contract's shape", async () => {
    const response = await app.inject({ method: "GET", url: SETTINGS, headers: asAdmin() });
    assert.equal(response.statusCode, 200);

    const payload = body(response.payload) as { items: Record<string, unknown>[] };
    // `additionalProperties: false` on PlatformSettingList: `items` and nothing else.
    assert.deepStrictEqual(Object.keys(payload), ["items"]);
    assert.equal(payload.items.length, BOOTSTRAP_PLATFORM_SETTINGS.length);

    for (const item of payload.items) {
      assert.deepStrictEqual(
        Object.keys(item).sort(),
        PLATFORM_SETTING_SHAPE,
        `${String(item["key"])} does not match the contract's PlatformSetting`,
      );
    }
  });

  it("serves COERCED values — numbers and booleans, never the stored text", async () => {
    const response = await app.inject({ method: "GET", url: SETTINGS, headers: asAdmin() });
    const items = (body(response.payload) as { items: Record<string, unknown>[] }).items;
    const byKey = new Map(items.map((item) => [item["key"] as string, item]));

    for (const seeded of BOOTSTRAP_PLATFORM_SETTINGS) {
      const item = byKey.get(seeded.key);
      assert.ok(item, `${seeded.key} is missing from the response`);
      assert.equal(item["value"], seeded.value, `${seeded.key} value`);
      assert.equal(typeof item["value"], typeof seeded.value, `${seeded.key} JSON type`);
      assert.equal(item["value_type"], seeded.valueType);
      assert.equal(item["min_value"], seeded.minValue);
      assert.equal(item["max_value"], seeded.maxValue);
    }
  });

  it("is null-updated_by until an admin touches a row", async () => {
    const before = await app.inject({ method: "GET", url: SETTINGS, headers: asAdmin() });
    const seeded = (body(before.payload) as { items: Record<string, unknown>[] }).items;
    assert.ok(seeded.every((item) => item["updated_by"] === null));

    await put(COVERAGE, 4);

    const after = await app.inject({ method: "GET", url: SETTINGS, headers: asAdmin() });
    const items = (body(after.payload) as { items: Record<string, unknown>[] }).items;
    const touched = items.find((item) => item["key"] === COVERAGE);
    assert.equal(touched?.["updated_by"], adminId);
    assert.equal(
      items.filter((item) => item["updated_by"] !== null).length,
      1,
      "one write must not stamp every row",
    );
  });
});

describe("PUT /admin/settings/{key}", () => {
  it("returns the UPDATED setting, in the contract's shape", async () => {
    const response = await put(COVERAGE, 4);
    assert.equal(response.statusCode, 200);

    const setting = body(response.payload);
    assert.deepStrictEqual(Object.keys(setting).sort(), PLATFORM_SETTING_SHAPE);
    assert.equal(setting["key"], COVERAGE);
    assert.equal(setting["value"], 4);
    assert.equal(setting["value_type"], "int");
    assert.equal(setting["updated_by"], adminId);
    // The injected clock, proving the handler does not read the wall clock.
    assert.equal(setting["updated_at"], NOW.toISOString());
  });

  it("attributes the write to the SESSION's admin, not to anything the client sent", async () => {
    const other = await insertUser({ handle: "other-admin" });
    // A body that tries to name a different actor changes nothing: the shape is
    // `{ value }`, and the actor comes from the gate's context.
    const response = await app.inject({
      method: "PUT",
      url: `${SETTINGS}/${COVERAGE}`,
      headers: asAdmin({ [IDEMPOTENCY_KEY_HEADER]: `key-${randomUUID()}` }),
      payload: { value: 3, updated_by: other, admin_user_id: other },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(body(response.payload)["updated_by"], adminId);

    const rows = await pool<{ admin_user_id: string }[]>`
      SELECT admin_user_id FROM admin_audit
    `;
    assert.deepStrictEqual([...rows].map((row) => row.admin_user_id), [adminId]);
  });

  it("404s an unknown key and creates NOTHING — never an upsert (D-040)", async () => {
    const response = await put("routing.nonexistent_knob", 1);
    assert.equal(response.statusCode, 404);
    assert.equal(errorOf(response.payload).code, "not_found");

    const rows = await pool<{ n: string }[]>`
      SELECT count(*)::text AS n FROM platform_settings WHERE key = 'routing.nonexistent_knob'
    `;
    assert.equal(rows[0]?.n, "0");
    assert.equal(await auditCount(), 0, "a rejected write must not be audited");
  });

  it("422s a type violation, with details the admin UI can render", async () => {
    const response = await put(COVERAGE, "four");
    assert.equal(response.statusCode, 422);

    const error = errorOf(response.payload);
    assert.equal(error.code, "unprocessable");
    const details = error.details as { field: string; issue: string; detail: string }[];
    assert.equal(details.length, 1);
    assert.equal(details[0]?.field, "value");
    assert.equal(details[0]?.issue, "type_mismatch");
    assert.ok((details[0]?.detail ?? "").length > 0, "a human-readable sentence is required");
    assert.equal(await auditCount(), 0);
  });

  it("422s a float for an int and a number for a bool", async () => {
    const fractional = await put(COVERAGE, 2.5);
    assert.equal(fractional.statusCode, 422);
    assert.equal((errorOf(fractional.payload).details as { issue: string }[])[0]?.issue, "type_mismatch");

    // The classic near-miss: 1 is not `true`.
    const numericBool = await put(AFFINITY, 1);
    assert.equal(numericBool.statusCode, 422);
    assert.equal((errorOf(numericBool.payload).details as { issue: string }[])[0]?.issue, "type_mismatch");
  });

  it("422s out of range, and ACCEPTS the inclusive boundaries", async () => {
    const over = await put(COVERAGE, 51);
    assert.equal(over.statusCode, 422);
    assert.equal((errorOf(over.payload).details as { issue: string }[])[0]?.issue, "out_of_range");

    const under = await put(COVERAGE, -1);
    assert.equal(under.statusCode, 422);

    // 0 and 50 are the declared bounds and must both be legal — an exclusive
    // comparison would fail exactly here and nowhere else.
    assert.equal((await put(COVERAGE, 0)).statusCode, 200);
    assert.equal((await put(COVERAGE, 50)).statusCode, 200);
  });

  it("takes a boolean for a bool row, whose bounds are null", async () => {
    const response = await put(AFFINITY, false);
    assert.equal(response.statusCode, 200);
    const setting = body(response.payload);
    assert.equal(setting["value"], false);
    assert.equal(setting["min_value"], null);
    assert.equal(setting["max_value"], null);
  });

  it("400s a body with no value property — a malformed request, not a bad value", async () => {
    const response = await app.inject({
      method: "PUT",
      url: `${SETTINGS}/${COVERAGE}`,
      headers: asAdmin({ [IDEMPOTENCY_KEY_HEADER]: `key-${randomUUID()}` }),
      payload: { velue: 4 },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(errorOf(response.payload).code, "bad_request");
    assert.equal(await auditCount(), 0);
  });

  it("422s an explicit null value — well-formed request, impossible value", async () => {
    const response = await put(COVERAGE, null);
    assert.equal(response.statusCode, 422);
    assert.equal(errorOf(response.payload).code, "unprocessable");
  });

  it("audits every accepted write with before AND after", async () => {
    await put(COVERAGE, 4);

    const rows = await pool<{ action: string; payload: Record<string, unknown> }[]>`
      SELECT action, payload FROM admin_audit
    `;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.action, "platform_setting.updated");
    assert.deepStrictEqual(rows[0]?.payload, { key: COVERAGE, before: 6, after: 4 });
  });
});

describe("PUT replay — the contract's idempotency note", () => {
  it("replays the ORIGINAL response and does not write a second audit row", async () => {
    const key = `key-${randomUUID()}`;

    const first = await put(COVERAGE, 4, key);
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers[IDEMPOTENT_REPLAY_HEADER], undefined);

    const replay = await put(COVERAGE, 4, key);
    assert.equal(replay.statusCode, 200);
    // "Replaying a key returns the original result" — byte for byte, including
    // the `updated_at` the first execution stamped.
    assert.equal(replay.payload, first.payload);
    assert.equal(replay.headers[IDEMPOTENT_REPLAY_HEADER], "true");

    // The real proof that the handler did not run twice: a second execution
    // would have appended a second audit row, with before === after.
    assert.equal(await auditCount(), 1);
  });

  it("409s the same key carrying a different body", async () => {
    const key = `key-${randomUUID()}`;
    assert.equal((await put(COVERAGE, 4, key)).statusCode, 200);

    const conflict = await put(COVERAGE, 5, key);
    assert.equal(conflict.statusCode, 409);
    assert.equal(errorOf(conflict.payload).code, "idempotency_conflict");
    assert.equal(await auditCount(), 1, "the conflicting write must not have landed");
  });

  it("leaves a REJECTED write's key reusable", async () => {
    const key = `key-${randomUUID()}`;
    // Only a 2xx is recorded (idempotency.ts judgment call (c)); a 422 leaves
    // no committed side effect, so the admin who fixes their typo and retries
    // must not be told their key is spent.
    assert.equal((await put(COVERAGE, 999, key)).statusCode, 422);
    assert.equal((await put(COVERAGE, 9, key)).statusCode, 200);
    assert.equal(await auditCount(), 1);
  });
});

describe("GET /admin/users/{userId}", () => {
  it("returns the full AdminUser shape, GitHub fields included", async () => {
    const userId = await insertUser({ handle: "subject-one", tierWouldBe: 2 });

    const response = await app.inject({
      method: "GET",
      url: `${USERS}/${userId}`,
      headers: asAdmin(),
    });
    assert.equal(response.statusCode, 200);

    const user = body(response.payload);
    assert.deepStrictEqual(Object.keys(user).sort(), ADMIN_USER_SHAPE);
    assert.equal(user["id"], userId);
    assert.equal(user["handle"], "subject-one");
    assert.equal(user["deleted"], false);
    assert.equal(user["github_login"], "gh-subject-one");
    assert.equal(typeof user["github_id"], "number");
    assert.equal(user["github_public_repos"], 17);
    assert.equal(user["github_created_at"], "2021-03-04T05:06:07.000Z");
    assert.equal(user["tier_would_be"], 2);
  });

  it("shows github_login to an admin even when the user did NOT opt in", async () => {
    // `show_github_login` is a PUBLIC-surface consent flag (D-029). The admin
    // view is the one place it does not apply — moderation attaches to a
    // GitHub account someone cares about.
    const userId = await insertUser({ handle: "private-one", showGithubLogin: false });
    const response = await app.inject({
      method: "GET",
      url: `${USERS}/${userId}`,
      headers: asAdmin(),
    });
    assert.equal(body(response.payload)["github_login"], "gh-private-one");
  });

  it("RETURNS a tombstoned user with deleted:true — never a 404", async () => {
    const userId = await insertUser({
      handle: "closed-one",
      deletedAt: new Date("2026-05-05T00:00:00.000Z"),
      showGithubLogin: true,
    });

    const response = await app.inject({
      method: "GET",
      url: `${USERS}/${userId}`,
      headers: asAdmin(),
    });

    assert.equal(response.statusCode, 200, "a tombstoned user must not 404 for an admin");
    const user = body(response.payload);
    assert.deepStrictEqual(Object.keys(user).sort(), ADMIN_USER_SHAPE);
    assert.equal(user["deleted"], true);
    assert.equal(user["handle"], "closed-one");
    // Still a string, not null: the public serializer nulls this for a
    // tombstone, the admin one does not, and that difference is the point of
    // there being two serializers.
    assert.equal(user["github_login"], "gh-closed-one");
    assert.equal(typeof user["github_id"], "number");
  });

  it("falls back to the actual tier when tier_would_be has never been recorded", async () => {
    const userId = await insertUser({ handle: "ungated-one", tierWouldBe: null });
    const response = await app.inject({
      method: "GET",
      url: `${USERS}/${userId}`,
      headers: asAdmin(),
    });
    const user = body(response.payload);
    // The column is nullable; the contract requires an integer 0..3.
    assert.equal(user["tier_would_be"], user["tier"]);
  });

  it("404s an id that has never existed", async () => {
    const response = await app.inject({
      method: "GET",
      url: `${USERS}/${randomUUID()}`,
      headers: asAdmin(),
    });
    assert.equal(response.statusCode, 404);
    assert.equal(errorOf(response.payload).code, "not_found");
  });

  it("404s a malformed id rather than turning it into a 500", async () => {
    const response = await app.inject({
      method: "GET",
      url: `${USERS}/not-a-uuid`,
      headers: asAdmin(),
    });
    assert.equal(response.statusCode, 404);
    assert.equal(errorOf(response.payload).code, "not_found");
  });
});
