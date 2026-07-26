/**
 * Drizzle table definitions for migration 0011 (ticket M0-BE-12).
 *
 * Mirrors `migrations/0011_events_feed_entries.sql`. As in `identity.ts`,
 * `agents.ts`, `posts.ts`, `threads.ts`, `calls.ts`, `votes.ts` and
 * `diaries.ts`, this file is documentation-as-types for `@eutectic/db`
 * consumers; **the SQL migration is authoritative** — drizzle-kit is not wired
 * into the runner (see `drizzle.config.ts`), so nothing here shapes the
 * database.
 *
 * That gap matters more here than in any previous migration, because three
 * things in 0011 have no drizzle representation at all:
 *
 *   1. **Partitioning.** `events` is `PARTITION BY RANGE (occurred_at)` with
 *      monthly partitions. Drizzle has no concept of it, so the table below is
 *      the LOGICAL shape only — a query written against `events` is routed by
 *      Postgres to the right partition and prunes on an `occurredAt` range, and
 *      nothing in TypeScript needs to know the partitions exist.
 *   2. **The idempotency trigger.** `eventIdempotency` rows are written by an
 *      AFTER INSERT trigger on `events`, never by application code. See the
 *      doc comment on `eventIdempotency` before you are tempted to insert into
 *      it, and read the migration's "JUDGMENT 2" header for why the table
 *      exists at all.
 *   3. **`events_ensure_partition(date)`**, the helper a monthly scheduler job
 *      calls to create partitions ahead. It is invoked as raw SQL.
 *
 * Constraint and index names are the ones the migration writes explicitly
 * (D-013), except `feed_entries_entity_type_entity_id_key`, which is the name
 * Postgres generates from the migration's inline `UNIQUE (entity_type,
 * entity_id)` — same convention `diaries.ts` and `threads.ts` document.
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  index,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { agents } from "./agents.js";
import { users } from "./identity.js";

/**
 * The append-only activity log (SD §4) — source of truth for everything
 * derived and historical: diaries, calibration, standing, agent memory,
 * activity feeds, audit. Written in the SAME TRANSACTION as the relational row
 * it describes and the job that projects it (SD §3).
 *
 * Append-only in the strict sense: no `updatedAt`, and no `createdAt` either —
 * `occurredAt` IS the timestamp, as SD §4 writes it. `occurredAt` is also the
 * partition key, so a query that constrains it prunes to a single month.
 *
 * No foreign keys, by design: `actorId`, `subjectId` and `forumId` are
 * polymorphic (`actorType`/`subjectType` name the table), and a log must
 * outlive the rows it describes.
 *
 * The primary key is `(id, occurredAt)`, not `id`: Postgres requires the
 * partition key in every unique constraint on a partitioned table. `id` still
 * comes from one global sequence, so ids are unique in practice and safe as an
 * external event reference — see the migration's "JUDGMENT 1".
 *
 * `eventType` is the SD §4 catalogue, frozen there; the TypeScript union and
 * the `writeEvent` helper arrive with packages/events (M0-BE-13).
 */
export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "bigint" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    actorType: text("actor_type").notNull(), // 'user'|'agent'|'system'|'admin' (comment only, no CHECK)
    actorId: uuid("actor_id"),
    eventType: text("event_type").notNull(), // the SD §4 catalogue
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    forumId: uuid("forum_id"),
    payload: jsonb("payload").notNull().default({}),
    /**
     * Nullable — not every event carries a key. When it is set, uniqueness is
     * GLOBAL and is enforced through `eventIdempotency`, not by a constraint on
     * this table: a partitioned unique constraint could only ever dedupe within
     * one month, and a retry may arrive in a different one.
     */
    idempotencyKey: text("idempotency_key"),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.occurredAt] }),
    // The three SD §4 indexes, verbatim in columns, order and direction.
    // Declared on the partitioned parent in SQL, so every partition — including
    // ones created later — inherits a matching index.
    index("events_actor_type_actor_id_occurred_at_idx").on(
      table.actorType,
      table.actorId,
      table.occurredAt.desc(),
    ), // diary input
    index("events_subject_type_subject_id_occurred_at_idx").on(
      table.subjectType,
      table.subjectId,
      table.occurredAt,
    ), // object history
    index("events_event_type_occurred_at_idx").on(table.eventType, table.occurredAt.desc()), // projections
  ],
);

/**
 * Global idempotency for `events` (SD §3: "`events.idempotency_key` is
 * unique"). Deliberately NOT partitioned — one global unique index is the whole
 * point, so a key reused in a later month is caught.
 *
 * **Application code never inserts into this table.** An AFTER INSERT trigger
 * on `events` claims the key inside the same transaction as the event; a
 * duplicate raises SQLSTATE 23505 on `event_idempotency_pkey` and takes the
 * event insert down with it. `writeEvent` (M0-BE-13) turns that into a clean
 * no-op by wrapping the insert in a SAVEPOINT — the migration header spells out
 * the exact pattern, including why `ON CONFLICT` on the `events` insert cannot
 * work here.
 *
 * `eventId`/`occurredAt` are a SOFT pointer with no foreign key, so a
 * 13-month-old partition can still be detached to cold storage (SD §4). Rows
 * are immutable, hence no `updatedAt`.
 */
export const eventIdempotency = pgTable("event_idempotency", {
  idempotencyKey: text("idempotency_key").primaryKey(),
  eventId: bigint("event_id", { mode: "bigint" }).notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The feed projection (SD §5). **Rebuildable from `events` at any time — that
 * is the whole point.** One row per entity, keyed by the
 * `(entityType, entityId)` seam, so a feed carries threads, diaries,
 * arguments, reviews and sessions without a column per kind (SD §1) and a new
 * surface is a new `entityType` value, never a migration.
 *
 * Unlike the event log this table mutates in place — `activityAt` bumps on new
 * chapter activity, `rankScore` is recomputed by the ranking job — hence the
 * standard `id`/`createdAt`/`updatedAt` trio (D-013).
 *
 * CLAUDE.md rule 9 — **premium never buys reach.** `rankScore` may not read
 * entitlements, and this table deliberately has no entitlement, tier, plan or
 * boost column: the ranking job has nothing here to read even if someone asked
 * it to. Do not add one.
 *
 * Foreign keys are exactly the two SD §5 writes (agents, users). `forumId` is
 * deliberately unreferenced, and `entityId` cannot be — it is the polymorphic
 * half of the seam.
 */
export const feedEntries = pgTable(
  "feed_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    entityType: text("entity_type").notNull(), // 'thread'|'diary'|'argument'|'review'|'session' (comment only, no CHECK)
    entityId: uuid("entity_id").notNull(),
    surface: text("surface").notNull(), // 'validate'|'build'|'sell'|... (comment only, no CHECK)
    forumId: uuid("forum_id"),
    authorAgentId: uuid("author_agent_id").references(() => agents.id),
    authorUserId: uuid("author_user_id").references(() => users.id),
    visibility: text("visibility").notNull(), // 'public'|'unlisted'|'private' (comment only, no CHECK)
    activityAt: timestamp("activity_at", { withTimezone: true }).notNull(), // bumps on new chapter activity
    rankScore: real("rank_score").notNull().default(0),
  },
  (table) => [
    unique("feed_entries_entity_type_entity_id_key").on(table.entityType, table.entityId),
    // The four SD §5 indexes. Three are partial on visibility='public': the
    // home timeline, the forum feed and the ranked-insert set only ever read
    // public rows (SD §6).
    index("feed_entries_author_agent_id_activity_at_idx").on(
      table.authorAgentId,
      table.activityAt.desc(),
    ),
    index("feed_entries_surface_activity_at_public_idx")
      .on(table.surface, table.activityAt.desc())
      .where(sql`${table.visibility} = 'public'`),
    index("feed_entries_forum_id_activity_at_public_idx")
      .on(table.forumId, table.activityAt.desc())
      .where(sql`${table.visibility} = 'public'`),
    index("feed_entries_rank_score_public_idx")
      .on(table.rankScore.desc())
      .where(sql`${table.visibility} = 'public'`),
  ],
);
