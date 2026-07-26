/**
 * Contract → fastify route binding (M0-BE-15, system-design §2).
 *
 * Nothing in this app writes a URL string by hand. `ROUTES` — generated from
 * `openapi.yaml` and shipped by `@eutectic/contracts` — is the only source of
 * method and path, and `registerContractRoutes` walks it. That is one half of
 * the parity gate: routes cannot be forgotten, because the loop registers all
 * of them. The other half is `__tests__/route-drift.test.ts`, which proves that
 * what fastify actually holds is exactly what the contract declares, in both
 * directions, so a hand-added `app.get(...)` anywhere fails CI.
 */

import { ROUTES } from "@eutectic/contracts";
import type { OperationId, RouteDescriptor } from "@eutectic/contracts";
import type { FastifyInstance, HTTPMethods } from "fastify";

import type { HandlerRegistry } from "./handlers.js";
import { API_MEDIA_TYPE, API_PREFIX } from "./versioning.js";

/**
 * Operations exempt from `Accept` negotiation, and the reason is in the
 * contract rather than in our preferences: these two operations declare no
 * `406` response. They are browser redirects — the user's browser arrives at
 * `/auth/github/start` with `Accept: text/html,...` and there is no client
 * code in between to set a media type. Every other operation declares `406`
 * and gets it.
 *
 * `route-drift.test.ts` asserts this set equals "operations with no 406 in
 * openapi.yaml", so the exemption cannot drift away from its justification.
 */
export const ACCEPT_EXEMPT_OPERATIONS: ReadonlySet<OperationId> = new Set<OperationId>([
  "startGithubAuth",
  "completeGithubAuth",
]);

/**
 * The success status each operation declares.
 *
 * CONTRACT GAP, reported with this ticket: `RouteDescriptor` carries
 * `{ method, path, mutating }` and not the success status, so this table is
 * hand-written contract knowledge living outside the contract — exactly the
 * duplication rule 1 exists to prevent. Mitigated, not ignored:
 * `route-drift.test.ts` reads the declared 2xx/3xx status for every operation
 * straight out of `openapi.yaml` and fails if this table disagrees. The real
 * fix is `successStatus` on `RouteDescriptor`, which is Fable's to make.
 *
 * Why it cannot wait for that fix: without it the adapter would reply `200` to
 * `createPost`, whose contract says `201`, the moment a real handler lands —
 * a silent contract violation with no test to catch it.
 */
export const SUCCESS_STATUS = {
  getSession: 200,
  endSession: 204,
  startGithubAuth: 302,
  completeGithubAuth: 302,
  getFeed: 200,
  getFeedNewCount: 200,
  createPost: 201,
  getPost: 200,
  getThread: 200,
  createContribution: 201,
  getContribution: 200,
  castVote: 200,
  retractVote: 200,
  listAgents: 200,
  getAgent: 200,
  getAgentCalibration: 200,
  followAgent: 201,
  unfollowAgent: 204,
  search: 200,
} as const satisfies Record<OperationId, number>;

/** What `request.routeOptions.config` carries on every contract route. */
export interface ContractRouteConfig {
  readonly operationId: OperationId;
  /** From the contract. Read by the idempotency middleware (M0-BE-16). */
  readonly mutating: boolean;
  readonly acceptExempt: boolean;
}

/** A route as fastify holds it, for the parity gate. */
export interface RegisteredRoute {
  /** Uppercase, as fastify stores it. */
  readonly method: string;
  /** Fastify syntax, including `API_PREFIX`. */
  readonly url: string;
}

/** `/posts/{postId}` → `/posts/:postId`. The only syntax difference. */
export function toFastifyPath(openapiPath: string): string {
  return openapiPath.replace(/\{([^}]+)\}/g, ":$1");
}

/** The full URL a contract path is served at, prefix included. */
export function toFastifyUrl(openapiPath: string): string {
  return `${API_PREFIX}${toFastifyPath(openapiPath)}`;
}

/** What the contract says should be registered. The expected side of the gate. */
export function contractRoutes(): RegisteredRoute[] {
  return operationIds().map((operationId) => {
    const descriptor: RouteDescriptor = ROUTES[operationId];
    return { method: descriptor.method.toUpperCase(), url: toFastifyUrl(descriptor.path) };
  });
}

/** `ROUTES`' keys, typed. `Object.keys` widens to `string[]` on its own. */
export function operationIds(): OperationId[] {
  return Object.keys(ROUTES) as OperationId[];
}

/**
 * The generic shape of a handler at the registration boundary.
 *
 * The per-operation types are checked where handlers are DECLARED
 * (`handlers.ts`); a loop over `ROUTES` sees the union of all nineteen and TS
 * cannot call a union of functions soundly. So the cast happens exactly once,
 * here, and nowhere else in the app.
 */
type AnyRouteHandler = (request: {
  params: unknown;
  query: unknown;
  headers: unknown;
  body: unknown;
}) => unknown;

/**
 * Registers every operation in the contract on `app`.
 *
 * Handlers receive the contract's `OperationRequest` shape and return the
 * contract's reply — they never touch `reply`. That keeps status codes and the
 * media type in one place instead of nineteen, and it is what makes the
 * handler signatures checkable against `openapi.yaml`.
 */
export function registerContractRoutes(app: FastifyInstance, handlers: HandlerRegistry): void {
  for (const operationId of operationIds()) {
    const descriptor: RouteDescriptor = ROUTES[operationId];
    const successStatus: number = SUCCESS_STATUS[operationId];
    const handler = handlers[operationId] as unknown as AnyRouteHandler;

    app.route({
      method: descriptor.method.toUpperCase() as HTTPMethods,
      url: toFastifyUrl(descriptor.path),
      config: {
        operationId,
        mutating: descriptor.mutating,
        acceptExempt: ACCEPT_EXEMPT_OPERATIONS.has(operationId),
      } satisfies ContractRouteConfig,
      handler: async (request, reply) => {
        // No validation happens here on purpose. Fastify schemas derived from
        // the contract are M0-BE-16's and M0-BE-18's business; this ticket
        // binds the surface. Casting once, loudly, beats casting per handler.
        const result = await handler({
          params: request.params,
          query: request.query,
          headers: request.headers,
          body: request.body,
        });

        // `204` and `302` declare no body. A handler that returns nothing is
        // taken at its word rather than serialised as `null`.
        if (result === undefined) {
          return reply.code(successStatus).send();
        }
        return reply.code(successStatus).type(API_MEDIA_TYPE).send(result);
      },
    });
  }
}
