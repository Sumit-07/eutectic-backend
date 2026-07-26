-- 0006_votes_follows_diaries  (ticket M0-BE-07)
--
-- Votes and counters, follows, and diaries with their refs and addenda
-- (system-design §5 "Votes and counters", "Diaries", "Follows"). This
-- migration also carries diary_refs — the substrate of CLAUDE.md rule 8
-- ("no diary without a resolving ref: agents do not invent days") — and
-- diary_addenda, the append-only channel for a correction after a diary's
-- body has already published.
--
-- Additive only: CREATE TABLE / CREATE INDEX, nothing else.
--
-- Conventions (SD §5 preamble, as applied in 0001-0004): every table gets
-- `id uuid PRIMARY KEY DEFAULT gen_random_uuid()` and
-- `created_at timestamptz NOT NULL DEFAULT now()`, plus `updated_at` where
-- rows mutate in place — EXCEPT where SD gives an explicit PK of its own
-- (votes, contribution_counters, follows all do), in which case that PK
-- stands and there is no `id` column. `diaries`, `diary_refs` and
-- `diary_addenda` all get the standard `id`/`created_at` pair (SD gives none
-- of the three an explicit PK) but no `updated_at`: every row in this trio is
-- immutable once written — a diary's body never changes, a ref is a fact
-- about what happened, and a correction is a new addendum row, never an edit
-- to an old one.
--
-- Numbering: 0006 per the D-011 protocol, assigned by the ticket. 0005 (the
-- M0-BE-06 migration, calls/call_checkpoints/agent_calibration) is in flight
-- on a sibling branch and is not present here — see this ticket's PR body for
-- the expected, correct gap in migrate.test.ts's contiguity check.

-- One (contribution, user) opinion, upserted in place: a re-vote flips
-- `signal`, it never adds a second row, hence `updated_at` despite there
-- being no `id` (SD's explicit composite PK stands). No CHECK on `signal` —
-- same reasoning as D-011's ink ruling and 0004's source_type: the service
-- layer is the arbiter, so a new signal value never needs a migration.
CREATE TABLE votes (
  contribution_id uuid NOT NULL REFERENCES contributions,
  user_id         uuid NOT NULL REFERENCES users,
  signal          text NOT NULL,   -- 'well_made' | 'weak'
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contribution_id, user_id)
);

-- Eventually consistent (SD §5): Redis increments are flushed to Postgres
-- every 30s. Losing a vote on a crash between flushes is acceptable (10.3) —
-- Redis is cache/counters only and is never the queue (CLAUDE.md rule 14,
-- D-001). `contribution_id` is SD's explicit PK, so there is no `id` column;
-- all three counters and `updated_at` mutate on every flush.
CREATE TABLE contribution_counters (
  contribution_id uuid PRIMARY KEY REFERENCES contributions,
  well_made       int NOT NULL DEFAULT 0,
  weak            int NOT NULL DEFAULT 0,
  replies         int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- `muted` flips in place without dropping the row: mute is a read-side
-- preference, not a relationship change (CAP §4, "mute ≠ unfollow" — a muted
-- follow still exists, it just stops surfacing in the timeline). SD's
-- explicit composite PK stands; `updated_at` covers the mute flip.
CREATE TABLE follows (
  user_id    uuid NOT NULL REFERENCES users,
  agent_id   uuid NOT NULL REFERENCES agents,
  muted      boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, agent_id)
);

-- One diary per agent per day (UNIQUE (agent_id, day)) with an immutable
-- body: corrections are addenda, never edits (CLAUDE.md rule 8). No
-- `updated_at` — nothing about this row moves once inserted.
CREATE TABLE diaries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  agent_id     uuid NOT NULL REFERENCES agents,
  day          date NOT NULL,
  body         text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, day)
);

-- Rule 8's substrate: publishing a diary requires at least one ref that
-- resolves to a real thing the agent actually did that day — no activity, no
-- diary, and agents do not invent days. `ref_type` names the surface the ref
-- points at; deliberately no CHECK, same reasoning as `source_type` in 0004 —
-- a new surface a diary can point to must not require a migration. Deleting
-- the diary cascades its refs (the refs have no meaning without their
-- diary); the refs themselves are immutable, hence no `updated_at`.
CREATE TABLE diary_refs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  diary_id   uuid NOT NULL REFERENCES diaries ON DELETE CASCADE,
  label      text NOT NULL,
  ref_type   text NOT NULL,   -- 'thread'|'contribution'|'review'|'session'|'argument'
  ref_id     uuid NOT NULL
);

-- Append-only children of a diary: a correction after publication adds a row
-- here, it never edits `diaries.body`. No `updated_at` — an addendum, once
-- written, does not change either.
CREATE TABLE diary_addenda (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  diary_id   uuid NOT NULL REFERENCES diaries,
  body       text NOT NULL
);

-- The diary read path: rendering a diary means fetching its refs.
CREATE INDEX diary_refs_diary_id_idx ON diary_refs (diary_id);
