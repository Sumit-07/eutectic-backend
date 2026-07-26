-- 0005_calls  (ticket M0-BE-06)
--
-- Calls and resolution (system-design §5 "Calls and resolution"). A call is
-- an agent's checkable, dated prediction attached to a contribution — "this
-- will fail," "this won't ship by then," "that's the wrong price" — and the
-- three tables here are the whole lifecycle: the claim itself, the
-- checkpoints that come due and get answered, and the projection that turns
-- resolved calls into a calibration curve per agent.
--
-- Additive only: CREATE TABLE / CREATE INDEX, nothing else.
--
-- Conventions (SD §5 preamble, as applied in 0001-0004): every table here gets
-- `id uuid PRIMARY KEY DEFAULT gen_random_uuid()` and
-- `created_at timestamptz NOT NULL DEFAULT now()` unless SD gives an explicit
-- PK of its own (agent_calibration does), plus `updated_at` where rows mutate
-- in place — calls.state advances, call_checkpoints is filled in place when a
-- checkpoint fires and resolves, and agent_calibration's counters accumulate.
--
-- Numbering: 0005 per the D-011 protocol, assigned by the ticket.

-- THE seam (SD §1, fourth row): `contribution_id`, not `post_id`. A call
-- attaches to whichever contribution asserted it, and a contribution can come
-- from any surface (SD §1's first seam) — Validate, a PR review, a session, an
-- Argument, Bell. So a call can originate anywhere, without a schema change,
-- because it never points at a post. UNIQUE because a contribution makes at
-- most one claim.
--
-- `claim_type` is text with a comment, deliberately uncheck-constrained: new
-- claim types ('will_fail'|'wont_ship'|'wrong_price'|...) must not need a
-- migration (same reasoning as D-011's ink ruling). `confidence`'s CHECK is
-- the one SD §5 gives verbatim and is kept as-is — it is the calibration
-- curve's bucket key (agent_calibration.confidence), so its domain is fixed by
-- the schema, not by the service layer. `state` is text with a comment and no
-- CHECK, same reasoning as `claim_type` and D-011's ink ruling: a new
-- resolution state must not need a migration.
CREATE TABLE calls (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- the seam: a call attaches to a contribution, never a post, so it can
  -- originate on any surface a contribution can come from (SD §1).
  contribution_id uuid UNIQUE NOT NULL REFERENCES contributions,
  agent_id        uuid NOT NULL REFERENCES agents,
  claim           text NOT NULL,
  claim_type      text NOT NULL,   -- 'will_fail'|'wont_ship'|'wrong_price'|... (comment only, no CHECK)
  confidence      smallint NOT NULL CHECK (confidence BETWEEN 1 AND 5),
  horizon_days    int NOT NULL,
  state           text NOT NULL DEFAULT 'open'
                  -- 'open'|'held_up'|'did_not'|'unresolvable'|'expired' (comment only, no CHECK)
);

-- Append-only: rows are only ever ADDED to a call's history, never deleted.
-- `asked_at`/`answered_at`/`outcome`/`note`/`credit_paid` are filled in place
-- when a checkpoint fires and resolves, hence `updated_at`.
CREATE TABLE call_checkpoints (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  call_id       uuid NOT NULL REFERENCES calls,
  due_at        timestamptz NOT NULL,
  asked_at      timestamptz,
  answered_at   timestamptz,
  outcome       text,
  note          text,
  resolver_id   uuid REFERENCES users,
  credit_paid   int NOT NULL DEFAULT 0
);

-- Invariant 3's substrate ("no lost resolution"): the partial index over only
-- the unanswered rows is what makes "everything due and not yet answered" a
-- cheap index scan instead of a table scan, no matter how large the resolved
-- history grows. This is what drives the unanswered queue.
CREATE INDEX call_checkpoints_due_at_unanswered_idx
  ON call_checkpoints (due_at) WHERE answered_at IS NULL;

-- Projection (SD §5): SD gives this table an explicit composite PRIMARY KEY,
-- so there is no surrogate `id`. Counters mutate in place, hence `updated_at`.
-- The curve, not the number: held_up/resolved bucketed by stated confidence;
-- unresolved calls are excluded, never counted as wrong.
CREATE TABLE agent_calibration (
  agent_id     uuid NOT NULL REFERENCES agents,
  confidence   smallint NOT NULL,
  resolved     int NOT NULL DEFAULT 0,
  held_up      int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, confidence)
);
