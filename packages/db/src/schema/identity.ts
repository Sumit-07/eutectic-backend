/**
 * Drizzle table definitions for migration 0001 (ticket M0-BE-02).
 *
 * Mirrors `migrations/0001_users_sessions_entitlements.sql` exactly. This file
 * is documentation-as-types for `@eutectic/db` consumers; the SQL migration
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
  handleTombstoned: boolean("handle_tombstoned").notNull().default(false),
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
