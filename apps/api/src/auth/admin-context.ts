/**
 * The acting admin, carried from the gate to the handler (P-09).
 *
 * THE PROBLEM THIS SOLVES. `admin_audit.admin_user_id` must be the admin who
 * made the change, and `updatePlatformSetting` therefore takes an
 * `adminUserId`. But a contract handler in this app receives EXACTLY
 * `{ params, query, headers, body }` — `RouteHandler<O>` in
 * `@eutectic/contracts` is generated from `openapi.yaml` and `routes.ts`
 * deliberately never passes `request`, which is what keeps handler signatures
 * checkable against the spec. There is no fifth field to add, and adding one
 * would mean editing `packages/contracts`, which this ticket does not own.
 *
 * THE MECHANISM IS THE ONE ALREADY PROVEN IN THIS APP. `tracing.ts` has the
 * same shape of problem — make something request-scoped visible to code that
 * was never handed it — and solves it with `AsyncLocalStorage`: a hook enters
 * the store and calls `done()` from inside, so every remaining hook, the route
 * handler, and everything they `await` are causally inside the store. See
 * `tracing.ts`'s module doc for why that works across fastify's dispatch loop.
 * This is the same technique with a smaller payload, and `admin-gate.ts` is
 * the only writer.
 *
 * IT FAILS CLOSED, WHICH IS THE PART WORTH GUARDING. `requireActingAdmin()`
 * THROWS when the store is empty rather than returning `undefined` or a
 * placeholder id. An audit row attributed to nobody, or worse to a fixed
 * service account, is a worse artefact than a `500`: it looks like a real
 * record of who changed a spend control, and it isn't one. The only way the
 * store can be empty inside an admin handler is a wiring mistake — the gate is
 * registered for every `/admin/*` route — so the loud failure is the correct
 * response to it.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { ApiFailure } from "../errors.js";

/** What the gate puts in the store. One field today; a shape so it can gain one. */
export interface ActingAdmin {
  /** `users.id` of the authenticated, allowlisted admin. */
  readonly userId: string;
}

const storage = new AsyncLocalStorage<ActingAdmin>();

/**
 * Runs `fn` with `admin` as the acting admin for the rest of this request.
 *
 * The callback is SYNCHRONOUS by design: the caller is a fastify hook calling
 * `done()`, and the store must be entered before that call rather than around
 * a promise the framework is not inside of.
 */
export function runAsActingAdmin<T>(admin: ActingAdmin, fn: () => T): T {
  return storage.run(admin, fn);
}

/** The acting admin, or `undefined` outside an admin request. */
export function actingAdmin(): ActingAdmin | undefined {
  return storage.getStore();
}

/**
 * The acting admin's user id, or a `500`.
 *
 * @throws {ApiFailure} `500` when called outside a gated request. See the
 *         module doc: an unattributed audit row is not an acceptable
 *         alternative.
 */
export function requireActingAdmin(): string {
  const admin = storage.getStore();
  if (admin === undefined) {
    throw new ApiFailure(500, "internal", "unexpected error", {
      cause: new Error(
        "admin handler ran outside the admin gate: no acting admin in context, so this " +
          "request cannot be attributed and must not be audited",
      ),
    });
  }
  return admin.userId;
}
