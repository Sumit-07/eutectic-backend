/**
 * Worker test for M0-BE-09: migration 0008 (grants, repos, reviews, products,
 * connections, sessions_, findings, finding_events, residencies,
 * deploy_signals).
 *
 * Same conventions as `identity.test.ts`, `calls.test.ts` and `votes.test.ts`:
 * every test applies the *real* `migrations/` directory into a throwaway
 * schema (dropped in `after()`), so the suite never touches the dev database
 * and is safely rerunnable.
 *
 * This branch's migration 0007 (M0-BE-08, arguments/sides/argument_votes +
 * the tags.slug pg_trgm index) is in flight on a sibling worktree and is not
 * present here, so the applied set has a gap at 0007 — deliberate per D-011
 * and this ticket's brief. This suite only asserts that 0008 lands; the
 * overall shipped-migrations contiguity check belongs to `migrate.test.ts`
 * and is expected to fail on this branch alone.
 *
 * The cases that matter are the acceptance criteria, not the shape:
 *   - grants: scopes text[] insert; revocation is an UPDATE (revoked_at set
 *     in place), never a DELETE — the row survives.
 *   - findings + finding_events: one event row per state change
 *     (open -> fixed -> reopened records two rows, from/to on each).
 *   - reviews UNIQUE (repo_id, pr_number, agent_id) rejects a duplicate.
 *   - residencies UNIQUE (product_id, agent_id) rejects a duplicate.
 *   - sessions_ inserts against the real `sessions_` table name, proving the
 *     trailing underscore survived end to end.
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

const MIGRATION_ID = "0008_grants_products_findings";
const silent = (): void => {};

let sql: Sql;
const schemasToDrop: string[] = [];

before(() => {
  // Fail with the actionable message rather than a connection timeout.
  requireDatabaseUrl();
  sql = createPool({ max: 4 });
});

after(async () => {
  for (const schema of schemasToDrop) {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
  await sql.end();
});

function useScratchSchema(): string {
  const schema = `m0be09_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  schemasToDrop.push(schema);
  return schema;
}

async function migrate(schema: string): Promise<Awaited<ReturnType<typeof runSqlMigrations>>> {
  return runSqlMigrations({ dir: MIGRATIONS_DIR, schema, log: silent });
}

async function insertUser(schema: string, githubId: number, handle: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO ${sql(schema)}.${sql("users")}
      (github_id, github_login, github_created_at, handle)
    VALUES (${githubId}, ${handle}, now(), ${handle})
    RETURNING id
  `;
  const id = rows[0]?.id;
  assert.ok(id, "insertUser must return an id");
  return id;
}

async function insertAgent(schema: string, slug: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO ${sql(schema)}.${sql("agents")}
      (slug, name, class, ink, voice, beat, hobby_horse, persona_ref, base_model)
    VALUES (${slug}, ${slug}, 'staff', 'bricklayer', 'serif', 'mornings',
            'unit economics', ${`personas/${slug}.md`}, 'test-model')
    RETURNING id
  `;
  const id = rows[0]?.id;
  assert.ok(id, "insertAgent must return an id");
  return id;
}

async function insertRepo(schema: string, userId: string, githubRepoId: number): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO ${sql(schema)}.${sql("repos")}
      (user_id, github_repo_id, full_name, installation_id)
    VALUES (${userId}, ${githubRepoId}, ${`org/repo-${githubRepoId}`}, 12345)
    RETURNING id
  `;
  const id = rows[0]?.id;
  assert.ok(id, "insertRepo must return an id");
  return id;
}

async function insertContribution(schema: string, agentId: string, seed: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO ${sql(schema)}.${sql("contributions")}
      (source_type, author_type, agent_id, body, idempotency_key)
    VALUES ('pr_review', 'agent', ${agentId}, 'A review.', ${`m0be09-contrib-${seed}`})
    RETURNING id
  `;
  const id = rows[0]?.id;
  assert.ok(id, "insertContribution must return an id");
  return id;
}

async function insertProduct(schema: string, ownerUserId: string, name: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO ${sql(schema)}.${sql("products")}
      (owner_user_id, name, purpose, sandbox_declaration)
    VALUES (${ownerUserId}, ${name}, 'A test product.', ${sql.json({ allowedHosts: [], denylist: [] })})
    RETURNING id
  `;
  const id = rows[0]?.id;
  assert.ok(id, "insertProduct must return an id");
  return id;
}

describe("migration 0008 — grants, repos, reviews, products, connections, sessions_, findings, finding_events, residencies, deploy_signals", () => {
  it("applies the real migrations directory, and a second run is a no-op", async () => {
    const schema = useScratchSchema();

    const first = await migrate(schema);
    assert.ok(
      first.applied.includes(MIGRATION_ID),
      `expected ${MIGRATION_ID} among applied migrations: ${first.applied.join(", ")}`,
    );

    const second = await migrate(schema);
    assert.deepEqual([...second.applied], [], "second run applies nothing");
    assert.ok(second.skipped.includes(MIGRATION_ID), "second run recognises 0008 as already applied");
    // Deliberately not asserting overall contiguity here — this branch has a
    // gap at 0007 (M0-BE-08, in flight on a sibling worktree per D-011), and
    // that overall check is migrate.test.ts's job, not this file's.
  });

  it("grants: inserts with scopes text[]; revocation is an UPDATE, not a DELETE", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const userId = await insertUser(schema, 1, "granter1");

    const inserted = await sql<{ id: string; scopes: string[]; revoked_at: string | null }[]>`
      INSERT INTO ${sql(schema)}.${sql("grants")}
        (user_id, target_type, target_id, scopes)
      VALUES (${userId}, 'repo', ${randomUUID()}, ${["review", "comment"]})
      RETURNING id, scopes, revoked_at
    `;
    const grantId = inserted[0]?.id;
    assert.ok(grantId, "grant insert must return an id");
    assert.deepEqual(inserted[0]?.scopes, ["review", "comment"], "scopes text[] round-trips");
    assert.equal(inserted[0]?.revoked_at, null, "a fresh grant is not revoked");

    await sql`
      UPDATE ${sql(schema)}.${sql("grants")} SET revoked_at = now() WHERE id = ${grantId}
    `;

    const rows = await sql<{ id: string; revoked_at: string | null }[]>`
      SELECT id, revoked_at FROM ${sql(schema)}.${sql("grants")} WHERE id = ${grantId}
    `;
    assert.equal(rows.length, 1, "the grant row still exists after revocation — an UPDATE, never a DELETE");
    assert.ok(rows[0]?.revoked_at, "revoked_at is set in place");
  });

  it("findings + finding_events: one event row per state change (open -> fixed -> reopened)", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const ownerId = await insertUser(schema, 2, "productowner1");
    const productId = await insertProduct(schema, ownerId, "Test Product");
    const agentId = await insertAgent(schema, "findingagent");

    const findingRows = await sql<{ id: string; state: string }[]>`
      INSERT INTO ${sql(schema)}.${sql("findings")}
        (product_id, agent_id, title, body, severity)
      VALUES (${productId}, ${agentId}, 'A bug', 'It breaks under load.', 3)
      RETURNING id, state
    `;
    const findingId = findingRows[0]?.id;
    assert.ok(findingId, "finding insert must return an id");
    assert.equal(findingRows[0]?.state, "open", "state defaults to 'open'");

    // The finding's opening event: no prior state.
    await sql`
      INSERT INTO ${sql(schema)}.${sql("finding_events")}
        (finding_id, from_state, to_state, actor_type, actor_id)
      VALUES (${findingId}, NULL, 'open', 'agent', ${agentId})
    `;

    // open -> fixed
    await sql`
      UPDATE ${sql(schema)}.${sql("findings")} SET state = 'fixed' WHERE id = ${findingId}
    `;
    await sql`
      INSERT INTO ${sql(schema)}.${sql("finding_events")}
        (finding_id, from_state, to_state, actor_type, actor_id)
      VALUES (${findingId}, 'open', 'fixed', 'agent', ${agentId})
    `;

    // fixed -> reopened
    await sql`
      UPDATE ${sql(schema)}.${sql("findings")} SET state = 'reopened' WHERE id = ${findingId}
    `;
    await sql`
      INSERT INTO ${sql(schema)}.${sql("finding_events")}
        (finding_id, from_state, to_state, actor_type, actor_id)
      VALUES (${findingId}, 'fixed', 'reopened', 'agent', ${agentId})
    `;

    const events = await sql<{ from_state: string | null; to_state: string }[]>`
      SELECT from_state, to_state FROM ${sql(schema)}.${sql("finding_events")}
      WHERE finding_id = ${findingId} ORDER BY created_at
    `;
    assert.deepEqual(
      events.map((row) => [row.from_state, row.to_state]),
      [
        [null, "open"],
        ["open", "fixed"],
        ["fixed", "reopened"],
      ],
      "one finding_events row per state change, from/to recorded",
    );

    const [current] = await sql<{ state: string }[]>`
      SELECT state FROM ${sql(schema)}.${sql("findings")} WHERE id = ${findingId}
    `;
    assert.equal(current?.state, "reopened", "findings.state mutates in place to the latest state");
  });

  it("reviews: UNIQUE (repo_id, pr_number, agent_id) rejects a duplicate", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const userId = await insertUser(schema, 3, "repoowner1");
    const repoId = await insertRepo(schema, userId, 111);
    const agentId = await insertAgent(schema, "reviewagent");
    const contributionId1 = await insertContribution(schema, agentId, "1");
    const contributionId2 = await insertContribution(schema, agentId, "2");

    await sql`
      INSERT INTO ${sql(schema)}.${sql("reviews")}
        (repo_id, agent_id, pr_number, contribution_id)
      VALUES (${repoId}, ${agentId}, 7, ${contributionId1})
    `;

    await assert.rejects(
      () => sql`
        INSERT INTO ${sql(schema)}.${sql("reviews")}
          (repo_id, agent_id, pr_number, contribution_id)
        VALUES (${repoId}, ${agentId}, 7, ${contributionId2})
      `,
      /duplicate key|unique/i,
      "a second review by the same agent on the same (repo, pr_number) must be rejected",
    );

    const [count] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.${sql("reviews")}
      WHERE repo_id = ${repoId} AND pr_number = 7 AND agent_id = ${agentId}
    `;
    assert.equal(count?.n, 1, "exactly one review survives per (repo, pr_number, agent)");
  });

  it("residencies: UNIQUE (product_id, agent_id) rejects a duplicate", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const ownerId = await insertUser(schema, 4, "productowner2");
    const productId = await insertProduct(schema, ownerId, "Another Product");
    const agentId = await insertAgent(schema, "residentagent");

    await sql`
      INSERT INTO ${sql(schema)}.${sql("residencies")} (product_id, agent_id)
      VALUES (${productId}, ${agentId})
    `;

    await assert.rejects(
      () => sql`
        INSERT INTO ${sql(schema)}.${sql("residencies")} (product_id, agent_id)
        VALUES (${productId}, ${agentId})
      `,
      /duplicate key|unique/i,
      "a duplicate (product, agent) residency must be rejected",
    );

    const [count] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.${sql("residencies")}
      WHERE product_id = ${productId} AND agent_id = ${agentId}
    `;
    assert.equal(count?.n, 1, "exactly one residency survives per (product, agent)");
  });

  it("sessions_: inserts against the real `sessions_` table name — the underscore survives end to end", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const ownerId = await insertUser(schema, 5, "productowner3");
    const productId = await insertProduct(schema, ownerId, "Sessioned Product");
    const agentId = await insertAgent(schema, "sessionagent");

    const rows = await sql<{ id: string; task: string }[]>`
      INSERT INTO ${sql(schema)}.${sql("sessions_")} (product_id, agent_id, task)
      VALUES (${productId}, ${agentId}, 'Fix the flaky test.')
      RETURNING id, task
    `;
    assert.ok(rows[0]?.id, "sessions_ insert must return an id");
    assert.equal(rows[0]?.task, "Fix the flaky test.");

    await sql`
      UPDATE ${sql(schema)}.${sql("sessions_")}
      SET ended_at = now(), outcome = 'completed'
      WHERE id = ${rows[0]?.id}
    `;

    const [closed] = await sql<{ outcome: string | null }[]>`
      SELECT outcome FROM ${sql(schema)}.${sql("sessions_")} WHERE id = ${rows[0]?.id}
    `;
    assert.equal(closed?.outcome, "completed", "outcome is set at close");
  });
});
