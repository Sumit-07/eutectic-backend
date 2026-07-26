/**
 * Worker test for M0-BE-16: migration 0012 (`idempotency_responses`).
 *
 * Same conventions as `identity.test.ts`, `events.test.ts` and the rest: every
 * test applies the *real* `migrations/` directory into a throwaway schema
 * (dropped in `after()`), so the suite never touches the dev database and is
 * safely rerunnable.
 *
 * The shape of one narrow table is not what is worth testing. What is worth
 * testing is the two atomic statements `apps/api` leans on — because the whole
 * claim of this ticket is that "exactly one execution" is a property of a
 * unique index and not of application locking, and that claim is either true
 * of this table or it is nothing:
 *
 *   - **The claim.** N concurrent `INSERT ... ON CONFLICT DO NOTHING` on the
 *     same `(scope, idempotency_key)` produce exactly one winner, from real
 *     parallel connections, not from a loop.
 *   - **The takeover.** N concurrent conditional `UPDATE ... RETURNING` on an
 *     abandoned claim produce exactly one winner too, so a crashed process
 *     cannot brick a key AND cannot be recovered by two racers at once.
 *   - **The claimed_by guard.** A request whose claim was taken over as stale
 *     cannot afterwards write its response over the row that superseded it.
 *   - **Scoping.** The same key under two principals is two independent rows —
 *     the migration's JUDGMENT 2, which is the difference between "caller B
 *     replays caller A's response" and "caller B has their own claim".
 *
 *   pnpm --filter @eutectic/db test
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { Sql } from "postgres";

import { createPool } from "../client.js";
import { requireDatabaseUrl } from "../env.js";
import { runSqlMigrations } from "../migrate.js";
import { MIGRATIONS_DIR } from "../paths.js";

const MIGRATION_ID = "0012_idempotency_responses";
const silent = (): void => {};

let sql: Sql;
const schemasToDrop: string[] = [];

before(() => {
  requireDatabaseUrl();
  // Enough connections that the concurrency tests below really are concurrent.
  sql = createPool({ max: 12 });
});

after(async () => {
  for (const schema of schemasToDrop) {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
  await sql.end();
});

function useScratchSchema(): string {
  const schema = `m0be16_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  schemasToDrop.push(schema);
  return schema;
}

async function migrate(schema: string): Promise<string> {
  await runSqlMigrations({ dir: MIGRATIONS_DIR, schema, log: silent });
  return schema;
}

/** The exact claim statement `apps/api` issues. Returns true if this caller won. */
async function claim(
  schema: string,
  input: { scope: string; key: string; requestId: string; fingerprint?: string },
): Promise<boolean> {
  const rows = await sql`
    INSERT INTO ${sql(schema)}.${sql("idempotency_responses")}
      (scope, idempotency_key, operation_id, request_fingerprint, state, claimed_by)
    VALUES (${input.scope}, ${input.key}, ${"createPost"}, ${input.fingerprint ?? "fp"},
            ${"in_progress"}, ${input.requestId})
    ON CONFLICT (scope, idempotency_key) DO NOTHING
    RETURNING claimed_by
  `;
  return rows.length === 1;
}

describe(MIGRATION_ID, () => {
  it("creates the table with the composite primary key and the retention index", async () => {
    const schema = await migrate(useScratchSchema());

    const columns = await sql<{ column_name: string; data_type: string; is_nullable: string }[]>`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = ${schema} AND table_name = 'idempotency_responses'
      ORDER BY ordinal_position
    `;
    assert.deepEqual(
      columns.map((c) => c.column_name),
      [
        "scope",
        "idempotency_key",
        "operation_id",
        "request_fingerprint",
        "state",
        "claimed_by",
        "response_status",
        "response_content_type",
        "response_body",
        "created_at",
        "updated_at",
      ],
    );

    // The response columns are the only nullable ones: nothing is known about
    // the outcome while the claim is in progress.
    const nullable = columns.filter((c) => c.is_nullable === "YES").map((c) => c.column_name);
    assert.deepEqual(nullable, ["response_status", "response_content_type", "response_body"]);

    // The body is text, not jsonb — a replay must be byte for byte the
    // original (the migration's JUDGMENT 3).
    assert.equal(columns.find((c) => c.column_name === "response_body")?.data_type, "text");

    const pk = await sql<{ column_name: string }[]>`
      SELECT a.attname AS column_name
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      WHERE n.nspname = ${schema} AND t.relname = 'idempotency_responses' AND c.contype = 'p'
      ORDER BY k.ord
    `;
    assert.deepEqual(
      pk.map((r) => r.column_name),
      ["scope", "idempotency_key"],
      "the claim's ON CONFLICT target is this exact constraint",
    );

    const indexes = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = ${schema} AND tablename = 'idempotency_responses'
      ORDER BY indexname
    `;
    assert.deepEqual(
      indexes.map((r) => r.indexname),
      ["idempotency_responses_created_at_idx", "idempotency_responses_pkey"],
    );
  });

  it("gives exactly one winner when 20 claims for one key race", async () => {
    const schema = await migrate(useScratchSchema());
    const key = randomUUID();

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        claim(schema, { scope: "anonymous", key, requestId: `req-${String(i)}` }),
      ),
    );

    assert.equal(
      results.filter(Boolean).length,
      1,
      "the unique index, not the application, decides who executes",
    );

    const rows = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM ${sql(schema)}.${sql("idempotency_responses")}
    `;
    assert.equal(rows[0]?.count, "1");
  });

  it("scopes the key to the principal — the same key under two scopes is two claims", async () => {
    const schema = await migrate(useScratchSchema());
    const key = "01J8Z6R2F3M4N5P6Q7R8S9T0V1";

    assert.equal(await claim(schema, { scope: "user-a", key, requestId: "a" }), true);
    assert.equal(
      await claim(schema, { scope: "user-b", key, requestId: "b" }),
      true,
      "caller B must not inherit caller A's claim, or its recorded response",
    );
    assert.equal(await claim(schema, { scope: "user-a", key, requestId: "a2" }), false);
  });

  it("hands an abandoned claim to exactly one of the racing takers", async () => {
    const schema = await migrate(useScratchSchema());
    const key = randomUUID();
    assert.equal(await claim(schema, { scope: "anonymous", key, requestId: "crashed" }), true);

    // Age the claim past any takeover horizon: the process that held it died.
    await sql`
      UPDATE ${sql(schema)}.${sql("idempotency_responses")}
      SET updated_at = now() - interval '10 minutes'
      WHERE scope = ${"anonymous"} AND idempotency_key = ${key}
    `;

    const takeover = async (requestId: string): Promise<boolean> => {
      const rows = await sql`
        UPDATE ${sql(schema)}.${sql("idempotency_responses")}
        SET claimed_by = ${requestId}, request_fingerprint = ${"fp"}, updated_at = now()
        WHERE scope = ${"anonymous"} AND idempotency_key = ${key}
          AND state = ${"in_progress"}
          AND updated_at < now() - ${"60 seconds"}::interval
        RETURNING claimed_by
      `;
      return rows.length === 1;
    };

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => takeover(`taker-${String(i)}`)),
    );
    assert.equal(
      results.filter(Boolean).length,
      1,
      "a crash must not brick the key, and recovery must not itself double-execute",
    );
  });

  it("refuses a superseded request's attempt to record its response", async () => {
    const schema = await migrate(useScratchSchema());
    const key = randomUUID();
    assert.equal(await claim(schema, { scope: "anonymous", key, requestId: "slow" }), true);

    // A takeover replaces the owner.
    await sql`
      UPDATE ${sql(schema)}.${sql("idempotency_responses")}
      SET claimed_by = ${"taker"}, updated_at = now()
      WHERE scope = ${"anonymous"} AND idempotency_key = ${key}
    `;

    const complete = async (requestId: string, body: string): Promise<number> => {
      const rows = await sql`
        UPDATE ${sql(schema)}.${sql("idempotency_responses")}
        SET state = ${"completed"}, response_status = ${201}, response_body = ${body},
            updated_at = now()
        WHERE scope = ${"anonymous"} AND idempotency_key = ${key}
          AND state = ${"in_progress"} AND claimed_by = ${requestId}
        RETURNING scope
      `;
      return rows.length;
    };

    assert.equal(await complete("slow", "stale body"), 0, "the superseded owner writes nothing");
    assert.equal(await complete("taker", "real body"), 1);

    const rows = await sql<{ response_body: string | null }[]>`
      SELECT response_body FROM ${sql(schema)}.${sql("idempotency_responses")}
      WHERE scope = ${"anonymous"} AND idempotency_key = ${key}
    `;
    assert.equal(rows[0]?.response_body, "real body");
  });
});
