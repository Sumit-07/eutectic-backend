/**
 * P-04 SEED TEST — "no Math.random anywhere in routing code paths" (this
 * ticket's acceptance criterion; the reason it matters is CLAUDE.md's
 * implicit determinism requirement for anything the router does — P-10 /
 * M1-BE-05 must be able to replay a routing decision byte-for-byte given a
 * seed, which `Math.random` makes structurally impossible).
 *
 * Modeled directly on
 * `apps/api/src/__tests__/rank-score-entitlement-guard.test.ts` (itself
 * modeled on `packages/db/src/__tests__/jsonb-double-encode-guard.test.ts`):
 * a plain `node:fs` walk, deliberately dependency-free — no database, no
 * Redis, so it runs even when both are down and never gets slower as the
 * schema grows.
 *
 * Scope, per the ticket wording ("Keep the scan scoped to routing paths"):
 * ONLY `apps/worker/src/routing/` — the future router home — not the whole
 * repo. That is deliberately narrower than the rank/feed guard (which walks
 * all of `apps/` and `packages/`): this ticket's job is to keep the routing
 * directory itself clean, not to police every file that might one day touch
 * randomness.
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
 * At runtime this module is `apps/worker/dist/routing/__tests__/<this
 * file>.js`. Five directory levels up from the file's own directory
 * (`__tests__` -> `routing` -> `dist` -> `worker` -> `apps`) is the repo
 * root — same technique as the rank-score-entitlement guard's `REPO_ROOT`,
 * adjusted for this file's one extra `routing/` nesting level.
 */
const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

/** The directory this ticket's acceptance criterion scopes the scan to. */
const ROUTING_DIR = join(REPO_ROOT, "apps", "worker", "src", "routing");

/** Directory names never walked: build output, dependency trees, VCS/tooling internals. */
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", ".turbo", ".git", "test"]);

/**
 * `Math.random` in any of its call forms — `Math.random()`, a reference
 * passed around (`Math.random`), whitespace variants. Deliberately a plain
 * substring/regex match over raw source text (no TS parser), same
 * "no-dependency, never slower" posture as the rank/feed entitlement guard —
 * sufficient because the acceptance criterion is "no occurrence of
 * Math.random", not "understand control flow".
 */
const MATH_RANDOM_PATTERN = /Math\s*\.\s*random/;

/**
 * Strip `/* ... *\/` block comments (JSDoc included) and `// ...` line
 * comments before scanning. Without this, `sampling.ts`'s own doc comments
 * — which legitimately explain, in prose, why the file does NOT call
 * `Math.random` (that explanation requires writing the string
 * "Math.random") — would trip the guard on documentation, not code. Crude
 * (no string-literal awareness — a `Math.random` substring inside a plain
 * string literal would still slip past this guard entirely, but nothing in
 * this ticket's code has a legitimate reason to hold that substring in a
 * string literal, and the rank/feed guard accepts the same class of gap for
 * import specifiers). Block-comment removal replaces non-newline characters
 * only, so line numbers in the reported violations stay aligned with the
 * ORIGINAL file.
 */
function stripComments(source: string): string {
  const noBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ""));
  return noBlockComments.replace(/\/\/.*$/gm, "");
}

interface Violation {
  file: string;
  line: number;
  text: string;
}

/**
 * This file's own basename. Its self-test below deliberately writes the
 * literal text `Math.random()` into a fixture file it creates elsewhere —
 * this file's own source text also contains that literal (in this very
 * comment, and in the pattern's own documentation), so it must exclude
 * itself the same way `rank-score-entitlement-guard.test.ts` excludes
 * itself via `SELF`.
 */
const SELF = "math-random-guard.test.ts";

/** Walk every `.ts`/`.js` file under `dir` (skipping {@link SKIP_DIR_NAMES} and {@link SELF}), returning absolute paths. */
function walkSourceFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // fixture trees, or (pre-P-10) an as-yet-thin routing/ dir
  }
  const out: string[] = [];
  for (const entry of entries) {
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
 * The guard itself: every source file under `routingDir`, checked line by
 * line for {@link MATH_RANDOM_PATTERN}. Shared between the real-repo
 * assertion and the fixture self-test so both exercises run the identical
 * logic.
 */
function findMathRandomViolations(routingDir: string): Violation[] {
  const violations: Violation[] = [];
  for (const file of walkSourceFiles(routingDir)) {
    const text = readFileSync(file, "utf8");
    const originalLines = text.split("\n");
    const codeOnlyLines = stripComments(text).split("\n");
    for (let i = 0; i < codeOnlyLines.length; i++) {
      const codeLine = codeOnlyLines[i] ?? "";
      if (MATH_RANDOM_PATTERN.test(codeLine)) {
        // Report the ORIGINAL line text (comments and all) for a readable
        // error message — only the MATCHING is comment-blind, not the report.
        violations.push({ file, line: i + 1, text: (originalLines[i] ?? codeLine).trim() });
      }
    }
  }
  return violations;
}

describe("routing Math.random guard — no Math.random anywhere under apps/worker/src/routing/", () => {
  it("finds zero violations in the real repo today", () => {
    const violations = findMathRandomViolations(ROUTING_DIR);
    assert.deepEqual(
      violations,
      [],
      "P-04's acceptance criterion ('no Math.random anywhere in routing code paths') was violated:\n" +
        violations.map((v) => `${v.file}:${v.line}: ${v.text}`).join("\n"),
    );
  });

  it("self-test: the guard DOES catch a planted Math.random() call (proves the pattern bites)", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), `math-random-guard-fixture-${randomUUID()}-`));
    try {
      await mkdir(fixtureRoot, { recursive: true });
      await writeFile(
        join(fixtureRoot, "planted-violation.ts"),
        [
          "// Planted fixture: routing code that (wrongly) reaches for ambient randomness.",
          "export function pickOne<T>(items: readonly T[]): T {",
          "  const index = Math.floor(Math.random() * items.length);",
          "  return items[index]!;",
          "}",
          "",
        ].join("\n"),
      );

      // A clean sibling file must never be flagged — proves the guard
      // reports only the planted line, not every file it visits.
      await writeFile(
        join(fixtureRoot, "clean.ts"),
        ["export function identity<T>(value: T): T {", "  return value;", "}", ""].join("\n"),
      );

      // A file that only ever MENTIONS Math.random in a comment (block and
      // line forms) — the exact shape `sampling.ts`'s own doc comments take
      // when explaining why the module does not use it — must not be
      // flagged either. This is the false positive this guard hit against
      // the real `sampling.ts` during development; pinned here so it can
      // never silently regress.
      await writeFile(
        join(fixtureRoot, "documents-but-does-not-call.ts"),
        [
          "/**",
          " * Deliberately not using Math.random here — see the PRNG module for why.",
          " */",
          "// Also not calling Math.random on this line.",
          "export function noop(): void {}",
          "",
        ].join("\n"),
      );

      const violations = findMathRandomViolations(fixtureRoot);
      assert.equal(violations.length, 1, "exactly the planted violation, and nothing else");
      assert.match(violations[0]?.file ?? "", /planted-violation\.ts$/);
      assert.equal(violations[0]?.line, 3);
      assert.match(violations[0]?.text ?? "", /Math\.random\(\)/);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("a non-existent routing dir (pre-P-04, or a typo'd path) yields zero violations, not a crash", () => {
    // The router directory is new territory (P-10 hasn't landed yet in most
    // checkouts of this history) — the walker must degrade gracefully
    // rather than throw ENOENT, so the guard is safe to run at any point in
    // the ticket sequence.
    assert.deepEqual(findMathRandomViolations(join(tmpdir(), `definitely-does-not-exist-${randomUUID()}`)), []);
  });
});
