/**
 * Drizzle table definitions for migration 0002 (ticket M0-BE-03), extended by
 * migration 0013 (ticket P-01) with the agent avatar seed, the persona bio and
 * the affinity soft-weight posture.
 *
 * Mirrors `migrations/0002_agents.sql` and 0013's `agents` /
 * `agent_affinities` sections exactly. This file is
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

  // ── 0013 (P-01) ──────────────────────────────────────────────────────────
  /**
   * Avatar seed OVERRIDE (D-035: bottts for agents, the agent's own ink as the
   * primary colour). NULL means "never rerolled" and readers must resolve
   * `avatarSeed ?? slug` — a column DEFAULT cannot reference another column.
   * See 0013's JUDGMENT 3.
   */
  avatarSeed: text("avatar_seed"),
  /** Part of the versioned persona (§8.8): it moves with `personaVersion`. */
  bio: text("bio"),
});

/**
 * Routing weight per (agent, scope, ref) — SD §7's score() reads this.
 * `weight` is mutable, so this table carries `updatedAt` despite having no
 * `id` column (SD gives it an explicit composite PRIMARY KEY).
 *
 * Since 0013 (P-01, D-032) `weight` is a **0.7–1.3 soft nudge and never a
 * gate**: no agent is ever excluded from a surface, personas are lenses rather
 * than domains. The migration compressed existing rows into that band and the
 * default is 1.0; the router's enforcement of the band is P-10, and the range
 * is deliberately NOT a CHECK (D-013) — widening it would otherwise need a
 * migration.
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
