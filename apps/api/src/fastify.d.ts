/**
 * Fastify type augmentation for this app (M0-BE-15).
 *
 * Two additions, both of them things the parity gate and the middleware after
 * it need to read off a request or an instance rather than guess.
 */

import type { ContractRouteConfig, RegisteredRoute } from "./routes.js";

declare module "fastify" {
  /**
   * `request.routeOptions.config` on a contract route. Optional because the
   * 404 handler and any future non-contract route (health checks, M0-BE-20)
   * carry no config — reading `operationId` is how the rest of the app asks
   * "is this a contract route?".
   */
  interface FastifyContextConfig extends Partial<ContractRouteConfig> {}

  interface FastifyInstance {
    /**
     * Every route fastify actually holds, collected by an `onRoute` hook in
     * `buildApp`. This is the observed side of system-design §2's "CI fails if
     * openapi.yaml and the API's registered routes disagree" — it records what
     * was registered, not what we meant to register, so a hand-added route
     * shows up here and fails the drift test.
     */
    readonly registeredRoutes: readonly RegisteredRoute[];
  }
}
