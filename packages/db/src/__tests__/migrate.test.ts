/**
 * Worker test for M0-BE-01: the migration runner applies a migration exactly
 * once across two consecutive runs.
 *
 * Runs against the Docker Postgres from `docker compose up -d --wait`, but never
 * against the dev database's own objects: everything happens inside a throwaway
 * schema named after a random suffix, dropped in `after()`, so the suite is
 * rerunnable and leaves nothing behind.
 *
 *   pnpm --filter @eutectic/db test
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import type { Sql } from "postgres";

import { createPool } from "../client.js";
import { requireDatabaseUrl } from "../env.js";
import { discoverMigrations, MigrationError, runSqlMigrations } from "../migrate.js";
import { MIGRATIONS_DIR, PACKAGE_ROOT } from "../paths.js";

const FIXTURE_MIGRATIONS = join(PACKAGE_ROOT, "test", "fixtures", "migrations");
const LEDGER = "_eutectic_migrations";
const silent = (): void => {};

/** A schema name no other run will collide with. */
function scratchSchema(): string {
  return `m0be01_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

let sql: Sql;
const schemasToDrop: string[] = [];

before(() => {
  // Fail with the actionable message rather than a connection timeout.
  requireDatabaseUrl();
  sql = createPool({ max: 2 });
});

after(async () => {
  for (const schema of schemasToDrop) {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
  await sql.end();
});

function useScratchSchema(): string {
  const schema = scratchSchema();
  schemasToDrop.push(schema);
  return schema;
}

async function countRows(schema: string, table: string): Promise<number> {
  const rows = await sql.unsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM "${schema}"."${table}"`,
  );
  return rows[0]?.n ?? -1;
}

describe("migration runner", () => {
  it("applies each migration exactly once across two consecutive runs", async () => {
    const schema = useScratchSchema();

    const first = await runSqlMigrations({ dir: FIXTURE_MIGRATIONS, schema, log: silent });
    assert.deepEqual(
      [...first.applied],
      ["0000_dummy_marker", "0001_dummy_second"],
      "first run applies both fixtures, in filename order",
    );
    assert.deepEqual([...first.skipped], [], "first run skips nothing");

    // The fixtures are not idempotent SQL. If the runner re-executed either one,
    // this call throws (duplicate table / duplicate key) instead of returning.
    const second = await runSqlMigrations({ dir: FIXTURE_MIGRATIONS, schema, log: silent });
    assert.deepEqual([...second.applied], [], "second run is a no-op");
    assert.deepEqual(
      [...second.skipped],
      ["0000_dummy_marker", "0001_dummy_second"],
      "second run recognises both as already applied",
    );

    // The in-database applied set records one application per migration.
    const ledgerRows = await sql.unsafe<{ id: string; n: number }[]>(
      `SELECT id, count(*)::int AS n FROM "${schema}"."${LEDGER}" GROUP BY id ORDER BY id`,
    );
    assert.deepEqual(
      ledgerRows.map((row) => [row.id, row.n]),
      [
        ["0000_dummy_marker", 1],
        ["0001_dummy_second", 1],
      ],
      "ledger holds exactly one row per migration",
    );

    // And the side effects happened exactly once.
    assert.equal(await countRows(schema, "migration_marker"), 2, "marker rows are not duplicated");
  });

  it("records the applied set in the database, not on disk", async () => {
    const schema = useScratchSchema();
    await runSqlMigrations({ dir: FIXTURE_MIGRATIONS, schema, log: silent });

    const rows = await sql.unsafe<{ id: string; filename: string; checksum: string }[]>(
      `SELECT id, filename, checksum FROM "${schema}"."${LEDGER}" ORDER BY id`,
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.filename, "0000_dummy_marker.sql");
    assert.match(rows[0]?.checksum ?? "", /^[0-9a-f]{64}$/, "checksum is a sha256 hex digest");
  });

  it("refuses to continue when an applied migration has been edited (forward-only)", async () => {
    const schema = useScratchSchema();
    const dir = await mkdtemp(join(tmpdir(), "eutectic-migrations-"));
    try {
      const file = join(dir, "0000_edited.sql");
      await writeFile(file, "CREATE TABLE forward_only_probe (id integer PRIMARY KEY);\n");
      await runSqlMigrations({ dir, schema, log: silent });

      await writeFile(file, "CREATE TABLE forward_only_probe (id integer PRIMARY KEY, extra text);\n");
      await assert.rejects(
        () => runSqlMigrations({ dir, schema, log: silent }),
        (error: unknown) =>
          error instanceof MigrationError && /has changed since it was applied/.test(error.message),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a malformed migration filename rather than guessing the order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eutectic-migrations-"));
    try {
      await writeFile(join(dir, "add-users.sql"), "SELECT 1;\n");
      await assert.rejects(
        () => discoverMigrations(dir),
        (error: unknown) => error instanceof MigrationError && /malformed/.test(error.message),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("shipped migrations", () => {
  it("contains only the 0000 bootstrap — domain tables belong to M0-BE-02 … M0-BE-12", async () => {
    const migrations = await discoverMigrations(MIGRATIONS_DIR);
    assert.deepEqual(
      migrations.map((m) => m.id),
      ["0000_extensions"],
    );

    const sqlText = await readFile(migrations[0]?.path ?? "", "utf8");
    const statements = sqlText
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    assert.doesNotMatch(statements, /CREATE\s+TABLE/i, "0000 must not create a domain table");
    assert.match(statements, /CREATE EXTENSION IF NOT EXISTS pg_trgm/i);
  });
});
