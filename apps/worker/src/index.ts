/**
 * @eutectic/worker — the queue consumer (system-design §2).
 *
 * Explicit named exports only — no barrel re-export (CLAUDE.md §4). Importing
 * this module starts nothing; the executable is `src/main.ts`.
 */

export type { DatabasePool, WorkerContext } from "./context.js";

export { buildTaskList, buildTaskRegistry, type TaskRegistry } from "./tasks.js";

export { main, startWorker, type WorkerHandle, type WorkerOptions } from "./worker.js";
