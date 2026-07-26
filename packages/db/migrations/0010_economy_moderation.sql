-- 0010_economy_moderation  (ticket M0-BE-11)
--
-- credit_ledger, standing_ledger, auctions, bids, agent_proposals, reports,
-- moderation_actions, admin_audit (system-design §5 "Economy, registry,
-- moderation"). Two shapes in this migration: the append-only ledgers and
-- audit trails that only ever gain rows, and the mutating lifecycle tables
-- (auctions, bids, agent_proposals, reports) whose state advances in place.
--
-- Additive only: CREATE TABLE, nothing else.
--
-- Conventions (SD §5 preamble, D-013): every table gets
-- `id uuid PRIMARY KEY DEFAULT gen_random_uuid()` and
-- `created_at timestamptz NOT NULL DEFAULT now()`; `updated_at` is added only
-- where a row mutates in place. No CHECK constraints beyond those SD §5
-- writes explicitly (none, in this migration) — enum-like text columns get a
-- comment naming the known values, validity lives in the service layer
-- (D-011's ink ruling, extended by D-013). FK ON DELETE defaults to RESTRICT
-- everywhere — SD writes no CASCADE for any table here.
--
-- Numbering: 0010 per the D-011 protocol, assigned by the ticket. This branch
-- is off develop @ 65aa1b6 (migrations 0000-0007 shipped); 0008 (M0-BE-09)
-- and 0009 (M0-BE-10, commitments/bell_state/bell_messages/distress_flags)
-- are in flight on sibling branches and not present here — see this ticket's
-- PR body for the expected gap in migrate.test.ts's contiguity check.

-- The SD §1 seam (sixth row): "every future earn/spend reason slots in as a
-- row" via the generic `ref_type`/`ref_id` pair, deliberately uncheck-
-- constrained — a new earn/spend reason must not require a migration.
-- Append-only: there is no `updated_at` and, deliberately, **no balance
-- column anywhere and never will be** (this ticket's acceptance) — balance is
-- SUM(delta) over this table, cached in Redis (SD §5's own comment). `reason`
-- is text with no CHECK, same reasoning as the ref seam: SD gives no fixed
-- enum for it here, so none is invented.
CREATE TABLE credit_ledger (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  user_id    uuid NOT NULL REFERENCES users,
  delta      int NOT NULL,
  reason     text NOT NULL,
  -- the SD §1 seam: every future earn/spend reason slots in as a row, no
  -- schema change required.
  ref_type   text,
  ref_id     uuid
);

-- Standing's ledger, same shape and same seam as credit_ledger, and the same
-- append-only guarantee: no `updated_at`, no balance column, ever — balance
-- is SUM(delta), cached in Redis. `reason` is text with a comment only (no
-- CHECK, D-011's ink reasoning): a new earned-standing reason must not need a
-- migration. Standing derives from resolved outcomes a call held up, a
-- finding confirmed, a piece of work judged well- or weakly-made — never from
-- raw applause volume (CLAUDE.md §6 invariant: "standing from applause" is a
-- prohibited relaxation). Enforcing which events may write here is a
-- service-layer concern, not this table's.
CREATE TABLE standing_ledger (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  agent_id   uuid NOT NULL REFERENCES agents,
  delta      int NOT NULL,
  reason     text NOT NULL,   -- 'call_held_up'|'well_made'|'weak'|'finding_confirmed'
  ref_type   text,
  ref_id     uuid
);

-- Mutates in place (`state` advances as the window opens and closes), hence
-- `updated_at`. `resource_type`/`state` are text with comments only, no
-- CHECK: a new auctionable resource type or a new lifecycle state must not
-- need a migration.
CREATE TABLE auctions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  resource_type text NOT NULL,   -- 'session_slot'|'named_agent'
  resource_ref  text NOT NULL,
  window_start  timestamptz NOT NULL,
  window_end    timestamptz NOT NULL,
  state         text NOT NULL DEFAULT 'open'   -- 'open'|'closed'|'settled' (comment only, no CHECK)
);

-- Mutates in place: `won` starts NULL and is set (true for the winner, false
-- for the rest, or left NULL if the auction is cancelled) at auction close —
-- hence `updated_at`.
CREATE TABLE bids (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  auction_id uuid NOT NULL REFERENCES auctions,
  user_id    uuid NOT NULL REFERENCES users,
  amount     int NOT NULL,
  won        boolean
);

-- Mutates in place across the whole proposal lifecycle, hence `updated_at`.
-- `state` is text with a comment only, no CHECK (D-011's ink reasoning): a
-- new lifecycle state must not need a migration. `probation_forum_id`,
-- `probation_started_at` and `agent_id` are filled in as the proposal
-- advances (submitted -> probation sets the first two; probation -> promoted
-- sets the third) — all three start NULL. All SD columns carried verbatim,
-- including `differentiation_score real` and the two spend columns
-- (`fee_paid_cents`, `standing_spent`) that record what the proposer paid in
-- each currency to get here.
CREATE TABLE agent_proposals (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  proposer_user_id     uuid NOT NULL REFERENCES users,
  spec                 jsonb NOT NULL,
  fee_paid_cents       int NOT NULL DEFAULT 0,
  standing_spent       int NOT NULL DEFAULT 0,
  differentiation_score real,
  state                text NOT NULL DEFAULT 'submitted',
    -- 'submitted'|'rejected'|'probation'|'promoted'|'withdrawn' (comment only, no CHECK)
  probation_forum_id   uuid REFERENCES forums,
  probation_started_at timestamptz,
  agent_id             uuid REFERENCES agents
);

-- Mutates in place (`state` advances as a report is triaged), hence
-- `updated_at`. `reporter_user_id` stays NULLABLE exactly as SD writes it —
-- anonymous and system-generated reports have no reporting user.
-- `target_type`/`target_id` is a second generic polymorphic seam (same shape
-- as `diary_refs.ref_type`/`ref_id` and the ledgers' `ref_type`/`ref_id`): a
-- report can target any surface without a schema change. `reason`/`state`
-- are text with comments only, no CHECK.
CREATE TABLE reports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  reporter_user_id uuid REFERENCES users,
  -- generic seam: a report can target any surface, no schema change required.
  target_type      text NOT NULL,
  target_id        uuid NOT NULL,
  reason           text NOT NULL,
  state            text NOT NULL DEFAULT 'open'   -- comment only, no CHECK
);

-- Append-only: an admin action is a fact about what was done, never edited —
-- no `updated_at`. `target_type`/`target_id` is the same generic seam as
-- `reports`, letting a moderation action point at any surface.
CREATE TABLE moderation_actions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  admin_user_id uuid NOT NULL REFERENCES users,
  action        text NOT NULL,
  target_type   text NOT NULL,
  target_id     uuid NOT NULL,
  reason        text NOT NULL
);

-- Append-only: the audit trail of every admin action, never edited — no
-- `updated_at`. `payload` is the free-form record of what happened; its
-- shape is deliberately not fixed at the DB layer.
CREATE TABLE admin_audit (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  admin_user_id uuid NOT NULL REFERENCES users,
  action        text NOT NULL,
  payload       jsonb NOT NULL
);
