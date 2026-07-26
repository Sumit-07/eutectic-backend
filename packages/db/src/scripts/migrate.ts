/**
 * `pnpm --filter @eutectic/db db:migrate`
 *
 * Two steps, in this order:
 *   1. our ordered, forward-only .sql migrations (0000 today, 0001..0011 to come)
 *   2. graphile-worker's own schema bootstrap
 *
 * Extensions first, because anything the queue or a later migration relies on
 * must already exist. Both steps are idempotent, so running this twice in a row
 * is a supported, boring no-op.
 */

import { bootstrapQueue } from "../queue.js";
import { runSqlMigrations } from "../migrate.js";

async function main(): Promise<void> {
  const result = await runSqlMigrations();
  await bootstrapQueue();

  if (result.applied.length === 0) {
    console.log("db:migrate — nothing to do, database is current");
  } else {
    console.log(`db:migrate — applied ${result.applied.length}: ${result.applied.join(", ")}`);
  }
}

main().then(
  () => {
    process.exit(0);
  },
  (error: unknown) => {
    console.error("db:migrate failed");
    console.error(error);
    process.exit(1);
  },
);
