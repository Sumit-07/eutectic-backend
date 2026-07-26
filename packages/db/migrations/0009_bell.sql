-- 0009_bell  (ticket M0-BE-10)
--
-- Bell's island (system-design §5 "Bell ↯"): commitments, bell_state,
-- bell_messages, distress_flags. Deliberately its own island — different
-- data, different risk (CAP §12): Bell is private by default, persistent
-- per-user, and remembers every commitment a user made. The six agents react
-- to public posts and have no memory of you specifically; Bell initiates on a
-- schedule and does.
--
-- Additive only: CREATE TABLE / CREATE INDEX, nothing else.
--
-- THE ISLAND INVARIANT: every table below carries a `user_id uuid REFERENCES
-- users` and nothing else FK-shaped. No Bell table references, or has a
-- column that names, posts / threads / chapters / contributions / forums /
-- feed_entries / diaries / or any other content table. Private by design
-- (CAP §12 — "public failure logs are humiliation-as-a-feature"; CLAUDE.md
-- rule 10's agent prohibitions and Bell's own circuit breaker (CLAUDE.md
-- rule 11, CAP §12) need this island to hold: nothing on the public surfaces
-- can join into Bell's data, and Bell's data can never leak into a diary, a
-- thread, or a feed by way of a foreign key. The isolation test in
-- bell.test.ts asserts this generically over the four table names so a
-- future FK addition here fails loudly instead of silently.
--
-- Conventions (D-013, as applied in 0001-0006): every table gets
-- `id uuid PRIMARY KEY DEFAULT gen_random_uuid()` and
-- `created_at timestamptz NOT NULL DEFAULT now()`, plus `updated_at` where
-- rows mutate in place — EXCEPT `bell_state`, where SD gives an explicit PK
-- of its own (`user_id`), so that PK stands and there is no `id` column.
-- No CHECK constraints beyond those SD §5 writes explicitly (there are none
-- in this table set); enum-like text columns (`commitments.state`,
-- `commitments.source`, `bell_state.cadence`, `bell_messages.kind`,
-- `distress_flags.action_taken`) get comments only — same reasoning as
-- D-011's `ink` ruling and 0004's `source_type`: a new value must not need a
-- migration, validity lives in the service layer. FK ON DELETE defaults to
-- RESTRICT (unqualified `REFERENCES users`) throughout — SD writes no CASCADE
-- here.
--
-- Numbering: 0009 per the D-011 protocol, assigned by the ticket. Siblings
-- 0007 and 0008 (M0-BE-08, M0-BE-09) are in flight on other branches and not
-- present here — see this ticket's PR body for the expected, correct gap in
-- migrate.test.ts's contiguity check.

-- SD gives `commitments` no explicit PK, so it gets the standard `id`/
-- `created_at` pair. `state` mutates (open|done|deferred|dropped as the user
-- works through it), hence `updated_at`. `state` and `source` are comment-only,
-- no CHECK (D-013).
CREATE TABLE commitments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  user_id    uuid NOT NULL REFERENCES users,
  text       text NOT NULL,
  due_on     date NOT NULL,
  state      text NOT NULL DEFAULT 'open',  -- 'open'|'done'|'deferred'|'dropped' (comment only, no CHECK)
  source     text NOT NULL                  -- 'user'|'bell_suggested' (comment only, no CHECK)
);

-- SD's explicit PK (`user_id`) stands — no surrogate `id`, one row per user.
-- This row mutates constantly (`paused_until`, `consecutive_silent_days`,
-- `tone_level` all move as Bell reacts to a user's activity and silence, CAP
-- §12's "softens on absence"), hence `updated_at`. `cadence` and `tone_level`
-- are comment-only, no CHECK (D-013) — `tone_level` in particular has to move
-- without a migration since it is Bell's circuit-breaker substrate (CLAUDE.md
-- rule 11: the breaker is code, not a prompt, and this column is only ever
-- read/written by that code, never gated by a DB constraint).
CREATE TABLE bell_state (
  user_id                  uuid PRIMARY KEY REFERENCES users,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  cadence                  text NOT NULL DEFAULT 'daily',  -- comment only, no CHECK
  send_at_local            time NOT NULL,
  timezone                 text NOT NULL,
  paused_until             date,
  consecutive_silent_days  int NOT NULL DEFAULT 0,
  tone_level               smallint NOT NULL DEFAULT 2   -- lowers on silence (comment only, no CHECK)
);

-- SD gives `bell_messages` no explicit PK, so the standard `id`/`created_at`
-- pair applies. `sent_at` is kept exactly as SD writes it, distinct from
-- `created_at`: the scheduler may write a message row (created) ahead of the
-- actual send (sent) — e.g. queued before a send window opens — so the two
-- timestamps can differ. `replied_at` is set in place later, hence
-- `updated_at`. `kind` is comment-only, no CHECK (D-013).
CREATE TABLE bell_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  user_id    uuid NOT NULL REFERENCES users,
  body       text NOT NULL,
  kind       text NOT NULL,   -- 'nudge'|'softened'|'plain_voice' (comment only, no CHECK)
  sent_at    timestamptz NOT NULL DEFAULT now(),
  replied_at timestamptz
);

-- SD gives `distress_flags` no explicit PK, so the standard `id`/`created_at`
-- pair applies. `reviewed_by` is set in place later (a human reviews the
-- flag after Bell's circuit breaker fires), hence `updated_at`. `action_taken`
-- is comment-only, no CHECK (D-013). `reviewed_by` references `users` exactly
-- as SD writes it — nullable until reviewed, RESTRICT on delete like every
-- other FK in this file.
CREATE TABLE distress_flags (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  user_id      uuid NOT NULL REFERENCES users,
  signal       text NOT NULL,
  action_taken text NOT NULL,   -- 'persona_dropped'|'paused'|'escalated' (comment only, no CHECK)
  reviewed_by  uuid REFERENCES users
);
