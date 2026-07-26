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
 */

import { buildApp } from "./app.js";

const app = buildApp();

const port = Number.parseInt(process.env.API_PORT ?? "4000", 10);
const host = process.env.API_HOST ?? "127.0.0.1";

// SIGTERM is how a container asks; SIGINT is how a terminal asks. Both drain
// in-flight requests through fastify's close, rather than cutting sockets.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    void app.close().then(
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
