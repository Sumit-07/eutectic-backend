/**
 * The admin gate (P-09, DIRECTIVE §3).
 *
 * One `preHandler` hook standing in front of EVERY `/admin/*` operation:
 *
 *   no valid session                  → 401
 *   valid session, not on the list    → 403
 *   valid session, on the list        → through, with the acting admin in
 *                                       context (`admin-context.ts`)
 *
 * WHICH ROUTES ARE GATED IS READ FROM THE CONTRACT, NOT LISTED HERE. `ROUTES`
 * is generated from `openapi.yaml`, and {@link adminOperations} selects every
 * operation whose PATH is under `/admin`. A hand-maintained list of three
 * operation ids would be correct today and wrong the first time someone adds
 * `/admin/agents` — and wrong silently, in the direction of an ungated admin
 * route. Deriving it means a new admin path is gated by existing.
 *
 * 401 AND 403 ARE DIFFERENT ANSWERS TO DIFFERENT QUESTIONS, and the split is
 * the contract's: `401` means "I do not know who you are", `403` means "I know
 * exactly who you are and the answer is no". A logged-in non-admin who pokes
 * `/v1/admin/settings` learns only that the route exists — which is already
 * public information, because `openapi.yaml` is published.
 *
 * THE GATE RUNS BEFORE THE IDEMPOTENCY MIDDLEWARE. `app.ts` registers it
 * first, and fastify runs `preHandler` hooks in registration order. That
 * ordering is load-bearing rather than incidental: an unauthenticated `PUT`
 * must not be able to CLAIM an idempotency key. If it could, an attacker who
 * cannot authenticate could still burn the key a legitimate admin's retry is
 * about to use, and turn a `401` into a `409` for somebody else.
 *
 * IT FAILS CLOSED IN EVERY DIRECTION. No cookie is a `401`; a database that
 * cannot answer raises, which `app.ts` renders as a `500` (never as a pass);
 * an empty allowlist rejects everybody (`allowlist.ts`); and a handler that
 * somehow runs without the context raises rather than inventing an actor
 * (`admin-context.ts`).
 */

import { ROUTES } from "@eutectic/contracts";
import type { OperationId, RouteDescriptor } from "@eutectic/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ISql } from "@eutectic/db";

import { ApiFailure } from "../errors.js";
import type { ContractRouteConfig } from "../routes.js";
import { isAllowlistedAdmin } from "./allowlist.js";
import { runAsActingAdmin } from "./admin-context.js";
import { readCookie, resolveSession, SESSION_COOKIE_NAME } from "./session.js";

/** Contract paths under this prefix are admin-only. */
const ADMIN_PATH_PREFIX = "/admin";

/** Whether a contract path is an admin path. `/admin` itself counts; `/administration` does not. */
export function isAdminPath(path: string): boolean {
  return path === ADMIN_PATH_PREFIX || path.startsWith(`${ADMIN_PATH_PREFIX}/`);
}

/**
 * Every operation the gate applies to, derived from the contract.
 *
 * Exported so `__tests__/admin-gate.test.ts` can assert the gate covers all of
 * them rather than the three this ticket happens to implement.
 */
export function adminOperations(): ReadonlySet<OperationId> {
  const operations = new Set<OperationId>();
  for (const [operationId, descriptor] of Object.entries(ROUTES) as [
    OperationId,
    RouteDescriptor,
  ][]) {
    if (isAdminPath(descriptor.path)) operations.add(operationId);
  }
  return operations;
}

export interface AdminGateOptions {
  /** Where `sessions` lives. Any postgres.js handle; `main.ts` passes the pool. */
  readonly sql: ISql;
  /** Parsed once at boot — see `allowlist.ts`. An empty set denies everybody. */
  readonly allowlist: ReadonlySet<string>;
  /**
   * The clock, injectable (D-014's discipline at the edge where a clock is
   * legitimately read). Defaults to the real one; a test pins it to put a
   * session's expiry in the past without waiting.
   */
  readonly now?: () => Date;
}

/**
 * Installs the gate on `app`. Call BEFORE `registerIdempotency` and before
 * `registerContractRoutes` — fastify snapshots an instance's hooks when each
 * route is registered, so a hook added afterwards applies to nothing.
 */
export function registerAdminGate(app: FastifyInstance, options: AdminGateOptions): void {
  const gated = adminOperations();
  const clock = options.now ?? ((): Date => new Date());
  // Normalised HERE as well as in `parseAdminAllowlist`, deliberately.
  // `allowlist` is a public `buildApp` option: a caller who builds the set some
  // other way (a test, a future config source) would otherwise get a silent
  // deny for an id that differs only in case, and a silent deny in an auth
  // path is the kind of bug that gets debugged at 3am. Normalising once at
  // registration costs nothing and makes the comparison total.
  const allowlist = new Set([...options.allowlist].map((id) => id.toLowerCase()));

  // The callback (not async) form, because entering the AsyncLocalStorage
  // store means calling `done()` from INSIDE `runAsActingAdmin` — see
  // `admin-context.ts` and `tracing.ts` for why that is what makes the store
  // visible to the handler.
  app.addHook("preHandler", (request, _reply, done) => {
    const config = request.routeOptions.config as ContractRouteConfig | undefined;
    const operationId = config?.operationId;
    if (operationId === undefined || !gated.has(operationId)) {
      done();
      return;
    }

    void authorize(request, options.sql, allowlist, clock()).then(
      (userId) => {
        runAsActingAdmin({ userId }, () => {
          done();
        });
      },
      (error: unknown) => {
        done(error as Error);
      },
    );
  });
}

/**
 * The whole decision, as a function, so it is testable without a server.
 *
 * @throws {ApiFailure} `401` or `403`. Anything else it throws (a database
 *         that will not answer) reaches `app.ts` as a `500`, which is the
 *         correct fail-closed outcome and is deliberately NOT caught here.
 */
async function authorize(
  request: FastifyRequest,
  sql: ISql,
  allowlist: ReadonlySet<string>,
  now: Date,
): Promise<string> {
  // `request.headers.cookie` is the raw header. The token extracted from it is
  // passed straight to `resolveSession` and never touched again — it is not
  // logged here, and it is not put into any `ApiFailure` message below.
  const token = readCookie(request.headers.cookie, SESSION_COOKIE_NAME);
  if (token === null) throw unauthorized();

  const userId = await resolveSession(sql, token, now);
  if (userId === null) throw unauthorized();

  if (!isAllowlistedAdmin(allowlist, userId)) {
    // The user id is logged (it is not a secret, and an operator asking "who
    // tried" is the entire point of this line) — the token is not.
    request.log.warn({ user_id: userId }, "admin access denied: not on the allowlist");
    throw new ApiFailure(403, "forbidden", "admin access is not enabled for this account");
  }

  return userId;
}

/**
 * One `401` for every way a session can fail to resolve — absent, unknown,
 * expired, revoked. Distinguishing them for the caller would tell an attacker
 * whether a stolen token was ever real.
 */
function unauthorized(): ApiFailure {
  return new ApiFailure(401, "unauthorized", "sign in to continue");
}
