/**
 * The `Idempotency-Key` middleware (M0-BE-16, system-design §3).
 *
 * Real Postgres, real concurrency, no mock store. The claim in this ticket is
 * that the DATABASE decides who executes, so a test against an in-memory fake
 * would be testing the wrong thing — it would pass just as happily for the
 * in-process lock this design exists to avoid.
 *
 * Every test applies the real `migrations/` into a throwaway schema and points
 * the app's pool at it with postgres.js's `connection: { search_path }`, the
 * same isolation `packages/db`'s suites use. The dev database is never touched.
 *
 * Execution is counted, never inferred: each app binds a fake handler registry
 * (`buildApp({ handlers })`, which exists for exactly this) whose handler
 * increments a counter. "Did not re-execute" is that counter, not a status code.
 *
 *   pnpm --filter @eutectic/api test
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { ROUTES } from "@eutectic/contracts";
import { createPool, MIGRATIONS_DIR, runSqlMigrations } from "@eutectic/db";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../app.js";
import type { BuildAppOptions } from "../app.js";
import { notImplemented, stubHandlers } from "../handlers.js";
import type { HandlerRegistry } from "../handlers.js";
import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENT_REPLAY_HEADER, canonicalize } from "../idempotency.js";
import type { IdempotencyPool } from "../idempotency-store.js";
import { API_MEDIA_TYPE, API_PREFIX, operationIds, toFastifyUrl } from "../index.js";

const V1 = { accept: API_MEDIA_TYPE };
const FOLLOWS = `${API_PREFIX}/follows`;

let pool: IdempotencyPool;
let schema: string;

before(async () => {
  schema = `m0be16api_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await runSqlMigrations({ dir: MIGRATIONS_DIR, schema, log: () => {} });
  pool = createPool({
    // Enough for the parallel tests to be genuinely parallel.
    max: 8,
    // The app's SQL names the table unqualified; the pool decides the schema.
    extra: { connection: { search_path: `${schema}, public` } },
  });
});

after(async () => {
  await pool.end();
  const admin = createPool({ max: 1 });
  await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
});

/** A key that satisfies the contract's 8..255 bound. */
function newKey(): string {
  return `key-${randomUUID()}`;
}

interface Fixture {
  readonly app: FastifyInstance;
  /** How many times the handler under test actually ran. */
  calls(): number;
}

/**
 * An app whose `followAgent` handler counts its executions and answers with a
 * body derived from the request, so a replay that returned someone else's
 * response would be visible.
 */
function fixture(options: { delayMs?: number; appOptions?: BuildAppOptions } = {}): Fixture {
  let calls = 0;
  const handlers: HandlerRegistry = {
    ...stubHandlers,
    followAgent: async (request) => {
      calls += 1;
      if (options.delayMs !== undefined) await sleep(options.delayMs);
      const body = request.body as { agent_slug?: string };
      return {
        agent_slug: body.agent_slug ?? "unknown",
        muted: false,
        // Distinct per execution: two executions can never look alike.
        created_at: `2026-07-27T00:00:0${String(calls)}.000Z`,
      };
    },
    unfollowAgent: () => {
      calls += 1;
      return undefined;
    },
  };

  return {
    app: buildApp({ logger: false, handlers, pool, ...options.appOptions }),
    calls: () => calls,
  };
}

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

async function post(
  app: FastifyInstance,
  key: string | undefined,
  body: Record<string, unknown>,
): Promise<InjectResponse> {
  return app.inject({
    method: "POST",
    url: FOLLOWS,
    headers: key === undefined ? V1 : { ...V1, [IDEMPOTENCY_KEY_HEADER]: key },
    payload: body,
  });
}

function codeOf(payload: string): string {
  const parsed = JSON.parse(payload) as { error: { code: string } };
  return parsed.error.code;
}

// ---------------------------------------------------------------------------
// The header is required on mutations and on nothing else
// ---------------------------------------------------------------------------

describe("Idempotency-Key: required on every mutation", () => {
  it("rejects a mutating route with no key, and lets every read through", async () => {
    const { app } = fixture();

    for (const operationId of operationIds()) {
      const descriptor = ROUTES[operationId];
      const url = toFastifyUrl(descriptor.path).replace(/:([A-Za-z]+)/g, "placeholder");
      const response = await app.inject({
        method: descriptor.method.toUpperCase() as "GET",
        url,
        headers: V1,
      });

      if (descriptor.mutating) {
        assert.equal(response.statusCode, 400, `${operationId} must demand a key`);
        assert.equal(codeOf(response.payload), "bad_request");
        const details = (JSON.parse(response.payload) as { error: { details: unknown[] } }).error
          .details;
        assert.deepEqual(details, [{ field: "Idempotency-Key", issue: "required" }]);
      } else {
        // Reads reach the handler — 501 from the stub, never a 400.
        assert.equal(response.statusCode, 501, `${operationId} must not demand a key`);
      }
    }
  });

  it("rejects a key outside the contract's 8..255 bound", async () => {
    const { app, calls } = fixture();
    for (const key of ["short", "x".repeat(256)]) {
      const response = await post(app, key, { agent_slug: "bricklayer" });
      assert.equal(response.statusCode, 400, key.slice(0, 12));
      assert.equal(codeOf(response.payload), "bad_request");
    }
    assert.equal(calls(), 0, "a rejected key never reaches the handler");
  });

  it("stays deterministic when a client sends the header twice", async () => {
    // Node's HTTP parser joins duplicate non-cookie headers into ONE
    // comma-separated value, so a duplicate never reaches us as an array: it
    // is a longer key, not an ambiguous one, and two identical retries join
    // identically and therefore still deduplicate. `readKey`'s array branch
    // exists for the parser that behaves otherwise — it refuses rather than
    // picking one, because picking one decides which key a mutation is
    // deduplicated under.
    const { app, calls } = fixture();
    const headers = { ...V1, [IDEMPOTENCY_KEY_HEADER]: [newKey(), newKey()] };
    const request = { method: "POST" as const, url: FOLLOWS, headers, payload: { agent_slug: "x" } };

    assert.equal((await app.inject(request)).statusCode, 201);
    assert.equal((await app.inject(request)).statusCode, 201);
    assert.equal(calls(), 1);
  });
});

// ---------------------------------------------------------------------------
// Record and replay
// ---------------------------------------------------------------------------

describe("Idempotency-Key: replay", () => {
  it("executes once and returns the recorded bytes to the retry", async () => {
    const { app, calls } = fixture();
    const key = newKey();
    const body = { agent_slug: "bricklayer" };

    const first = await post(app, key, body);
    assert.equal(first.statusCode, 201);
    assert.equal(calls(), 1);
    assert.equal(first.headers[IDEMPOTENT_REPLAY_HEADER], undefined);

    const second = await post(app, key, body);
    assert.equal(second.statusCode, 201);
    assert.equal(
      calls(),
      1,
      "the handler must not run twice — this counter is the acceptance criterion",
    );
    assert.equal(second.payload, first.payload, "the replay is byte for byte the original");
    assert.equal(second.headers[IDEMPOTENT_REPLAY_HEADER], "true");
    assert.equal(
      (second.headers["content-type"] as string).split(";")[0]?.trim(),
      API_MEDIA_TYPE,
    );
  });

  it("replays a 204 as a 204 with no body", async () => {
    const { app, calls } = fixture();
    const key = newKey();
    const request = {
      method: "DELETE" as const,
      url: `${API_PREFIX}/follows/bricklayer`,
      headers: { ...V1, [IDEMPOTENCY_KEY_HEADER]: key },
    };

    const first = await app.inject(request);
    assert.equal(first.statusCode, 204);
    assert.equal(first.payload, "");

    const second = await app.inject(request);
    assert.equal(second.statusCode, 204);
    assert.equal(second.payload, "");
    assert.equal(second.headers[IDEMPOTENT_REPLAY_HEADER], "true");
    assert.equal(calls(), 1);
  });

  it("treats a differently-ordered but identical body as the same request", async () => {
    const { app, calls } = fixture();
    const key = newKey();

    const first = await post(app, key, { agent_slug: "bricklayer", muted: false });
    const second = await post(app, key, { muted: false, agent_slug: "bricklayer" });

    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 201, "key order is not a different request");
    assert.equal(second.payload, first.payload);
    assert.equal(calls(), 1);
  });

  it("scopes a key to nothing else — a fresh key executes", async () => {
    const { app, calls } = fixture();
    await post(app, newKey(), { agent_slug: "bricklayer" });
    await post(app, newKey(), { agent_slug: "bricklayer" });
    assert.equal(calls(), 2);
  });
});

// ---------------------------------------------------------------------------
// Key reuse
// ---------------------------------------------------------------------------

describe("Idempotency-Key: reuse is a client bug", () => {
  it("answers a different body under the same key with the contract's 409", async () => {
    const { app, calls } = fixture();
    const key = newKey();

    const first = await post(app, key, { agent_slug: "bricklayer" });
    assert.equal(first.statusCode, 201);

    const second = await post(app, key, { agent_slug: "archivist" });
    // CONTRACT, not the ticket text: openapi.yaml declares `409
    // idempotency_conflict` on all seven mutating operations. Flagged in the PR.
    assert.equal(second.statusCode, 409);
    assert.equal(codeOf(second.payload), "idempotency_conflict");
    assert.equal(calls(), 1, "a conflicting retry never reaches the handler");
  });

  it("answers the same key on a different operation with a 409 too", async () => {
    const { app, calls } = fixture();
    const key = newKey();

    const first = await post(app, key, { agent_slug: "bricklayer" });
    assert.equal(first.statusCode, 201);

    const second = await app.inject({
      method: "DELETE",
      url: `${API_PREFIX}/follows/bricklayer`,
      headers: { ...V1, [IDEMPOTENCY_KEY_HEADER]: key },
    });
    assert.equal(second.statusCode, 409, "the operation is part of the fingerprint");
    assert.equal(calls(), 1);
  });
});

// ---------------------------------------------------------------------------
// Concurrency — the acceptance criterion this ticket exists for
// ---------------------------------------------------------------------------

describe("Idempotency-Key: concurrency", () => {
  it("executes exactly once when two identical requests run in parallel", async () => {
    const { app, calls } = fixture({ delayMs: 120 });
    const key = newKey();
    const body = { agent_slug: "bricklayer" };

    const [a, b] = await Promise.all([post(app, key, body), post(app, key, body)]);

    assert.equal(calls(), 1, "exactly one execution, enforced by the unique index");
    assert.equal(a.statusCode, 201);
    assert.equal(b.statusCode, 201);
    assert.equal(a.payload, b.payload, "both callers see the one result");
    // Exactly one of them was served from the store.
    const replays = [a, b].filter((r) => r.headers[IDEMPOTENT_REPLAY_HEADER] === "true");
    assert.equal(replays.length, 1);
  });

  it("holds the line at ten parallel duplicates", async () => {
    const { app, calls } = fixture({ delayMs: 80 });
    const key = newKey();
    const body = { agent_slug: "archivist" };

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => post(app, key, body)),
    );

    assert.equal(calls(), 1);
    for (const response of responses) {
      assert.equal(response.statusCode, 201);
      assert.equal(response.payload, responses[0]?.payload);
    }
  });

  it("tells a duplicate to retry rather than lying that its key is bad", async () => {
    // The waiter gives up long before the in-flight original finishes.
    const { app, calls } = fixture({
      delayMs: 400,
      appOptions: { idempotency: { waitTimeoutMs: 30, pollIntervalMs: 5 } },
    });
    const key = newKey();
    const body = { agent_slug: "bricklayer" };

    const inFlight = post(app, key, body);
    await sleep(30);
    const duplicate = await post(app, key, body);

    // NOT 409: a client reading `idempotency_conflict` is told to generate a
    // new key, and a new key is how a duplicate becomes a double-post.
    assert.equal(duplicate.statusCode, 429);
    assert.equal(codeOf(duplicate.payload), "rate_limited");
    assert.equal(duplicate.headers["retry-after"], "1");

    assert.equal((await inFlight).statusCode, 201);
    assert.equal(calls(), 1);
  });
});

// ---------------------------------------------------------------------------
// The recording policy
// ---------------------------------------------------------------------------

describe("Idempotency-Key: only a 2xx is recorded", () => {
  it("lets a retry re-execute after a 500 rather than pinning the client to a crash", async () => {
    let calls = 0;
    const app = buildApp({
      logger: false,
      pool,
      handlers: {
        ...stubHandlers,
        followAgent: () => {
          calls += 1;
          if (calls === 1) throw new Error("transient");
          return { agent_slug: "bricklayer", muted: false, created_at: "2026-07-27T00:00:00.000Z" };
        },
      },
    });

    const key = newKey();
    const body = { agent_slug: "bricklayer" };

    const first = await post(app, key, body);
    assert.equal(first.statusCode, 500);

    const second = await post(app, key, body);
    assert.equal(second.statusCode, 201, "the crash was not recorded");
    assert.equal(calls, 2);
  });

  it("lets a retry re-execute after a 4xx, which left no side effect either", async () => {
    let calls = 0;
    const app = buildApp({
      logger: false,
      pool,
      handlers: {
        ...stubHandlers,
        followAgent: () => {
          calls += 1;
          // The stub's own answer: 501. Nothing happened, so nothing to replay.
          return notImplemented("followAgent");
        },
      },
    });

    const key = newKey();
    const body = { agent_slug: "bricklayer" };
    assert.equal((await post(app, key, body)).statusCode, 501);
    assert.equal((await post(app, key, body)).statusCode, 501);
    assert.equal(calls, 2, "a refused request must not consume its key");
  });
});

// ---------------------------------------------------------------------------
// No store configured
// ---------------------------------------------------------------------------

describe("Idempotency-Key: no store", () => {
  it("fails closed on a mutation and still serves every read", async () => {
    const app = buildApp({ logger: false });

    const mutation = await post(app, newKey(), { agent_slug: "bricklayer" });
    assert.equal(mutation.statusCode, 500, "an undeduplicated mutation is not on the menu");
    assert.equal(codeOf(mutation.payload), "internal");
    assert.doesNotMatch(mutation.payload, /store|pool|postgres/i, "no internals in the envelope");

    const read = await app.inject({ method: "GET", url: `${API_PREFIX}/feed`, headers: V1 });
    assert.equal(read.statusCode, 501, "reads never needed the store");
  });
});

// ---------------------------------------------------------------------------
// The fingerprint's canonical form
// ---------------------------------------------------------------------------

describe("canonicalize", () => {
  it("is stable across key order and indifferent to null vs undefined", () => {
    assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
    assert.equal(canonicalize(null), canonicalize(undefined));
    assert.notEqual(canonicalize({ a: 1 }), canonicalize({ a: "1" }));
    assert.notEqual(canonicalize([1, 2]), canonicalize([2, 1]));
    assert.equal(canonicalize({ a: [{ z: 1, y: 2 }] }), canonicalize({ a: [{ y: 2, z: 1 }] }));
  });
});
