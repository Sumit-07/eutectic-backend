/**
 * Drizzle table definitions for migration 0003 (ticket M0-BE-04).
 *
 * Mirrors `migrations/0003_forums_tags_posts.sql` exactly. As in `identity.ts`,
 * this file is documentation-as-types for `@eutectic/db` consumers; **the SQL
 * migration is authoritative** — drizzle-kit is not wired into the runner (see
 * `drizzle.config.ts`), so nothing here shapes the database. Where drizzle
 * cannot express a construct natively (the `tsvector` type below), the SQL
 * remains the definition of record and this file only has to describe it well
 * enough to type a query.
 */

import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { customType, index, integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { users } from "./identity.js";

/**
 * `tsvector` has no first-class column builder in drizzle-orm 0.45, so it is
 * declared as a custom type. It is read-only in practice: the column is
 * GENERATED ALWAYS AS ... STORED, and Postgres rejects any attempt to write it.
 */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector";
  },
});

/**
 * A forum's `tonePolicy` shapes every agent response inside it. Both it and the
 * class allow-list are admin-editable, hence `updatedAt`. No CHECK constraint on
 * either: adding a tone or an agent class must not require a migration —
 * validity is enforced in the service layer (same reasoning as D-011's ink
 * ruling).
 */
export const forums = pgTable("forums", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  tonePolicy: text("tone_policy").notNull(), // 'roast' | 'plain' | 'care'
  allowedAgentClasses: text("allowed_agent_classes")
    .array()
    .notNull()
    .default(sql`'{staff,registry}'`),
});

/**
 * `canonicalTagId` is the alias seam, present day 1 (SD §5): an alias tag points
 * at the canonical tag it collapses into, and aliases are resolved on write
 * (SD §8), never at query time. Null on a canonical tag.
 */
export const tags = pgTable("tags", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  slug: text("slug").notNull().unique(),
  canonicalTagId: uuid("canonical_tag_id").references((): AnyPgColumn => tags.id),
  postCount: integer("post_count").notNull().default(0),
});

/**
 * A post is structured, not a text box: `bodyIdea` plus the two answered fields
 * are separate columns because the composer asks separate questions and the
 * agents read them separately. `searchVector` is maintained by Postgres
 * (GENERATED ALWAYS ... STORED) — never written by the application.
 */
export const posts = pgTable(
  "posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    authorUserId: uuid("author_user_id")
      .notNull()
      .references(() => users.id),
    surface: text("surface").notNull(), // 'validate' (others later)
    forumId: uuid("forum_id")
      .notNull()
      .references(() => forums.id),
    bodyIdea: text("body_idea").notNull(), // 50-70 words, enforced in the service layer
    fieldWho: text("field_who").notNull(),
    fieldToday: text("field_today").notNull(),
    visibility: text("visibility").notNull().default("public"), // 'public' | 'unlisted'
    status: text("status").notNull().default("live"), // 'live' | 'removed'
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`to_tsvector('english', body_idea || ' ' || field_who || ' ' || field_today)`,
    ),
  },
  (table) => [index("posts_search_idx").using("gin", table.searchVector)],
);

/**
 * Max 2 tags per post is enforced in the service layer, not here. The composite
 * primary key is SD §5's — there is no surrogate `id` and no `updatedAt`, since
 * a link row is inserted or deleted, never edited.
 */
export const postTags = pgTable(
  "post_tags",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.postId, table.tagId] }),
    index("post_tags_tag_id_post_id_idx").on(table.tagId, table.postId),
  ],
);
