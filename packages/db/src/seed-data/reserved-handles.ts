/**
 * Reserved handles — the permanent denylist (P-01, DIRECTIVE §2 and §9).
 *
 * This module is the CANONICAL LIST. Migration 0013 seeds exactly
 * `CORE_RESERVED_HANDLES` with the same `ON CONFLICT DO NOTHING` semantics, and
 * `migration-0013.test.ts` asserts the two agree — so there is one list, in two
 * places that are checked against each other, rather than two lists that drift.
 *
 * **The founder/investor list is deliberately empty here** (D-038(c)): the human
 * supplies it after sign-off. Adding it is pure data — append to
 * `FOUNDER_RESERVED_HANDLES` and either run `syncReservedHandles` (an admin/ops
 * path, `db:seed` in development) or land the same rows in a later migration for
 * production. No code changes, no schema changes, and re-running is safe.
 *
 * Handles are stored lowercase-normalised (§9's format rule: 3–20 chars,
 * `[a-z0-9_-]`), because that is the only form a signup can ever produce.
 */

import type { Sql } from "postgres";

/**
 * Why a handle is unclaimable. Text in the database (no CHECK, D-013); this
 * union is the vocabulary the seeding path writes.
 *
 * - `staff_agent` — a resident's slug. A user posting as `ledger` is the most
 *   damaging impersonation available on this platform.
 * - `brand` — the platform's own name.
 * - `product_surface` — a surface a reader would read as official (`bell`).
 * - `role` — reads as staff or infrastructure (`admin`, `support`, `system`).
 * - `impersonation_risk` — a real person or firm. The founder/investor list.
 */
export type ReservedHandleReason = "staff_agent" | "brand" | "product_surface" | "role" | "impersonation_risk";

export interface ReservedHandle {
  readonly handle: string;
  readonly reason: ReservedHandleReason;
}

/**
 * The six staff agents (`capabilities.md` §8). Their slugs are their public
 * identity on every surface, so the handle namespace must not be able to
 * produce a second one.
 */
export const STAFF_AGENT_SLUGS = ["bricklayer", "ledger", "marguerite", "sprout", "grouse", "vellum"] as const;

/** Seeded by migration 0013. Changing this list requires a new migration too. */
export const CORE_RESERVED_HANDLES: readonly ReservedHandle[] = [
  ...STAFF_AGENT_SLUGS.map((slug): ReservedHandle => ({ handle: slug, reason: "staff_agent" })),
  { handle: "eutectic", reason: "brand" },
  { handle: "bell", reason: "product_surface" },
  { handle: "admin", reason: "role" },
  { handle: "staff", reason: "role" },
  { handle: "support", reason: "role" },
  { handle: "official", reason: "role" },
  { handle: "system", reason: "role" },
  { handle: "mod", reason: "role" },
  { handle: "help", reason: "role" },
];

/**
 * Well-known founders and investors — impersonation is the obvious abuse
 * (DIRECTIVE §2). Empty until the human supplies the list (D-038(c)); it is
 * purely additive when it arrives.
 */
export const FOUNDER_RESERVED_HANDLES: readonly ReservedHandle[] = [];

/** Everything this repo knows about, in seeding order. */
export const RESERVED_HANDLES: readonly ReservedHandle[] = [
  ...CORE_RESERVED_HANDLES,
  ...FOUNDER_RESERVED_HANDLES,
];

export interface SyncReservedHandlesOptions {
  /** Schema to write into. Defaults to `public`; tests pass a scratch schema. */
  readonly schema?: string;
  /** Entries to apply. Defaults to `RESERVED_HANDLES`. */
  readonly entries?: readonly ReservedHandle[];
}

/**
 * Insert reserved handles, skipping any that already exist.
 *
 * Idempotent by construction: `ON CONFLICT (handle) DO NOTHING` means a rerun
 * inserts nothing and — importantly — never rewrites the `reason` of a handle
 * an operator reserved by hand. Returns the handles this call actually
 * inserted, so a caller can log what changed.
 */
export async function syncReservedHandles(sql: Sql, options: SyncReservedHandlesOptions = {}): Promise<readonly string[]> {
  const schema = options.schema ?? "public";
  const entries = options.entries ?? RESERVED_HANDLES;
  const inserted: string[] = [];

  for (const entry of entries) {
    const rows = await sql<{ handle: string }[]>`
      INSERT INTO ${sql(schema)}.${sql("reserved_handles")} (handle, reason)
      VALUES (${entry.handle}, ${entry.reason})
      ON CONFLICT (handle) DO NOTHING
      RETURNING handle
    `;
    if (rows.length > 0) inserted.push(entry.handle);
  }

  return inserted;
}
