/**
 * The admin gate (P-09, DIRECTIVE §3).
 *
 * Real Postgres, real cookies, real `sessions` rows. A fake session store
 * would be testing the wrong thing here — "expired" and "revoked" are SQL
 * predicates in `auth/session.ts`, and a mock that answers `null` for both
 * would pass just as happily if the WHERE clause were deleted.
 *
 * Every test applies the real `migrations/` into a throwaway schema and points
 * the app's pool at it with postgres.js's `connection: { search_path }`, the
 * same isolation `idempotency.test.ts` uses. The dev database is never touched.
 *
 *   pnpm --filter @eutectic/api test
 */

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { ROUTES } from "@eutectic/contracts";
import type { OperationId, RouteDescriptor } from "@eutectic/contracts";
import { createPool, MIGRATIONS_DIR, runSqlMigrations, type Sql } from "@eutectic/db";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../app.js";
import {
  ADMIN_USER_IDS_ENV,
  AdminAllowlistError,
  adminAllowlistFromEnv,
  parseAdminAllowlist,
} from "../auth/allowlist.js";
import { adminOperations, isAdminPath } from "../auth/admin-gate.js";
import { hashSessionToken, readCookie, SESSION_COOKIE_NAME } from "../auth/session.js";
import { IDEMPOTENCY_KEY_HEADER } from "../idempotency.js";
import { API_MEDIA_TYPE, API_PREFIX, toFastifyUrl } from "../index.js";

const V1 = { accept: API_MEDIA_TYPE };
const SETTINGS = `${API_PREFIX}/admin/settings`;
const NOW = new Date("2026-07-27T12:00:00.000Z");

let pool: Sql;
let schema: string;

before(async () => {
  schema = `p09gate_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await runSqlMigrations({ dir: MIGRATIONS_DIR, schema, log: () => {} });
  pool = createPool({ max: 6, extra: { connection: { search_path: `${schema}, public` } } });
});

after(async () => {
  await pool.end();
  const admin = createPool({ max: 1 });
  await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
});

let githubCounter = 700000;

async function insertUser(handle: string): Promise<string> {
  githubCounter += 1;
  const rows = await pool<{ id: string }[]>`
    INSERT INTO users (github_id, github_login, github_created_at, handle)
    VALUES (${githubCounter}, ${handle}, now(), ${handle})
    RETURNING id
  `;
  const id = rows[0]?.id;
  assert.ok(id);
  return id;
}

interface SessionOptions {
  expiresAt?: Date;
  revokedAt?: Date | null;
}

/** Mints a session the way the OAuth ticket eventually will: store the HASH only. */
async function insertSession(userId: string, options: SessionOptions = {}): Promise<string> {
  const token = `tok_${randomUUID()}${randomUUID()}`;
  await pool`
    INSERT INTO sessions (user_id, token_hash, expires_at, revoked_at)
    VALUES (
      ${userId},
      ${hashSessionToken(token)},
      ${options.expiresAt ?? new Date(NOW.getTime() + 86_400_000)},
      ${options.revokedAt ?? null}
    )
  `;
  return token;
}

function cookie(token: string): Record<string, string> {
  return { ...V1, cookie: `${SESSION_COOKIE_NAME}=${token}` };
}

interface AppFixture {
  app: FastifyInstance;
  /** Every line the logger emitted, raw. */
  logs(): string;
}

function makeApp(allowlist: Iterable<string>): AppFixture {
  const lines: string[] = [];
  const app = buildApp({
    // `trace` so nothing is filtered out: an assertion that a secret was not
    // logged is worthless if the level would have dropped the line anyway.
    logger: {
      level: "trace",
      stream: {
        write(chunk: string): void {
          lines.push(chunk);
        },
      },
    },
    pool,
    admin: { sql: pool, allowlist: new Set(allowlist), now: () => NOW },
  });
  return { app, logs: () => lines.join("") };
}

function statusOf(payload: string): string {
  return (JSON.parse(payload) as { error: { code: string } }).error.code;
}

// ---------------------------------------------------------------------------

describe("which routes the gate covers", () => {
  it("is derived from the contract, not from a hand-written list", () => {
    const gated = adminOperations();
    const expected = (Object.entries(ROUTES) as [OperationId, RouteDescriptor][])
      .filter(([, descriptor]) => descriptor.path.startsWith("/admin"))
      .map(([operationId]) => operationId);

    assert.ok(expected.length >= 3, "the contract should have at least the P-09 admin trio");
    assert.deepStrictEqual([...gated].sort(), expected.sort());
  });

  it("gates EVERY admin operation, including any a later ticket adds", async () => {
    // Not "the three P-09 implements" — every one the contract declares. A new
    // `/admin/*` route that shipped ungated would fail here rather than in
    // production.
    const { app } = makeApp([]);
    for (const operationId of adminOperations()) {
      const descriptor: RouteDescriptor = ROUTES[operationId];
      const response = await app.inject({
        method: descriptor.method.toUpperCase() as "GET",
        url: toFastifyUrl(descriptor.path).replace(/:[^/]+/g, "x"),
        headers: descriptor.mutating ? { ...V1, [IDEMPOTENCY_KEY_HEADER]: randomUUID() } : V1,
        payload: descriptor.mutating ? { value: 1 } : undefined,
      });
      assert.equal(response.statusCode, 401, `${operationId} answered without a session`);
    }
  });

  it("leaves non-admin routes alone", async () => {
    const { app } = makeApp([]);
    const response = await app.inject({ method: "GET", url: `${API_PREFIX}/feed`, headers: V1 });
    // Still the stub, not a 401: the gate must not become a site-wide login wall.
    assert.equal(response.statusCode, 501);
  });

  it("classifies paths without matching a prefix by accident", () => {
    assert.equal(isAdminPath("/admin"), true);
    assert.equal(isAdminPath("/admin/settings"), true);
    assert.equal(isAdminPath("/administration"), false);
    assert.equal(isAdminPath("/posts"), false);
  });
});

describe("401 — I do not know who you are", () => {
  it("no cookie at all", async () => {
    const { app } = makeApp([]);
    const response = await app.inject({ method: "GET", url: SETTINGS, headers: V1 });
    assert.equal(response.statusCode, 401);
    assert.equal(statusOf(response.payload), "unauthorized");
  });

  it("a cookie header with some other cookie in it", async () => {
    const { app } = makeApp([]);
    const response = await app.inject({
      method: "GET",
      url: SETTINGS,
      headers: { ...V1, cookie: "theme=dark; consent=1" },
    });
    assert.equal(response.statusCode, 401);
  });

  it("a token that was never issued", async () => {
    const admin = await insertUser("ghost-admin");
    const { app } = makeApp([admin]);
    const response = await app.inject({
      method: "GET",
      url: SETTINGS,
      headers: cookie(`tok_${randomUUID()}`),
    });
    assert.equal(response.statusCode, 401);
  });

  it("an EXPIRED session, even for an allowlisted admin", async () => {
    const admin = await insertUser("expired-admin");
    const token = await insertSession(admin, {
      expiresAt: new Date(NOW.getTime() - 1000),
    });
    const { app } = makeApp([admin]);
    const response = await app.inject({ method: "GET", url: SETTINGS, headers: cookie(token) });
    assert.equal(response.statusCode, 401);
    assert.equal(statusOf(response.payload), "unauthorized");
  });

  it("a REVOKED session, even one that has not expired", async () => {
    const admin = await insertUser("revoked-admin");
    const token = await insertSession(admin, { revokedAt: new Date(NOW.getTime() - 60_000) });
    const { app } = makeApp([admin]);
    const response = await app.inject({ method: "GET", url: SETTINGS, headers: cookie(token) });
    assert.equal(response.statusCode, 401);
  });

  it("says the same thing to all four, so it is not an oracle", async () => {
    // A caller who could tell "expired" from "never existed" would learn
    // whether a stolen token was ever real.
    const admin = await insertUser("oracle-admin");
    const { app } = makeApp([admin]);
    const bodies = await Promise.all(
      [
        undefined,
        `tok_${randomUUID()}`,
        await insertSession(admin, { expiresAt: new Date(NOW.getTime() - 1) }),
        await insertSession(admin, { revokedAt: NOW }),
      ].map(async (token) => {
        const response = await app.inject({
          method: "GET",
          url: SETTINGS,
          headers: token === undefined ? V1 : cookie(token),
        });
        const parsed = JSON.parse(response.payload) as { error: { code: string; message: string } };
        return `${String(response.statusCode)} ${parsed.error.code} ${parsed.error.message}`;
      }),
    );
    assert.equal(new Set(bodies).size, 1, `four different answers: ${bodies.join(" | ")}`);
  });
});

describe("403 — I know exactly who you are and the answer is no", () => {
  it("a valid session for a user who is not on the allowlist", async () => {
    const admin = await insertUser("real-admin");
    const bystander = await insertUser("bystander");
    const token = await insertSession(bystander);

    const { app } = makeApp([admin]);
    const response = await app.inject({ method: "GET", url: SETTINGS, headers: cookie(token) });
    assert.equal(response.statusCode, 403);
    assert.equal(statusOf(response.payload), "forbidden");
  });

  it("an EMPTY allowlist denies an otherwise-perfect admin session", async () => {
    // The forgotten-env-var case, which is the one that matters: the failure
    // mode of a missing `ADMIN_USER_IDS` must be "nobody gets in", never
    // "everybody does".
    const admin = await insertUser("locked-out-admin");
    const token = await insertSession(admin);
    const { app } = makeApp([]);
    const response = await app.inject({ method: "GET", url: SETTINGS, headers: cookie(token) });
    assert.equal(response.statusCode, 403);
  });
});

describe("200 — the allowlisted admin gets through", () => {
  it("serves the settings list", async () => {
    const admin = await insertUser("working-admin");
    const token = await insertSession(admin);
    const { app } = makeApp([admin]);

    const response = await app.inject({ method: "GET", url: SETTINGS, headers: cookie(token) });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.payload) as { items: unknown[] };
    assert.ok(body.items.length > 0, "the seeded settings should be there");
  });

  it("normalises a raw allowlist set, so case never causes a silent deny", async () => {
    const admin = await insertUser("shouty-admin");
    const token = await insertSession(admin);
    const { app } = makeApp([admin.toUpperCase()]);
    const response = await app.inject({ method: "GET", url: SETTINGS, headers: cookie(token) });
    assert.equal(response.statusCode, 200);
  });
});

describe("the raw token never becomes a log line or a row", () => {
  it("survives a full authenticated write without appearing anywhere", async () => {
    const admin = await insertUser("audited-admin");
    const token = await insertSession(admin);
    const fixture = makeApp([admin]);

    const response = await fixture.app.inject({
      method: "PUT",
      url: `${SETTINGS}/routing.coverage_target`,
      headers: { ...cookie(token), [IDEMPOTENCY_KEY_HEADER]: `key-${randomUUID()}` },
      payload: { value: 4 },
    });
    assert.equal(response.statusCode, 200, response.payload);

    // 1. Not in the logs — captured at `trace`, so nothing was filtered out.
    const logs = fixture.logs();
    assert.ok(logs.length > 0, "the fake sink captured nothing, so it proves nothing");
    assert.ok(!logs.includes(token), "the raw session token reached a log line");

    // 2. Not in the response body or its headers.
    assert.ok(!response.payload.includes(token));
    assert.ok(!JSON.stringify(response.headers).includes(token));

    // 3. Not in ANY row of ANY table in this schema. Every table is dumped as
    //    JSON text and searched, rather than naming the three tables this
    //    request happens to write — a token that leaked into a column added by
    //    a later migration would still be caught.
    const tables = await pool<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${schema} AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;
    assert.ok(tables.length > 10, `only ${String(tables.length)} tables scanned`);

    for (const { table_name: table } of tables) {
      const rows = await pool.unsafe<{ dump: string }[]>(
        `SELECT coalesce(string_agg(to_jsonb(t)::text, ' '), '') AS dump FROM "${schema}"."${table}" t`,
      );
      assert.ok(
        !(rows[0]?.dump ?? "").includes(token),
        `the raw session token was persisted in ${table}`,
      );
    }

    // 4. And the hash IS there, so the scan above is not passing because
    //    nothing was written at all.
    const stored = await pool<{ count: string }[]>`
      SELECT count(*)::text AS count FROM sessions WHERE token_hash = ${hashSessionToken(token)}
    `;
    assert.equal(stored[0]?.count, "1");
  });
});

describe("the gate runs before the idempotency middleware", () => {
  /**
   * OBSERVED AS AN INSERT ATTEMPT, NOT AS A LATER 409 — and the difference
   * matters enough to explain.
   *
   * The obvious test ("an unauthenticated PUT must not burn the key a real
   * admin is about to use") PASSES WITH THE HOOKS IN EITHER ORDER, so it
   * proves nothing: `idempotency.ts` records only a 2xx and RELEASES the claim
   * on everything else, so even a claim made before a `401` is handed back.
   * That was found by breaking the order deliberately and watching the test
   * stay green (red-gate RG-14 in the PR body).
   *
   * What is genuinely different is whether an UNAUTHENTICATED request gets to
   * write to `idempotency_responses` AT ALL. With the gate first it never
   * touches the table; with the gate second, every anonymous `PUT` — including
   * a flood of them — becomes an INSERT and a DELETE against a table nobody
   * has authenticated to. A BEFORE INSERT trigger counting attempts into a
   * probe table makes that exactly observable, deterministically and without a
   * race (the same technique `packages/db`'s settings suite uses to prove the
   * audit row is inside the write transaction).
   */
  it("an unauthenticated PUT never even reaches the idempotency table", async () => {
    const admin = await insertUser("racing-admin");
    const token = await insertSession(admin);
    const fixture = makeApp([admin]);
    const url = `${SETTINGS}/routing.coverage_window_hours`;

    await pool.unsafe(`CREATE TABLE idempotency_probe (at timestamptz NOT NULL DEFAULT now())`);
    await pool.unsafe(`
      CREATE FUNCTION idempotency_probe_fn() RETURNS trigger AS $probe$
      BEGIN
        INSERT INTO idempotency_probe DEFAULT VALUES;
        RETURN NEW;
      END;
      $probe$ LANGUAGE plpgsql
    `);
    await pool.unsafe(`
      CREATE TRIGGER idempotency_probe_trg BEFORE INSERT ON idempotency_responses
      FOR EACH ROW EXECUTE FUNCTION idempotency_probe_fn()
    `);

    try {
      const rejected = await fixture.app.inject({
        method: "PUT",
        url,
        headers: { ...V1, [IDEMPOTENCY_KEY_HEADER]: `key-${randomUUID()}` },
        payload: { value: 12 },
      });
      assert.equal(rejected.statusCode, 401);

      const afterAnonymous = await pool<{ n: string }[]>`
        SELECT count(*)::text AS n FROM idempotency_probe
      `;
      assert.equal(
        afterAnonymous[0]?.n,
        "0",
        "an unauthenticated request claimed an idempotency key — the gate is registered too late",
      );

      // The probe is not passing because it never fires: an AUTHENTICATED
      // write goes through the middleware exactly as it should.
      const accepted = await fixture.app.inject({
        method: "PUT",
        url,
        headers: { ...cookie(token), [IDEMPOTENCY_KEY_HEADER]: `key-${randomUUID()}` },
        payload: { value: 12 },
      });
      assert.equal(accepted.statusCode, 200, accepted.payload);

      const afterAdmin = await pool<{ n: string }[]>`
        SELECT count(*)::text AS n FROM idempotency_probe
      `;
      assert.equal(afterAdmin[0]?.n, "1");
    } finally {
      await pool.unsafe(`DROP TRIGGER idempotency_probe_trg ON idempotency_responses`);
      await pool.unsafe(`DROP FUNCTION idempotency_probe_fn()`);
      await pool.unsafe(`DROP TABLE idempotency_probe`);
    }
  });
});

describe("parsing the allowlist", () => {
  it("unset is an empty set, not an open door", () => {
    assert.equal(parseAdminAllowlist(undefined).size, 0);
    assert.equal(adminAllowlistFromEnv({}).size, 0);
  });

  it("an empty or whitespace value is an empty set", () => {
    assert.equal(parseAdminAllowlist("").size, 0);
    assert.equal(parseAdminAllowlist("   ").size, 0);
    assert.equal(parseAdminAllowlist(",,").size, 0);
  });

  it("reads a comma-separated list, tolerating spacing and a trailing comma", () => {
    const a = "0f4a1c9e-5b62-4d18-9a71-3c8e2d5f6b04";
    const b = "8d3e7a21-64bf-4c05-b9e8-127a5f30d9c6";
    assert.deepStrictEqual([...parseAdminAllowlist(` ${a} , ${b} ,`)].sort(), [a, b].sort());
  });

  it("A MALFORMED ENTRY IS A BOOT-TIME ERROR, never a silently skipped one", () => {
    // Skipping it would leave a deployment where one of two admins works and
    // nobody finds out until the other tries at 3am.
    const valid = "0f4a1c9e-5b62-4d18-9a71-3c8e2d5f6b04";
    for (const raw of [
      "not-a-uuid",
      `${valid},oops`,
      "0f4a1c9e-5b62-4d18-9a71-3c8e2d5f6b0", // one character short
      "mira", // a handle where an id belongs
    ]) {
      assert.throws(
        () => parseAdminAllowlist(raw),
        AdminAllowlistError,
        `${raw} should have failed the boot`,
      );
    }
  });

  it("names the offending values, because 'one of your entries is wrong' is not actionable", () => {
    assert.throws(
      () => parseAdminAllowlist("mira,zeno"),
      (error: unknown) => {
        assert.ok(error instanceof AdminAllowlistError);
        assert.match(error.message, /"mira"/);
        assert.match(error.message, /"zeno"/);
        assert.match(error.message, new RegExp(ADMIN_USER_IDS_ENV));
        return true;
      },
    );
  });

  it("lowercases, so a differently-cased paste is the same admin", () => {
    const id = "0F4A1C9E-5B62-4D18-9A71-3C8E2D5F6B04";
    assert.ok(parseAdminAllowlist(id).has(id.toLowerCase()));
  });
});

describe("reading the session cookie by hand", () => {
  const NAME = SESSION_COOKIE_NAME;

  it("finds the cookie among others, whatever the spacing", () => {
    assert.equal(readCookie(`${NAME}=abc`, NAME), "abc");
    assert.equal(readCookie(`theme=dark; ${NAME}=abc; consent=1`, NAME), "abc");
    assert.equal(readCookie(`  ${NAME}   =   abc  `, NAME), "abc");
  });

  it("keeps everything after the FIRST '=' — a base64 token ends in padding", () => {
    assert.equal(readCookie(`${NAME}=YWJjZA==`, NAME), "YWJjZA==");
  });

  it("unwraps a quoted value (RFC 6265 permits it)", () => {
    assert.equal(readCookie(`${NAME}="abc"`, NAME), "abc");
  });

  it("returns null for absent, empty and malformed alike", () => {
    assert.equal(readCookie(undefined, NAME), null);
    assert.equal(readCookie("", NAME), null);
    assert.equal(readCookie("theme=dark", NAME), null);
    assert.equal(readCookie(`${NAME}=`, NAME), null);
    assert.equal(readCookie(NAME, NAME), null);
  });

  it("does not match a cookie whose name merely contains the session name", () => {
    assert.equal(readCookie(`not_${NAME}=abc`, NAME), null);
    assert.equal(readCookie(`${NAME}_old=abc`, NAME), null);
  });
});

describe("hashing the session token", () => {
  it("is hex SHA-256 of the token, and nothing about the token is recoverable", () => {
    const token = "tok_example";
    assert.equal(hashSessionToken(token), createHash("sha256").update(token).digest("hex"));
    assert.match(hashSessionToken(token), /^[0-9a-f]{64}$/);
    assert.ok(!hashSessionToken(token).includes(token));
  });

  it("is stable and collision-free across the tokens this server mints", () => {
    const a = `tok_${randomUUID()}`;
    const b = `tok_${randomUUID()}`;
    assert.equal(hashSessionToken(a), hashSessionToken(a));
    assert.notEqual(hashSessionToken(a), hashSessionToken(b));
  });
});
