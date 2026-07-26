/**
 * Worker test for M0-BE-11: migration 0010 (credit_ledger, standing_ledger,
 * auctions, bids, agent_proposals, reports, moderation_actions, admin_audit).
 *
 * Same conventions as `calls.test.ts` and `votes.test.ts`: every test applies
 * the *real* `migrations/` directory into a throwaway schema (dropped in
 * `after()`), so the suite never touches the dev database and is safely
 * rerunnable.
 *
 * This branch is off develop @ 65aa1b6 (migrations 0000-0007 shipped);
 * migrations 0008 (M0-BE-09) and 0009 (M0-BE-10, Bell's island) are in flight
 * on sibling branches and not present here, so the applied set has a gap at
 * 0008-0009 — deliberate per D-011 and this ticket's brief. This suite only
 * asserts that 0010 lands; the overall shipped-migrations contiguity check
 * belongs to `migrate.test.ts` and is expected to fail on this branch alone.
 *
 * The cases that matter are the acceptance criteria, not the tables' shape:
 *   - credit_ledger / standing_ledger: SUM(delta) over a mix of positive and
 *     negative deltas is correct, and — the acceptance that must hold
 *     forever — neither table has a `balance` column at all
 *     (information_schema.columns), and there is no UPDATE path exercised
 *     against a ledger row anywhere in this suite (append-only by
 *     convention; the write-API-level enforcement is a service-layer
 *     concern per the PR body).
 *   - agent_proposals: the full state walk submitted -> probation (with
 *     probation_forum_id/probation_started_at set) -> promoted (with
 *     agent_id set), via UPDATEs to the row itself (not the ledgers).
 *   - bids: insert with `won` NULL, then set true at auction close.
 *   - reports: reporter_user_id NULL (anonymous/system report) succeeds.
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

const MIGRATION_ID = "0010_economy_moderation";
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
  const schema = `m0be11_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
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

async function insertForum(schema: string, slug: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO ${sql(schema)}.${sql("forums")} (slug, name, tone_policy)
    VALUES (${slug}, ${slug}, 'plain')
    RETURNING id
  `;
  const id = rows[0]?.id;
  assert.ok(id, "insertForum must return an id");
  return id;
}

describe("migration 0010 — credit_ledger, standing_ledger, auctions, bids, agent_proposals, reports, moderation_actions, admin_audit", () => {
  it("applies the real migrations directory, and a second run is a no-op", async () => {
    const schema = useScratchSchema();

    const first = await migrate(schema);
    assert.ok(
      first.applied.includes(MIGRATION_ID),
      `expected ${MIGRATION_ID} among applied migrations: ${first.applied.join(", ")}`,
    );

    const second = await migrate(schema);
    assert.deepEqual([...second.applied], [], "second run applies nothing");
    assert.ok(second.skipped.includes(MIGRATION_ID), "second run recognises 0010 as already applied");
    // Deliberately not asserting overall contiguity here — this branch has a
    // gap at 0008-0009 (M0-BE-09, M0-BE-10, in flight on sibling branches per
    // D-011), and that overall check is migrate.test.ts's job, not this
    // file's.
  });

  it("credit_ledger: SUM(delta) over mixed deltas is correct, and there is no balance column", async () => {
    const schema = useScratchSchema();
    await migrate(schema);
    const userId = await insertUser(schema, 1, "ledgeruser");

    for (const delta of [100, -30, 5, -75]) {
      await sql`
        INSERT INTO ${sql(schema)}.${sql("credit_ledger")} (user_id, delta, reason)
        VALUES (${userId}, ${delta}, 'test_delta')
      `;
    }

    const [row] = await sql<{ balance: number }[]>`
      SELECT COALESCE(SUM(delta), 0)::int AS balance FROM ${sql(schema)}.${sql("credit_ledger")}
      WHERE user_id = ${userId}
    `;
    assert.equal(row?.balance, 0, "100 - 30 + 5 - 75 = 0");

    const columns = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${schema} AND table_name = 'credit_ledger'
    `;
    assert.ok(
      !columns.some((c) => c.column_name === "balance"),
      "credit_ledger must never have a balance column — balance is SUM(delta), cached in Redis",
    );
  });

  it("standing_ledger: SUM(delta) over mixed deltas is correct, and there is no balance column", async () => {
    const schema = useScratchSchema();
    await migrate(schema);
    const agentId = await insertAgent(schema, "standingagent");

    const deltas: Array<[number, string]> = [
      [100, "call_held_up"],
      [-30, "weak"],
      [5, "well_made"],
      [-75, "weak"],
    ];
    for (const [delta, reason] of deltas) {
      await sql`
        INSERT INTO ${sql(schema)}.${sql("standing_ledger")} (agent_id, delta, reason)
        VALUES (${agentId}, ${delta}, ${reason})
      `;
    }

    const [row] = await sql<{ balance: number }[]>`
      SELECT COALESCE(SUM(delta), 0)::int AS balance FROM ${sql(schema)}.${sql("standing_ledger")}
      WHERE agent_id = ${agentId}
    `;
    assert.equal(row?.balance, 0, "100 - 30 + 5 - 75 = 0");

    const columns = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${schema} AND table_name = 'standing_ledger'
    `;
    assert.ok(
      !columns.some((c) => c.column_name === "balance"),
      "standing_ledger must never have a balance column — balance is SUM(delta), cached in Redis",
    );
  });

  it("credit_ledger and standing_ledger carry the generic ref_type/ref_id seam (SD §1)", async () => {
    const schema = useScratchSchema();
    await migrate(schema);
    const userId = await insertUser(schema, 2, "refuser");
    const agentId = await insertAgent(schema, "refagent");

    const refId = randomUUID();
    await sql`
      INSERT INTO ${sql(schema)}.${sql("credit_ledger")} (user_id, delta, reason, ref_type, ref_id)
      VALUES (${userId}, 50, 'auction_win', 'auction', ${refId})
    `;
    await sql`
      INSERT INTO ${sql(schema)}.${sql("standing_ledger")} (agent_id, delta, reason, ref_type, ref_id)
      VALUES (${agentId}, 10, 'finding_confirmed', 'contribution', ${refId})
    `;

    const [creditRow] = await sql<{ ref_type: string; ref_id: string }[]>`
      SELECT ref_type, ref_id FROM ${sql(schema)}.${sql("credit_ledger")} WHERE user_id = ${userId}
    `;
    assert.equal(creditRow?.ref_type, "auction");
    assert.equal(creditRow?.ref_id, refId);

    const [standingRow] = await sql<{ ref_type: string; ref_id: string }[]>`
      SELECT ref_type, ref_id FROM ${sql(schema)}.${sql("standing_ledger")} WHERE agent_id = ${agentId}
    `;
    assert.equal(standingRow?.ref_type, "contribution");
    assert.equal(standingRow?.ref_id, refId);

    // ref_type/ref_id are also nullable — an earn/spend row need not point
    // anywhere.
    await sql`
      INSERT INTO ${sql(schema)}.${sql("credit_ledger")} (user_id, delta, reason)
      VALUES (${userId}, -5, 'no_ref_reason')
    `;
  });

  it("auctions and bids: a bid inserts with won NULL, then is set true at auction close", async () => {
    const schema = useScratchSchema();
    await migrate(schema);
    const userId = await insertUser(schema, 3, "bidder");

    const auctionRows = await sql<{ id: string }[]>`
      INSERT INTO ${sql(schema)}.${sql("auctions")}
        (resource_type, resource_ref, window_start, window_end)
      VALUES ('session_slot', 'slot-1', now(), now() + interval '1 day')
      RETURNING id
    `;
    const auctionId = auctionRows[0]?.id;
    assert.ok(auctionId, "auction insert must return an id");

    const bidRows = await sql<{ id: string; won: boolean | null }[]>`
      INSERT INTO ${sql(schema)}.${sql("bids")} (auction_id, user_id, amount)
      VALUES (${auctionId}, ${userId}, 500)
      RETURNING id, won
    `;
    const bidId = bidRows[0]?.id;
    assert.ok(bidId, "bid insert must return an id");
    assert.equal(bidRows[0]?.won, null, "won starts NULL — the auction has not closed");

    await sql`
      UPDATE ${sql(schema)}.${sql("bids")} SET won = true WHERE id = ${bidId}
    `;
    await sql`
      UPDATE ${sql(schema)}.${sql("auctions")} SET state = 'settled' WHERE id = ${auctionId}
    `;

    const [wonRow] = await sql<{ won: boolean }[]>`
      SELECT won FROM ${sql(schema)}.${sql("bids")} WHERE id = ${bidId}
    `;
    assert.equal(wonRow?.won, true, "won flips to true at auction close");
  });

  it("agent_proposals: full state walk submitted -> probation -> promoted", async () => {
    const schema = useScratchSchema();
    await migrate(schema);
    const proposerId = await insertUser(schema, 4, "proposer");
    const forumId = await insertForum(schema, "probation-forum");

    const rows = await sql<{ id: string; state: string }[]>`
      INSERT INTO ${sql(schema)}.${sql("agent_proposals")}
        (proposer_user_id, spec, fee_paid_cents, standing_spent, differentiation_score)
      VALUES (${proposerId}, ${sql.json({ persona: "a test agent" })}, 5000, 20, 0.82)
      RETURNING id, state
    `;
    const proposalId = rows[0]?.id;
    assert.ok(proposalId, "agent_proposals insert must return an id");
    assert.equal(rows[0]?.state, "submitted", "state defaults to 'submitted'");

    // submitted -> probation: probation_forum_id and probation_started_at are
    // filled in as the proposal advances.
    await sql`
      UPDATE ${sql(schema)}.${sql("agent_proposals")}
      SET state = 'probation', probation_forum_id = ${forumId}, probation_started_at = now()
      WHERE id = ${proposalId}
    `;
    const [probationRow] = await sql<
      { state: string; probation_forum_id: string | null; probation_started_at: Date | null; agent_id: string | null }[]
    >`
      SELECT state, probation_forum_id, probation_started_at, agent_id
      FROM ${sql(schema)}.${sql("agent_proposals")} WHERE id = ${proposalId}
    `;
    assert.equal(probationRow?.state, "probation");
    assert.equal(probationRow?.probation_forum_id, forumId, "probation_forum_id is set");
    assert.ok(probationRow?.probation_started_at, "probation_started_at is set");
    assert.equal(probationRow?.agent_id, null, "agent_id is still unset at the probation stage");

    // probation -> promoted: agent_id is filled in once the proposal clears
    // probation and becomes a real registry agent.
    const agentId = await insertAgent(schema, "promoted-agent");
    await sql`
      UPDATE ${sql(schema)}.${sql("agent_proposals")}
      SET state = 'promoted', agent_id = ${agentId}
      WHERE id = ${proposalId}
    `;
    const [promotedRow] = await sql<{ state: string; agent_id: string | null }[]>`
      SELECT state, agent_id FROM ${sql(schema)}.${sql("agent_proposals")} WHERE id = ${proposalId}
    `;
    assert.equal(promotedRow?.state, "promoted");
    assert.equal(promotedRow?.agent_id, agentId, "agent_id is set once promoted");
  });

  it("reports: reporter_user_id NULL succeeds — anonymous and system-generated reports", async () => {
    const schema = useScratchSchema();
    await migrate(schema);

    const rows = await sql<{ id: string; reporter_user_id: string | null }[]>`
      INSERT INTO ${sql(schema)}.${sql("reports")} (reporter_user_id, target_type, target_id, reason)
      VALUES (${null}, 'post', ${randomUUID()}, 'looks like spam')
      RETURNING id, reporter_user_id
    `;
    assert.ok(rows[0]?.id, "reports insert must return an id");
    assert.equal(rows[0]?.reporter_user_id, null, "an anonymous/system report has no reporting user");

    // A reported report still works with a real reporter, for contrast.
    const reporterId = await insertUser(schema, 5, "reporter1");
    const withReporter = await sql<{ reporter_user_id: string | null }[]>`
      INSERT INTO ${sql(schema)}.${sql("reports")} (reporter_user_id, target_type, target_id, reason)
      VALUES (${reporterId}, 'post', ${randomUUID()}, 'off-topic')
      RETURNING reporter_user_id
    `;
    assert.equal(withReporter[0]?.reporter_user_id, reporterId);
  });

  it("moderation_actions and admin_audit: append-only rows, generic target seam", async () => {
    const schema = useScratchSchema();
    await migrate(schema);
    const adminId = await insertUser(schema, 6, "admin1");
    const targetId = randomUUID();

    const actionRows = await sql<{ id: string }[]>`
      INSERT INTO ${sql(schema)}.${sql("moderation_actions")}
        (admin_user_id, action, target_type, target_id, reason)
      VALUES (${adminId}, 'remove', 'post', ${targetId}, 'violates tone policy')
      RETURNING id
    `;
    assert.ok(actionRows[0]?.id, "moderation_actions insert must return an id");

    const auditRows = await sql<{ id: string }[]>`
      INSERT INTO ${sql(schema)}.${sql("admin_audit")} (admin_user_id, action, payload)
      VALUES (${adminId}, 'remove_post', ${sql.json({ target_id: targetId, target_type: "post" })})
      RETURNING id
    `;
    assert.ok(auditRows[0]?.id, "admin_audit insert must return an id");

    const [count] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.${sql("moderation_actions")} WHERE admin_user_id = ${adminId}
    `;
    assert.equal(count?.n, 1, "one moderation_actions row recorded");
  });
});
