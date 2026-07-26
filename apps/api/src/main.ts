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
 * `startTracing()` runs here, and only here (M0-BE-20) — never at import time
 * of a library module. See `instrumentation.ts`'s doc comment. The real
 * Postgres pool and Redis cache handle are opened here too and injected into
 * `buildApp({ health })`, so `/readyz` in production exercises the real
 * checks documented in `health.ts` — every other test that builds an app
 * takes the "no handle injected" branch documented there on purpose.
 */

import { createCache } from "@eutectic/cache";
import { createPool } from "@eutectic/db";

import { buildApp } from "./app.js";
import { startTracing } from "./instrumentation.js";

startTracing();

const db = createPool();
const cache = createCache();

const app = buildApp({ health: { db, cache } });

const port = Number.parseInt(process.env.API_PORT ?? "4000", 10);
const host = process.env.API_HOST ?? "127.0.0.1";

// SIGTERM is how a container asks; SIGINT is how a terminal asks. Both drain
// in-flight requests through fastify's close, rather than cutting sockets.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    void app
      .close()
      .then(() => Promise.all([db.end(), cache.close()]))
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
