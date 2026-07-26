/**
 * Entitlement resolution (M0-BE-18, system-design §5, §6, §11).
 *
 * A pure Postgres query and nothing else: no cache, no clock read, no HTTP
 * concern. `now` is an explicit parameter (D-014's discipline, restated by
 * this ticket's CTO ruling) — this module never calls `Date.now()` or `now()`
 * as a bare SQL default; the caller supplies the instant to resolve against,
 * so the same function is trivially testable and trivially reusable by the
 * worker later (SD §7's turn context will need the same resolution).
 *
 * `packages/db` owns Postgres access (system-design §2) and this function
 * lives here — not in `apps/api` — for exactly that reason: the cached
 * wrapper is an `apps/api` concern (session-adjacent), the query itself is
 * not. `packages/db` must never import `@eutectic/cache` (M0-BE-19's
 * dependency-direction rule): this file has no cache import, and none of
 * `packages/db` does.
 *
 * RULE 9 — "premium never buys reach" (system-design §16 invariant 8,
 * CLAUDE.md rule 9): this module, and the `entitlements` table it reads, must
 * never be reachable from ranking/feed code. `apps/api`'s
 * `rank-score-entitlement-guard.test.ts` is the CI-able seed of that
 * invariant; nothing in this file changes that guard's premise (this module
 * has zero callers today outside its own test and the BE-18 apps/api wrapper).
 */

import type { ISql } from "postgres";

/**
 * The `entitlements` row shape (system-design §5), camelCased. Every field the
 * table has, because SD §5's read path resolves "the entitlement row", not a
 * projection of it — callers decide which fields they need, this module does
 * not pre-guess.
 */
export interface EntitlementRow {
  readonly id: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly userId: string;
  readonly plan: string;
  readonly maxPostsPerDay: number;
  readonly maxRounds: number;
  readonly maxAgentResponses: number;
  readonly guaranteedPickup: boolean;
  readonly canUnlist: boolean;
  readonly canRequestAgent: boolean;
  readonly residenciesAllowed: number;
  readonly validFrom: Date;
  readonly validTo: Date | null;
}

/** The raw column shape postgres.js hands back — snake_case, as the DDL names them. */
interface EntitlementRowSql {
  id: string;
  created_at: Date;
  updated_at: Date;
  user_id: string;
  plan: string;
  max_posts_per_day: number;
  max_rounds: number;
  max_agent_responses: number;
  guaranteed_pickup: boolean;
  can_unlist: boolean;
  can_request_agent: boolean;
  residencies_allowed: number;
  valid_from: Date;
  valid_to: Date | null;
}

function toEntitlementRow(row: EntitlementRowSql): EntitlementRow {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    userId: row.user_id,
    plan: row.plan,
    maxPostsPerDay: row.max_posts_per_day,
    maxRounds: row.max_rounds,
    maxAgentResponses: row.max_agent_responses,
    guaranteedPickup: row.guaranteed_pickup,
    canUnlist: row.can_unlist,
    canRequestAgent: row.can_request_agent,
    residenciesAllowed: row.residencies_allowed,
    validFrom: row.valid_from,
    validTo: row.valid_to,
  };
}

/**
 * Resolve the active entitlement row for `userId` at `now`.
 *
 * Active = `valid_from <= now < coalesce(valid_to, 'infinity')`, newest
 * `valid_from` wins (ticket acceptance, verbatim). Written with the explicit
 * `coalesce(..., 'infinity')` form rather than `valid_to IS NULL OR valid_to >
 * now` because that is the acceptance criterion's own wording and the two are
 * exactly equivalent for a `timestamptz` column — Postgres's `'infinity'`
 * literal compares greater than any finite timestamp.
 *
 * Returns `null` when no row is active — a synthetic free-plan default is an
 * `apps/api` concern (this ticket's free-plan constants), never this
 * module's: a pure query returns exactly what the table has, or nothing.
 *
 * `sql` is typed as `ISql` — the interface `Sql` (the pool) and
 * `TransactionSql` (a `sql.begin(...)` handle) both extend, and the only part
 * of either this function actually uses (the tagged-template query call). That
 * makes this callable with the pool directly (apps/api's cached wrapper) or
 * from inside a larger transaction later (e.g. a turn-context assembly)
 * without a second code path.
 */
export async function resolveEntitlement(
  sql: ISql,
  userId: string,
  now: Date,
): Promise<EntitlementRow | null> {
  const rows = await sql<EntitlementRowSql[]>`
    SELECT id, created_at, updated_at, user_id, plan, max_posts_per_day,
           max_rounds, max_agent_responses, guaranteed_pickup, can_unlist,
           can_request_agent, residencies_allowed, valid_from, valid_to
    FROM entitlements
    WHERE user_id = ${userId}
      AND valid_from <= ${now}
      AND ${now} < coalesce(valid_to, 'infinity'::timestamptz)
    ORDER BY valid_from DESC
    LIMIT 1
  `;

  const row = rows[0];
  return row === undefined ? null : toEntitlementRow(row);
}
