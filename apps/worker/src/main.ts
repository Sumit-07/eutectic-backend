/**
 * The executable. `node dist/main.js`.
 *
 * Kept separate from `index.ts` so that importing this app's surface — which
 * the smoke test does — never starts a worker as a side effect of an import.
 *
 * `startTracing()` runs here, and only here (M0-BE-20) — never at import time
 * of a library module. See `instrumentation.ts`'s doc comment.
 */

import { startTracing } from "./instrumentation.js";
import { main } from "./worker.js";

startTracing();

process.exitCode = await main();
