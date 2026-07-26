-- 0011_events_feed_entries  (ticket M0-BE-12)
--
-- The append-only event log (system-design §4) and the feed projection
-- (system-design §5 "The feed projection"). Every projection in the product
-- reads one of these two tables, so read the judgment calls below before
-- changing anything here.
--
-- `events` is the source of truth for everything derived and historical:
-- diaries, calibration, standing, agent memory, activity feeds, audit (SD §4).
-- It is written in the SAME TRANSACTION as the relational row it describes and
-- as the graphile-worker job that projects it (SD §3 — the single most
-- important reliability decision). Append-only in the strict sense: no
-- `updated_at`, and no `created_at` either — `occurred_at` IS the timestamp, as
-- SD §4 writes it. Rows are never updated and never deleted; old months are
-- detached to cold storage after 13 months.
--
-- `feed_entries` is a PROJECTION and is REBUILDABLE FROM `events` AT ANY TIME
-- (SD §5: "Rebuildable from events at any time. That is the whole point.").
-- Truncating it is a recoverable operation, not a data loss. Because it is
-- rebuildable, `activity_at` and `rank_score` mutate in place and it carries
-- the standard `id`/`created_at`/`updated_at` trio.
--
-- Additive only: CREATE TABLE / CREATE INDEX / CREATE FUNCTION / CREATE
-- TRIGGER, nothing else. No CHECK constraints beyond those SD writes
-- explicitly (D-013; SD writes none for either table) — enum-like text columns
-- get a comment and the service layer is the arbiter, so a new actor type,
-- event type, surface or visibility never needs a migration.
--
-- Numbering: 0011 per the D-011 protocol, assigned by the ticket. 0007-0010
-- (M0-BE-08 … M0-BE-11) are in flight on sibling branches and are not present
-- here — see this ticket's PR body for the expected, correct gap in
-- migrate.test.ts's contiguity check. Nothing in this file depends on them:
-- `events` has no foreign keys at all, and `feed_entries` has exactly the two
-- SD §5 writes (agents, users), which landed in 0001 and 0002.
--
--
-- ============================================================================
-- JUDGMENT 1 — the primary key on a partitioned table
-- ============================================================================
-- SD §4 writes `id bigserial PRIMARY KEY` on a table declared
-- `PARTITION BY RANGE (occurred_at)`. Postgres cannot do that: every unique
-- constraint on a partitioned table — the primary key included — must contain
-- the partition key, because uniqueness is enforced by per-partition indexes
-- and there is no global index.
--
--   Deviation: PRIMARY KEY (id, occurred_at).
--
-- What that DOES guarantee: `id` still comes from ONE global sequence
-- (`bigserial` on the parent; every partition shares it), so ids handed out by
-- the database are globally unique and are safe to use as an external event
-- reference. The `(id, occurred_at)` index has `id` leading, so a lookup by id
-- alone is still an index scan — one per partition, pruned to one if the caller
-- also knows the month.
-- What it does NOT guarantee: a writer that supplies an EXPLICIT `id`
-- (overriding the sequence) could plant the same id in two different months and
-- the database would not object. No writer does this; `id` is never supplied by
-- hand. Nothing FKs to `events` (below), so no other table can be corrupted by
-- it.
--
--
-- ============================================================================
-- JUDGMENT 2 — `idempotency_key UNIQUE`, which must stay GLOBAL
-- ============================================================================
-- SD §3 states the invariant plainly: "`events.idempotency_key` is unique". The
-- SEMANTIC requirement is global dedupe — a retry of an agent turn keyed
-- `hash(agent_id, chapter_id, round_no)` (SD §3) can arrive minutes or days
-- later, with a different `occurred_at`, possibly in a different MONTH. The
-- same partitioned-uniqueness rule as Judgment 1 applies, so the options were:
--
--   (i)   UNIQUE (occurred_at, idempotency_key) — the shape the partitioning
--         rule invites. REJECTED: it dedupes only within one partition, and
--         worse, only within one exact timestamp. The retry case above — the
--         only case the invariant exists for — sails straight through it. This
--         would be an invariant in name only.
--   (ii)  Make `idempotency_key` part of the partition key. REJECTED: destroys
--         range partitioning by time, which is what the 13-month detach and
--         every occurred_at query need.
--   (iii) Enforce dedupe in the writer (packages/events, M0-BE-13) with a
--         claim-then-insert CTE against a side table. REJECTED as the *only*
--         mechanism: dedupe would then be a convention that any future writer
--         can forget. CLAUDE.md rule 7 and SD §3 treat this as an invariant,
--         and an invariant is a constraint, not a habit.
--   (iv)  A small NON-PARTITIONED dedupe table, `event_idempotency`, whose
--         PRIMARY KEY is the bare `idempotency_key`, written by an AFTER INSERT
--         trigger on `events` in the same transaction as the event.  ← CHOSEN.
--
-- (iv) restores exactly the invariant SD §3 states: a second event bearing a
-- key that has ever been used fails, whatever month it lands in, whoever wrote
-- it and by whatever path. The uniqueness is a real database constraint on a
-- real global index.
--
-- What it costs, stated plainly:
--   - One extra insert plus one B-tree maintenance per KEYED event. Events with
--     a NULL key (the majority — SD makes the column nullable, not every event
--     carries one) skip the trigger entirely via its WHEN clause and pay
--     nothing.
--   - `event_idempotency` is not partitioned and grows without bound. It is
--     narrow (a key, a soft pointer, a timestamp) and is prunable: once a key
--     is older than any retry horizon, its row can be deleted without weakening
--     anything. A retention job is a later ticket, deliberately not built here.
--   - The dedupe row is a SOFT pointer: `event_id` / `occurred_at` columns with
--     NO foreign key to `events`. Deliberate — a real FK would block the 13-
--     month partition DETACH that SD §4 requires.
--
-- INTENDED INSERT PATTERN — read this before writing packages/events
-- (M0-BE-13), which consumes this schema:
--
--   Writers NEVER insert into `event_idempotency` themselves. The trigger owns
--   that table; a manual insert would collide with the trigger's own.
--
--   Inside the caller's transaction, `writeEvent(tx, event)` does:
--
--     -- optional fast path: a PK probe that avoids the subtransaction in the
--     -- common "already written" case
--     SELECT 1 FROM event_idempotency WHERE idempotency_key = $key;
--     -- if found → clean no-op, return the existing event, do not insert
--
--     SAVEPOINT ev;                      -- closes the concurrent-retry race
--     INSERT INTO events (occurred_at, actor_type, actor_id, event_type,
--                         subject_type, subject_id, forum_id, payload,
--                         idempotency_key)
--     VALUES (...) RETURNING id, occurred_at;
--     RELEASE SAVEPOINT ev;
--
--   A duplicate key raises SQLSTATE 23505 on constraint
--   `event_idempotency_pkey` (not on an `events` constraint — check the
--   constraint name, not just the SQLSTATE). The writer rolls back to the
--   savepoint and returns the no-op result, which is exactly M0-BE-13's
--   acceptance criterion ("second write is a clean no-op, not an error"). The
--   enclosing transaction — the contribution row, the queued job — survives
--   untouched, which is why the savepoint exists rather than a bare catch.
--
--   `ON CONFLICT` on the `events` INSERT does NOT work for this and must not be
--   used: the conflict is raised inside the trigger, on another table, and
--   `ON CONFLICT` cannot see it.
--
--
-- ============================================================================
-- JUDGMENT 3 — no DEFAULT partition
-- ============================================================================
-- An event whose `occurred_at` has no partition is REJECTED with "no partition
-- of relation \"events\" found for row". That is the intent. A default
-- partition would silently pool those rows, and would then have to be scanned
-- in full every time a real partition is attached over the same range — it
-- converts a loud, immediate scheduler failure into a slow, quiet one. The
-- partitions below cover today (2026-07) plus two months of runway;
-- `events_ensure_partition()` extends it, and the job that calls it monthly is
-- a later ticket.

-- ----------------------------------------------------------------------------
-- The event log (SD §4)
-- ----------------------------------------------------------------------------
-- Columns exactly as SD §4 writes them. NO foreign keys, by design and not by
-- omission: `actor_id`, `subject_id` and `forum_id` are polymorphic
-- (`actor_type`/`subject_type` name the table), and an append-only log must
-- outlive the rows it describes — a deleted user's audit trail is the whole
-- point of having one. Referential integrity here belongs to the writer.
CREATE TABLE events (
  id              bigserial,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  actor_type      text NOT NULL,          -- 'user' | 'agent' | 'system' | 'admin'  (comment only, no CHECK)
  actor_id        uuid,
  event_type      text NOT NULL,          -- the SD §4 catalogue, frozen there and typed in packages/events (M0-BE-13)
  subject_type    text NOT NULL,
  subject_id      uuid NOT NULL,
  forum_id        uuid,
  payload         jsonb NOT NULL DEFAULT '{}',
  idempotency_key text,                   -- NULLABLE: not every event carries one. Global uniqueness: see Judgment 2.
  -- Judgment 1: the partition key must be in every unique constraint.
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

-- Monthly partitions (SD §4). Bounds are written with an explicit `Z` offset so
-- they mean the same instants regardless of the session TimeZone that happens
-- to be in effect when the migration runs. Ranges are [FROM, TO).
CREATE TABLE events_2026_07 PARTITION OF events
  FOR VALUES FROM ('2026-07-01T00:00:00Z') TO ('2026-08-01T00:00:00Z');
CREATE TABLE events_2026_08 PARTITION OF events
  FOR VALUES FROM ('2026-08-01T00:00:00Z') TO ('2026-09-01T00:00:00Z');
CREATE TABLE events_2026_09 PARTITION OF events
  FOR VALUES FROM ('2026-09-01T00:00:00Z') TO ('2026-10-01T00:00:00Z');

-- The three SD §4 indexes, verbatim in columns, order and direction. Created on
-- the partitioned parent, so Postgres builds a matching index on every existing
-- partition AND on every partition created later — including the ones
-- `events_ensure_partition()` makes. Names are explicit per D-013 (SD writes
-- them anonymous); the per-partition children get generated names.
CREATE INDEX events_actor_type_actor_id_occurred_at_idx
  ON events (actor_type, actor_id, occurred_at DESC);   -- diary input
CREATE INDEX events_subject_type_subject_id_occurred_at_idx
  ON events (subject_type, subject_id, occurred_at);    -- object history
CREATE INDEX events_event_type_occurred_at_idx
  ON events (event_type, occurred_at DESC);             -- projections

-- ----------------------------------------------------------------------------
-- Global idempotency (Judgment 2)
-- ----------------------------------------------------------------------------
-- Not partitioned — that is the entire point: one global unique index, so a key
-- reused in a different month is caught. Immutable rows, so no `updated_at`;
-- no surrogate `id`, because the key IS the key (D-013: SD-named keys stand,
-- and here the key is what makes the table exist at all).
CREATE TABLE event_idempotency (
  idempotency_key text PRIMARY KEY,
  -- Soft pointer to the event that claimed the key. NO foreign key, so that a
  -- 13-month-old partition can still be DETACHed (SD §4).
  event_id        bigint NOT NULL,
  occurred_at     timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION events_claim_idempotency_key() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  -- No ON CONFLICT: a duplicate MUST raise 23505 on event_idempotency_pkey and
  -- take the event insert down with it. That failure IS the invariant.
  INSERT INTO event_idempotency (idempotency_key, event_id, occurred_at)
  VALUES (NEW.idempotency_key, NEW.id, NEW.occurred_at);
  RETURN NULL;   -- AFTER trigger; return value is ignored
END;
$fn$;

-- AFTER, not BEFORE: `NEW.id` must already be assigned from the sequence.
-- Declared on the parent, so Postgres clones it to every partition, present and
-- future. The WHEN clause means unkeyed events never enter the function.
CREATE TRIGGER events_claim_idempotency_key
  AFTER INSERT ON events
  FOR EACH ROW WHEN (NEW.idempotency_key IS NOT NULL)
  EXECUTE FUNCTION events_claim_idempotency_key();

-- ----------------------------------------------------------------------------
-- Partition helper
-- ----------------------------------------------------------------------------
-- Idempotent and safe to call repeatedly; a monthly scheduler job will call it
-- some months ahead (that job is a later ticket). Returns the partition name,
-- so a caller can log what it did.
--
-- `month_start` is truncated to the first of its month, so
-- `events_ensure_partition(current_date + interval '2 months')` is a valid way
-- to call it. Bounds are computed as UTC midnights, matching the literal
-- partitions above.
CREATE FUNCTION events_ensure_partition(month_start date) RETURNS text
LANGUAGE plpgsql AS $fn$
DECLARE
  v_start   date;
  v_end     date;
  v_name    text;
  v_schema  text := current_schema();
BEGIN
  v_start := date_trunc('month', month_start::timestamp)::date;
  v_end   := (v_start + interval '1 month')::date;
  v_name  := 'events_' || to_char(v_start, 'YYYY_MM');

  -- Check by name rather than leaning on CREATE TABLE IF NOT EXISTS: this way a
  -- repeat call is a genuine no-op and the caller is told which it was.
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = v_name AND n.nspname = v_schema
  ) THEN
    RETURN v_name;
  END IF;

  EXECUTE format(
    'CREATE TABLE %I.%I PARTITION OF %I.events FOR VALUES FROM (%L) TO (%L)',
    v_schema, v_name, v_schema,
    v_start::timestamp AT TIME ZONE 'UTC',
    v_end::timestamp AT TIME ZONE 'UTC'
  );

  RETURN v_name;
END;
$fn$;

-- Both functions resolve unqualified names (`event_idempotency`, `events`) and
-- `current_schema()` at CALL time, when the caller's search_path — a trigger
-- firing from an application connection, a scheduler job, a test inserting into
-- a scratch schema — is not ours to predict. Pinning search_path to the schema
-- the migration is being applied into makes both functions correct from any
-- caller, and is also the standard hardening for a SET-search_path-injection.
-- Done in a DO block because the schema name is only known at apply time
-- (`public` in production, a throwaway schema under test).
DO $do$
BEGIN
  EXECUTE format('ALTER FUNCTION events_claim_idempotency_key() SET search_path = %I, pg_catalog',
                 current_schema());
  EXECUTE format('ALTER FUNCTION events_ensure_partition(date) SET search_path = %I, pg_catalog',
                 current_schema());
END;
$do$;

-- ----------------------------------------------------------------------------
-- The feed projection (SD §5)
-- ----------------------------------------------------------------------------
-- Rebuildable from `events` at any time — that is the whole point (SD §5). One
-- row per entity, keyed by the `(entity_type, entity_id)` SEAM: a feed carries
-- threads, diaries, arguments, reviews and sessions without a column per kind,
-- so a new surface is a new `entity_type` value, never a migration (SD §1).
-- Gets the standard `id`/`created_at`/`updated_at` trio (D-013): unlike the
-- event log, this table mutates in place — `activity_at` bumps on new chapter
-- activity and `rank_score` is recomputed by the ranking job.
--
-- CLAUDE.md rule 9 — PREMIUM NEVER BUYS REACH. `rank_score` may not read
-- entitlements, and this table deliberately has NO entitlement, tier, plan or
-- boost column: the ranking job has nothing here to read even if someone asked
-- it to. Do not add one. There is a CI test.
--
-- Foreign keys are exactly the two SD §5 writes. `forum_id` is deliberately
-- unreferenced (as in `events`), and `entity_id` cannot be referenced at all —
-- it is the polymorphic half of the seam.
CREATE TABLE feed_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  entity_type     text NOT NULL,   -- 'thread'|'diary'|'argument'|'review'|'session'  (comment only, no CHECK)
  entity_id       uuid NOT NULL,
  surface         text NOT NULL,   -- 'validate'|'build'|'sell'|... the surface the entry belongs to (comment only, no CHECK)
  forum_id        uuid,
  author_agent_id uuid REFERENCES agents,
  author_user_id  uuid REFERENCES users,
  visibility      text NOT NULL,   -- 'public'|'unlisted'|'private'  (comment only, no CHECK)
  activity_at     timestamptz NOT NULL,   -- bumps on new chapter activity
  rank_score      real NOT NULL DEFAULT 0,
  UNIQUE (entity_type, entity_id)
);

-- The four SD §5 indexes, verbatim, with explicit names per D-013. Three of
-- them are partial on `visibility='public'`: the home timeline, the forum feed
-- and the ranked-insert set only ever read public rows (SD §6), so the index
-- that serves them should not carry the ones they can never return.
CREATE INDEX feed_entries_author_agent_id_activity_at_idx
  ON feed_entries (author_agent_id, activity_at DESC);
CREATE INDEX feed_entries_surface_activity_at_public_idx
  ON feed_entries (surface, activity_at DESC) WHERE visibility = 'public';
CREATE INDEX feed_entries_forum_id_activity_at_public_idx
  ON feed_entries (forum_id, activity_at DESC) WHERE visibility = 'public';
CREATE INDEX feed_entries_rank_score_public_idx
  ON feed_entries (rank_score DESC) WHERE visibility = 'public';
