/**
 * Drizzle table definitions for migration 0010 (ticket M0-BE-11).
 *
 * Mirrors `migrations/0010_economy_moderation.sql` exactly. As in
 * `identity.ts`, `agents.ts`, `posts.ts`, `threads.ts` and `calls.ts`, this
 * file is documentation-as-types for `@eutectic/db` consumers; **the SQL
 * migration is authoritative** — drizzle-kit is not wired into the runner
 * (see `drizzle.config.ts`), so nothing here shapes the database.
 *
 * No table here has a CHECK, so there is nothing to name explicitly (unlike
 * `calls.ts`'s `calls_confidence_check`).
 */

import { boolean, integer, jsonb, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { agents } from "./agents.js";
import { users } from "./identity.js";
import { forums } from "./posts.js";

/**
 * The SD §1 seam (sixth row): "every future earn/spend reason slots in as a
 * row" via the generic `refType`/`refId` pair, deliberately uncheck-
 * constrained. Append-only: no `updatedAt`, and — this ticket's acceptance —
 * **no balance column anywhere and never will be**. Balance is SUM(delta)
 * over this table, cached in Redis.
 */
export const creditLedger = pgTable("credit_ledger", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  delta: integer("delta").notNull(),
  reason: text("reason").notNull(),
  // the SD §1 seam: every future earn/spend reason slots in as a row.
  refType: text("ref_type"),
  refId: uuid("ref_id"),
});

/**
 * Standing's ledger: same shape and seam as `creditLedger`, same append-only
 * guarantee (no `updatedAt`, no balance column, ever). Standing derives from
 * resolved outcomes — never from raw applause volume (CLAUDE.md §6
 * invariant). Enforcing which events may write here is a service-layer
 * concern, not this table's.
 */
export const standingLedger = pgTable("standing_ledger", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id),
  delta: integer("delta").notNull(),
  reason: text("reason").notNull(), // 'call_held_up'|'well_made'|'weak'|'finding_confirmed'
  refType: text("ref_type"),
  refId: uuid("ref_id"),
});

/**
 * Mutates in place (`state` advances as the window opens and closes), hence
 * `updatedAt`. `resourceType`/`state` are text with comments only, no CHECK.
 */
export const auctions = pgTable("auctions", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  resourceType: text("resource_type").notNull(), // 'session_slot'|'named_agent'
  resourceRef: text("resource_ref").notNull(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
  state: text("state").notNull().default("open"), // 'open'|'closed'|'settled'
});

/**
 * Mutates in place: `won` starts NULL and is set at auction close, hence
 * `updatedAt`.
 */
export const bids = pgTable("bids", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  auctionId: uuid("auction_id")
    .notNull()
    .references(() => auctions.id),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  amount: integer("amount").notNull(),
  won: boolean("won"),
});

/**
 * Mutates in place across the whole proposal lifecycle, hence `updatedAt`.
 * `state` is text with a comment only, no CHECK. `probationForumId`,
 * `probationStartedAt` and `agentId` start NULL and are filled in as the
 * proposal advances.
 */
export const agentProposals = pgTable("agent_proposals", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  proposerUserId: uuid("proposer_user_id")
    .notNull()
    .references(() => users.id),
  spec: jsonb("spec").notNull(),
  feePaidCents: integer("fee_paid_cents").notNull().default(0),
  standingSpent: integer("standing_spent").notNull().default(0),
  differentiationScore: real("differentiation_score"),
  state: text("state").notNull().default("submitted"), // 'submitted'|'rejected'|'probation'|'promoted'|'withdrawn'
  probationForumId: uuid("probation_forum_id").references(() => forums.id),
  probationStartedAt: timestamp("probation_started_at", { withTimezone: true }),
  agentId: uuid("agent_id").references(() => agents.id),
});

/**
 * Mutates in place (`state` advances as a report is triaged), hence
 * `updatedAt`. `reporterUserId` stays nullable exactly as SD writes it —
 * anonymous and system-generated reports have no reporting user.
 * `targetType`/`targetId` is a second generic polymorphic seam.
 */
export const reports = pgTable("reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  reporterUserId: uuid("reporter_user_id").references(() => users.id),
  // generic seam: a report can target any surface, no schema change required.
  targetType: text("target_type").notNull(),
  targetId: uuid("target_id").notNull(),
  reason: text("reason").notNull(),
  state: text("state").notNull().default("open"),
});

/**
 * Append-only: an admin action is a fact about what was done, never edited —
 * no `updatedAt`. `targetType`/`targetId` is the same generic seam as
 * `reports`.
 */
export const moderationActions = pgTable("moderation_actions", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  adminUserId: uuid("admin_user_id")
    .notNull()
    .references(() => users.id),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: uuid("target_id").notNull(),
  reason: text("reason").notNull(),
});

/**
 * Append-only: the audit trail of every admin action, never edited — no
 * `updatedAt`. `payload`'s shape is deliberately not fixed at the DB layer.
 */
export const adminAudit = pgTable("admin_audit", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  adminUserId: uuid("admin_user_id")
    .notNull()
    .references(() => users.id),
  action: text("action").notNull(),
  payload: jsonb("payload").notNull(),
});
