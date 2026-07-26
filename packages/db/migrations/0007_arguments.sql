-- 0007_arguments  (ticket M0-BE-08)
--
-- Arguments, argument_sides, argument_votes (system-design §5 "Arguments").
-- An Argument **references** contributions and never owns them — that single
-- choice is what lets it start admin-authored (`origin_contribution_id` null)
-- and become emergent out of a live disagreement (`origin_contribution_id`
-- set to the contribution that spawned it) with zero migration. Same seam
-- shape as `contributions.source_ref`: a nullable FK, not a second table.
--
-- Also in this migration, per D-013 (SD §8's pg_trgm index on `tags.slug` was
-- unassigned in batch 1, assigned here): the typeahead index. `pg_trgm` itself
-- is already created in 0000_extensions.sql — this migration only adds the
-- index, it does not re-create the extension.
--
-- Additive only: CREATE TABLE / CREATE INDEX, nothing else.
--
-- Conventions (D-013, ratified from the 0001-0006 wave): `updated_at` only
-- where a row mutates in place; SD's explicit composite PKs stand (no
-- surrogate `id`); no CHECK beyond what SD §5 writes explicitly — enum-like
-- text columns get a comment instead, validity lives in the service layer;
-- FK ON DELETE defaults to RESTRICT (no clause) unless SD writes CASCADE, and
-- SD writes no CASCADE here.
--
-- Numbering: 0007 per the D-011 protocol, assigned by the ticket.

-- SD gives `arguments` no explicit PK, so it gets the standard
-- `id`/`created_at` pair. `state` moves open -> judged (SD §5), hence
-- `updated_at` despite the table otherwise reading like a fact. No CHECK on
-- `created_by` or `state` — same reasoning as D-011's ink ruling and 0004's
-- `source_type`: a new creator or resolution state must not require a
-- migration, the service layer is the arbiter.
--
-- `origin_contribution_id` is the authored <-> emergent seam (SD §5's closing
-- note): null when the motion was authored directly (admin-seeded), set to
-- the contribution whose disagreement spawned the Argument when it emerged
-- from the floor. Nullable FK, no ON DELETE clause — SD writes none.
CREATE TABLE arguments (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  motion                 text NOT NULL,
  origin_contribution_id uuid REFERENCES contributions,  -- null when authored, set when emergent
  created_by             text NOT NULL,     -- 'admin' | 'agent'
  state                  text NOT NULL DEFAULT 'open'   -- 'open' | 'judged'
);

-- SD's explicit composite PK stands (argument_id, agent_id) — no surrogate
-- `id`. `contribution_id` is nullable because an agent takes a side before it
-- has written the contribution that argues it — the row is created at
-- side-taking time and `contribution_id` is filled in once the agent's
-- contribution lands, hence `updated_at` even though `side` itself is not
-- expected to flip. No CHECK on `side`: it is a signed direction (for/against
-- the motion), not an enumerable vocabulary the service layer needs to gate.
CREATE TABLE argument_sides (
  argument_id     uuid NOT NULL REFERENCES arguments,
  agent_id        uuid NOT NULL REFERENCES agents,
  side            smallint NOT NULL,
  contribution_id uuid REFERENCES contributions,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (argument_id, agent_id)
);

-- SD's explicit composite PK stands (argument_id, user_id) — no surrogate
-- `id`. Same shape as 0006's `votes`: a re-vote flips `side` in place, it
-- never adds a second row, hence `updated_at` despite there being no `id`.
-- No CHECK on `side`, same reasoning as `argument_sides`.
CREATE TABLE argument_votes (
  argument_id uuid NOT NULL REFERENCES arguments,
  user_id     uuid NOT NULL REFERENCES users,
  side        smallint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (argument_id, user_id)
);

-- SD §8's typeahead index, assigned to this ticket by D-013. `pg_trgm` is
-- already created (0000_extensions.sql); this is only the index. Deterministic
-- name per D-013's anonymous-index convention.
CREATE INDEX tags_slug_trgm_idx ON tags USING gin (slug gin_trgm_ops);
