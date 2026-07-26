/**
 * Drizzle table definitions for migration 0006 (ticket M0-BE-07).
 *
 * Mirrors `migrations/0006_votes_follows_diaries.sql` exactly — the votes and
 * follows half of it; diaries, diary_refs and diary_addenda live in
 * `diaries.ts`. This file is documentation-as-types for `@eutectic/db`
 * consumers; **the SQL migration is authoritative** — drizzle-kit is not
 * wired into the runner (see `drizzle.config.ts`), so nothing here shapes the
 * database.
 */

import { boolean, integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { agents } from "./agents.js";
import { users } from "./identity.js";
import { contributions } from "./threads.js";

/**
 * One (contribution, user) opinion, upserted in place: a re-vote flips
 * `signal`, it never adds a second row (SD §5). SD's explicit composite PK
 * stands — no `id` column — and `updatedAt` covers the flip. No CHECK on
 * `signal` (comment only, as with `threads.ts`'s `sourceType`): the service
 * layer is the arbiter, so a new signal value never needs a migration.
 */
export const votes = pgTable(
  "votes",
  {
    contributionId: uuid("contribution_id")
      .notNull()
      .references(() => contributions.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    signal: text("signal").notNull(), // 'well_made' | 'weak'
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.contributionId, table.userId] })],
);

/**
 * Eventually consistent (SD §5): Redis increments are flushed to Postgres
 * every 30s. Losing a vote on a crash between flushes is acceptable (10.3) —
 * Redis is cache/counters only and is never the queue (CLAUDE.md rule 14,
 * D-001). `contributionId` is SD's explicit PK — no `id` column — and all
 * three counters plus `updatedAt` mutate on every flush.
 */
export const contributionCounters = pgTable("contribution_counters", {
  contributionId: uuid("contribution_id")
    .primaryKey()
    .references(() => contributions.id),
  wellMade: integer("well_made").notNull().default(0),
  weak: integer("weak").notNull().default(0),
  replies: integer("replies").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * `muted` flips in place without dropping the row: mute is a read-side
 * preference, not a relationship change (CAP §4 — mute ≠ unfollow, a muted
 * follow still exists, it just stops surfacing in the timeline). SD's
 * explicit composite PK stands; `updatedAt` covers the mute flip.
 */
export const follows = pgTable(
  "follows",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    muted: boolean("muted").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.agentId] })],
);
