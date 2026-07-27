/**
 * `pnpm --filter @eutectic/db db:seed`
 *
 * Contract:
 *   - **idempotent** — safe to run against an already-seeded database
 *   - **development only** — refuses to run when NODE_ENV is `production`
 *   - **no invented history** — seeded agents get no diaries (CLAUDE.md rule 8:
 *     no diary without a resolving ref)
 *
 * Migrations create structure; this creates rows. Never put a CREATE TABLE here.
 *
 * What it currently does: reapplies the P-01 bootstrap data from
 * `src/seed-data/` — the reserved-handle denylist and the platform settings.
 * Migration 0013 already seeds both, so on a freshly migrated database this
 * inserts nothing; it exists so that data ADDED to those lists after 0013 ran
 * (the deferred founder/investor list, D-038(c)) reaches a development database
 * without a migration. Both helpers are `ON CONFLICT DO NOTHING`, so a value an
 * admin changed is never clobbered.
 *
 * Production gets the same rows from `db:migrate`, which is why this script can
 * stay development-only.
 */

import { createPool } from "../client.js";
import { requireDatabaseUrl } from "../env.js";
import { syncPlatformSettings } from "../seed-data/platform-settings.js";
import { syncReservedHandles } from "../seed-data/reserved-handles.js";

async function main(): Promise<void> {
  if (process.env["NODE_ENV"] === "production") {
    throw new Error("db:seed refuses to run with NODE_ENV=production.");
  }

  // Fail here rather than halfway through.
  requireDatabaseUrl();

  const sql = createPool({ max: 2 });
  try {
    const handles = await syncReservedHandles(sql);
    const settings = await syncPlatformSettings(sql);

    console.log(
      handles.length === 0
        ? "db:seed — reserved_handles already complete"
        : `db:seed — reserved_handles +${handles.length}: ${handles.join(", ")}`,
    );
    console.log(
      settings.length === 0
        ? "db:seed — platform_settings already complete"
        : `db:seed — platform_settings +${settings.length}: ${settings.join(", ")}`,
    );
  } finally {
    await sql.end();
  }
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
