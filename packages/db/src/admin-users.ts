/**
 * The admin view of a `users` row (P-09, D-029, DIRECTIVE §5).
 *
 * A pure Postgres query, exactly like `./entitlements.ts`: no cache, no clock
 * read, no HTTP concern, and no wire shape. `apps/api`'s
 * `serializers/user.ts` owns the wire shape and is the only thing that builds
 * it; this function owns the SELECT.
 *
 * WHY THIS QUERY LIVES IN `packages/db` AND NOT IN THE HANDLER, which is the
 * one genuinely surprising thing about this file:
 *
 * P-02-BE shut the admin door with a guard in `user-serializer.test.ts` that
 * walks every production source under `apps/api/src` and fails if any of them
 * so much as SPELLS a GitHub-derived field name (`/github[_A-Z]/`). That guard
 * is doing exactly its job: a handler that writes `github_created_at` is a
 * handler assembling a user payload by hand, which is how the fingerprint
 * leaks. But a `SELECT` naming those columns trips it too — and weakening the
 * guard to let one handler through would retire the invariant to make room for
 * the first route that needs it, which is precisely backwards.
 *
 * So the column names stay on this side of the package boundary, where they
 * have always belonged (system-design §2: `packages/db` owns Postgres access),
 * and `apps/api` handles a camelCase record it passes straight to the
 * serializer without naming a single field. The guard keeps its full strength
 * and the admin route still works. Same split, and the same reasoning, as
 * `resolveEntitlement` versus `apps/api`'s cached wrapper.
 *
 * D-029 REMINDER: everything this function returns is admin-only, forever.
 * It has exactly one caller — `apps/api/src/admin/handlers.ts` — and the
 * contract makes `AdminUser` reachable from exactly one operation (D-040).
 */

import type { ISql } from "postgres";

/**
 * The admin-only projection of a user, camelCased.
 *
 * Structurally identical to `apps/api`'s `AdminUserRecord`, and deliberately
 * declared here rather than imported from there — the dependency runs one way
 * (`apps/api` depends on `@eutectic/db`, never the reverse), and P-02-BE's
 * serializer takes a structural input for exactly this reason: "any object
 * with these fields satisfies it".
 */
export interface AdminUserRow {
  readonly id: string;
  readonly handle: string;
  readonly tier: number;
  /** `users.created_at` — the PLATFORM join date, never the GitHub one. */
  readonly createdAt: Date;
  /** `users.deleted_at`. Null for a live account; a tombstoned user is still returned. */
  readonly deletedAt: Date | null;
  readonly githubLogin: string;
  readonly githubId: number;
  readonly githubCreatedAt: Date;
  readonly githubPublicRepos: number;
  /** See {@link findAdminUser} on the NULL fallback. */
  readonly tierWouldBe: number;
  readonly showGithubLogin: boolean;
}

/** The raw column shape postgres.js hands back — snake_case, as the DDL names them. */
interface AdminUserRowSql {
  id: string;
  handle: string;
  tier: number;
  created_at: Date;
  deleted_at: Date | null;
  login: string;
  external_id: string | number;
  external_created_at: Date;
  public_repos: number;
  tier_would_be: number | null;
  show_login: boolean;
}

/**
 * One user by id, tombstoned or not, or `null` if the id has never existed.
 *
 * TOMBSTONES ARE RETURNED, NOT HIDDEN. `WHERE deleted_at IS NULL` is
 * conspicuously absent and that is the whole point of the admin route: D-040
 * and the contract both say this route "DOES return tombstoned users with
 * `deleted: true` — admins see the record. `404` means the id has never
 * existed." Moderation attaches to an account that no longer posts.
 *
 * `tier_would_be` IS NULLABLE IN THE SCHEMA AND REQUIRED ON THE WIRE, which
 * needs a decision and this is it: `COALESCE(tier_would_be, tier)`. Migration
 * 0013's own comment says the column is "Null until the first login after
 * P-09" — every row seeded or created before the login path computes it is
 * NULL — while `AdminUser.tier_would_be` is a required `integer 0..3`. The
 * alternatives were worse: `0` is an active claim that the gate would demote
 * this user, which is a statement nobody has made; and widening the contract
 * to allow null is a shared-package change this ticket does not own. Falling
 * back to the user's ACTUAL tier says the only true thing available — "no gate
 * opinion has been recorded for this account" — and it is self-correcting: the
 * fallback stops firing for a row the moment its owner next logs in.
 *
 * `github_id` is `bigint`, which postgres.js returns as a STRING rather than
 * risk a precision loss it cannot detect. It is coerced here and checked
 * against `Number.isSafeInteger`, so a real GitHub id (nine digits today, and
 * ~2^53 away from trouble) arrives as the `integer` the contract declares
 * rather than as a string that would fail the client's schema at the boundary.
 */
export async function findAdminUser(sql: ISql, userId: string): Promise<AdminUserRow | null> {
  const rows = await sql<AdminUserRowSql[]>`
    SELECT id,
           handle,
           tier,
           created_at,
           deleted_at,
           github_login       AS login,
           github_id          AS external_id,
           github_created_at  AS external_created_at,
           github_public_repos AS public_repos,
           coalesce(tier_would_be, tier) AS tier_would_be,
           show_github_login  AS show_login
    FROM users
    WHERE id = ${userId}
  `;

  const row = rows[0];
  if (row === undefined) return null;

  const externalId = Number(row.external_id);
  if (!Number.isSafeInteger(externalId)) {
    // Loud rather than lossy. A value this function cannot represent as the
    // contract's `integer` is a value it must not guess at.
    throw new TypeError(`user ${row.id} has an unrepresentable external account id`);
  }

  return {
    id: row.id,
    handle: row.handle,
    tier: row.tier,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
    githubLogin: row.login,
    githubId: externalId,
    githubCreatedAt: row.external_created_at,
    githubPublicRepos: row.public_repos,
    // `coalesce` above guarantees non-null, but the driver's type does not
    // know that; `?? row.tier` is the same fallback stated twice rather than
    // a non-null assertion that would silently become a lie if the SELECT
    // were edited.
    tierWouldBe: row.tier_would_be ?? row.tier,
    showGithubLogin: row.show_login,
  };
}
