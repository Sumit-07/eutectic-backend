/**
 * The route surface (M0-BE-15): what a caller actually gets back.
 *
 * Everything runs through fastify's `inject()` — no port is bound, so this is
 * safe to run in parallel with a real local api and in CI without networking.
 *
 *   pnpm --filter @eutectic/api test
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { ROUTES } from "@eutectic/contracts";
import { createPool, MIGRATIONS_DIR, runSqlMigrations } from "@eutectic/db";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../app.js";
import { stubHandlers } from "../handlers.js";
import {
  API_MEDIA_TYPE,
  API_PREFIX,
  acceptsApiMediaType,
  IDEMPOTENCY_KEY_HEADER,
  operationIds,
  REQUEST_ID_HEADER,
  sanitizeRequestId,
  toFastifyUrl,
  type ErrorEnvelope,
  type IdempotencyPool,
} from "../index.js";

const app = buildApp({ logger: false });

/**
 * A second app, with an idempotency store behind it (M0-BE-16).
 *
 * Every MUTATING route now needs one: a mutation with no store fails closed
 * with a `500` rather than run undeduplicated. The pool is pinned to a
 * throwaway schema, so this file still never touches the dev database — and
 * the pool-less `app` above still serves every read, which is the point of
 * making it optional.
 */
let mutatingApp: FastifyInstance;
let pool: IdempotencyPool;
let schema: string;

/** The header the contract requires on every mutating operation. */
const IDEMPOTENT = { [IDEMPOTENCY_KEY_HEADER]: "01J8Z6R2F3M4N5P6Q7R8S9T0V1" };

before(async () => {
  schema = `m0be15api_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await runSqlMigrations({ dir: MIGRATIONS_DIR, schema, log: () => {} });
  pool = createPool({ max: 4, extra: { connection: { search_path: `${schema}, public` } } });
  mutatingApp = buildApp({ logger: false, pool });
});

after(async () => {
  await pool.end();
  const admin = createPool({ max: 1 });
  await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
});

/** Every request in this file sends the version header unless it is the subject. */
const V1 = { accept: API_MEDIA_TYPE };

function envelopeOf(payload: string): ErrorEnvelope {
  const parsed: unknown = JSON.parse(payload);
  assert.ok(typeof parsed === "object" && parsed !== null && "error" in parsed, "not an envelope");
  return parsed as ErrorEnvelope;
}

/**
 * Fastify appends `; charset=utf-8` to a JSON content type. The parameter is
 * redundant for a `+json` media type but harmless, and the contract negotiates
 * on the type, not on its parameters — so assert the type.
 */
function assertMediaType(header: string | string[] | undefined): void {
  assert.equal(typeof header, "string");
  assert.equal((header as string).split(";")[0]?.trim(), API_MEDIA_TYPE);
}

/** The envelope's schema: `code`, `message`, `request_id` required, `details` an array. */
function assertEnvelope(payload: string, expected: { code: string; requestId?: string }): void {
  const body = envelopeOf(payload);
  assert.deepEqual(Object.keys(body), ["error"], "envelope has exactly one key");
  assert.deepEqual(
    Object.keys(body.error).sort(),
    ["code", "details", "message", "request_id"],
    "envelope carries exactly the contract's fields",
  );
  assert.equal(body.error.code, expected.code);
  assert.ok(Array.isArray(body.error.details));
  assert.equal(typeof body.error.message, "string");
  assert.ok(body.error.message.length > 0, "message is not empty");
  // The spec's rule for this field: "Human-readable, lowercase, no trailing
  // period." Read as a prose-style rule, not a ban on every capital letter —
  // a message may quote an identifier (`getFeed is not implemented yet`).
  assert.notEqual(body.error.message[0], body.error.message[0]?.toUpperCase(), "message is lowercase");
  assert.ok(!body.error.message.endsWith("."), "message has no trailing period");
  assert.ok(body.error.request_id.length > 0, "request_id is present");
  if (expected.requestId !== undefined) assert.equal(body.error.request_id, expected.requestId);
}

// ---------------------------------------------------------------------------
// Every contract route answers, in the contract's shape
// ---------------------------------------------------------------------------

describe("contract routes", () => {
  it("answers on every operation with the stub's 501 envelope", async () => {
    for (const operationId of operationIds()) {
      const descriptor = ROUTES[operationId];
      // Path parameters get a syntactically plausible value; nothing reads it.
      const url = toFastifyUrl(descriptor.path).replace(/:([A-Za-z]+)/g, "placeholder");

      // A mutating operation needs a key and a store to get past the
      // idempotency middleware (M0-BE-16) and reach its stub at all. A key per
      // operation: one key shared across seven operations is seven different
      // requests, which is a `409` by design.
      const response = await (descriptor.mutating ? mutatingApp : app).inject({
        method: descriptor.method.toUpperCase() as "GET",
        url,
        headers: descriptor.mutating
          ? { ...V1, [IDEMPOTENCY_KEY_HEADER]: `surface-${operationId}` }
          : V1,
      });

      assert.equal(response.statusCode, 501, `${operationId} ${url}`);
      assertMediaType(response.headers["content-type"]);
      assertEnvelope(response.payload, { code: "not_implemented" });
      assert.match(envelopeOf(response.payload).error.message, new RegExp(operationId));
    }
  });

  it("serves error bodies as the versioned media type", async () => {
    const response = await app.inject({ method: "GET", url: `${API_PREFIX}/feed`, headers: V1 });
    assertMediaType(response.headers["content-type"]);
  });
});

// ---------------------------------------------------------------------------
// Accept negotiation
// ---------------------------------------------------------------------------

describe("versioned Accept", () => {
  const feed = `${API_PREFIX}/feed`;

  it("rejects an absent Accept with a contract-shaped 406", async () => {
    const response = await app.inject({ method: "GET", url: feed });
    assert.equal(response.statusCode, 406);
    assertMediaType(response.headers["content-type"]);
    assertEnvelope(response.payload, { code: "not_acceptable" });
    assert.match(envelopeOf(response.payload).error.message, /vnd\.staffroom\.v1\+json/);
  });

  it("rejects wildcards and plain json", async () => {
    for (const accept of ["*/*", "application/*", "application/json", "text/html"]) {
      const response = await app.inject({ method: "GET", url: feed, headers: { accept } });
      assert.equal(response.statusCode, 406, `accept: ${accept}`);
      assertEnvelope(response.payload, { code: "not_acceptable" });
    }
  });

  it("rejects the right media type at q=0", async () => {
    const response = await app.inject({
      method: "GET",
      url: feed,
      headers: { accept: `${API_MEDIA_TYPE};q=0` },
    });
    assert.equal(response.statusCode, 406);
  });

  it("accepts the media type among others, with parameters, in any case", async () => {
    for (const accept of [
      API_MEDIA_TYPE,
      `text/html, ${API_MEDIA_TYPE};q=0.9`,
      ` ${API_MEDIA_TYPE.toUpperCase()} ; q=1 `,
      `${API_MEDIA_TYPE}, */*`,
    ]) {
      const response = await app.inject({ method: "GET", url: feed, headers: { accept } });
      assert.equal(response.statusCode, 501, `accept: ${accept}`);
    }
  });

  it("exempts the browser-redirect auth routes", async () => {
    // They declare no 406 in the contract: the browser arrives with
    // `Accept: text/html`, and there is no client library in between.
    for (const url of [`${API_PREFIX}/auth/github/start`, `${API_PREFIX}/auth/github/callback`]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { accept: "text/html,application/xhtml+xml" },
      });
      assert.equal(response.statusCode, 501, url);
    }
  });

  it("negotiates in the parser, not only over the wire", () => {
    assert.equal(acceptsApiMediaType(undefined), false);
    assert.equal(acceptsApiMediaType(""), false);
    assert.equal(acceptsApiMediaType("*/*"), false);
    assert.equal(acceptsApiMediaType(API_MEDIA_TYPE), true);
    assert.equal(acceptsApiMediaType([`text/html`, API_MEDIA_TYPE]), true);
    assert.equal(acceptsApiMediaType(`${API_MEDIA_TYPE};q=0.0`), false);
    assert.equal(acceptsApiMediaType(`${API_MEDIA_TYPE};q=nonsense`), true);
    assert.equal(acceptsApiMediaType("application/vnd.staffroom.v2+json"), false);
  });
});

// ---------------------------------------------------------------------------
// Request id
// ---------------------------------------------------------------------------

describe("request id", () => {
  const feed = `${API_PREFIX}/feed`;

  it("generates one, echoes it, and puts the same value in the envelope", async () => {
    const response = await app.inject({ method: "GET", url: feed, headers: V1 });
    const echoed = response.headers[REQUEST_ID_HEADER];
    assert.equal(typeof echoed, "string");
    assertEnvelope(response.payload, { code: "not_implemented", requestId: echoed as string });
  });

  it("honours a well-formed inbound id", async () => {
    const inbound = "01J8Z6R2F3M4N5P6Q7R8S9T0V1";
    const response = await app.inject({
      method: "GET",
      url: feed,
      headers: { ...V1, [REQUEST_ID_HEADER]: inbound },
    });
    assert.equal(response.headers[REQUEST_ID_HEADER], inbound);
    assertEnvelope(response.payload, { code: "not_implemented", requestId: inbound });
  });

  it("replaces an unsafe inbound id rather than echoing it", async () => {
    for (const hostile of ["short", "a".repeat(200), "has space", "semi;colon"]) {
      const response = await app.inject({
        method: "GET",
        url: feed,
        headers: { ...V1, [REQUEST_ID_HEADER]: hostile },
      });
      assert.notEqual(response.headers[REQUEST_ID_HEADER], hostile, hostile);
      assert.equal(sanitizeRequestId(hostile), undefined, hostile);
    }
    assert.equal(sanitizeRequestId("01J8Z6R2F3M4N5P6Q7R8S9T0V1"), "01J8Z6R2F3M4N5P6Q7R8S9T0V1");
    assert.equal(sanitizeRequestId(undefined), undefined);
  });

  it("echoes on a 404 and on a 406, not only on a handled route", async () => {
    const inbound = "0000-1111-2222-3333";
    for (const request of [
      { url: "/nothing/here", headers: { ...V1, [REQUEST_ID_HEADER]: inbound } },
      { url: feed, headers: { [REQUEST_ID_HEADER]: inbound } },
    ]) {
      const response = await app.inject({ method: "GET", ...request });
      assert.equal(response.headers[REQUEST_ID_HEADER], inbound, request.url);
      assert.equal(envelopeOf(response.payload).error.request_id, inbound);
    }
  });

  it("appears on every log line, under request_id", async () => {
    const lines: string[] = [];
    const logged = buildApp({
      logger: {
        level: "info",
        stream: {
          write(line: string): void {
            lines.push(line);
          },
        },
      },
    });

    const inbound = "logline-0000-1111";
    await logged.inject({
      method: "GET",
      url: feed,
      headers: { ...V1, [REQUEST_ID_HEADER]: inbound },
    });

    const records = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      // The instantiation banner has no request in scope; every line that is
      // about a request carries the id.
      .filter((record) => record["req"] !== undefined || record["res"] !== undefined);

    assert.ok(records.length > 0, "no request log lines were emitted");
    for (const record of records) {
      assert.equal(record["request_id"], inbound, JSON.stringify(record));
    }
  });
});

// ---------------------------------------------------------------------------
// The single error envelope
// ---------------------------------------------------------------------------

describe("error envelope", () => {
  it("answers an unknown route under the prefix with 404 not_found", async () => {
    const response = await app.inject({
      method: "GET",
      url: `${API_PREFIX}/no-such-thing`,
      headers: V1,
    });
    assert.equal(response.statusCode, 404);
    assertMediaType(response.headers["content-type"]);
    assertEnvelope(response.payload, { code: "not_found" });
  });

  it("answers an unknown route outside the prefix the same way", async () => {
    const response = await app.inject({ method: "GET", url: "/", headers: V1 });
    assert.equal(response.statusCode, 404);
    assertEnvelope(response.payload, { code: "not_found" });
  });

  it("answers a known path with an undeclared method with the envelope", async () => {
    const response = await app.inject({ method: "PUT", url: `${API_PREFIX}/feed`, headers: V1 });
    assert.equal(response.statusCode, 404);
    assertEnvelope(response.payload, { code: "not_found" });
  });

  it("answers a malformed body with 400 bad_request, not a fastify error shape", async () => {
    const response = await app.inject({
      method: "POST",
      url: `${API_PREFIX}/posts`,
      headers: { ...V1, "content-type": "application/json" },
      payload: '{"forum":',
    });
    assert.equal(response.statusCode, 400);
    assertMediaType(response.headers["content-type"]);
    assertEnvelope(response.payload, { code: "bad_request" });
  });

  it("collapses a status the contract does not declare", async () => {
    // Fastify answers an unparseable content type with 415, which is not in
    // the spec's vocabulary; a client has no branch for it.
    const response = await app.inject({
      method: "POST",
      url: `${API_PREFIX}/posts`,
      headers: { ...V1, "content-type": "application/xml" },
      payload: "<post/>",
    });
    assert.equal(response.statusCode, 400);
    assertEnvelope(response.payload, { code: "bad_request" });
  });

  it("never leaks an unexpected error's message", async () => {
    const leaky = buildApp({
      logger: false,
      handlers: {
        ...stubHandlers,
        getFeed: () => {
          throw new Error("connection string postgres://secret@host/db");
        },
      },
    });
    const response = await leaky.inject({ method: "GET", url: `${API_PREFIX}/feed`, headers: V1 });
    assert.equal(response.statusCode, 500);
    assertEnvelope(response.payload, { code: "internal" });
    assert.doesNotMatch(response.payload, /postgres/);
  });
});

// ---------------------------------------------------------------------------
// The handler adapter — status codes come from the contract, not from handlers
// ---------------------------------------------------------------------------

describe("handler adapter", () => {
  it("uses the operation's declared success status and media type", async () => {
    const bound = buildApp({
      logger: false,
      handlers: {
        ...stubHandlers,
        getFeed: () => ({ items: [], page: { next_cursor: null, has_more: false } }),
      },
    });

    const response = await bound.inject({ method: "GET", url: `${API_PREFIX}/feed`, headers: V1 });
    assert.equal(response.statusCode, 200);
    assertMediaType(response.headers["content-type"]);
    assert.deepEqual(JSON.parse(response.payload), {
      items: [],
      page: { next_cursor: null, has_more: false },
    });
  });

  it("sends no body for an operation whose success status is 204", async () => {
    const bound = buildApp({
      logger: false,
      pool,
      handlers: { ...stubHandlers, endSession: () => undefined },
    });

    const response = await bound.inject({
      method: "DELETE",
      url: `${API_PREFIX}/auth/session`,
      headers: { ...V1, ...IDEMPOTENT },
    });
    assert.equal(response.statusCode, 204);
    assert.equal(response.payload, "");
  });

  it("hands the handler the request parts the contract describes", async () => {
    let seen: { params: unknown; query: unknown; body: unknown } | undefined;
    const bound = buildApp({
      logger: false,
      handlers: {
        ...stubHandlers,
        getPost: (request) => {
          seen = { params: request.params, query: request.query, body: request.body };
          throw new Error("stop here — the shape is what is under test");
        },
      },
    });

    await bound.inject({
      method: "GET",
      url: `${API_PREFIX}/posts/1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d`,
      headers: V1,
    });

    // Spread away fastify's null-prototype objects: the values are the subject
    // here, not the prototype `deepEqual` would otherwise compare.
    assert.deepEqual({ ...(seen?.params as object) }, {
      postId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    });
    assert.deepEqual({ ...(seen?.query as object) }, {});
    assert.equal(seen?.body, undefined);
  });
});
