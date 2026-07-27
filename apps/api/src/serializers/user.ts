/**
 * The user serializers (P-02-BE, DIRECTIVE §5, D-029).
 *
 * THE RULE: this module is the ONLY place a user row becomes a wire object.
 * Not a convention — the point of the one-way door. A handler that assembles
 * a user payload by hand is how `github_created_at` reaches a client, and
 * `github_created_at` plus `github_public_repos` narrows a pseudonymous handle
 * to a handful of real GitHub accounts. `github-leak-gate.test.ts` proves the
 * CONTRACT can't describe such a payload; this module is what makes sure the
 * server can't build one either.
 *
 * WHY THE INPUT IS A STRUCTURAL INTERFACE, NOT THE DRIZZLE ROW TYPE
 * -------------------------------------------------------------------------
 * `users.show_github_login` is added by migration 0013 (P-01), which is in
 * flight on another branch. Importing `packages/db`'s inferred row type would
 * chain this ticket to that one and leave the opt-in untestable until it
 * merges. So the input is declared here, structurally, in the row's own
 * camelCase: any object with these fields satisfies it, including a real
 * drizzle row once P-01 lands — no change needed in this file when it does.
 * Fixtures supply the flag today.
 *
 * It also keeps the seam honest in the long run: a serializer that takes the
 * whole row takes every column that will ever be added to it, forever. This
 * one takes six named fields, and adding a seventh is a visible edit here.
 *
 * DECISIONS TAKEN IN THIS MODULE, all of them fail-closed:
 *
 *  1. `github_login` is ALWAYS PRESENT, and null when the user has not opted
 *     in. The contract says "absent and null are the same statement"; one
 *     representation is picked so the output shape is constant, and it is the
 *     one that carries the "we asked and the answer is no" signal explicitly.
 *     Pinned by test, not just by prose.
 *  2. `showGithubLogin` is OPTIONAL on the input and a missing flag reads as
 *     FALSE. A query that forgets the column publishes nothing.
 *  3. `joined_at` is the PLATFORM join date (`users.created_at`). Never
 *     `github_created_at` — which this module cannot see, because it is not
 *     on the input type at all.
 *  4. A tombstoned user (`deletedAt` set) serializes with `deleted: true` and
 *     `github_login: null` REGARDLESS of the opt-in: consent does not survive
 *     the account. The handle is kept — the contract requires it, the
 *     `Handle` pattern (`^[a-z0-9_-]{3,20}$`) cannot hold the words "account
 *     closed", and §9 wants links not to rot. "Renders as account closed" is
 *     the client's job, driven by `deleted`; the server states the fact.
 *  5. `users.handle_tombstoned` is deliberately NOT read here. It is about
 *     retiring a HANDLE, not closing an ACCOUNT, and D-037 item 4 makes
 *     reconciling it with `handle_history` P-01's job. `deleted_at` is the
 *     account-closed signal.
 */

import type { Schemas } from "@eutectic/contracts";

/**
 * What a user row must look like to be serializable. Deliberately narrow: the
 * GitHub-derived fields other than the opt-in login are not on it, so no
 * amount of editing this file can put them on the public wire.
 */
export interface PublicUserRecord {
  readonly id: string;
  readonly handle: string;
  readonly tier: number;
  /** `users.created_at` — the PLATFORM join date. */
  readonly createdAt: Date | string;
  /** `users.deleted_at`. Null/absent for a live account. */
  readonly deletedAt?: Date | string | null;
  readonly githubLogin?: string | null;
  /** `users.show_github_login` (migration 0013, P-01). Absent reads as false. */
  readonly showGithubLogin?: boolean | null;
}

/**
 * The public wire shape. Hand-written so the assertion below has something to
 * check. Not `readonly`: the assertion compares these against the generated
 * contract types byte for byte, and those are mutable.
 */
export interface PublicUserWire {
  id: string;
  handle: string;
  tier: number;
  joined_at: string;
  deleted: boolean;
  github_login?: string | null;
}

/** Everything {@link PublicUserRecord} has, plus the admin-only columns. */
export interface AdminUserRecord extends PublicUserRecord {
  readonly githubLogin: string;
  readonly githubId: number;
  readonly githubCreatedAt: Date | string;
  readonly githubPublicRepos: number;
  /** `users.tier_would_be` (migration 0013, P-01) — D-036. */
  readonly tierWouldBe: number;
}

/** The admin wire shape. Reachable only under `/v1/admin/*` (P-09). */
export interface AdminUserWire {
  id: string;
  handle: string;
  tier: number;
  joined_at: string;
  deleted: boolean;
  github_login: string;
  github_id: number;
  github_created_at: string;
  github_public_repos: number;
  tier_would_be: number;
}

/** One timestamp format on the wire, whatever the driver hands back. */
function toIsoTimestamp(value: Date | string, field: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`${field} is not a valid timestamp: ${String(value)}`);
  }
  return date.toISOString();
}

/**
 * A human, as every non-admin caller sees one. The only user shape any route
 * outside `/v1/admin/*` may return.
 */
export function serializePublicUser(record: PublicUserRecord): PublicUserWire {
  const deleted = record.deletedAt !== undefined && record.deletedAt !== null;
  const optedIn = record.showGithubLogin === true;
  const login = record.githubLogin ?? null;
  return {
    id: record.id,
    handle: record.handle,
    tier: record.tier,
    joined_at: toIsoTimestamp(record.createdAt, "createdAt"),
    deleted,
    github_login: optedIn && !deleted ? login : null,
  };
}

/**
 * The admin view. NOT WIRED TO ANYTHING: no route imports this, and
 * `user-serializer.test.ts` has a guard that fails if one starts to. The
 * `/v1/admin/*` routes land with P-09, and wiring this up is meant to be a
 * deliberate act with a reviewer attached.
 *
 * `github_login` is shown regardless of the opt-in and regardless of deletion
 * — DIRECTIVE §5: "moderation still attaches to a GitHub account someone
 * cares about". That is exactly why the shape is admin-only.
 */
export function serializeAdminUser(record: AdminUserRecord): AdminUserWire {
  return {
    id: record.id,
    handle: record.handle,
    tier: record.tier,
    joined_at: toIsoTimestamp(record.createdAt, "createdAt"),
    deleted: record.deletedAt !== undefined && record.deletedAt !== null,
    github_login: record.githubLogin,
    github_id: record.githubId,
    github_created_at: toIsoTimestamp(record.githubCreatedAt, "githubCreatedAt"),
    github_public_repos: record.githubPublicRepos,
    tier_would_be: record.tierWouldBe,
  };
}

/**
 * COMPILE-TIME SHAPE PROOF. The wire types above must be EXACTLY the contract's
 * — not merely assignable to them. Checked by `tsc`, so they hold in `build`,
 * `typecheck` and CI even if nobody runs a test.
 *
 * WHY NOT THE HOUSE `[A] extends [B] ? [B] extends [A]` IDIOM
 * -------------------------------------------------------------------------
 * That form is right for `handlers.ts`' `RegistryCoversContract`, where both
 * sides are key unions. Over OBJECT types it has a hole this ticket cannot
 * afford: an OPTIONAL extra property is invisible to it, because
 * `{ id: string; github_id?: number }` and `{ id: string }` are assignable in
 * both directions. `Assert<HouseExact<…>>` on exactly that pair compiles
 * clean — so a leak added as `github_id?: number` would pass. The
 * identical-type form below (two generic signatures are the same type only if
 * their conditionals resolve identically) sees optionality, and is the reason
 * the wire interfaces above are not `readonly`: it sees that too, and the
 * generated types are mutable.
 */
type Assert<T extends true> = T;
type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

type PublicWireIsContractShape = Assert<Exact<PublicUserWire, Schemas["PublicUser"]>>;
type AdminWireIsContractShape = Assert<Exact<AdminUserWire, Schemas["AdminUser"]>>;
type PublicSerializerReturnsContractShape = Assert<
  Exact<ReturnType<typeof serializePublicUser>, Schemas["PublicUser"]>
>;
type AdminSerializerReturnsContractShape = Assert<
  Exact<ReturnType<typeof serializeAdminUser>, Schemas["AdminUser"]>
>;

export type UserSerializerTypeAssertions = [
  PublicWireIsContractShape,
  AdminWireIsContractShape,
  PublicSerializerReturnsContractShape,
  AdminSerializerReturnsContractShape,
];
