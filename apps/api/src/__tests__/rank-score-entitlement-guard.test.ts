/**
 * RULE 9 SEED TEST — "premium never buys reach" (CLAUDE.md rule 9;
 * system-design §16 invariant 8: "`rank_score` may not read from
 * `entitlements`. Enforce with a test."). This is that test's seed, built by
 * M0-BE-18 alongside the entitlement module it guards.
 *
 * A dependency-direction guard: no ranking/feed source file anywhere in this
 * repo (`eutectic-backend`'s `apps/` and `packages/` SOURCE directories) may
 * import an entitlement module. Modeled directly on
 * `packages/db/src/__tests__/jsonb-double-encode-guard.test.ts` — a plain
 * `node:fs` walk, deliberately dependency-free: no database connection, no
 * Redis, so it runs even when both are down and never gets slower as the
 * schema grows.
 *
 * THE RANKING/FEED MATCHER — a NAMED, DOCUMENTED list, extended by future
 * tickets and by nothing else (do not loosen this by editing the matching
 * function itself; add a marker below with a comment citing the ticket that
 * needed it):
 *
 *   - "rank"       — SD §7's `route.candidates` scorer (`score(agent) = ...`),
 *                     and any future `rank_score`-adjacent module
 *   - "feed"       — SD §5's `feed_entries` projection and SD §6's home-feed
 *                     read path
 *   - "projection" — the job registry's `projection.contribution` and any
 *                     sibling projection handler that writes/reads
 *                     `feed_entries.rank_score`
 *
 * Today (M0) there is no ranking or feed code anywhere in the repo — SD §15
 * phase 1 (`calls, checkpoints, calibration`) hasn't shipped routing yet, and
 * `feed_entries` has no reader or writer beyond its migration. So this guard
 * asserts TWO things, not one: (a) zero violations against the real repo right
 * now, and (b) the matcher and the import-detector actually catch a violation
 * when one exists — proven against a throwaway fixture tree this test creates
 * and deletes itself, so criterion (a) passing today can never be "vacuously
 * true because the pattern is broken."
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * At runtime this module is `apps/api/dist/__tests__/<this file>.js`. Four
 * directory levels up from the file's own directory (`__tests__` -> `dist` ->
 * `api` -> `apps`) is the repo root — same technique as
 * `packages/db/src/paths.ts`'s `PACKAGE_ROOT` (one level up from `dist/` to
 * the package root there; here, four levels up from `dist/__tests__/` to the
 * repo root that contains both `apps/` and `packages/`).
 */
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** Directory names never walked: build output, dependency trees, VCS/tooling internals. */
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", ".turbo", ".git", "test"]);

/** THE MATCHER. See the module doc comment — extend this array only, and only with a citing comment. */
const RANKING_PATH_MARKERS: readonly string[] = ["rank", "feed", "projection"];

/** True if `path` (file or directory name/path) looks like ranking/feed code, per {@link RANKING_PATH_MARKERS}. */
function isRankingLikePath(path: string): boolean {
  const lower = path.toLowerCase();
  return RANKING_PATH_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * Every import/require/dynamic-import specifier string found in `source`,
 * e.g. `from "../entitlements.js"` yields `../entitlements.js`. Deliberately
 * crude (a single regex over the raw text, no TS parser — same "no
 * dependency, never slower" posture as the double-encode guard) — sufficient
 * because the acceptance criterion is "match specifier substrings
 * 'entitlement'", not "understand the module graph".
 */
const IMPORT_SPECIFIER = /(?:from\s*|import\(|require\()\s*["']([^"']+)["']/g;

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(IMPORT_SPECIFIER)].map((match) => match[1] ?? "");
}

interface Violation {
  file: string;
  specifier: string;
}

/**
 * This file's own basename. Its path contains "rank" (the matcher would
 * happily flag it as ranking-like) and its self-test below deliberately
 * writes the literal text `from "../entitlements.js"` into a fixture file —
 * which means, unexcluded, this file's OWN source text contains a string
 * that looks exactly like the violation it exists to detect. Same shape as
 * `jsonb-double-encode-guard.test.ts`'s `SELF` exclusion: the file that
 * documents/exercises the forbidden pattern must never be able to trip its
 * own guard, and a future violation can't be "fixed" by editing this file
 * instead of the offending one.
 */
const SELF = "rank-score-entitlement-guard.test.ts";

/** Walk every `.ts`/`.js` file under `dir` (skipping {@link SKIP_DIR_NAMES} and {@link SELF}), returning absolute paths. */
function walkSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkSourceFiles(path));
    } else if (
      entry.isFile() &&
      entry.name !== SELF &&
      (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))
    ) {
      out.push(path);
    }
  }
  return out;
}

/**
 * The guard itself: every ranking/feed-like file under `root`'s `apps/` and
 * `packages/` directories, checked for an entitlement import. Shared between
 * the real-repo assertion and the fixture self-test so both exercises run the
 * identical logic.
 */
function findRankFeedEntitlementViolations(root: string): Violation[] {
  const violations: Violation[] = [];
  for (const topLevel of ["apps", "packages"]) {
    const topLevelDir = join(root, topLevel);
    let entries;
    try {
      entries = readdirSync(topLevelDir, { withFileTypes: true });
    } catch {
      continue; // fixture trees may not have both — that's fine
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(topLevelDir, entry.name);
      for (const file of walkSourceFiles(dir)) {
        if (!isRankingLikePath(file)) continue;
        const text = readFileSync(file, "utf8");
        for (const specifier of importSpecifiers(text)) {
          if (specifier.toLowerCase().includes("entitlement")) {
            violations.push({ file, specifier });
          }
        }
      }
    }
  }
  return violations;
}

describe("rule 9 seed — ranking/feed code must never import an entitlement module", () => {
  it("finds zero violations in the real repo today", () => {
    const violations = findRankFeedEntitlementViolations(REPO_ROOT);
    assert.deepEqual(
      violations,
      [],
      "premium must never buy reach (CLAUDE.md rule 9 / SD §16 invariant 8) — a ranking/feed " +
        "file imported an entitlement module:\n" +
        violations.map((v) => `${v.file}: ${v.specifier}`).join("\n"),
    );
  });

  it("the ranking/feed matcher actually recognises today's SD §7/§5/§3 vocabulary", () => {
    // Guards against RANKING_PATH_MARKERS silently losing every term it needs
    // (e.g. a future edit that empties the array) — the "zero violations"
    // result above would then be trivially true for the wrong reason.
    assert.ok(isRankingLikePath("apps/worker/src/route-candidates-rank-score.ts"), "rank");
    assert.ok(isRankingLikePath("packages/db/src/schema/feed-entries.ts"), "feed");
    assert.ok(isRankingLikePath("apps/worker/src/tasks/projection-contribution.ts"), "projection");
    assert.equal(isRankingLikePath("apps/api/src/handlers.ts"), false, "an unrelated file must not match");
  });

  it("self-test: the guard DOES catch a planted violation (proves the regex bites)", async () => {
    // NOTE: this prefix must not itself contain any RANKING_PATH_MARKERS
    // substring ("rank"/"feed"/"projection") — isRankingLikePath matches the
    // FULL path, and a temp-dir name like "rank-feed-guard-..." would flag
    // every file underneath it, including the "unrelated" fixture below that
    // is specifically there to prove the guard is path-scoped.
    const fixtureRoot = await mkdtemp(join(tmpdir(), `guard-fixture-${randomUUID()}-`));
    try {
      const rankingDir = join(fixtureRoot, "apps", "planted-app", "src", "feed");
      await mkdir(rankingDir, { recursive: true });
      await writeFile(
        join(rankingDir, "rank-score.ts"),
        [
          '// Planted fixture: a feed/ranking-shaped file with a forbidden import.',
          'import { resolveEntitlementCached } from "../entitlements.js";',
          "",
          "export function score(): number {",
          "  return 0;",
          "}",
          "",
        ].join("\n"),
      );

      // A sibling non-ranking file with the same forbidden import must NOT be
      // reported — the guard is path-scoped, not repo-wide.
      const unrelatedDir = join(fixtureRoot, "apps", "planted-app", "src", "unrelated");
      await mkdir(unrelatedDir, { recursive: true });
      await writeFile(
        join(unrelatedDir, "checkout.ts"),
        'import { resolveEntitlementCached } from "../entitlements.js";\n',
      );

      const violations = findRankFeedEntitlementViolations(fixtureRoot);
      assert.equal(violations.length, 1, "exactly the planted ranking-path violation, and nothing else");
      assert.match(violations[0]?.file ?? "", /feed[/\\]rank-score\.ts$/);
      assert.match(violations[0]?.specifier ?? "", /entitlements\.js$/);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
