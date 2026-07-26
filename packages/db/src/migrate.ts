/**
 * Migration runner: ordered, forward-only, recorded in-database, idempotent.
 *
 * Rules it enforces, in the order you will hit them:
 *
 *  1. **Ordered.** Files are `NNNN_snake_name.sql`. They run in ascending NNNN.
 *     A duplicate or malformed prefix is a hard error, not a coin flip.
 *  2. **Forward-only.** There is no `down`. A migration that has been applied is
 *     never re-run and never edited: if the file's checksum no longer matches the
 *     recorded one, or the file has vanished, the run aborts. Fixes go forward as
 *     a new file (CLAUDE.md rule 5: expand → migrate → contract).
 *  3. **Recorded in-database.** The applied set lives in `_eutectic_migrations`,
 *     not in a lockfile, so it is true for whichever database you actually
 *     pointed at.
 *  4. **Idempotent.** A second run applies nothing and exits 0.
 *  5. **Serialized.** A session-level advisory lock means two `db:migrate`
 *     invocations (or a deploy racing itself) cannot interleave.
 *
 * Each migration runs inside a transaction together with the insert of its own
 * ledger row, so a failure leaves neither the change nor the record. A migration
 * that genuinely cannot run in a transaction (e.g. `CREATE INDEX CONCURRENTLY`)
 * opts out with a `-- eutectic:no-transaction` directive on any of its first
 * lines, and accepts that it is then not atomic with its ledger row.
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Sql } from "postgres";

import { createPool } from "./client.js";
import { MIGRATIONS_DIR } from "./paths.js";

const FILENAME_PATTERN = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
const NO_TRANSACTION_DIRECTIVE = /^\s*--\s*eutectic:no-transaction\s*$/m;
const DEFAULT_TABLE = "_eutectic_migrations";
const DEFAULT_SCHEMA = "public";

export interface DiscoveredMigration {
  /** Ordering key, e.g. `0000`. */
  readonly sequence: string;
  /** Stable identity, e.g. `0000_extensions`. Also the ledger primary key. */
  readonly id: string;
  readonly filename: string;
  readonly path: string;
}

export interface MigrationRunOptions {
  /** Connection string. Defaults to `process.env.DATABASE_URL`. */
  url?: string;
  /** Directory of `.sql` files. Defaults to this package's `migrations/`. */
  dir?: string;
  /** Schema the migrations and the ledger live in. Defaults to `public`. Tests use a scratch schema. */
  schema?: string;
  /** Ledger table name. Defaults to `_eutectic_migrations`. */
  table?: string;
  /** Progress sink. Defaults to `console.log`; pass `() => {}` to silence. */
  log?: (message: string) => void;
}

export interface AppliedMigration {
  readonly id: string;
  readonly filename: string;
  readonly checksum: string;
  readonly appliedAt: Date;
}

export interface MigrationRunResult {
  /** Ids applied by *this* run. Empty on a no-op second run. */
  readonly applied: readonly string[];
  /** Ids that were already recorded and were left alone. */
  readonly skipped: readonly string[];
  /** Schema the ledger was read from. */
  readonly schema: string;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

/** Read and validate the migration set on disk, in execution order. */
export async function discoverMigrations(
  dir: string = MIGRATIONS_DIR,
): Promise<DiscoveredMigration[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (cause) {
    throw new MigrationError(`Cannot read migrations directory ${dir}: ${String(cause)}`);
  }

  const sqlFiles = entries.filter((name) => name.endsWith(".sql")).sort();
  const seen = new Map<string, string>();
  const migrations: DiscoveredMigration[] = [];

  for (const filename of sqlFiles) {
    const match = FILENAME_PATTERN.exec(filename);
    if (match === null) {
      throw new MigrationError(
        `Migration filename ${JSON.stringify(filename)} in ${dir} is malformed. ` +
          `Expected NNNN_snake_case_name.sql, e.g. 0001_users.sql.`,
      );
    }
    const sequence = match[1] as string;
    const previous = seen.get(sequence);
    if (previous !== undefined) {
      throw new MigrationError(
        `Duplicate migration sequence ${sequence}: ${previous} and ${filename}. ` +
          `Order must be total, so every prefix is unique.`,
      );
    }
    seen.set(sequence, filename);
    migrations.push({
      sequence,
      id: filename.slice(0, -".sql".length),
      filename,
      path: join(dir, filename),
    });
  }

  migrations.sort((a, b) => a.sequence.localeCompare(b.sequence));
  return migrations;
}

function checksumOf(contents: string): string {
  // Normalise line endings so a checkout on another platform is not a "changed" migration.
  return createHash("sha256").update(contents.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

async function ensureLedger(sql: Sql, schema: string, table: string): Promise<void> {
  if (schema !== DEFAULT_SCHEMA) {
    await sql`CREATE SCHEMA IF NOT EXISTS ${sql(schema)}`;
    await sql.unsafe(`SET search_path TO ${quoteIdent(schema)}, public`);
  } else {
    await sql.unsafe(`SET search_path TO public`);
  }
  await sql`
    CREATE TABLE IF NOT EXISTS ${sql(schema)}.${sql(table)} (
      id           text PRIMARY KEY,
      filename     text        NOT NULL,
      checksum     text        NOT NULL,
      applied_at   timestamptz NOT NULL DEFAULT now(),
      duration_ms  integer     NOT NULL
    )
  `;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Read the applied set, oldest first. */
export async function readAppliedMigrations(
  sql: Sql,
  schema: string = DEFAULT_SCHEMA,
  table: string = DEFAULT_TABLE,
): Promise<AppliedMigration[]> {
  const rows = await sql<
    { id: string; filename: string; checksum: string; applied_at: Date }[]
  >`
    SELECT id, filename, checksum, applied_at
    FROM ${sql(schema)}.${sql(table)}
    ORDER BY id ASC
  `;
  return rows.map((row) => ({
    id: row.id,
    filename: row.filename,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  }));
}

/**
 * Apply every pending `.sql` migration. Safe to run repeatedly; a second run
 * against an unchanged directory applies nothing.
 */
export async function runSqlMigrations(
  options: MigrationRunOptions = {},
): Promise<MigrationRunResult> {
  const dir = options.dir ?? MIGRATIONS_DIR;
  const schema = options.schema ?? DEFAULT_SCHEMA;
  const table = options.table ?? DEFAULT_TABLE;
  const log = options.log ?? ((message: string) => console.log(message));

  const migrations = await discoverMigrations(dir);

  // max: 1 — migrations are strictly serial, and the advisory lock below is
  // session-scoped, so the lock and the DDL must share one connection.
  const sql = createPool({
    ...(options.url === undefined ? {} : { url: options.url }),
    max: 1,
    idleTimeoutSeconds: 5,
  });

  const lockKey = `eutectic:migrations:${schema}`;
  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    await sql`SELECT pg_advisory_lock(hashtext(${lockKey})::bigint)`;
    try {
      await ensureLedger(sql, schema, table);
      const alreadyApplied = await readAppliedMigrations(sql, schema, table);
      const appliedById = new Map(alreadyApplied.map((row) => [row.id, row]));

      const known = new Set(migrations.map((m) => m.id));
      for (const row of alreadyApplied) {
        if (!known.has(row.id)) {
          throw new MigrationError(
            `Migration ${row.id} is recorded as applied but ${row.filename} is not in ${dir}. ` +
              `Migrations are forward-only: an applied file is never deleted or renamed.`,
          );
        }
      }

      for (const migration of migrations) {
        const contents = await readFile(migration.path, "utf8");
        const checksum = checksumOf(contents);
        const record = appliedById.get(migration.id);

        if (record !== undefined) {
          if (record.checksum !== checksum) {
            throw new MigrationError(
              `Migration ${migration.id} has changed since it was applied ` +
                `(recorded ${record.checksum.slice(0, 12)}, on disk ${checksum.slice(0, 12)}). ` +
                `Migrations are forward-only: revert the edit and add a new migration instead.`,
            );
          }
          skipped.push(migration.id);
          continue;
        }

        const startedAt = Date.now();
        if (NO_TRANSACTION_DIRECTIVE.test(contents)) {
          log(`applying ${migration.id} (no-transaction)`);
          await sql.unsafe(contents).simple();
          await sql`
            INSERT INTO ${sql(schema)}.${sql(table)} (id, filename, checksum, duration_ms)
            VALUES (${migration.id}, ${migration.filename}, ${checksum}, ${Date.now() - startedAt})
          `;
        } else {
          log(`applying ${migration.id}`);
          await sql.begin(async (tx) => {
            await tx.unsafe(contents).simple();
            await tx`
              INSERT INTO ${tx(schema)}.${tx(table)} (id, filename, checksum, duration_ms)
              VALUES (${migration.id}, ${migration.filename}, ${checksum}, ${Date.now() - startedAt})
            `;
          });
        }
        applied.push(migration.id);
      }
    } finally {
      await sql`SELECT pg_advisory_unlock(hashtext(${lockKey})::bigint)`;
    }
  } finally {
    await sql.end();
  }

  if (applied.length === 0) {
    log(`migrations up to date (${skipped.length} applied previously)`);
  } else {
    log(`applied ${applied.length} migration(s): ${applied.join(", ")}`);
  }

  return { applied, skipped, schema };
}
