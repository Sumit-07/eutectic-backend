/**
 * Cached entitlement resolution (M0-BE-18, system-design §5, §6, §11).
 *
 * This module is the ONLY place that combines `@eutectic/db`'s pure
 * `resolveEntitlement` query with `@eutectic/cache`'s session-adjacent cache —
 * per this ticket's CTO ruling, the query itself lives in `packages/db`
 * (Postgres access is that package's job, and the worker will need the same
 * resolution later), and the cache is an `apps/api` concern.
 *
 * SCOPE, and why the cache key is the user id and NOT the session id: SD §5
 * says plainly "the read path resolves the active row once per request and
 * caches it on the session" — but a user's entitlement does not vary by
 * *which* session is asking (system-design §11: `entitlements` is a property
 * of the user, closed and reopened by the Dodo webhook, never per-device or
 * per-cookie). Keying by session id would mean two tabs of the same user pay
 * two independent cache misses and, worse, could show two different plans for
 * a few seconds after a webhook lands depending on which session's cache
 * happened to be warm. Keying by user id makes one entitlement change visible
 * to every session for that user at once, bounded by the same TTL.
 *
 * RULE 9 ("premium never buys reach", CLAUDE.md rule 9 / SD §16 invariant 8):
 * this module — like `@eutectic/db`'s `resolveEntitlement` — must never be
 * reachable from ranking/feed code. See `rank-score-entitlement-guard.test.ts`
 * in this directory for the CI-able seed of that invariant.
 *
 * INVALIDATION — explicit bust, no pubsub subscriber. `@eutectic/cache`
 * deliberately has no pub/sub (its whole surface is get/set/del/incr/limiter —
 * loss-tolerant primitives, not a message bus; see packages/cache's module
 * doc). Wiring a Redis Invalidate-on-`entitlement.changed` subscriber here
 * would be the first pub/sub consumer in the codebase and would need its own
 * loss-tolerance story (a dropped pub/sub message is silent and permanent,
 * unlike a `get` miss). Instead: whoever writes a new entitlements row MUST
 * call `bustEntitlement(cache, userId)` in the same request that emits
 * `entitlement.changed` (system-design §11 — the Dodo webhook handler, a
 * later ticket). The trade this accepts: a bust that is missed or reordered
 * relative to the write leaves a stale cached value for at most
 * `ENTITLEMENT_CACHE_TTL_SECONDS` (<=60s) — bounded staleness, never
 * unbounded, which is exactly D-001's "Redis degrades latency/staleness,
 * never correctness" posture applied to this one value. A user who just paid
 * can wait up to 60s to see `guaranteed_pickup` flip; nothing about ranking,
 * budget, or money hinges on the entitlement read being instant.
 */

import { resolveEntitlement, type EntitlementRow, type Sql } from "@eutectic/db";
import type { NamespacedCache } from "@eutectic/cache";

/** TTL ceiling this ticket's acceptance criterion sets: "<= 60s". */
export const ENTITLEMENT_CACHE_TTL_SECONDS = 60;

/**
 * The free-plan defaults used when no `entitlements` row is active for a
 * user (system-design §5's DDL has no NOT NULL default clause for these
 * columns other than `residencies_allowed`, so "no row" needs an explicit
 * fallback rather than one the schema hands us for free).
 *
 * VALUES ARE PRODUCT POLICY, not test fixtures: `capabilities.md` §16 (the
 * Premium table) is the one source of truth — free tier is **5 posts/day,
 * 3 rounds/chapter, up to 4 agents/thread**. D-019 (Fable) REJECTED the
 * originally-delivered `1/1/1` values precisely because they were copied from
 * M0-BE-02's `identity.test.ts` "expired free row" fixture rather than
 * validated against the spec — a fixture is not policy, and this is the fix
 * ticket (M0-BE-23) that ratifies the correct numbers. Booleans and
 * `residenciesAllowed: 0` are unaffected by that ruling and stand as before:
 * no guarantees, no unlisting, no agent requests, no residencies on free.
 */
export const FREE_PLAN_DEFAULTS = {
  plan: "free",
  maxPostsPerDay: 5,
  maxRounds: 3,
  maxAgentResponses: 4,
  guaranteedPickup: false,
  canUnlist: false,
  canRequestAgent: false,
  residenciesAllowed: 0,
} as const;

/**
 * The row shape callers actually get back, ROWS-not-booleans as SD §5
 * requires, plus the discriminant this ticket's CTO ruling asks for so a
 * caller never has to branch on `null`: `source` says whether this came from
 * a real `entitlements` row or is the synthesized free-tier default.
 *
 * `validFrom`/`validTo` are ISO 8601 strings, not `Date` — deliberately.
 * `@eutectic/cache`'s codec is a bare `JSON.stringify`/`JSON.parse` (no
 * reviver): a `Date` survives `encode()` (dates serialize to an ISO string)
 * but does NOT survive `decode()` (JSON.parse never reconstructs a `Date`), so
 * a value that came from `resolveEntitlement` fresh and a value that came back
 * from the cache would otherwise disagree on the *type* of the exact same
 * field. Converting once, here, at the boundary means every caller — cache hit
 * or cache miss — gets the identical shape.
 */
export interface ResolvedEntitlement {
  readonly source: "row" | "free-default";
  readonly userId: string;
  readonly plan: string;
  readonly maxPostsPerDay: number;
  readonly maxRounds: number;
  readonly maxAgentResponses: number;
  readonly guaranteedPickup: boolean;
  readonly canUnlist: boolean;
  readonly canRequestAgent: boolean;
  readonly residenciesAllowed: number;
  /** ISO 8601. `null` only when `source` is `"free-default"` (there is no row). */
  readonly validFrom: string | null;
  /** ISO 8601, or `null` for an open-ended row or a synthetic free-default. */
  readonly validTo: string | null;
}

function fromRow(row: EntitlementRow): ResolvedEntitlement {
  return {
    source: "row",
    userId: row.userId,
    plan: row.plan,
    maxPostsPerDay: row.maxPostsPerDay,
    maxRounds: row.maxRounds,
    maxAgentResponses: row.maxAgentResponses,
    guaranteedPickup: row.guaranteedPickup,
    canUnlist: row.canUnlist,
    canRequestAgent: row.canRequestAgent,
    residenciesAllowed: row.residenciesAllowed,
    validFrom: row.validFrom.toISOString(),
    validTo: row.validTo === null ? null : row.validTo.toISOString(),
  };
}

function freeDefault(userId: string): ResolvedEntitlement {
  return {
    source: "free-default",
    userId,
    ...FREE_PLAN_DEFAULTS,
    validFrom: null,
    validTo: null,
  };
}

/**
 * Resolve `userId`'s active entitlement at `now`, through the cache.
 *
 * `cache` is expected to already be the `entitlement` view — i.e. the caller
 * passes `rootCache.namespace("entitlement")`, not the root cache — so this
 * module never hardcodes the namespace string and a caller composing several
 * namespaces (session id, tenant, whatever a later ticket needs) stays in
 * charge of that composition. The cache KEY under that namespace is bare
 * `userId`: user-scoped, not session-scoped (see the module doc comment).
 *
 * Cache miss or a Redis outage (indistinguishable at this call's boundary —
 * `NamespacedCache.get` returns `undefined` for both, by `@eutectic/cache`'s
 * design) falls through to `resolveEntitlement` every time: the loss-tolerance
 * invariant holds by construction, with no special-casing in this function.
 */
export async function resolveEntitlementCached(
  sql: Sql,
  cache: NamespacedCache,
  userId: string,
  now: Date,
): Promise<ResolvedEntitlement> {
  const cached = await cache.get<ResolvedEntitlement>(userId);
  if (cached !== undefined) return cached;

  const row = await resolveEntitlement(sql, userId, now);
  const resolved = row === null ? freeDefault(userId) : fromRow(row);

  // Fire-and-degrade by construction: `NamespacedCache.set` already never
  // throws (packages/cache's invariant), so a failed write here is silently
  // "next call misses again and re-resolves from Postgres" — never an error
  // surfaced to this function's caller.
  await cache.set(userId, resolved, ENTITLEMENT_CACHE_TTL_SECONDS);

  return resolved;
}

/**
 * Explicit cache bust. The entitlement WRITER (the Dodo webhook handler,
 * system-design §11 — a later ticket) MUST call this, under the same
 * `cache.namespace("entitlement")` view, immediately after it writes the new
 * `entitlements` row and in the same request that emits `entitlement.changed`.
 * There is no subscriber wired to that event — see the module doc comment for
 * why, and for the bounded-staleness trade a missed call accepts.
 */
export async function bustEntitlement(cache: NamespacedCache, userId: string): Promise<void> {
  await cache.del(userId);
}
