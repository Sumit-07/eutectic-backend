/**
 * Regression guard for the debt fixed in M0-BE-22 (D-016 item 6a).
 *
 * `${JSON.stringify(payload)}::jsonb` (and its `::json` variant) looks like it
 * binds a JSON value correctly and does not: postgres.js sends an untyped
 * parameter, the server infers its type from the cast, and postgres.js then
 * JSON-encodes the ALREADY-encoded string — the value lands as a jsonb STRING
 * SCALAR (`jsonb_typeof` says `string`) instead of an OBJECT, and every
 * `payload->>'...'` read comes back `null` with nothing complaining. See
 * `packages/db/src/jobs.ts`'s payload-binding comment on `withJob` for the full
 * mechanism (reproduced against this database before that comment was
 * written), and `events.test.ts`'s `insertEvent` helper — fixed in this same
 * ticket — for the correct shape: `sql.json(payload)`, no cast needed.
 *
 * This is a plain `node:fs` walk, deliberately dependency-free: it does not
 * open a database connection, so it runs even when Postgres is down and never
 * gets slower as the schema grows.
 *
 * Walks every `.ts` file under `packages/db/src` — production source AND test
 * sources both, per the ticket's acceptance criteria — and fails loudly,
 * naming the offending file and line, if the shape reappears anywhere other
 * than in a comment documenting the trap (this file's own doc-comment above,
 * and jobs.ts's, use escaped/prose forms for exactly this reason).
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { PACKAGE_ROOT } from "../paths.js";

const SRC_DIR = join(PACKAGE_ROOT, "src");

/**
 * Matches the template-literal-into-a-cast shape: `${JSON.stringify(...)}`
 * immediately (modulo whitespace) followed by a `::json` or `::jsonb` cast.
 * `jsonb?` makes the trailing `b` optional so both casts are caught in one
 * pattern. Deliberately does NOT match a bare `JSON.stringify(...)` — plenty
 * of legitimate code (error messages, this file's own doc-comment) calls it
 * without ever piping the result into a SQL cast.
 */
const DOUBLE_ENCODE_SHAPE = /\$\{\s*JSON\.stringify\([^)]*\)\s*\}\s*::\s*jsonb?\b/;

/**
 * This file's own basename. Excluded from the walk so the pattern's
 * description above — written in prose, never as the literal offending shape
 * — can never trip its own guard, and so a future violation can't be "fixed"
 * by editing this file instead of the offending one.
 */
const SELF = "jsonb-double-encode-guard.test.ts";

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTsFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && entry.name !== SELF) {
      out.push(path);
    }
  }
  return out;
}

/** True for a line that is itself a comment — `//`, `/*`, or `*` continuation. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*");
}

describe("regression guard — no ${JSON.stringify(...)}::jsonb double-encode", () => {
  it("packages/db source and test files never reintroduce the double-encode shape", () => {
    const offenders: string[] = [];

    for (const file of walkTsFiles(SRC_DIR)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (isCommentLine(line)) return; // documenting the trap is fine; only live code is checked
        if (DOUBLE_ENCODE_SHAPE.test(line)) {
          offenders.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    assert.deepEqual(
      offenders,
      [],
      "found the ${JSON.stringify(payload)}::jsonb double-encode shape in packages/db — " +
        "it silently stores a jsonb STRING SCALAR instead of an object. Use sql.json(payload) " +
        "instead (no cast needed — see packages/db/src/jobs.ts's payload-binding comment on " +
        "withJob for the full mechanism):\n" +
        offenders.join("\n"),
    );
  });
});
