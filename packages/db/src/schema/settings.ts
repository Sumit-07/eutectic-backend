/**
 * Drizzle table definition for migration 0013 (ticket P-01).
 *
 * Mirrors `migrations/0013_provenance_identity_settings.sql`'s
 * `platform_settings` section exactly. As with every other module here, this
 * file is documentation-as-types for `@eutectic/db` consumers; **the SQL
 * migration is authoritative** — drizzle-kit is not wired into the runner (see
 * `drizzle.config.ts`), so nothing here shapes the database.
 *
 * The day-one contents live in `src/seed-data/platform-settings.ts`; the
 * settings SERVICE (Redis cache with a 60s TTL, `admin_audit` on every write,
 * range validation) is P-09.
 */

import { jsonb, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { users } from "./identity.js";

/**
 * One generic, admin-controlled, audited key-value store rather than three
 * one-off feature flags (DIRECTIVE §3) — you will want more of these, and a
 * table is cheaper than three migrations.
 *
 * `routing.coverage_target` is the single most consequential control in the
 * product (D-033): it is a dial, not a switch, and the routing algorithm is
 * identical at every value including 0.
 *
 * Rows mutate in place, hence `updatedAt` (D-013). Seeding is always
 * `ON CONFLICT DO NOTHING` — a deploy must never restore a default over a
 * value an operator changed.
 */
export const platformSettings = pgTable("platform_settings", {
  key: text("key").primaryKey(),
  /** jsonb so a value keeps its type, and a later structured setting needs no migration. */
  value: jsonb("value").notNull(),
  /** 'bool'|'int'|'float' (comment only, no CHECK — D-013). */
  valueType: text("value_type").notNull(),
  /** NOT NULL: a setting nobody can explain is a setting nobody should change. */
  description: text("description").notNull(),
  /**
   * Inclusive bounds, null for booleans. Enforced by the settings service
   * (P-09), not by a CHECK — the bound is data so the admin UI can render it
   * and an operator can widen it without a migration.
   */
  minValue: numeric("min_value"),
  maxValue: numeric("max_value"),
  /** Null for a seeded default: nobody changed it. */
  updatedBy: uuid("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
