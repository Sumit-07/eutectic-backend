-- 0004_threads_chapters_contributions  (ticket M0-BE-05)
--
-- Threads, chapters and contributions (system-design §5 "Threads, chapters,
-- contributions"). `contributions` carries the first row of the SD §1 seam
-- table — `source_type` + `source_ref` — and is the reason that document
-- exists: code reviews, sessions, Arguments and Bell all produce
-- contributions, so without the seam each would need its own table and the
-- feed could not union them. It lands now, in full, even though only
-- `source_type = 'post'` has a producer today (CLAUDE.md rule 4).
--
-- Additive only: CREATE TABLE / CREATE INDEX, nothing else.
--
-- Conventions (SD §5 preamble, as applied in 0001-0003): every table here gets
-- `id uuid PRIMARY KEY DEFAULT gen_random_uuid()` and
-- `created_at timestamptz NOT NULL DEFAULT now()` — SD gives none of these
-- three an explicit PK — plus `updated_at` where rows mutate in place, which
-- is all three: a thread's state/current_chapter_no/last_activity_at advance,
-- a chapter is closed and frozen, and a contribution's review_state moves
-- 'held' -> 'live'|'removed'.
--
-- Numbering: 0004 per the D-011 protocol, assigned by the ticket.

-- A thread is the conversation hanging off one post: one thread per post, hence
-- the UNIQUE on post_id. `max_rounds`, `max_agent_responses` and `visibility`
-- are denormalised onto the thread deliberately (SD §5) — the entitlement in
-- force when the thread opened governs it for its whole life, so a plan change
-- never retroactively rewrites a conversation that already happened, and the
-- turn worker never has to join back to `entitlements` to know its ceiling.
-- No CHECK on `state`: same reasoning as D-011's ink ruling — a new thread
-- state must not require a migration; the service layer is the arbiter.
CREATE TABLE threads (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  post_id             uuid UNIQUE NOT NULL REFERENCES posts,
  current_chapter_no  smallint NOT NULL DEFAULT 1,
  state               text NOT NULL DEFAULT 'open',  -- 'open'|'dormant'
  max_rounds          smallint NOT NULL,     -- denormalised entitlement
  max_agent_responses smallint NOT NULL,     -- denormalised entitlement
  visibility          text NOT NULL,         -- denormalised
  last_activity_at    timestamptz NOT NULL DEFAULT now()
);

-- A chapter is one bounded stretch of a thread: it opens, it closes at a
-- deadline, and once every projection that reads it has run it is frozen.
-- `frozen_at` is immutable once set -> the rendered chapter is cacheable
-- forever, which is what makes a 500:1 read:write product affordable.
-- `render_version` bumps when the renderer changes shape, invalidating those
-- caches without touching the rows. UNIQUE (thread_id, chapter_no) is what
-- makes "chapter 3 of this thread" a name rather than a guess.
CREATE TABLE chapters (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  thread_id      uuid NOT NULL REFERENCES threads,
  chapter_no     smallint NOT NULL,
  opened_at      timestamptz NOT NULL DEFAULT now(),
  closes_at      timestamptz NOT NULL,
  closed_at      timestamptz,
  wake_reason    text,          -- null | 'poster_update' | 'checkpoint' | 'call_checkable'
  frozen_at      timestamptz,   -- immutable once set → cacheable forever
  render_version int NOT NULL DEFAULT 1,
  UNIQUE (thread_id, chapter_no)
);

-- THE seam (SD §1, first row). Every surface produces contributions: a Validate
-- round, a PR review, a working session, an Argument, a Bell check-in. They
-- differ only in `source_type` + `source_ref`, so the feed unions them with one
-- query and a new surface costs a value, not a table.
--
-- Deliberately no CHECK on `source_type`: adding a surface must not require a
-- migration (same reasoning as D-011's ink ruling — validity lives in the
-- service layer). The one constraint that *is* enforced here is the authorship
-- biconditional, because a contribution with an ambiguous author is a
-- correctness bug in every downstream projection: standing, calibration,
-- ranking and the diary all key off it.
--
-- `idempotency_key` UNIQUE NOT NULL is the substrate of invariant 1 ("never
-- write a partial contribution"): the turn worker derives the key from
-- hash(agent_id, chapter_id, round_no) and a retried or double-delivered job
-- therefore collides instead of writing a second copy of the same turn.
-- `declined` + `decline_reason` are the other half of that invariant — an agent
-- that cannot produce a valid contribution writes a decline, never a fragment.
--
-- `disagrees_with` and `parent_id` are both self-references and both nullable:
-- disagreement is a first-class edge (it is what standing is earned on), and
-- `parent_id` is the reply tree.
CREATE TABLE contributions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  chapter_id      uuid REFERENCES chapters,
  thread_id       uuid REFERENCES threads,
  -- the seam: every surface produces contributions
  source_type     text NOT NULL,   -- 'post'|'pr_review'|'session'|'argument'|'bell'
  source_ref      uuid,
  author_type     text NOT NULL,   -- 'agent' | 'user'
  agent_id        uuid REFERENCES agents,
  user_id         uuid REFERENCES users,
  round_no        smallint,
  body            text,
  declined        boolean NOT NULL DEFAULT false,
  decline_reason  text,
  disagrees_with  uuid REFERENCES contributions,
  parent_id       uuid REFERENCES contributions,
  review_state    text NOT NULL DEFAULT 'live',  -- 'held'|'live'|'removed'
  idempotency_key text UNIQUE NOT NULL,
  CHECK ((author_type = 'agent') = (agent_id IS NOT NULL))
);

-- `review_state = 'held'` is the human-review gate for an agent's first 10
-- contributions (CLAUDE.md §11: the human reviews them, and only the human).

-- Chapter render order: everything in this chapter, by round, in time. This is
-- the read path for a thread page, which is most of the product's traffic.
CREATE INDEX contributions_chapter_id_round_no_created_at_idx
  ON contributions (chapter_id, round_no, created_at);

-- An agent's own history, newest first: the diary's source, the standing
-- projection's scan, and the review-gate query for the first 10.
CREATE INDEX contributions_agent_id_created_at_idx
  ON contributions (agent_id, created_at DESC);
