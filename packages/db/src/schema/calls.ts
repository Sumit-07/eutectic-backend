/**
 * Drizzle table definitions for migration 0005 (ticket M0-BE-06).
 *
 * Mirrors `migrations/0005_calls.sql` exactly. As in `identity.ts`, `agents.ts`,
 * `posts.ts` and `threads.ts`, this file is documentation-as-types for
 * `@eutectic/db` consumers; **the SQL migration is authoritative** —
 * drizzle-kit is not wired into the runner (see `drizzle.config.ts`), so
 * nothing here shapes the database.
 *
 * The one table-level constraint below is named explicitly, for the name
 * Postgres generates from the migration's inline `CHECK (confidence BETWEEN 1
 * AND 5)` (`calls_confidence_check`, confirmed against `pg_constraint` in a
 * scratch schema) — drizzle's default would read as a different constraint.
 * Column-level `.unique()` on `contributionId` is left unnamed, as in the
 * merged suites.
 */

import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, primaryKey, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { agents } from "./agents.js";
import { users } from "./identity.js";
import { contributions } from "./threads.js";

/**
 * THE seam (SD §1, fourth row): `contributionId`, not `postId`. A call
 * attaches to whichever contribution asserted it, and a contribution can come
 * from any surface (SD §1's first seam), so a call can originate anywhere
 * without a schema change. UNIQUE because a contribution makes at most one
 * claim. `claimType` and `state` are text with a comment and deliberately no
 * CHECK — new claim types and resolution states must not need a migration
 * (same reasoning as D-011's ink ruling). `confidence`'s CHECK is the one SD
 * §5 gives verbatim, kept as-is: it fixes the domain of
 * `agentCalibration.confidence`'s bucket key. `state` mutates in place
 * ('open' → 'held_up'|'did_not'|'unresolvable'|'expired'), hence `updatedAt`.
 */
export const calls = pgTable(
  "calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // the seam: a call attaches to a contribution, never a post, so it can
    // originate on any surface a contribution can come from (SD §1).
    contributionId: uuid("contribution_id")
      .notNull()
      .unique()
      .references(() => contributions.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    claim: text("claim").notNull(),
    claimType: text("claim_type").notNull(), // 'will_fail'|'wont_ship'|'wrong_price'|... (comment only, no CHECK)
    confidence: smallint("confidence").notNull(),
    horizonDays: integer("horizon_days").notNull(),
    state: text("state").notNull().default("open"), // 'open'|'held_up'|'did_not'|'unresolvable'|'expired'
  },
  (table) => [
    // Named for the constraint Postgres generates from the migration's inline
    // CHECK, confirmed via pg_constraint in a scratch schema.
    check("calls_confidence_check", sql`${table.confidence} BETWEEN 1 AND 5`),
  ],
);

/**
 * Append-only: rows are only ever ADDED to a call's history, never deleted.
 * `askedAt`/`answeredAt`/`outcome`/`note`/`creditPaid` are filled in place when
 * a checkpoint fires and resolves, hence `updatedAt`.
 */
export const callCheckpoints = pgTable(
  "call_checkpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    callId: uuid("call_id")
      .notNull()
      .references(() => calls.id),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    askedAt: timestamp("asked_at", { withTimezone: true }),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    outcome: text("outcome"),
    note: text("note"),
    resolverId: uuid("resolver_id").references(() => users.id),
    creditPaid: integer("credit_paid").notNull().default(0),
  },
  (table) => [
    // Invariant 3's substrate ("no lost resolution"): the partial index over
    // only the unanswered rows drives the unanswered queue no matter how large
    // the resolved history grows.
    index("call_checkpoints_due_at_unanswered_idx").on(table.dueAt).where(sql`${table.answeredAt} IS NULL`),
  ],
);

/**
 * Projection (SD §5): SD gives this table an explicit composite PRIMARY KEY,
 * so there is no surrogate `id`. Counters mutate in place, hence `updatedAt`.
 * The curve, not the number: held_up/resolved bucketed by stated confidence;
 * unresolved calls are excluded, never counted as wrong.
 */
export const agentCalibration = pgTable(
  "agent_calibration",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    confidence: smallint("confidence").notNull(),
    resolved: integer("resolved").notNull().default(0),
    heldUp: integer("held_up").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.confidence] })],
);
