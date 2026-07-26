/**
 * `writeEvent` — the only way a row gets into `events`.
 *
 * It takes the CALLER'S transaction handle and never opens or commits one of
 * its own. That is the whole point (SD §3, the single most important
 * reliability decision in this product):
 *
 *     BEGIN;
 *       INSERT INTO contributions (...);
 *       writeEvent(tx, { event_type: 'contribution.created', ... });
 *       SELECT graphile_worker.add_job('projection.contribution', ...);
 *     COMMIT;
 *
 * The domain row, the event and the queued job commit together or not at all.
 * A `writeEvent` that managed its own transaction would reintroduce exactly the
 * orphaned-event / lost-job class of bug that putting the queue in Postgres
 * exists to make impossible.
 *
 * The insert pattern below is the one migration 0011 specifies (Judgment 2,
 * "INTENDED INSERT PATTERN"), and the reasons it is not something simpler are
 * written there:
 *
 *   - `ON CONFLICT` on the `events` insert CANNOT work. The duplicate is raised
 *     by an AFTER INSERT trigger inserting into `event_idempotency`, a
 *     different table; `ON CONFLICT` cannot see a conflict raised inside a
 *     trigger on another relation.
 *   - Writers never touch `event_idempotency` themselves. The trigger owns it.
 *   - A bare try/catch is not enough either: in Postgres, an error aborts the
 *     whole transaction unless a SAVEPOINT is standing. Without one, catching
 *     the duplicate would leave the caller holding a transaction in which every
 *     subsequent statement fails with 25P02 — the contribution row and the
 *     queued job would be lost to a retry that was supposed to be a no-op.
 *
 * Table names are unqualified and resolve through the connection's
 * `search_path`, exactly like the Drizzle table definitions in `@eutectic/db`
 * (`public` in the app; a throwaway schema under test).
 */

import type { JSONValue, PostgresError, TransactionSql } from "postgres";

import type { EventInput } from "./event.js";

/**
 * The constraint a duplicate `idempotency_key` violates.
 *
 * Checked BY NAME, not by SQLSTATE alone. 23505 is "some unique constraint was
 * violated" and plenty of them can fire under an event write — a future unique
 * index on `events`, a constraint on a table touched by a later trigger. Only
 * this one means "this event has already been written"; anything else is a real
 * failure and must reach the caller.
 */
export const EVENT_IDEMPOTENCY_CONSTRAINT = "event_idempotency_pkey";

/** The event was inserted. */
export interface EventWritten {
  readonly written: true;
  /**
   * `events.id`, as text. `id` is `bigserial`; postgres.js returns int8 as a
   * string, and this is cast in SQL so the shape does not change if the pool is
   * ever configured to parse bigints.
   */
  readonly id: string;
  /** The timestamp the row actually carries, whether supplied or defaulted. */
  readonly occurred_at: Date;
}

/**
 * The event was NOT inserted, because its `idempotency_key` had already been
 * claimed. This is a success, not a failure — see SD §3 and CLAUDE.md rule 7.
 */
export interface EventDeduplicated {
  readonly written: false;
  readonly reason: "duplicate_idempotency_key";
  readonly idempotency_key: string;
  /**
   * The event that claimed the key, when it is visible to this transaction.
   *
   * `null` when the winner is a CONCURRENT transaction that has not committed
   * yet: under READ COMMITTED its `event_idempotency` row is invisible to us,
   * even though its uncommitted index entry is what our insert collided with.
   * Callers that need the winner should re-read after commit.
   */
  readonly existing: { readonly id: string; readonly occurred_at: Date } | null;
}

export type WriteEventResult = EventWritten | EventDeduplicated;

interface EventRow {
  readonly id: string;
  readonly occurred_at: Date;
}

interface ClaimRow {
  readonly event_id: string;
  readonly occurred_at: Date;
}

/**
 * The one widening in this package, kept to one line so it can be audited.
 *
 * Every payload in `payloads.ts` is a plain JSON object by construction — no
 * `Date`, no `bigint`, no symbol — but they are declared as INTERFACES, and TS
 * gives an implicit index signature to type aliases only. So a perfectly
 * JSON-safe interface is not assignable to postgres.js's `JSONValue` even
 * though every value it can hold is. Nothing is unchecked here except that
 * structural technicality: the payload types themselves are still enforced at
 * every call site.
 */
function asJsonValue(payload: object): JSONValue {
  return payload as JSONValue;
}

/** postgres.js sets `code` and `constraint_name` on a server error. */
function isDuplicateIdempotencyKey(error: unknown): boolean {
  const candidate = error as Partial<PostgresError> | null;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    candidate.code === "23505" &&
    candidate.constraint_name === EVENT_IDEMPOTENCY_CONSTRAINT
  );
}

/**
 * Write one event inside the caller's transaction.
 *
 * @param tx  A transaction handle — the `sql` given to `sql.begin(...)`, or a
 *            savepoint handle inside one. Not a pool: a pool handle has no
 *            `.savepoint`, and an event written outside a transaction is an
 *            event that can outlive the row it describes.
 * @param event  A catalogue event. An `event_type` outside SD §4 does not
 *            typecheck, so the write path does no name validation at runtime.
 *
 * @returns `{ written: true, ... }` on insert, `{ written: false, ... }` when
 *          the `idempotency_key` was already claimed. NEITHER path throws for a
 *          duplicate. Every other database error propagates untouched.
 */
export async function writeEvent(tx: TransactionSql, event: EventInput): Promise<WriteEventResult> {
  const key = event.idempotency_key;

  if (key === undefined) {
    // No key means no `event_idempotency` insert (the trigger's WHEN clause
    // skips unkeyed events entirely), so there is no duplicate to recover from
    // and nothing for a savepoint to protect. Every other error must abort the
    // caller's transaction anyway — that is what a failed write of the event
    // half of an atomic write is supposed to do — so wrapping this in a
    // savepoint would buy nothing and cost two round trips plus a subtransaction
    // on the MAJORITY of events (migration 0011: unkeyed events are the common
    // case). Subtransactions are also not free at scale: past 64 of them in one
    // transaction, every backend pays for suboverflow.
    return { written: true, ...(await insertEvent(tx, event)) };
  }

  // Fast path. A primary-key probe on `event_idempotency`, which is the whole
  // reason that table is not partitioned. It turns the common "this retry has
  // already been written" case into one index lookup, no subtransaction, and it
  // is the only path that can return the winning event's id, because a
  // committed claim is visible here.
  //
  // It also catches a key written EARLIER IN THIS SAME TRANSACTION, which the
  // savepoint path below could not report a winner for.
  const claims = await tx<ClaimRow[]>`
    SELECT event_id::text AS event_id, occurred_at
    FROM event_idempotency
    WHERE idempotency_key = ${key}
  `;
  const claim = claims[0];
  if (claim !== undefined) {
    return {
      written: false,
      reason: "duplicate_idempotency_key",
      idempotency_key: key,
      existing: { id: claim.event_id, occurred_at: claim.occurred_at },
    };
  }

  // The probe cannot close the race — a concurrent transaction may claim the key
  // between the SELECT and the INSERT, and its claim is invisible to us until it
  // commits. The savepoint is what makes losing that race survivable.
  //
  // postgres.js 3.4.9 semantics, verified against
  // node_modules/postgres/src/index.js (`scope()`): `tx.savepoint(fn)` issues
  // `SAVEPOINT sN`, runs `fn`, and if `fn` rejects issues `ROLLBACK TO sN` and
  // rethrows the original error. So the rollback is automatic and the catch
  // below runs with the transaction already clean and usable.
  //
  // Two consequences worth knowing:
  //   - The catch MUST be outside `savepoint(...)`. Catching inside the callback
  //     does not help: postgres.js records the failed query in `uncaughtError`
  //     and rethrows it even when the callback resolves.
  //   - postgres.js does not `RELEASE` the savepoint on success. Harmless — an
  //     unreleased savepoint is released by COMMIT — but it is another reason
  //     the unkeyed path above does not open one.
  try {
    const row = await tx.savepoint((sp: TransactionSql) => insertEvent(sp, event));
    return { written: true, ...row };
  } catch (error) {
    if (!isDuplicateIdempotencyKey(error)) throw error;
    return {
      written: false,
      reason: "duplicate_idempotency_key",
      idempotency_key: key,
      existing: null,
    };
  }
}

/**
 * The insert itself. Columns exactly as migration 0011 declares them.
 *
 * `occurred_at` is written as the literal `DEFAULT` when the caller omits it,
 * rather than a client-side `new Date()` or a repeated `now()`: the column's
 * default is the schema's business, and a timestamp minted in Node would be the
 * app server's clock rather than the database's.
 *
 * `payload` goes through `tx.json(...)` and NOT `${JSON.stringify(payload)}::jsonb`.
 * The latter looks right and silently stores the wrong thing: postgres.js reads
 * the `::jsonb` cast, decides the parameter is json, and JSON-encodes the
 * ALREADY-encoded string — so `{ from_state: 'open' }` lands as the jsonb
 * *string scalar* `"{\"from_state\":\"open\"}"` instead of an object.
 * `jsonb_typeof` says `string`, every `payload->>'from_state'` returns null, and
 * nothing complains until a projection quietly reads nothing. `tx.json` binds
 * the value as 3802 with one encoding pass.
 */
async function insertEvent(tx: TransactionSql, event: EventInput): Promise<EventRow> {
  const occurredAt = event.occurred_at;
  const rows = await tx<EventRow[]>`
    INSERT INTO events (
      occurred_at, actor_type, actor_id, event_type,
      subject_type, subject_id, forum_id, payload, idempotency_key
    ) VALUES (
      ${occurredAt === undefined ? tx`DEFAULT` : tx`${occurredAt}`},
      ${event.actor.type},
      ${event.actor.id ?? null},
      ${event.event_type},
      ${event.subject.type},
      ${event.subject.id},
      ${event.forum_id ?? null},
      ${tx.json(asJsonValue(event.payload ?? {}))},
      ${event.idempotency_key ?? null}
    )
    RETURNING id::text AS id, occurred_at
  `;

  const row = rows[0];
  if (row === undefined) {
    // Unreachable: an INSERT ... RETURNING that inserts nothing has already
    // thrown. Guarded because `noUncheckedIndexedAccess` is on and a silent
    // `undefined` in the reliability spine is not a thing to shrug at.
    throw new Error("writeEvent: INSERT ... RETURNING produced no row");
  }
  return row;
}
