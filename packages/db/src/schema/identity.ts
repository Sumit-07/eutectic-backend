/**
 * Drizzle table definitions for migration 0001 (ticket M0-BE-02), extended by
 * migration 0013 (ticket P-01) with the pseudonymous-identity columns, the
 * avatar seed, the bio, and the two tables that complete the handle namespace.
 *
 * Mirrors `migrations/0001_users_sessions_entitlements.sql` and 0013's `users`
 * / `handle_history` / `reserved_handles` sections exactly. This file is
 * documentation-as-types for `@eutectic/db` consumers; the SQL migration
 * remains the one thing that actually shapes the database (drizzle-kit is not
 * wired into the runner — see `drizzle.config.ts`).
 */

import { bigint, boolean, index, integer, pgTable, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),

  // GitHub trust-oracle inputs (SD §5).
  githubId: bigint("github_id", { mode: "number" }).notNull().unique(),
  githubLogin: text("github_login").notNull(),
  githubCreatedAt: timestamp("github_created_at", { withTimezone: true }).notNull(),
  githubPublicRepos: integer("github_public_repos").notNull().default(0),

  handle: text("handle").notNull().unique(),
  tier: smallint("tier").notNull().default(0), // 0..3, no CHECK (SD §5 gives none)
  tierComputedAt: timestamp("tier_computed_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  /**
   * The account is closed and its handle is retired for good. A CLOSURE
   * MARKER, never a reservation mechanism: the row (and therefore the handle)
   * survives so `/u/[handle]` renders "account closed" rather than 404
   * (frontend-spec §10), which is what makes the name permanently unclaimable
   * through the existing UNIQUE index. See 0013's RULING 1.
   */
  handleTombstoned: boolean("handle_tombstoned").notNull().default(false),

  // ── 0013 (P-01) ──────────────────────────────────────────────────────────
  /** D-029: the GitHub login is private unless the user opts in. */
  showGithubLogin: boolean("show_github_login").notNull().default(false),
  /** NULL = never changed. The §9 90-day rename cooldown is measured from here. */
  handleChangedAt: timestamp("handle_changed_at", { withTimezone: true }),
  /**
   * Tier as it WOULD be under the signup gate, computed on every login whether
   * the gate is on or not (D-036). Admin-only — it is derived from the GitHub
   * fingerprint and leaks it (D-029, P-02's forbidden list).
   */
  tierWouldBe: smallint("tier_would_be"),
  /**
   * Avatar seed OVERRIDE. NULL means "never rerolled" and readers must resolve
   * `avatar_seed ?? id` — a column DEFAULT cannot reference another column, so
   * the natural seed lives in the read path, not in the schema. See 0013's
   * JUDGMENT 3 and D-035.
   */
  avatarSeed: text("avatar_seed"),
  /** 160 chars, plain text, URLs inert — all enforced at the edge (§8.8). */
  bio: text("bio"),
});

/**
 * Handles released by a LIVE account that renamed, reserved for 90 days (§9)
 * so links do not rot and squatting is awkward. The only path that ever frees
 * a name; a tombstoned account's handle is never released and never appears
 * here. See 0013's RULING 1 for how this composes with `users.handle` and
 * `reserved_handles` into one availability predicate.
 *
 * Written once, expires by clock — no `updatedAt`.
 */
export const handleHistory = pgTable(
  "handle_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Kept after the reservation lapses: moderation follows `user_id` (§9). */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    handle: text("handle").notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }).notNull().defaultNow(),
    reservedUntil: timestamp("reserved_until", { withTimezone: true }).notNull(),
  },
  // Not UNIQUE: one handle can be released more than once over the platform's life.
  (table) => [index("handle_history_handle_idx").on(table.handle)],
);

/**
 * The PERMANENT denylist: staff agent slugs, the brand, the Bell surface, role
 * names, and (once the human supplies it, D-038(c)) well-known founders and
 * investors. Nothing in the account lifecycle ever writes here — see 0013's
 * RULING 1.
 *
 * The canonical list is `src/seed-data/reserved-handles.ts`, seeded by 0013 and
 * appliable additively with `syncReservedHandles`.
 */
export const reservedHandles = pgTable("reserved_handles", {
  handle: text("handle").primaryKey(),
  /**
   * 'staff_agent'|'brand'|'product_surface'|'role'|'impersonation_risk'
   * (comment only, no CHECK — D-013).
   */
  reason: text("reason").notNull(),
});

/**
 * Auth sessions (D-011): an opaque bearer token handed to the client in an
 * httpOnly cookie (SD §11). `tokenHash` stores a hash of that token — the
 * token itself is never persisted anywhere. Distinct from the agent-execution
 * `sessions_` table (SD §5), which arrives in a later migration.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("sessions_user_id_idx").on(table.userId)],
);

/**
 * Entitlements are rows with a validity window, never booleans on `users`
 * (SD §1 seam). The read path resolves the active row once per request and
 * caches it on the session.
 */
export const entitlements = pgTable(
  "entitlements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    plan: text("plan").notNull(), // 'free' | 'premium'
    maxPostsPerDay: smallint("max_posts_per_day").notNull(),
    maxRounds: smallint("max_rounds").notNull(),
    maxAgentResponses: smallint("max_agent_responses").notNull(),
    guaranteedPickup: boolean("guaranteed_pickup").notNull(),
    canUnlist: boolean("can_unlist").notNull(),
    canRequestAgent: boolean("can_request_agent").notNull(),
    residenciesAllowed: smallint("residencies_allowed").notNull().default(0),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validTo: timestamp("valid_to", { withTimezone: true }),
  },
  (table) => [index("entitlements_user_id_valid_from_idx").on(table.userId, table.validFrom.desc())],
);
