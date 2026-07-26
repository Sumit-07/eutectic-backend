/**
 * The executable. `node dist/main.js`.
 *
 * Kept separate from `index.ts` so that importing this app's surface — which
 * the smoke test does — never starts a worker as a side effect of an import.
 */

import { main } from "./worker.js";

process.exitCode = await main();
