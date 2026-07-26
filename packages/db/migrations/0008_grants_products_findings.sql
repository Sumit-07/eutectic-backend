-- 0008_grants_products_findings  (ticket M0-BE-09)
--
-- Grants, repos, reviews, products, connections, sessions_, findings,
-- finding_events, residencies and deploy_signals (system-design §5 "Grants,
-- repos, products, sessions, findings"). This is the machinery behind two
-- surfaces at once: unprompted PR review (repos/reviews) and product
-- residency (products/connections/sessions_/findings/finding_events/
-- residencies/deploy_signals) — an agent moving into a user's product to work
-- it, the way it moves into a repo to review it.
--
-- `grants` carries the second row of the SD §1 seam table: `target_type` +
-- `target_id` ('repo' | 'product'), because a repo grant and a product grant
-- are the same shape of thing — a user handing an agent scoped access to
-- something it owns — so one table serves both instead of two near-identical
-- ones.
--
-- Additive only: CREATE TABLE / CREATE INDEX, nothing else.
--
-- Conventions (SD §5 preamble, D-013): every table here gets
-- `id uuid PRIMARY KEY DEFAULT gen_random_uuid()` and
-- `created_at timestamptz NOT NULL DEFAULT now()` — SD gives none of these ten
-- an explicit PK, including `reviews` and `residencies`, whose UNIQUE
-- constraints are not primary keys — plus `updated_at` wherever a row mutates
-- in place. `reviews`, `finding_events` and `deploy_signals` are the
-- exceptions: a filed review, a state-transition log line and a delivery
-- signal are each an immutable record of something that already happened, so
-- none of the three gets `updated_at`. No CHECK constraints beyond what SD §5
-- writes explicitly (SD §5 writes none here) — enum-like text columns get a
-- comment, validity lives in the service layer (D-011, D-013). FK ON DELETE
-- defaults to RESTRICT everywhere; SD writes no CASCADE in this section.
--
-- Numbering: 0008 per the D-011 protocol, assigned by the ticket. 0007 (the
-- M0-BE-08 migration, arguments/sides/argument_votes + the tags.slug pg_trgm
-- index) is in flight on a sibling branch and is not present here — see this
-- ticket's PR body for the expected, correct gap in migrate.test.ts's
-- contiguity check.

-- SD §1's second seam row: repos and products are the same object shape from
-- a grant's point of view — a user handing an agent scoped, revocable access
-- to something the user owns — so `target_type` + `target_id` lets one table
-- serve both instead of forking into `repo_grants` / `product_grants`.
-- Deliberately no CHECK on `target_type` (comment only, D-011's ink
-- reasoning): a third grantable object must not require a migration.
-- `scopes` is `text[]` — a grant can carry more than one permission string at
-- once (e.g. 'review'|'comment'). Revocation is an UPDATE that flips
-- `revoked_at` in place, never a DELETE — the grant's history (what was
-- granted, when, and when it stopped) is itself an auditable fact — hence
-- `updated_at` alongside SD's own `granted_at`.
CREATE TABLE grants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  user_id     uuid NOT NULL REFERENCES users,
  target_type text NOT NULL,      -- 'repo' | 'product' (SD §1 seam; comment only, no CHECK)
  target_id   uuid NOT NULL,
  scopes      text[] NOT NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);

-- One row per installed GitHub repo. `full_name` and `installation_id` track
-- GitHub's own state for that repo (a rename, a reinstall) and mutate in
-- place, hence `updated_at`. `github_repo_id` is the stable external key GitHub
-- never reassigns, so it is the UNIQUE, not `full_name`.
CREATE TABLE repos (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  user_id         uuid NOT NULL REFERENCES users,
  github_repo_id  bigint UNIQUE NOT NULL,
  full_name       text NOT NULL,
  installation_id bigint NOT NULL
);

-- A filed review is an immutable record once written — no `updated_at`.
-- `unprompted` distinguishes an agent reviewing on its own initiative from one
-- asked to; `files`/`adds`/`dels` are nullable (SD gives them no NOT NULL —
-- GitHub's diff stats may not always be available). UNIQUE (repo_id,
-- pr_number, agent_id): one review per agent per PR.
CREATE TABLE reviews (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  repo_id         uuid NOT NULL REFERENCES repos,
  agent_id        uuid NOT NULL REFERENCES agents,
  pr_number       int NOT NULL,
  contribution_id uuid NOT NULL REFERENCES contributions,
  unprompted      boolean NOT NULL DEFAULT true,
  files int, adds int, dels int,
  UNIQUE (repo_id, pr_number, agent_id)
);

-- A product is a thing the user owns that an agent can be resident in and
-- work on (the residency surface's root). `sandbox_declaration` is the
-- allowed-hosts / destructive-verb denylist the sandbox is bound to;
-- `dry_run_approved_at` starts null and is set later, in place, once a dry run
-- clears — residency stays blocked until then — hence `updated_at`.
CREATE TABLE products (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  owner_user_id       uuid NOT NULL REFERENCES users,
  name                text NOT NULL,
  purpose             text NOT NULL,
  sandbox_declaration jsonb NOT NULL,   -- allowed hosts, destructive-verb denylist
  dry_run_approved_at timestamptz       -- residency blocked until set
);

-- How an agent actually reaches a product. `credentials_ref` is a KMS
-- reference, never the secret — the secret itself never touches this table or
-- any row derived from it. `verified_at` starts null and is set later, in
-- place, once the connection has been proven live — hence `updated_at`.
CREATE TABLE connections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  product_id      uuid NOT NULL REFERENCES products,
  kind            text NOT NULL,   -- 'mcp' | 'http' | 'cli' | 'browser' (comment only, no CHECK)
  endpoint        text NOT NULL,
  credentials_ref text,            -- KMS reference, never the secret
  verified_at     timestamptz
);

-- The table name IS `sessions_`, trailing underscore and all — SD's
-- deliberate disambiguation from the auth `sessions` table (0001,
-- `identity.ts`), which is an unrelated concept (a login token, not an
-- agent's working session inside a product). One row per agent working a
-- product for one task; `ended_at`/`outcome`/`stalled_step` are set at close,
-- in place, hence `updated_at`. `transcript_ref` is an object storage key
-- (SD §0: output only, no full reasoning traces retained).
CREATE TABLE sessions_ (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  product_id     uuid NOT NULL REFERENCES products,
  agent_id       uuid NOT NULL REFERENCES agents,
  task           text NOT NULL,
  started_at     timestamptz NOT NULL DEFAULT now(),
  ended_at       timestamptz,
  outcome        text,          -- 'completed'|'stalled'|'error'|'refused' (comment only, no CHECK)
  stalled_step   smallint,
  steps_total    smallint,
  transcript_ref text,          -- object storage key
  runner_id      text
);

-- What a session turns up. `state` starts 'open' and mutates in place, hence
-- `updated_at`. The seven states SD names: open|fixed|confirmed|reopened|
-- ignored|disputed|stale — comment only, deliberately no CHECK (D-011's ink
-- reasoning: a new state must not need a migration). Finding state
-- transitions are guarded by row lock + transition whitelist in the service
-- layer, not by the schema — `finding_events` is the audit trail those
-- guarded transitions write to.
CREATE TABLE findings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  product_id  uuid NOT NULL REFERENCES products,
  agent_id    uuid NOT NULL REFERENCES agents,
  session_id  uuid REFERENCES sessions_,
  title       text NOT NULL,
  body        text NOT NULL,
  severity    smallint NOT NULL,
  state       text NOT NULL DEFAULT 'open'
    -- open|fixed|confirmed|reopened|ignored|disputed|stale (comment only, no CHECK)
);

-- Append-only log of every state change a finding goes through — never
-- updated, never deleted, hence no `updated_at`. `from_state` is nullable
-- (the row created when a finding opens has no prior state); `to_state` is
-- always known. `actor_type`/`actor_id` name who drove the transition (an
-- agent, a user, or the system); `actor_id` is deliberately un-FK'd because it
-- is polymorphic across those actor types, same shape as SD's other
-- polymorphic refs (SD §1).
CREATE TABLE finding_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  finding_id uuid NOT NULL REFERENCES findings,
  from_state text, to_state text NOT NULL,
  actor_type text NOT NULL, actor_id uuid,
  note       text
);

-- One row per (product, agent): SD gives this table a UNIQUE, not a PRIMARY
-- KEY, so it gets the standard surrogate `id` like every other table in this
-- migration (D-013) while the UNIQUE (product_id, agent_id) still stands —
-- an agent has at most one residency per product. `active` flips and
-- `last_retest_at` mutates in place, hence `updated_at`.
CREATE TABLE residencies (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  product_id     uuid NOT NULL REFERENCES products,
  agent_id       uuid NOT NULL REFERENCES agents,
  active         boolean NOT NULL DEFAULT true,
  last_retest_at timestamptz,
  UNIQUE (product_id, agent_id)
);

-- Append-only: every inbound signal that a product deployed (a webhook fired,
-- a poll observed a change, an owner declared it) is its own row, never
-- edited — no `updated_at`. `source` names the channel (comment only, no
-- CHECK, same reasoning throughout this migration); `credit_cost` is what the
-- signal cost to observe (e.g. a poll's inference spend).
CREATE TABLE deploy_signals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  product_id  uuid NOT NULL REFERENCES products,
  source      text NOT NULL,   -- 'webhook'|'poll'|'owner_declared' (comment only, no CHECK)
  ref         text,
  credit_cost int NOT NULL DEFAULT 0
);

-- Revocation and grant lookups by user (grants list, permission checks).
CREATE INDEX grants_user_id_idx ON grants (user_id);

-- The unanswered-review and session-history read paths: an agent's own
-- findings/sessions, newest first.
CREATE INDEX findings_product_id_idx ON findings (product_id);
CREATE INDEX finding_events_finding_id_created_at_idx ON finding_events (finding_id, created_at);
