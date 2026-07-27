/**
 * The executable. `node dist/main.js`.
 *
 * Kept separate from `index.ts` so that importing this app's surface — which
 * every test does — never starts a server as a side effect of an import.
 *
 * Defaults match `openapi.yaml#/servers`' local entry, `http://127.0.0.1:4000/v1`:
 * the port is 4000 and the host is loopback, because binding 0.0.0.0 is a
 * deployment decision (D-006: everything is local until further notice) and
 * not something a default should make for us.
 *
 * The pool is opened HERE and nowhere else. `createPool()` reads
 * `DATABASE_URL` and throws a named error if it is missing, so a misconfigured
 * process fails at boot with an actionable message rather than at the first
 * mutation with a `500` — which is the right trade for a store that every
 * mutating route depends on (M0-BE-16). The SAME pool backs `/readyz`'s
 * Postgres check (M0-BE-20): readiness reports on the pool production
 * actually mutates through, not a parallel one.
 *
 * `startTracing()` runs here, and only here (M0-BE-20) — never at import time
 * of a library module. See `instrumentation.ts`'s doc comment. The Redis
 * cache handle is opened here too and injected into `buildApp({ health })`,
 * so `/readyz` in production exercises the real checks documented in
 * `health.ts` — every other test that builds an app takes the "no handle
 * injected" branch documented there on purpose.
 */

import { createCache } from "@eutectic/cache";
import { createPool } from "@eutectic/db";

import { buildApp } from "./app.js";
import { adminAllowlistFromEnv } from "./auth/allowlist.js";
import { startTracing } from "./instrumentation.js";

startTracing();

const pool = createPool();
const cache = createCache();

// Parsed HERE, at boot, before anything listens (P-09). A malformed
// `ADMIN_USER_IDS` throws out of this line and the process never starts, which
// is the loud failure `auth/allowlist.ts` argues for — a silently dropped
// entry would leave a deployment where one of two admins works and nobody
// finds out until the other one tries. An unset variable is not an error; it
// is an empty set, and an empty set denies every admin request.
const adminAllowlist = adminAllowlistFromEnv();

const app = buildApp({
  pool,
  health: { db: pool, cache },
  // The `settings` namespace is composed HERE rather than inside
  // `packages/db`: that package declares no cache dependency at all (the
  // `SettingsCache` interface is an injected seam), and the caller composing
  // several namespaces stays in charge of that composition — the same split
  // `entitlements.ts` uses.
  admin: { sql: pool, allowlist: adminAllowlist, cache: cache.namespace("settings") },
});

const port = Number.parseInt(process.env.API_PORT ?? "4000", 10);
const host = process.env.API_HOST ?? "127.0.0.1";

// SIGTERM is how a container asks; SIGINT is how a terminal asks. Both drain
// in-flight requests through fastify's close, rather than cutting sockets.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    // Drain in-flight requests first, then the pool — closing the pool while a
    // request is still recording its idempotency claim would lose the record.
    void app
      .close()
      .then(() => Promise.all([pool.end(), cache.close()]))
      .then(
        () => {
          process.exitCode = 0;
        },
        (error: unknown) => {
          app.log.error({ err: error }, "shutdown failed");
          process.exitCode = 1;
        },
      );
  });
}

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error({ err: error }, "failed to listen");
  process.exitCode = 1;
}
