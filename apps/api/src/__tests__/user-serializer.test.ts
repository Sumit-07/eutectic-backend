/**
 * The other half of the D-029 one-way door (P-02-BE).
 *
 * `github-leak-gate.test.ts` proves the CONTRACT cannot describe a leak.
 * This file proves the SERVER cannot build one: every fixture is checked
 * byte-for-byte against the object the wire should carry, and then swept again
 * for any forbidden key at any depth, so a field added by a future edit has to
 * get past both an exact-match assertion and a structural sweep.
 *
 * No database, no Redis, no network — pure functions and fixtures. This runs
 * in the fast pipeline next to the gate.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  serializeAdminUser,
  serializePublicUser,
  type AdminUserRecord,
  type PublicUserRecord,
} from "../serializers/user.js";
import { FORBIDDEN_IDENTITY_FIELDS, forbiddenKeysIn } from "./identity-fields.js";

/** At runtime this file is `apps/api/dist/__tests__/…`; two levels up is `apps/api/`. */
const API_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const JOINED = new Date("2026-06-12T00:00:00.000Z");

/**
 * A row-shaped fixture. Typed as `PublicUserRecord` through a variable rather
 * than inline, so the extra `githubCreatedAt` below is legal — that is the
 * point: a real row carries fingerprint columns, and the serializer must not
 * be able to see them.
 */
const optedIn: PublicUserRecord = {
  id: "2b6a2c8e-9f43-4a15-8f1e-5c0f9a3d7b21",
  handle: "mira",
  tier: 2,
  createdAt: JOINED,
  deletedAt: null,
  githubLogin: "mira-k",
  showGithubLogin: true,
};

const optedOut: PublicUserRecord = { ...optedIn, showGithubLogin: false };

/** The column P-01 adds is not selected: fail closed, not open. */
const flagMissing: PublicUserRecord = {
  id: optedIn.id,
  handle: optedIn.handle,
  tier: optedIn.tier,
  createdAt: JOINED,
  githubLogin: "mira-k",
};

const tombstoned: PublicUserRecord = {
  ...optedIn,
  deletedAt: new Date("2026-07-20T11:30:00.000Z"),
};

describe("serializePublicUser — exactly PublicUser, and nothing else", () => {
  it("serializes an opted-in user", () => {
    assert.deepStrictEqual(serializePublicUser(optedIn), {
      id: "2b6a2c8e-9f43-4a15-8f1e-5c0f9a3d7b21",
      handle: "mira",
      tier: 2,
      joined_at: "2026-06-12T00:00:00.000Z",
      deleted: false,
      github_login: "mira-k",
    });
  });

  it("serializes an opted-out user with github_login null, not absent", () => {
    // The contract calls absent and null the same statement; ONE
    // representation is chosen (D-029 note in serializers/user.ts) and pinned
    // here, so the output shape never varies between users.
    const wire = serializePublicUser(optedOut);
    assert.deepStrictEqual(wire, {
      id: optedIn.id,
      handle: "mira",
      tier: 2,
      joined_at: "2026-06-12T00:00:00.000Z",
      deleted: false,
      github_login: null,
    });
    assert.ok("github_login" in wire, "the key is always present");
  });

  it("publishes nothing when the opt-in flag was not selected", () => {
    assert.equal(serializePublicUser(flagMissing).github_login, null);
  });

  it("renders a tombstoned user as closed, and revokes the opt-in", () => {
    // "Tombstoned users render as 'account closed', never 404" (PublicUser's
    // description). `deleted` is the machine-readable form of that sentence;
    // the handle stays because `Handle`'s pattern cannot hold the words and
    // DIRECTIVE §9 wants links not to rot. Consent, however, does not survive
    // the account: github_login goes null even though the user opted in.
    assert.deepStrictEqual(serializePublicUser(tombstoned), {
      id: optedIn.id,
      handle: "mira",
      tier: 2,
      joined_at: "2026-06-12T00:00:00.000Z",
      deleted: true,
      github_login: null,
    });
  });

  it("uses the PLATFORM join date even when the row carries a GitHub one", () => {
    const row = {
      ...optedIn,
      githubCreatedAt: new Date("2014-03-02T00:00:00.000Z"),
      githubPublicRepos: 41,
      githubId: 99887766,
      tierWouldBe: 3,
      email: "mira@example.com",
    };
    const wire = serializePublicUser(row);
    assert.equal(wire.joined_at, "2026-06-12T00:00:00.000Z");
    assert.deepStrictEqual(forbiddenKeysIn(wire), []);
  });

  it("accepts a string timestamp and normalises it", () => {
    assert.equal(
      serializePublicUser({ ...optedIn, createdAt: "2026-06-12T00:00:00Z" }).joined_at,
      "2026-06-12T00:00:00.000Z",
    );
  });

  it("throws on an unusable timestamp rather than emitting one", () => {
    assert.throws(
      () => serializePublicUser({ ...optedIn, createdAt: "not a date" }),
      /createdAt is not a valid timestamp/,
    );
  });

  it("emits exactly the contract's key set, for every fixture", () => {
    for (const record of [optedIn, optedOut, flagMissing, tombstoned]) {
      assert.deepStrictEqual(Object.keys(serializePublicUser(record)).sort(), [
        "deleted",
        "github_login",
        "handle",
        "id",
        "joined_at",
        "tier",
      ]);
    }
  });

  it("never emits a forbidden field, at any depth, for any fixture", () => {
    for (const record of [optedIn, optedOut, flagMissing, tombstoned]) {
      assert.deepStrictEqual(
        forbiddenKeysIn(serializePublicUser(record)),
        [],
        `${record.handle} leaked a GitHub-derived field (D-029)`,
      );
    }
  });
});

describe("serializeAdminUser — the admin shape, exactly", () => {
  const adminRecord: AdminUserRecord = {
    ...optedIn,
    githubLogin: "mira-k",
    githubId: 99887766,
    githubCreatedAt: new Date("2014-03-02T00:00:00.000Z"),
    githubPublicRepos: 41,
    tierWouldBe: 3,
  };

  it("serializes every admin field", () => {
    assert.deepStrictEqual(serializeAdminUser(adminRecord), {
      id: "2b6a2c8e-9f43-4a15-8f1e-5c0f9a3d7b21",
      handle: "mira",
      tier: 2,
      joined_at: "2026-06-12T00:00:00.000Z",
      deleted: false,
      github_login: "mira-k",
      github_id: 99887766,
      github_created_at: "2014-03-02T00:00:00.000Z",
      github_public_repos: 41,
      tier_would_be: 3,
    });
  });

  it("shows github_login regardless of the opt-in and of deletion", () => {
    // DIRECTIVE §5: accountability is unaffected — moderation still attaches
    // to a GitHub account someone cares about.
    const closed = serializeAdminUser({
      ...adminRecord,
      showGithubLogin: false,
      deletedAt: new Date("2026-07-20T11:30:00.000Z"),
    });
    assert.equal(closed.github_login, "mira-k");
    assert.equal(closed.deleted, true);
  });

  it("carries all five forbidden names — which is the whole reason it is admin-only", () => {
    const hits = forbiddenKeysIn(serializeAdminUser(adminRecord)).map((hit) => hit.field);
    assert.deepStrictEqual(
      hits.sort(),
      ["github_created_at", "github_id", "github_public_repos", "tier_would_be"],
      "the admin shape must carry exactly the fingerprint fields (email is not a column — D-037)",
    );
    assert.ok(FORBIDDEN_IDENTITY_FIELDS.includes("email"));
  });
});

/**
 * WIRING GUARDS. The admin serializer exists and is unreachable, and the
 * public one is the single door. Both are asserted against the source tree,
 * the same way the rule-9 guard asserts a dependency direction, because a
 * reviewer cannot be expected to notice a new import in a diff forever.
 */
describe("the serializers are the only door, and the admin door is shut", () => {
  const SKIP_DIRS: ReadonlySet<string> = new Set(["__tests__", "node_modules", "dist"]);
  const SERIALIZER = join("serializers", "user.ts");

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...sourceFiles(path));
      else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(path);
    }
    return out;
  }

  const productionSources = sourceFiles(join(API_ROOT, "src")).filter(
    (path) => !path.endsWith(SERIALIZER),
  );

  it("has production sources to check (the walk is not empty)", () => {
    assert.ok(productionSources.length >= 10, `only ${productionSources.length} files walked`);
    assert.ok(productionSources.some((path) => path.endsWith("routes.ts")));
    assert.ok(productionSources.some((path) => path.endsWith("handlers.ts")));
  });

  it("no route or handler reaches for the admin serializer (P-09 wires it, deliberately)", () => {
    const offenders = productionSources.filter((path) =>
      readFileSync(path, "utf8").includes("serializeAdminUser"),
    );
    assert.deepStrictEqual(
      offenders,
      [],
      "the admin serializer became reachable outside /v1/admin/* — that is a ticket with a " +
        "reviewer attached (P-09), not an import",
    );
  });

  it("no other module mentions a GitHub-derived field name", () => {
    // If a handler starts spelling `github_login` itself, it is building a
    // user payload by hand — which is exactly what this module exists to
    // prevent, whether or not the payload happens to be correct today.
    const offenders = productionSources.filter((path) => /github[_A-Z]/.test(readFileSync(path, "utf8")));
    assert.deepStrictEqual(offenders, [], "a user payload is being assembled outside the serializer");
  });
});

/**
 * The `Exact<>` proof in `serializers/user.ts` is checked by `tsc`, so it
 * cannot be demonstrated by a runtime assertion. It CAN be demonstrated that
 * the pattern is not vacuously true: each line below must FAIL to compile, and
 * `@ts-expect-error` fails the build if any of them ever starts compiling.
 *
 * The third case is the one that decided which idiom the serializer uses. The
 * house `[A] extends [B] ? [B] extends [A]` form compiles that pair clean —
 * an optional `github_id?: number` is invisible to it — which is precisely the
 * shape a leak would take.
 */
type Assert<T extends true> = T;
type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
// @ts-expect-error an extra key must make the assertion false — if this compiles, Exact<> is broken
type ExtraKeyIsNotExact = Assert<Exact<{ a: string }, { a: string; b: number }>>;
// @ts-expect-error a missing key must make it false in the other direction, too
type MissingKeyIsNotExact = Assert<Exact<{ a: string; b: number }, { a: string }>>;
// @ts-expect-error an OPTIONAL extra key must fail too — the whole reason for this idiom
type OptionalExtraKeyIsNotExact = Assert<Exact<{ a: string; b?: number }, { a: string }>>;
// @ts-expect-error required and optional are different shapes, not a formality
type OptionalityIsNotExact = Assert<Exact<{ a: string; b?: number }, { a: string; b: number }>>;
export type ExactnessProofs = [
  ExtraKeyIsNotExact,
  MissingKeyIsNotExact,
  OptionalExtraKeyIsNotExact,
  OptionalityIsNotExact,
];
