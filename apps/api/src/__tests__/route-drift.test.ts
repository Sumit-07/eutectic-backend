/**
 * The route-parity gate (M0-BE-15, system-design §2:
 * "CI fails if openapi.yaml and the API's registered routes disagree").
 *
 * Three artefacts must agree, and this file checks every edge of the triangle:
 *
 *     openapi.yaml  ←→  ROUTES (@eutectic/contracts)  ←→  fastify's route table
 *
 * Every comparison is a set equality in BOTH directions. A route in the spec
 * that nobody registered fails; a route registered that the spec does not
 * declare fails just as hard — that second direction is the one that catches a
 * hand-written `app.get(...)` sneaking a surface in without a contract change.
 *
 *   pnpm --filter @eutectic/api test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ROUTES } from "@eutectic/contracts";

import { buildApp } from "../app.js";
import { stubHandlers } from "../handlers.js";
import {
  ACCEPT_EXEMPT_OPERATIONS,
  API_PREFIX,
  contractRoutes,
  operationIds,
  toFastifyUrl,
} from "../index.js";
import { scanOperations } from "./openapi-scan.js";

const spec = scanOperations();

/** No logging: this file makes many apps and none of them serve a request. */
const app = buildApp({ logger: false });

const key = (route: { method: string; url: string }): string => `${route.method} ${route.url}`;
const sorted = (values: readonly string[]): string[] => [...values].sort();

describe("openapi.yaml ↔ ROUTES", () => {
  it("declares exactly the operations ROUTES declares", () => {
    // Proves the scan found something, too: an empty scan fails here.
    assert.deepEqual(
      sorted(spec.map((operation) => operation.operationId)),
      sorted(operationIds()),
    );
  });

  it("agrees with ROUTES on every method and path", () => {
    for (const operation of spec) {
      const descriptor = ROUTES[operation.operationId as keyof typeof ROUTES];
      assert.ok(descriptor, `${operation.operationId} missing from ROUTES`);
      assert.equal(descriptor.method, operation.method, `${operation.operationId} method`);
      assert.equal(descriptor.path, operation.path, `${operation.operationId} path`);
    }
  });

  it("marks the same operations mutating as ROUTES does", () => {
    // The contract's own definition of mutating: it is exactly the operations
    // that require an Idempotency-Key (system-design §3). M0-BE-16 reads this
    // flag off the route config, so a disagreement here is a correctness bug
    // in retry handling, not a naming quibble.
    for (const operation of spec) {
      const descriptor = ROUTES[operation.operationId as keyof typeof ROUTES];
      const mutatingMethod = operation.method !== "get";
      assert.equal(
        descriptor.mutating,
        mutatingMethod,
        `${operation.operationId} mutating flag disagrees with its method`,
      );
    }
  });
});

describe("openapi.yaml ↔ apps/api's tables", () => {
  it("agrees with ROUTES.successStatus on every operation (M0-SH-12, M0-BE-23)", () => {
    // The hand-maintained `SUCCESS_STATUS` table this test used to bind to
    // openapi.yaml is gone (M0-BE-23): `RouteDescriptor.successStatus` is now
    // generator-derived straight from the contract (M0-SH-12), and
    // `routes.ts` reads it directly. That retires the "hand table might drift
    // from the spec" risk this test was written for — but not the test
    // itself: `scanOperations()` below parses `openapi.yaml`'s raw YAML
    // completely independently of `@eutectic/contracts`' own generator, so
    // this is a genuine second-implementation cross-check (the same shape as
    // the "mutating flag" test above), not circular busywork bouncing a
    // generated value off itself — it still catches a generator bug or a
    // stale, un-rebuilt `dist/`. 201 for createPost, 204 for endSession, 302
    // for the redirects, etc.
    for (const operation of spec) {
      const declared = operation.statuses
        .map((status) => Number.parseInt(status, 10))
        .filter((status) => status >= 200 && status < 400);
      assert.equal(
        declared.length,
        1,
        `${operation.operationId} declares ${declared.length} success statuses`,
      );
      const descriptor = ROUTES[operation.operationId as keyof typeof ROUTES];
      assert.equal(descriptor.successStatus, declared[0], `${operation.operationId} success status`);
    }
  });

  it("exempts from Accept exactly the operations that declare no 406", () => {
    // The exemption's justification IS the contract: a browser-redirect
    // endpoint declares no 406 because no client sets an Accept header for it.
    const withoutNotAcceptable = spec
      .filter((operation) => !operation.statuses.includes("406"))
      .map((operation) => operation.operationId);

    assert.deepEqual(sorted([...ACCEPT_EXEMPT_OPERATIONS]), sorted(withoutNotAcceptable));
  });

  it("declares a 500 and a 429 on every operation, as the envelope assumes", () => {
    // Not decoration: app.ts maps every unexpected throw to 500 and the rate
    // limiter (M0-BE-19) will map to 429. Both must be legal on every route.
    for (const operation of spec) {
      assert.ok(operation.statuses.includes("500"), `${operation.operationId} has no 500`);
      assert.ok(operation.statuses.includes("429"), `${operation.operationId} has no 429`);
    }
  });
});

describe("ROUTES ↔ fastify", () => {
  it("registers every contract route, and only contract routes", () => {
    const expected = sorted(contractRoutes().map(key));
    const actual = sorted(
      app.registeredRoutes.filter((route) => route.url.startsWith(`${API_PREFIX}/`)).map(key),
    );
    assert.deepEqual(actual, expected);
  });

  it("registers nothing outside the versioned prefix", () => {
    // Operational endpoints (/healthz, /readyz — M0-BE-20) live here and are
    // legitimately outside the contract: liveness/readiness probes for an
    // orchestrator, not client-facing operations (see `health.ts`). Nothing
    // else may use this exemption — a third entry here is exactly the
    // un-noticed drift this test exists to catch.
    const allowed: ReadonlySet<string> = new Set<string>(["GET /healthz", "GET /readyz"]);
    const outside = app.registeredRoutes
      .filter((route) => !route.url.startsWith(`${API_PREFIX}/`))
      .map(key)
      .filter((route) => !allowed.has(route));
    assert.deepEqual(outside, []);
  });

  it("registers each route exactly once", () => {
    const seen = app.registeredRoutes.map(key);
    assert.deepEqual(sorted(seen), sorted([...new Set(seen)]));
  });

  it("translates path parameters into fastify syntax", () => {
    assert.equal(toFastifyUrl("/posts/{postId}"), `${API_PREFIX}/posts/:postId`);
    assert.equal(
      toFastifyUrl("/threads/{threadId}/contributions"),
      `${API_PREFIX}/threads/:threadId/contributions`,
    );
    assert.equal(toFastifyUrl("/feed"), `${API_PREFIX}/feed`);
    for (const route of contractRoutes()) {
      assert.ok(!route.url.includes("{"), `${route.url} still carries OpenAPI braces`);
    }
  });
});

describe("handler registry ↔ ROUTES", () => {
  it("binds one handler per operation, and no others", () => {
    // The compiler already proves this (handlers.ts' RegistryCoversContract).
    // Asserted at runtime too, because the compile-time proof disappears the
    // moment someone reaches for a cast.
    assert.deepEqual(sorted(Object.keys(stubHandlers)), sorted(operationIds()));
  });
});
