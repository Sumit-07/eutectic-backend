-- 0012_idempotency_responses  (ticket M0-BE-16)
--
-- One table: `idempotency_responses`, the store behind the API's
-- `Idempotency-Key` middleware (system-design §3 "Idempotency, everywhere";
-- openapi.yaml `components.parameters.IdempotencyKey`).
--
-- Additive only: CREATE TABLE and one CREATE INDEX, nothing else.
--
-- Conventions (SD §5 preamble, D-013): `created_at timestamptz NOT NULL
-- DEFAULT now()` on every table; `updated_at` present here because this row
-- DOES mutate in place (see the state column); no CHECK constraints beyond
-- those the spec writes explicitly — enum-like text columns get a comment
-- naming the known values and validity lives in the service layer (D-011's ink
-- ruling, extended by D-013); indexes are named explicitly.
--
-- Numbering: 0012 per the D-011 protocol, assigned by the ticket. Branch is
-- off develop @ 4dc09ad (migrations 0000-0011 shipped); this is the next
-- contiguous number and `migrate.test.ts`'s contiguity gate passes with it.

-- ============================================================================
-- JUDGMENT 1 — why a new table and not `event_idempotency` (0011)
-- ============================================================================
-- The ticket allows reuse of `event_idempotency` "ONLY if semantics genuinely
-- fit". They do not, on four counts, any one of which is disqualifying:
--
--   1. It stores a POINTER TO AN EVENT, not a response. `event_id bigint NOT
--      NULL` has no legal value for an HTTP request that has not run yet — and
--      the whole mechanism here needs a row to exist BEFORE the work happens
--      (that row is the claim that makes "exactly one execution" a database
--      fact rather than a hope).
--   2. It is TRIGGER-OWNED. 0011 states the rule in its own header: "Writers
--      NEVER insert into `event_idempotency` themselves. The trigger owns that
--      table; a manual insert would collide with the trigger's own." An API
--      middleware inserting into it is precisely the forbidden write.
--   3. Its key space is GLOBAL AND SHARED with the event log. An API client's
--      `Idempotency-Key` landing in that table can collide with an agent
--      turn's `hash(agent_id, chapter_id, round_no)` (SD §3), and the loser of
--      that collision is a legitimate `events` INSERT failing 23505 for a
--      reason that has nothing to do with events. Coupling API retry semantics
--      to the event log's uniqueness namespace is a bug waiting for a name.
--   4. Retention horizons differ. Event dedupe must outlive any agent retry
--      horizon; an HTTP response record is dead within hours. One table cannot
--      carry two retention policies without inventing a discriminator column,
--      at which point it is two tables wearing one name.
--
-- ============================================================================
-- JUDGMENT 2 — the primary key is (scope, idempotency_key)
-- ============================================================================
-- The PK is the one thing a later migration cannot change additively, so it is
-- decided now rather than discovered later.
--
-- `idempotency_key` ALONE was rejected. The contract calls the key
-- "client-generated" (openapi.yaml `components.parameters.IdempotencyKey`),
-- which means the server does not control the namespace: two different callers
-- can and eventually will pick the same string. With a bare key as the PK,
-- caller B's request either replays caller A's recorded response — a
-- cross-account disclosure of an id and a body — or is refused forever because
-- caller A got there first. Neither is acceptable, and no amount of
-- fingerprinting fixes the second.
--
-- `(operation_id, idempotency_key)` was also rejected: scoping BY OPERATION
-- would make the same key on two different operations two independent claims,
-- both executing. The contract says the opposite — reusing a key with a
-- different request is a `409` — so the operation belongs in the FINGERPRINT
-- (where a mismatch is detected and refused), never in the key.
--
-- `scope` is therefore the PRINCIPAL: the authenticated identity the request
-- acts as. Until M0-BE-17 lands sessions there is no principal and the API
-- writes the literal `'anonymous'`; that is one line in `apps/api` when auth
-- arrives, and no migration.
--
-- ============================================================================
-- JUDGMENT 3 — the response body is `text`, not `jsonb`
-- ============================================================================
-- What is stored is the ALREADY-SERIALISED response payload, and a replay must
-- return it byte for byte. `jsonb` cannot promise that: it normalises key
-- order, discards insignificant whitespace, canonicalises numeric literals
-- (`1e2` becomes `100`) and drops duplicate keys. A client that hashes,
-- diffs or signs a response body would see the replay differ from the
-- original, which defeats the point of recording it. Nothing queries inside
-- these bodies — they are opaque blobs read by exactly one code path — so
-- `jsonb`'s only real advantage buys nothing here.
--
-- ============================================================================
-- RETENTION — deliberately not built here
-- ============================================================================
-- This table grows with every successful mutation and must not live forever.
-- Rows are prunable without weakening anything once they are older than any
-- client retry horizon (hours, not months): deleting a row means a replay of
-- that key would re-execute, which for a key nobody is retrying any more costs
-- nothing. `idempotency_responses_created_at_idx` exists for exactly that
-- sweep and for nothing else. The cleanup job is a LATER TICKET — the same
-- shape as, and groomable alongside, the `event_idempotency` retention job
-- already opened as debt in D-016 item 6(d).

-- One row per (principal, key). The row is created BEFORE the work runs — the
-- INSERT is the claim, and `ON CONFLICT (scope, idempotency_key) DO NOTHING`
-- is what makes "exactly one execution" a property of a unique index rather
-- than of application locking. The row then mutates ONCE, in place, from
-- 'in_progress' to 'completed' (hence `updated_at`, D-013); a request whose
-- outcome must not be replayed deletes its own claim instead, freeing the key.
CREATE TABLE idempotency_responses (
  -- The principal the key is scoped to. `'anonymous'` until M0-BE-17 lands
  -- sessions; thereafter the user id. See JUDGMENT 2. Text, not uuid: 'system'
  -- and agent-scoped callers are not users and must still be scopable.
  scope               text        NOT NULL,
  -- The client's `Idempotency-Key` header verbatim. The contract bounds it at
  -- 8..255 characters; that bound is enforced at the edge (a violation is a
  -- `400` a client can act on) and left uncheck-constrained here, D-013.
  idempotency_key     text        NOT NULL,

  -- Which contract operation claimed the key. Not part of the PK (JUDGMENT 2);
  -- carried for operator forensics and folded into the fingerprint below.
  operation_id        text        NOT NULL,
  -- sha256, hex. Covers the operation, the route, the path and query
  -- parameters and the canonicalised body. Same key + different fingerprint is
  -- the contract's `409 idempotency_conflict`.
  request_fingerprint text        NOT NULL,
  -- 'in_progress' | 'completed'  (comment only, no CHECK — D-013)
  state               text        NOT NULL,
  -- The `x-request-id` of the request that holds the claim. Two jobs: it puts
  -- a stuck claim in the logs by its own trace id, and it is the guard on the
  -- completing UPDATE, so a request whose claim was taken over as stale can
  -- never write a response over the row that superseded it.
  claimed_by          text        NOT NULL,

  -- Populated only on the 'completed' transition, and only for an outcome that
  -- is safe to replay. Null while 'in_progress'.
  response_status     int,
  -- Null for a `204`, which declares no body and no type.
  response_content_type text,
  response_body       text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  -- Also the staleness clock: a claim whose `updated_at` is older than the
  -- API's takeover horizon is treated as abandoned (a crashed process) and may
  -- be claimed again, so a crash cannot brick a key permanently.
  updated_at          timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (scope, idempotency_key)
);

-- The retention sweep's only access path. Not a read-path index: nothing in
-- the request path looks a row up by age.
CREATE INDEX idempotency_responses_created_at_idx ON idempotency_responses (created_at);
