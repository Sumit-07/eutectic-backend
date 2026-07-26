-- 0001_users_sessions_entitlements  (ticket M0-BE-02)
--
-- Identity and entitlement (system-design §5), plus the auth `sessions` table
-- specified by D-011 (absent from SD §5, which only names the httpOnly-cookie
-- session in §11). Additive only: CREATE TABLE / CREATE INDEX, nothing else.
--
-- Conventions (SD §5 preamble, applied here since the doc omits them for
-- brevity): every table gets `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`
-- and `created_at timestamptz NOT NULL DEFAULT now()`; `updated_at` is added
-- where rows mutate in place. `sessions` is the one exception — D-011 gives
-- its column list verbatim and it has no `updated_at` (rows are replaced, not
-- updated: revocation sets `revoked_at` once).

CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  github_id             bigint NOT NULL UNIQUE,
  github_login          text NOT NULL,
  github_created_at     timestamptz NOT NULL,        -- trust oracle input
  github_public_repos   int NOT NULL DEFAULT 0,
  handle                text NOT NULL UNIQUE,
  tier                  smallint NOT NULL DEFAULT 0,  -- 0..3
  tier_computed_at      timestamptz,
  deleted_at            timestamptz,
  handle_tombstoned     boolean NOT NULL DEFAULT false
);

-- Auth sessions (D-011): an opaque bearer token handed to the client in an
-- httpOnly cookie (SD §11). Only a hash of that token is ever persisted here —
-- `token_hash` is not the token, and the token itself is never written to any
-- table, log, or event. Distinct from the agent-execution `sessions_` table
-- (SD §5 "Grants, repos, products, sessions, findings"), which lands in a
-- later migration and is named with the trailing underscore for exactly this
-- reason.
CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users,
  token_hash  text NOT NULL UNIQUE,  -- hash of the opaque token; never the token itself
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);

-- Entitlements are rows with a validity window, never booleans on `users`
-- (SD §1 seam): a plan change closes the old row (`valid_to`) and opens a new
-- one, so entitlement history is queryable and payments webhooks (SD §11) are
-- pure inserts/updates, never a destructive write to `users`.
CREATE TABLE entitlements (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  user_id               uuid NOT NULL REFERENCES users,
  plan                  text NOT NULL,              -- 'free' | 'premium'
  max_posts_per_day     smallint NOT NULL,
  max_rounds            smallint NOT NULL,
  max_agent_responses   smallint NOT NULL,
  guaranteed_pickup     boolean NOT NULL,
  can_unlist            boolean NOT NULL,
  can_request_agent     boolean NOT NULL,
  residencies_allowed   smallint NOT NULL DEFAULT 0,
  valid_from            timestamptz NOT NULL,
  valid_to              timestamptz
);

CREATE INDEX entitlements_user_id_valid_from_idx ON entitlements (user_id, valid_from DESC);
