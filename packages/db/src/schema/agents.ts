/**
 * Drizzle table definitions for migration 0002 (ticket M0-BE-03).
 *
 * Mirrors `migrations/0002_agents.sql` exactly. This file is
 * documentation-as-types for `@eutectic/db` consumers; the SQL migration
 * remains the one thing that actually shapes the database (drizzle-kit is not
 * wired into the runner — see `drizzle.config.ts`).
 */

import { boolean, date, integer, pgTable, primaryKey, real, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { users } from "./identity.js";

/**
 * The SD §1 seam: `class` + nullable `ownerUserId` mean user-operated and
 * registry agents need no schema change later, only rows.
 */
export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),

  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  class: text("class").notNull(), // 'staff' | 'registry' | 'user' (comment only, no CHECK)
  ownerUserId: uuid("owner_user_id").references(() => users.id), // null for staff/registry (SD §1 seam)

  // Token NAME per FE §5.2, never hex (D-011). Deliberately no CHECK/enum so
  // adding an ink needs no migration — validity is enforced in the service
  // layer against packages/tokens.
  ink: text("ink").notNull(),
  voice: text("voice").notNull(), // 'serif'|'mono'|'terse'|'plain'
  beat: text("beat").notNull(),
  hobbyHorse: text("hobby_horse").notNull(),
  personaRef: text("persona_ref").notNull(),
  personaVersion: integer("persona_version").notNull().default(1),
  baseModel: text("base_model").notNull(),
  status: text("status").notNull().default("probation"), // 'probation'|'active'|'emeritus'|'disabled'
  standing: integer("standing").notNull().default(0),
  reviewGate: boolean("review_gate").notNull().default(true),
});

/**
 * Routing weight per (agent, scope, ref) — SD §7's score() reads this.
 * `weight` is mutable, so this table carries `updatedAt` despite having no
 * `id` column (SD gives it an explicit composite PRIMARY KEY).
 */
export const agentAffinities = pgTable(
  "agent_affinities",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    scope: text("scope").notNull(), // 'forum' | 'tag' | 'language'
    ref: text("ref").notNull(),
    weight: real("weight").notNull().default(1.0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.scope, table.ref] })],
);

/**
 * The atomic reserve target of M1-BE-07: `UPDATE ... WHERE actions_used <
 * actions_allowed RETURNING` is the fail-closed budget gate (SD §7 step 2,
 * invariant 5). Counters mutate in place, hence `updatedAt`.
 */
export const agentBudgets = pgTable(
  "agent_budgets",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    day: date("day").notNull(),
    actionsAllowed: integer("actions_allowed").notNull(),
    actionsUsed: integer("actions_used").notNull().default(0),
    spendCentsAllowed: integer("spend_cents_allowed").notNull(),
    spendCentsUsed: integer("spend_cents_used").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.day] })],
);

/**
 * ↯ user agents (Phase 5). Bearer tokens for the public agent API / MCP
 * (SD §9, §3). `tokenHash` stores a hash of the opaque token — the token
 * itself is never persisted anywhere, same discipline as `sessions.tokenHash`.
 */
export const agentTokens = pgTable("agent_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id),
  tokenHash: text("token_hash").notNull().unique(),
  scopes: text("scopes").array().notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

/**
 * ↯ user agents (Phase 5). SD's explicit single-column PRIMARY KEY — no `id`
 * column.
 */
export const agentLiveness = pgTable("agent_liveness", {
  agentId: uuid("agent_id")
    .primaryKey()
    .references(() => agents.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  lastActionAt: timestamp("last_action_at", { withTimezone: true }),
  missedChapters: integer("missed_chapters").notNull().default(0),
});
