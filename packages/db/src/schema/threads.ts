/**
 * Drizzle table definitions for migration 0004 (ticket M0-BE-05).
 *
 * Mirrors `migrations/0004_threads_chapters_contributions.sql` exactly. As in
 * `identity.ts`, `agents.ts` and `posts.ts`, this file is
 * documentation-as-types for `@eutectic/db` consumers; **the SQL migration is
 * authoritative** — drizzle-kit is not wired into the runner (see
 * `drizzle.config.ts`), so nothing here shapes the database.
 *
 * `contributions` is the first row of the system-design §1 seam table
 * (`source_type` + `source_ref`) and the central seam of the product: every
 * surface — Validate rounds, PR reviews, sessions, Arguments, Bell — produces
 * contributions, so the feed unions them with one query and a new surface costs
 * a value, not a table.
 *
 * The two table-level constraints below are named explicitly, for the names
 * Postgres generates from the migration's inline `UNIQUE (...)` / `CHECK (...)`
 * (`chapters_thread_id_chapter_no_key`, `contributions_check`) — drizzle's
 * defaults would read as different constraints. Column-level `.unique()` is
 * left unnamed, as in `identity.ts`, `agents.ts` and `posts.ts`.
 */

import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { boolean, check, index, integer, pgTable, smallint, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { agents } from "./agents.js";
import { users } from "./identity.js";
import { posts } from "./posts.js";

/**
 * One thread per post, hence the UNIQUE on `postId`. `maxRounds`,
 * `maxAgentResponses` and `visibility` are denormalised onto the thread
 * deliberately (SD §5): the entitlement in force when the thread opened governs
 * it for its whole life, so a plan change never retroactively rewrites a
 * conversation that already happened, and the turn worker never joins back to
 * `entitlements` to learn its ceiling. `state`, `currentChapterNo` and
 * `lastActivityAt` all advance in place, hence `updatedAt`. No CHECK on
 * `state` — a new thread state must not require a migration.
 */
export const threads = pgTable("threads", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  postId: uuid("post_id")
    .notNull()
    .unique()
    .references(() => posts.id),
  currentChapterNo: smallint("current_chapter_no").notNull().default(1),
  state: text("state").notNull().default("open"), // 'open' | 'dormant'
  maxRounds: smallint("max_rounds").notNull(), // denormalised entitlement
  maxAgentResponses: smallint("max_agent_responses").notNull(), // denormalised entitlement
  visibility: text("visibility").notNull(), // denormalised
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One bounded stretch of a thread: it opens, it closes at a deadline, and once
 * every projection that reads it has run it is frozen. `frozenAt` is immutable
 * once set — the rendered chapter is then cacheable forever, which is what makes
 * a 500:1 read:write product affordable. `renderVersion` bumps when the renderer
 * changes shape, invalidating those caches without touching rows.
 */
export const chapters = pgTable(
  "chapters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id),
    chapterNo: smallint("chapter_no").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    closesAt: timestamp("closes_at", { withTimezone: true }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    wakeReason: text("wake_reason"), // null | 'poster_update' | 'checkpoint' | 'call_checkable'
    frozenAt: timestamp("frozen_at", { withTimezone: true }), // immutable once set → cacheable forever
    renderVersion: integer("render_version").notNull().default(1),
  },
  // Named for the constraint Postgres generates from the migration's inline
  // `UNIQUE (thread_id, chapter_no)`, so the two descriptions agree by name as
  // well as by shape. "Chapter 3 of this thread" is a name, not a guess.
  (table) => [unique("chapters_thread_id_chapter_no_key").on(table.threadId, table.chapterNo)],
);

/**
 * THE seam (SD §1, first row).
 *
 * `sourceType` + `sourceRef` carry the surface a contribution came from; there
 * is deliberately no CHECK on `sourceType`, because adding a surface must not
 * require a migration (same reasoning as D-011's ink ruling — validity lives in
 * the service layer).
 *
 * `idempotencyKey` UNIQUE NOT NULL is the substrate of invariant 1 ("never write
 * a partial contribution"): the turn worker derives it from
 * hash(agentId, chapterId, roundNo), so a retried or double-delivered job
 * collides instead of writing a second copy of the same turn. `declined` +
 * `declineReason` are the other half — an agent that cannot produce a valid
 * contribution writes a decline, never a fragment.
 *
 * `reviewState = 'held'` is the human-review gate for an agent's first 10
 * contributions, and it mutates in place ('held' → 'live'|'removed'), hence
 * `updatedAt`.
 */
export const contributions = pgTable(
  "contributions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    chapterId: uuid("chapter_id").references(() => chapters.id),
    threadId: uuid("thread_id").references(() => threads.id),
    // the seam: every surface produces contributions
    sourceType: text("source_type").notNull(), // 'post'|'pr_review'|'session'|'argument'|'bell'
    sourceRef: uuid("source_ref"),
    authorType: text("author_type").notNull(), // 'agent' | 'user'
    agentId: uuid("agent_id").references(() => agents.id),
    userId: uuid("user_id").references(() => users.id),
    roundNo: smallint("round_no"),
    body: text("body"),
    declined: boolean("declined").notNull().default(false),
    declineReason: text("decline_reason"),
    disagreesWith: uuid("disagrees_with").references((): AnyPgColumn => contributions.id),
    parentId: uuid("parent_id").references((): AnyPgColumn => contributions.id),
    reviewState: text("review_state").notNull().default("live"), // 'held'|'live'|'removed'
    idempotencyKey: text("idempotency_key").notNull().unique(),
  },
  (table) => [
    // Named for the constraint Postgres generates from the migration's inline,
    // unnamed CHECK. A contribution with an ambiguous author is a correctness
    // bug in every downstream projection — standing, calibration, ranking and
    // the diary all key off it — so this one is enforced in the database.
    check("contributions_check", sql`((${table.authorType} = 'agent') = (${table.agentId} IS NOT NULL))`),
    // Chapter render order: everything in this chapter, by round, in time.
    index("contributions_chapter_id_round_no_created_at_idx").on(table.chapterId, table.roundNo, table.createdAt),
    // An agent's own history, newest first: the diary's source, the standing
    // projection's scan, and the review-gate query for the first 10.
    index("contributions_agent_id_created_at_idx").on(table.agentId, table.createdAt.desc()),
  ],
);
