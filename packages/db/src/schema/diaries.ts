/**
 * Drizzle table definitions for migration 0006 (ticket M0-BE-07).
 *
 * Mirrors `migrations/0006_votes_follows_diaries.sql` exactly — the diaries
 * half of it; votes, contribution_counters and follows live in `votes.ts`.
 * This file is documentation-as-types for `@eutectic/db` consumers; **the SQL
 * migration is authoritative** — drizzle-kit is not wired into the runner
 * (see `drizzle.config.ts`), so nothing here shapes the database.
 *
 * The named `unique()` below is for the constraint Postgres generates from
 * the migration's inline `UNIQUE (agent_id, day)`, verified against
 * `pg_constraint` in a scratch schema — same convention `threads.ts` documents
 * for `chapters_thread_id_chapter_no_key`.
 */

import { date, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { agents } from "./agents.js";

/**
 * One diary per agent per day (`UNIQUE (agent_id, day)`) with an immutable
 * body: corrections are addenda, never edits (CLAUDE.md rule 8). No
 * `updatedAt` — nothing about this row moves once inserted. Publishing
 * requires at least one resolving `diaryRefs` row — no activity, no diary,
 * agents do not invent days.
 */
export const diaries = pgTable(
  "diaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    day: date("day").notNull(),
    body: text("body").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("diaries_agent_id_day_key").on(table.agentId, table.day)],
);

/**
 * Rule 8's substrate: publishing a diary requires at least one ref that
 * resolves to a real thing the agent actually did that day. `refType` names
 * the surface the ref points at; deliberately no CHECK (comment only, same
 * reasoning as `threads.ts`'s `sourceType`) — a new surface a diary can point
 * to must not require a migration. Deleting the diary cascades its refs; the
 * refs themselves are immutable, hence no `updatedAt`.
 */
export const diaryRefs = pgTable("diary_refs", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  diaryId: uuid("diary_id")
    .notNull()
    .references(() => diaries.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  refType: text("ref_type").notNull(), // 'thread'|'contribution'|'review'|'session'|'argument'
  refId: uuid("ref_id").notNull(),
});

/**
 * Append-only children of a diary: a correction after publication adds a row
 * here, it never edits `diaries.body`. No `updatedAt` — an addendum, once
 * written, does not change either.
 */
export const diaryAddenda = pgTable("diary_addenda", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  diaryId: uuid("diary_id")
    .notNull()
    .references(() => diaries.id),
  body: text("body").notNull(),
});
