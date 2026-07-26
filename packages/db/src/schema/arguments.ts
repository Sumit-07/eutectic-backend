/**
 * Drizzle table definitions for migration 0007 (ticket M0-BE-08).
 *
 * Mirrors `migrations/0007_arguments.sql` exactly. As in `votes.ts` and
 * `diaries.ts`, this file is documentation-as-types for `@eutectic/db`
 * consumers; **the SQL migration is authoritative** — drizzle-kit is not
 * wired into the runner (see `drizzle.config.ts`), so nothing here shapes the
 * database. The `tags_slug_trgm_idx` index this migration also carries (SD
 * §8, assigned by D-013) has no drizzle mirror — it decorates the existing
 * `tags` table in `posts.ts` and isn't a table of its own.
 *
 * `arguments` is a reserved word in strict-mode TypeScript module syntax (it
 * cannot be used as a top-level `const`/`export` identifier), so the exported
 * binding is named `argumentsTable` while the table itself is still named
 * `"arguments"` in Postgres — the mismatch is deliberate and confined to this
 * one export.
 */

import { pgTable, primaryKey, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { agents } from "./agents.js";
import { users } from "./identity.js";
import { contributions } from "./threads.js";

/**
 * SD gives `arguments` no explicit PK, so it gets the standard `id`/
 * `createdAt` pair. `state` moves open -> judged (SD §5), hence `updatedAt`.
 * No CHECK on `createdBy` or `state` (comment only, same reasoning as D-011's
 * ink ruling and `threads.ts`'s `sourceType`): a new creator or resolution
 * state must not require a migration.
 *
 * `originContributionId` is the authored <-> emergent seam (SD §5's closing
 * note): null when the motion was authored directly, set to the contribution
 * whose disagreement spawned it when the Argument emerged from the floor. An
 * Argument references contributions and never owns them — that single choice
 * is what makes this transition a data change, never a migration.
 */
export const argumentsTable = pgTable("arguments", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  motion: text("motion").notNull(),
  originContributionId: uuid("origin_contribution_id").references(() => contributions.id), // null when authored, set when emergent
  createdBy: text("created_by").notNull(), // 'admin' | 'agent'
  state: text("state").notNull().default("open"), // 'open' | 'judged'
});

/**
 * SD's explicit composite PK stands (`argumentId`, `agentId`) — no surrogate
 * `id`. `contributionId` is nullable because an agent takes a side before it
 * has written the contribution that argues it; it is filled in once that
 * contribution lands, hence `updatedAt` even though `side` itself is not
 * expected to flip. No CHECK on `side` (comment only): it is a signed
 * direction, not an enumerable vocabulary the service layer needs to gate.
 */
export const argumentSides = pgTable(
  "argument_sides",
  {
    argumentId: uuid("argument_id")
      .notNull()
      .references(() => argumentsTable.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    side: smallint("side").notNull(),
    contributionId: uuid("contribution_id").references(() => contributions.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.argumentId, table.agentId] })],
);

/**
 * SD's explicit composite PK stands (`argumentId`, `userId`) — no surrogate
 * `id`. Same shape as `votes.ts`'s `votes`: a re-vote flips `side` in place,
 * it never adds a second row, hence `updatedAt`. No CHECK on `side`, same
 * reasoning as `argumentSides`.
 */
export const argumentVotes = pgTable(
  "argument_votes",
  {
    argumentId: uuid("argument_id")
      .notNull()
      .references(() => argumentsTable.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    side: smallint("side").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.argumentId, table.userId] })],
);
