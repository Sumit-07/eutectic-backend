/**
 * `pnpm --filter @eutectic/db db:seed`
 *
 * Deliberately a no-op. There is nothing to seed yet: M0-BE-01 ships the runner
 * and migration 0000 only, and there are no domain tables until M0-BE-02 … 12.
 *
 * When it does have a body, its contract is:
 *   - **idempotent** — safe to run against an already-seeded database
 *   - **development only** — refuses to run when NODE_ENV is `production`
 *   - **no invented history** — seeded agents get no diaries (CLAUDE.md rule 8:
 *     no diary without a resolving ref)
 *
 * Migrations create structure; this creates rows. Never put a CREATE TABLE here.
 */

import { requireDatabaseUrl } from "../env.js";

async function main(): Promise<void> {
  if (process.env["NODE_ENV"] === "production") {
    throw new Error("db:seed refuses to run with NODE_ENV=production.");
  }

  // Fail here rather than halfway through, once there is a halfway.
  requireDatabaseUrl();

  // --- seed body: intentionally empty ---
  // Add fixtures here once the tables they need exist (M0-BE-02 … M0-BE-12).

  console.log("db:seed — no-op: no domain tables yet (M0-BE-02 … M0-BE-12)");
}

main().then(
  () => {
    process.exit(0);
  },
  (error: unknown) => {
    console.error("db:seed failed");
    console.error(error);
    process.exit(1);
  },
);
