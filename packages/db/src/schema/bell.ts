/**
 * Drizzle table definitions for migration 0009 (ticket M0-BE-10).
 *
 * Mirrors `migrations/0009_bell.sql` exactly. As in `identity.ts`, `agents.ts`,
 * `posts.ts`, `threads.ts`, `calls.ts` and `votes.ts`, this file is
 * documentation-as-types for `@eutectic/db` consumers; **the SQL migration is
 * authoritative** — drizzle-kit is not wired into the runner (see
 * `drizzle.config.ts`), so nothing here shapes the database.
 *
 * THE ISLAND INVARIANT: every table below references `users` and nothing
 * else. Bell is its own island (system-design §5, CAP §12) — private by
 * default, persistent per-user, with no path into or out of the public
 * content graph (posts, threads, chapters, contributions, forums,
 * feed_entries, diaries, ...). Do not add a `.references()` here that points
 * anywhere but `users` — `bell.test.ts`'s schema-isolation test asserts this
 * generically over all four tables and will fail loudly if it is violated.
 */

import { date, integer, pgTable, smallint, text, time, timestamp, uuid } from "drizzle-orm/pg-core";

import { users } from "./identity.js";

/**
 * SD gives `commitments` no explicit PK, so it gets the standard `id`/
 * `createdAt` pair. `state` mutates in place as the user works through it
 * ('open' → 'done'|'deferred'|'dropped'), hence `updatedAt`. `state` and
 * `source` are text with a comment and deliberately no CHECK — same
 * reasoning as D-011's `ink` ruling: a new value must not need a migration.
 */
export const commitments = pgTable("commitments", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  text: text("text").notNull(),
  dueOn: date("due_on", { mode: "string" }).notNull(),
  state: text("state").notNull().default("open"), // 'open'|'done'|'deferred'|'dropped' (comment only, no CHECK)
  source: text("source").notNull(), // 'user'|'bell_suggested' (comment only, no CHECK)
});

/**
 * SD's explicit PK (`userId`) stands — no surrogate `id`, one row per user.
 * This row mutates constantly (`pausedUntil`, `consecutiveSilentDays`,
 * `toneLevel` all move as Bell reacts to a user's activity and silence, CAP
 * §12's "softens on absence"), hence `updatedAt`. `cadence` and `toneLevel`
 * are comment-only, no CHECK: `toneLevel` in particular is Bell's
 * circuit-breaker substrate (CLAUDE.md rule 11 — the breaker is code, not a
 * prompt) and must move without a migration.
 */
export const bellState = pgTable("bell_state", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  cadence: text("cadence").notNull().default("daily"), // comment only, no CHECK
  sendAtLocal: time("send_at_local").notNull(),
  timezone: text("timezone").notNull(),
  pausedUntil: date("paused_until", { mode: "string" }),
  consecutiveSilentDays: integer("consecutive_silent_days").notNull().default(0),
  toneLevel: smallint("tone_level").notNull().default(2), // lowers on silence (comment only, no CHECK)
});

/**
 * SD gives `bell_messages` no explicit PK, so the standard `id`/`createdAt`
 * pair applies. `sentAt` is kept distinct from `createdAt`: the scheduler may
 * write a message row (created) ahead of the actual send (sent), so the two
 * can differ. `repliedAt` is set in place later, hence `updatedAt`. `kind` is
 * comment-only, no CHECK.
 */
export const bellMessages = pgTable("bell_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  body: text("body").notNull(),
  kind: text("kind").notNull(), // 'nudge'|'softened'|'plain_voice' (comment only, no CHECK)
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  repliedAt: timestamp("replied_at", { withTimezone: true }),
});

/**
 * SD gives `distress_flags` no explicit PK, so the standard `id`/`createdAt`
 * pair applies. `reviewedBy` is set in place later — a human reviews the flag
 * after Bell's circuit breaker fires (CAP §12, CLAUDE.md rule 11) — hence
 * `updatedAt`. `actionTaken` is comment-only, no CHECK. `reviewedBy`
 * references `users` exactly as SD writes it.
 */
export const distressFlags = pgTable("distress_flags", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  signal: text("signal").notNull(),
  actionTaken: text("action_taken").notNull(), // 'persona_dropped'|'paused'|'escalated' (comment only, no CHECK)
  reviewedBy: uuid("reviewed_by").references(() => users.id),
});
