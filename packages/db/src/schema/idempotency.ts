/**
 * Drizzle table definitions for migration 0012 (ticket M0-BE-16).
 *
 * Mirrors `migrations/0012_idempotency_responses.sql` exactly. As in
 * `identity.ts`, `agents.ts`, `posts.ts`, `threads.ts`, `calls.ts`, `votes.ts`,
 * `diaries.ts` and `events.ts`, this file is documentation-as-types for
 * `@eutectic/db` consumers; **the SQL migration is authoritative** —
 * drizzle-kit is not wired into the runner (see `drizzle.config.ts`), so
 * nothing here shapes the database.
 *
 * NOT THE INTENDED READ SURFACE. The only writer and only reader of this table
 * is the `Idempotency-Key` middleware in `apps/api`, which drives it with
 * hand-written SQL: the claim is an `INSERT ... ON CONFLICT DO NOTHING`, and
 * the takeover of an abandoned claim is a conditional `UPDATE ... RETURNING`.
 * Both are atomic single statements whose whole purpose is that the DATABASE,
 * not the process, decides who executes. Drizzle's query builder would express
 * them, but expressing them twice is how the two drift apart; there is one
 * copy, in `apps/api/src/idempotency-store.ts`, and this file exists so a
 * consumer can see the shape and so the table is not invisible in the schema
 * namespace.
 */

import { index, pgTable, primaryKey, text, timestamp, integer } from "drizzle-orm/pg-core";

/**
 * The `Idempotency-Key` store (system-design §3, openapi.yaml
 * `components.parameters.IdempotencyKey`).
 *
 * No foreign keys, deliberately. `scope` is a principal identifier that is
 * `'anonymous'` until M0-BE-17 lands sessions and may later name a user, an
 * agent or `'system'` — a polymorphic actor reference, the same reasoning
 * `events` gives for `actorId`. A retention sweep must also be able to delete
 * rows here without consulting anything else.
 *
 * The composite primary key `(scope, idempotencyKey)` is the row's whole
 * identity; there is no surrogate `id` because nothing references this table
 * and because the claim's `ON CONFLICT (scope, idempotency_key)` needs exactly
 * this constraint. See the migration's JUDGMENT 2 for why `scope` is in the
 * key and `operationId` is not.
 *
 * The row mutates in place exactly once — `'in_progress'` → `'completed'` —
 * hence `updatedAt` (D-013), which doubles as the staleness clock for taking
 * over a claim abandoned by a crashed process.
 */
export const idempotencyResponses = pgTable(
  "idempotency_responses",
  {
    /** The principal. `'anonymous'` until M0-BE-17; then the user id. */
    scope: text("scope").notNull(),
    /** The client's header, verbatim. Length is bounded at the edge, not here. */
    idempotencyKey: text("idempotency_key").notNull(),
    /** The contract `operationId` that claimed the key. */
    operationId: text("operation_id").notNull(),
    /** sha256 hex over operation, route, params, query and canonicalised body. */
    requestFingerprint: text("request_fingerprint").notNull(),
    /** 'in_progress'|'completed' (comment only, no CHECK — D-013) */
    state: text("state").notNull(),
    /** `x-request-id` of the request holding the claim; guards the completing UPDATE. */
    claimedBy: text("claimed_by").notNull(),
    /** Set on completion, and only for an outcome that is safe to replay. */
    responseStatus: integer("response_status"),
    /** Null for a `204`, which declares no body and no type. */
    responseContentType: text("response_content_type"),
    /**
     * The already-serialised payload, stored as text so a replay is byte for
     * byte the original. See the migration's JUDGMENT 3 for why not `jsonb`.
     */
    responseBody: text("response_body"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "idempotency_responses_pkey",
      columns: [table.scope, table.idempotencyKey],
    }),
    // The retention sweep's only access path (a later ticket, see the
    // migration header). Not a request-path index.
    index("idempotency_responses_created_at_idx").on(table.createdAt),
  ],
);
