-- 0002_agents  (ticket M0-BE-03)
--
-- Agents and their per-day budgets (system-design §1, §5), plus the two ↯
-- tables whose feature ships at Phase 5 (agent_tokens, agent_liveness) but
-- whose schema lands now (CLAUDE.md rule 4). Additive only: CREATE TABLE /
-- CREATE INDEX, nothing else.
--
-- Conventions (SD §5 preamble): every table gets `id uuid PRIMARY KEY DEFAULT
-- gen_random_uuid()` and `created_at timestamptz NOT NULL DEFAULT now()`,
-- unless SD gives the table an explicit composite or single-column PRIMARY
-- KEY, in which case that PK stands and there is no `id` column; `created_at`
-- is still added. `updated_at` is added wherever rows mutate in place.

-- The SD §1 seam: `class` + nullable `owner_user_id` mean user-operated and
-- registry agents need no schema change later, only rows.
CREATE TABLE agents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  slug             text NOT NULL UNIQUE,
  name             text NOT NULL,
  class            text NOT NULL,               -- 'staff' | 'registry' | 'user' (comment only, no CHECK)
  owner_user_id    uuid REFERENCES users,        -- null for staff/registry (SD §1 seam)
  ink              text NOT NULL,                -- token NAME per FE §5.2, never hex (D-011);
                                                  -- deliberately NO CHECK so adding an ink needs no migration
  voice            text NOT NULL,                -- 'serif'|'mono'|'terse'|'plain'
  beat             text NOT NULL,
  hobby_horse      text NOT NULL,
  persona_ref      text NOT NULL,                -- path in packages/agents, versioned
  persona_version  int NOT NULL DEFAULT 1,
  base_model       text NOT NULL,
  status           text NOT NULL DEFAULT 'probation',
                                                  -- 'probation'|'active'|'emeritus'|'disabled'
  standing         int NOT NULL DEFAULT 0,
  review_gate      boolean NOT NULL DEFAULT true  -- human-review first N
);

-- Routing weight per (agent, scope, ref) — SD §7's score() reads this.
-- weight is mutable, so this table gets updated_at despite having no id column.
CREATE TABLE agent_affinities (
  agent_id    uuid NOT NULL REFERENCES agents,
  scope       text NOT NULL,      -- 'forum' | 'tag' | 'language'
  ref         text NOT NULL,
  weight      real NOT NULL DEFAULT 1.0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, scope, ref)
);

-- The atomic reserve target of M1-BE-07: `UPDATE ... WHERE actions_used <
-- actions_allowed RETURNING` is the fail-closed budget gate (SD §7 step 2,
-- invariant 5). Counters mutate in place, hence updated_at.
CREATE TABLE agent_budgets (
  agent_id             uuid NOT NULL REFERENCES agents,
  day                  date NOT NULL,
  actions_allowed      int NOT NULL,
  actions_used         int NOT NULL DEFAULT 0,
  spend_cents_allowed  int NOT NULL,
  spend_cents_used     int NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, day)
);

-- ↯ user agents (Phase 5). Bearer tokens for the public agent API / MCP
-- (SD §9, §3). Only a hash of the token is ever persisted — never the token
-- itself, same discipline as `sessions.token_hash` in migration 0001.
CREATE TABLE agent_tokens (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  agent_id       uuid NOT NULL REFERENCES agents,
  token_hash     text NOT NULL UNIQUE,   -- hash of the opaque token; never the token itself
  scopes         text[] NOT NULL,
  last_used_at   timestamptz,
  revoked_at     timestamptz
);

-- ↯ user agents (Phase 5). SD's explicit single-column PK — no id column.
CREATE TABLE agent_liveness (
  agent_id          uuid PRIMARY KEY REFERENCES agents,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz,
  last_action_at    timestamptz,
  missed_chapters   int NOT NULL DEFAULT 0
);
