-- 0013_provenance_identity_settings  (ticket P-01)
--
-- The pre-M1 batch: contribution provenance, shadow mode, pseudonymous
-- identity, the handle namespace, platform settings, avatar seeds, bios, the
-- profile vote index and the affinity soft-weight compression
-- (DIRECTIVE-pre-M1 §2/§3/§9; D-029, D-030, D-032, D-033, D-035, D-036).
--
-- ONE migration, not five (the directive's instruction, D-037 item 1). Every
-- reference in the directive to "migration 0012" reads as 0013: 0012 was
-- already taken by `idempotency_responses` before the directive was written.
--
-- Additive only: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS /
-- CREATE INDEX IF NOT EXISTS, one DEFAULT change, one added CHECK, and three
-- one-shot backfill UPDATEs. Nothing is dropped, renamed or narrowed, so this
-- is not a destructive migration (CLAUDE.md rule 5, §6 "Destructive").
--
-- **Forward-only. There is deliberately no `0013_down.sql`** — D-038(a)
-- resolved the directive's "0012_down.sql exists and is tested" acceptance item
-- in favour of the standing `packages/db/README.md` convention: the runner has
-- no `down`, and a fix goes forward as a new file.
--
-- Conventions (SD §5 preamble, D-013): `created_at timestamptz NOT NULL DEFAULT
-- now()` on every new table; `updated_at` only where a row mutates in place; no
-- CHECK constraints on enum-like text — the known values are named in a comment
-- and validity lives in the service layer, with exactly one exception,
-- `selected_by`, ruled by D-042/D-043 (see RULING 2); indexes are named
-- explicitly. The
-- directive writes three of its indexes unnamed (`CREATE INDEX ON t (...)`);
-- they are given here the exact names Postgres would have generated, so the
-- name is in review rather than in a catalogue.

-- ============================================================================
-- RULING 1 — ONE handle system, not two
-- ============================================================================
-- `users.handle_tombstoned` already exists (migration 0001, SD §5) and this
-- migration adds `handle_history` and `reserved_handles`. The ticket requires a
-- ruling on how they compose. They are three DISJOINT sources answering one
-- question, and there is exactly one predicate that reads all three:
--
--   available(h)  ⇔  NOT EXISTS (SELECT 1 FROM users            WHERE handle = h)
--                AND NOT EXISTS (SELECT 1 FROM reserved_handles WHERE handle = h)
--                AND NOT EXISTS (SELECT 1 FROM handle_history
--                                 WHERE handle = h AND reserved_until > now())
--
-- (`migration-0013.test.ts` executes exactly this query over a fixture covering
-- every branch; P-08 and the signup path must use it and must not invent a
-- second one.)
--
-- Who owns what, and why there is no overlap:
--
--   * `users.handle` — every handle CURRENTLY SPENT, by a live account or a
--     closed one. Account closure sets `deleted_at` + `handle_tombstoned` and
--     KEEPS THE ROW: `/u/[handle]` must still render "account closed" rather
--     than 404 (frontend-spec §10), which is only possible while the row and
--     its handle survive. The existing UNIQUE index therefore already makes a
--     tombstoned handle permanently unclaimable, at zero cost.
--     **`handle_tombstoned` is a closure marker, never a reservation
--     mechanism.** Its one job is to tell a reader "this account is gone"
--     without reusing `deleted_at` (which is also set by administrative
--     removals that do not retire the name).
--
--   * `handle_history` — handles RELEASED BY A LIVE ACCOUNT that renamed. This
--     is the ONLY path that frees a name, and it frees it slowly: 90 days
--     (§9), so old links do not rot into someone else's profile and squatting
--     is awkward. A row here is temporary by construction — once
--     `reserved_until` passes, the name is available again. NOTHING writes a
--     tombstoned account's handle here: that handle is never released at all,
--     so a row would be a lie with an expiry date on it.
--
--   * `reserved_handles` — the PERMANENT denylist, hand-curated: staff agent
--     slugs, the brand, roles, and (later) well-known founders and investors.
--     Nothing in the account lifecycle ever inserts into it.
--
-- Rejected alternative: writing a `reserved_handles` row on account closure,
-- which would have made "unavailable" a single-table lookup. It conflates a
-- curated policy list with per-account lifecycle data, it duplicates a fact the
-- UNIQUE index on `users.handle` already enforces, and it needs a compensating
-- delete if a closure is ever reversed. Three narrow sources and one predicate
-- beats one wide table and a discriminator column.
--
-- Moderation history keys off `user_id` and is untouched by any of this (§9).

-- ============================================================================
-- RULING 2 — `selected_by`: settled by D-042 item 1, refined by D-043
-- ============================================================================
-- The directive was internally inconsistent: §2's DDL comment said
-- 'scored' | 'exploration' | 'floor'; §4 and D-033 said
-- 'coverage' | 'discretionary' | 'exploration'. **D-042 item 1 rules that §2's
-- comment is a stale earlier draft and D-033's set is the vocabulary.** D-042's
-- `NOT NULL` shape is superseded by **D-043**, which is the final resolution:
-- nullable, no default, with a CHECK conditional on `author_type`.
--
-- `contributions` is not agent-only — `author_type` is 'agent' | 'user' — and
-- this vocabulary names agent ROUTING PASSES. A blanket NOT NULL would force
-- every human reply to claim a pass nobody ran, and every eval grouping by this
-- column would then count that reply as a coverage pick: it would inflate
-- exactly the metric the constraint exists to protect. So a human row is
-- honestly NULL.
--
-- The conditional form is stronger than a plain NOT NULL in both directions:
--   * an agent insert that omits the value still fails at insert time (23514
--     rather than 23502) — the turn worker must always say how it was picked;
--   * a human insert CLAIMING a routing pass also fails, which a plain NOT NULL
--     would have accepted silently.
-- Consequently an eval query never needs an `author_type` filter to trust this
-- column: non-null means routed, full stop.
--
-- **This column deliberately carries a CHECK, overriding the D-013 house style
-- of naming enum-like values in a comment and validating in the service layer.**
-- D-042/D-043 are the newer decisions and name this column specifically:
-- `selected_by` is the field every routing eval groups by, so a wrong value is
-- not a bad row, it is a silently wrong measurement of how the product picks
-- who speaks. D-013 still governs every other enum-like text column here.
--
-- **No DEFAULT, ever** (D-043 forecloses one). Rows that predate routing are
-- handled by the one-shot backfill below, not by a default that would outlive
-- the migration.

-- ============================================================================
-- JUDGMENT 3 — `avatar_seed` has no DEFAULT, and cannot have one
-- ============================================================================
-- The ticket asks for "default id" on users and "default slug" on agents. A
-- Postgres column DEFAULT is an expression over constants and functions — it
-- cannot reference another column of the row being inserted — so neither is
-- expressible as a DEFAULT, and NOT NULL is therefore unreachable without a
-- BEFORE INSERT trigger on both tables. A trigger was rejected: it buys a
-- non-null column and costs a hidden write path on the two hottest inserts in
-- the product, for a value every read must be able to compute anyway.
--
-- The invariant is instead: **seed = COALESCE(avatar_seed, <natural key>)**,
-- where the natural key is `users.id::text` and `agents.slug`. NULL means "no
-- reroll has happened" and is the common case; a non-null value is an admin
-- override (D-035: a single unfortunate generation can be rerolled without
-- touching a primary key). The backfills below follow the directive verbatim
-- and materialise the natural seed for rows that already existed, which is
-- harmless under COALESCE and keeps `UPDATE ... WHERE avatar_seed IS NULL`
-- meaning "never rerolled" for everything created afterwards.

-- ============================================================================
-- JUDGMENT 4 — the affinity compression is a CLAMP
-- ============================================================================
-- "Compress any seeded weights into 0.7-1.3" (§2). A linear rescale would need
-- a source range, and the old column had none: `real NOT NULL DEFAULT 1.0` with
-- no bound, seeded by hand. Clamping is the only transformation that is
-- correct for an unbounded input, preserves every in-range value exactly, and
-- is idempotent. Rows already inside the band are left byte-identical —
-- including `updated_at`, so the clamp does not fabricate an edit that never
-- happened.

-- ============================================================================
-- JUDGMENT 5 — the seeds live here, not only in the seed script
-- ============================================================================
-- `reserved_handles` and `platform_settings` are BOOTSTRAP DATA, not
-- development fixtures: production is wrong without them (an unseeded
-- `platform_settings` means the router has no coverage target, and an unseeded
-- `reserved_handles` means `ledger` is claimable by anyone). `db:seed` refuses
-- to run under NODE_ENV=production by contract (README "Seeding"), so it cannot
-- be the delivery mechanism. They are seeded here, where `db:migrate` is the
-- deploy step that runs them.
--
-- The canonical lists also exist as data in `src/seed-data/` and
-- `syncReservedHandles` / `syncPlatformSettings` apply them with the same
-- ON CONFLICT DO NOTHING semantics; the migration test asserts the SQL below
-- and those modules agree exactly, so they are one list checked against itself
-- rather than two that drift. That is what makes the deferred founder/investor
-- list (D-038(c)) purely additive: append to `FOUNDER_RESERVED_HANDLES`, and
-- apply it with the sync helper or a one-statement later migration.
--
-- ON CONFLICT DO NOTHING everywhere, never DO UPDATE: re-running must not
-- clobber a value an admin changed. A deploy silently restoring
-- `routing.coverage_target` to 6 after an operator lowered it to 2 would be a
-- spend incident with no fingerprints on it.

-- ── provenance on contributions ──────────────────────────────
-- D-030: without these, an eval result cannot be attributed to a cause and
-- shadow-mode comparison is impossible. Every column is NOT NULL with a default
-- so the backfill of existing rows is honest rather than invented: version 1,
-- one validation attempt, no model recorded.
ALTER TABLE contributions
  ADD COLUMN IF NOT EXISTS persona_version      int      NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS skill_version        int      NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS prompt_version       int      NOT NULL DEFAULT 1,
  -- '' for rows written before providers were wired (P-03). Empty, not null:
  -- "no model recorded" is a fact about the row, and a NOT NULL column keeps
  -- every attribution query free of a null branch.
  ADD COLUMN IF NOT EXISTS model_id             text     NOT NULL DEFAULT '',
  -- How many schema-validation attempts the turn took (rule 7: retry ≤3, then
  -- a decline — never a fragment). A rising mean is a persona regression.
  ADD COLUMN IF NOT EXISTS validation_attempts  smallint NOT NULL DEFAULT 1,
  -- Null until a judge runs (P-06/M1-BE-23). Nullable on purpose: 0.0 is a
  -- real score and must not be confused with "not judged".
  ADD COLUMN IF NOT EXISTS judge_score          real,
  -- The structured turn's self-assessment (D-031), including
  -- `specific_criticism`. jsonb, written with sql.json — never a stringified
  -- value into a cast (see jsonb-double-encode-guard.test.ts).
  ADD COLUMN IF NOT EXISTS self_check           jsonb,
  -- Which routing pass picked this agent for this chapter (D-033 vocabulary;
  -- D-042 item 1 as refined by D-043). Nullable, no default, and constrained
  -- against `author_type` below — a human's reply was routed by nobody and says
  -- so. See RULING 2.
  ADD COLUMN IF NOT EXISTS selected_by          text;

-- Existing rows first, constraint second — the reverse order fails on any
-- database that already holds agent contributions (all of dev does). Every
-- contribution written before routing existed was picked by the single-pass
-- scorer that coverage replaced, so 'coverage' is the honest reading; human
-- rows are left NULL, which is what they always were.
UPDATE contributions SET selected_by = 'coverage'
 WHERE author_type = 'agent' AND selected_by IS NULL;

-- D-043's conditional CHECK. A table constraint, not a column one: it reads two
-- columns. Guarded rather than `IF NOT EXISTS` because Postgres has no such form
-- for ADD CONSTRAINT — the guard is what makes re-running this file a no-op.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'contributions'::regclass
       AND conname  = 'contributions_selected_by_check'
  ) THEN
    ALTER TABLE contributions
      ADD CONSTRAINT contributions_selected_by_check
      CHECK (
        (author_type = 'agent') = (selected_by IS NOT NULL)
        AND (selected_by IS NULL
             OR selected_by IN ('coverage', 'discretionary', 'exploration'))
      );
  END IF;
END $$;

-- The eval attribution scan: one agent, one persona version, newest first.
-- Distinct from `contributions_agent_id_created_at_idx` (0004), which cannot
-- answer "this agent under persona v3" without reading every row it has ever
-- written.
CREATE INDEX IF NOT EXISTS contributions_persona_idx
  ON contributions (agent_id, persona_version, created_at DESC);

-- ── shadow mode ──────────────────────────────────────────────
-- A parallel, never-published turn: same chapter, same agent, different persona
-- or prompt version, so a change can be compared against production traffic
-- before it ships. Deliberately NOT a flag on `contributions` — a shadow row
-- must be invisible to every existing query (the feed, standing, calibration,
-- the diary), and the only way to guarantee that additively is a table those
-- queries do not name.
--
-- No `idempotency_key` and no UNIQUE on (chapter, agent, round): running the
-- same shadow turn twice under two candidate prompts is the point.
-- No `updated_at`: a shadow row is written once and never mutates.
CREATE TABLE IF NOT EXISTS contributions_shadow (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chapter_id      uuid NOT NULL REFERENCES chapters,
  agent_id        uuid NOT NULL REFERENCES agents,
  round_no        smallint NOT NULL,
  persona_version int  NOT NULL,
  skill_version   int  NOT NULL,
  prompt_version  int  NOT NULL,
  model_id        text NOT NULL,
  body            text,
  self_check      jsonb,
  judge_score     real,
  declined        boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Same shape as `contributions_persona_idx` so the A/B is one query written
-- twice against two tables, not two query plans.
CREATE INDEX IF NOT EXISTS contributions_shadow_agent_id_persona_version_created_at_idx
  ON contributions_shadow (agent_id, persona_version, created_at DESC);

-- ── pseudonymous identity ────────────────────────────────────
-- D-029: the handle is the public name; the GitHub identity is private unless
-- the user opts in. Note what is NOT here: `users.email` does not exist and is
-- not added (D-037 item 3).
ALTER TABLE users
  -- Opt-in, so the default is the private posture and a migration cannot
  -- accidentally out anyone.
  ADD COLUMN IF NOT EXISTS show_github_login boolean NOT NULL DEFAULT false,
  -- NULL = never changed. Backfills NULL for every existing row (D-037 item 4)
  -- — which is true: nobody has changed a handle, because until this migration
  -- there was no mechanism to. The 90-day cooldown (§9) is measured from here.
  ADD COLUMN IF NOT EXISTS handle_changed_at timestamptz,
  -- Tier as it WOULD be under the signup gate, computed on every login whether
  -- the gate is on or not (D-036), so turning it on later is an informed
  -- decision rather than a guess. Null until the first login after P-09.
  -- Admin-only: it is derived from `github_created_at`/`github_public_repos`
  -- and leaks the same fingerprint (D-029, P-02's forbidden list).
  ADD COLUMN IF NOT EXISTS tier_would_be     smallint;

-- Handles released by a rename, reserved for 90 days. See RULING 1.
-- `released_at` and `reserved_until` are both stored rather than deriving the
-- second from the first: the cooldown is a platform setting-shaped number and
-- an operator may need to release one name early without rewriting policy.
-- No `updated_at` — a row here is written once and expires by clock.
CREATE TABLE IF NOT EXISTS handle_history (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The account that released it. Kept after the reservation lapses: "who used
  -- to be @foo" is a moderation question, and moderation follows user_id (§9).
  user_id        uuid NOT NULL REFERENCES users,
  handle         text NOT NULL,
  released_at    timestamptz NOT NULL DEFAULT now(),
  reserved_until timestamptz NOT NULL
);

-- The availability check's access path. Not UNIQUE: one handle can be released
-- more than once over the life of the platform.
CREATE INDEX IF NOT EXISTS handle_history_handle_idx ON handle_history (handle);

-- The permanent denylist. See RULING 1 and JUDGMENT 5. `handle` is the primary
-- key — one row per name, and the seed's ON CONFLICT target.
CREATE TABLE IF NOT EXISTS reserved_handles (
  handle text PRIMARY KEY,
  -- 'staff_agent' | 'brand' | 'product_surface' | 'role' | 'impersonation_risk'
  -- (comment only, no CHECK — D-013). Carried so an operator can tell a policy
  -- reservation from a name that is merely spent.
  reason text NOT NULL
);

-- ── profile stats ────────────────────────────────────────────
-- votes PK is (contribution_id, user_id); the profile aggregate counts by
-- user_id, which the PK's leading column cannot serve.
CREATE INDEX IF NOT EXISTS votes_user_idx ON votes (user_id);

-- ── avatars ──────────────────────────────────────────────────
-- D-035. See JUDGMENT 3 for why there is no DEFAULT and no NOT NULL, and for
-- the COALESCE contract every reader must use.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS avatar_seed text;
UPDATE users SET avatar_seed = id::text WHERE avatar_seed IS NULL;

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS avatar_seed text;
UPDATE agents SET avatar_seed = slug WHERE avatar_seed IS NULL;

-- ── profile bios ─────────────────────────────────────────────
ALTER TABLE users
  -- 160 chars, plain text, URLs inert, one edit per 24h — all enforced at the
  -- edge (§8.8), not here: a length CHECK would need a migration to relax and
  -- would fail a write with a constraint name instead of a message a person
  -- can act on.
  ADD COLUMN IF NOT EXISTS bio text;

ALTER TABLE agents
  -- Part of the versioned persona (§8.8): written by the persona pass, not by
  -- the agent, and it moves with `persona_version`.
  ADD COLUMN IF NOT EXISTS bio text;

-- ── platform settings ────────────────────────────────────────
-- One generic, admin-controlled, audited key-value store rather than three
-- one-off feature flags (§3). The service layer — Redis cache with a 60s TTL,
-- `admin_audit` append on every write, range validation against
-- min_value/max_value — is P-09; this is the table and its day-one contents.
CREATE TABLE IF NOT EXISTS platform_settings (
  key         text PRIMARY KEY,
  -- jsonb rather than text so a value keeps its type across the wire and a
  -- later structured setting (a list, an object) needs no migration.
  value       jsonb NOT NULL,
  -- 'bool'|'int'|'float' (comment only, no CHECK — D-013). How the settings
  -- service coerces and how the admin UI renders the input.
  value_type  text  NOT NULL,
  -- NOT NULL: a setting nobody can explain is a setting nobody should change.
  description text  NOT NULL,
  -- Inclusive bounds, null for booleans. Validation is the service's job (P-09)
  -- — the bound is DATA here so the admin UI can render it and an operator can
  -- widen it without a migration.
  min_value   numeric,
  max_value   numeric,
  -- Null for a seeded default: nobody changed it. Set to the acting admin on
  -- every subsequent write, alongside the `admin_audit` row.
  updated_by  uuid REFERENCES users,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Bootstrap posture, §3's table verbatim. Ranges are this ticket's judgment
-- (the directive gives values, not bounds) and are typo guards, not policy —
-- see `src/seed-data/platform-settings.ts` for the reasoning per key.
INSERT INTO platform_settings (key, value, value_type, description, min_value, max_value) VALUES
  ('routing.coverage_target', '6'::jsonb, 'int',
   'Substantive contributions every post is guaranteed within the coverage window. Lowering this is how bootstrap mode ends; 0 is pure choice-based routing.', 0, 50),
  ('routing.coverage_window_hours', '6'::jsonb, 'int',
   'How long a post has to reach its coverage target before the guarantee is considered missed.', 1, 168),
  ('routing.discretionary_enabled', 'true'::jsonb, 'bool',
   'Agents spend leftover budget on posts they choose. Off means coverage only, and the choosing signal disappears.', NULL, NULL),
  ('routing.exploration_rate', '0.25'::jsonb, 'float',
   'Share of picks made ignoring affinity entirely, so the panel is not predictable from the topic.', 0, 1),
  ('routing.affinity_enabled', 'true'::jsonb, 'bool',
   'Apply the 0.7-1.3 affinity weight when scoring candidates. A soft weight only, never a gate.', NULL, NULL),
  ('routing.decline_counts_as_coverage', 'false'::jsonb, 'bool',
   'Whether a published decline counts toward the coverage target. False: it fills the thread but not the guarantee.', NULL, NULL),
  ('signup.tier_gate_enabled', 'false'::jsonb, 'bool',
   'Gate posting on GitHub account age and public repos. False at launch: everyone posts. Tiers 2 and 3 stay gated regardless.', NULL, NULL),
  ('signup.min_account_age_days', '90'::jsonb, 'int',
   'Minimum GitHub account age for tier 1, applied only when the tier gate is on.', 0, 3650),
  ('signup.min_public_repos', '1'::jsonb, 'int',
   'Minimum public repositories for tier 1, applied only when the tier gate is on.', 0, 1000),
  ('budget.daily_cents_per_agent', '500'::jsonb, 'int',
   'Per-agent daily inference ceiling in cents. Alert at 80% (budget.md).', 0, 100000)
ON CONFLICT (key) DO NOTHING;

-- ── reserved handles ─────────────────────────────────────────
-- The six staff agent slugs (capabilities.md §8) plus the brand, the Bell
-- surface and the role names. The founder/investor list is deferred to the
-- human (D-038(c)) and lands additively — see JUDGMENT 5.
INSERT INTO reserved_handles (handle, reason) VALUES
  ('bricklayer', 'staff_agent'),
  ('ledger',     'staff_agent'),
  ('marguerite', 'staff_agent'),
  ('sprout',     'staff_agent'),
  ('grouse',     'staff_agent'),
  ('vellum',     'staff_agent'),
  ('eutectic',   'brand'),
  ('bell',       'product_surface'),
  ('admin',      'role'),
  ('staff',      'role'),
  ('support',    'role'),
  ('official',   'role'),
  ('system',     'role'),
  ('mod',        'role'),
  ('help',       'role')
ON CONFLICT (handle) DO NOTHING;

-- ── affinity becomes a soft weight ───────────────────────────
-- D-032: personas are lenses, not domains. Weight is a nudge, never a gate; no
-- agent is ever excluded from a surface. The router's enforcement of that lives
-- in P-10 — this is the column posture it reads.
ALTER TABLE agent_affinities
  ALTER COLUMN weight SET DEFAULT 1.0;

-- Compress seeded weights into 0.7-1.3. See JUDGMENT 4: a clamp, and rows
-- already inside the band are not touched at all.
UPDATE agent_affinities
   SET weight = LEAST(1.3, GREATEST(0.7, weight)),
       updated_at = now()
 WHERE weight < 0.7 OR weight > 1.3;
