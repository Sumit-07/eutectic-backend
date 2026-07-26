/**
 * The `Idempotency-Key` store (M0-BE-16, system-design §3).
 *
 * Every statement in this file is atomic and guarded, and that is the whole
 * design: **the database decides who executes**, never this process. There is
 * no mutex, no in-flight map, no promise cache — those work for one process and
 * silently stop working the day a second one starts, which is the day the API
 * is behind a load balancer.
 *
 * Exactly three statements grant or use ownership of a key:
 *
 *   1. `INSERT ... ON CONFLICT (scope, idempotency_key) DO NOTHING RETURNING` —
 *      the claim. Under N concurrent identical requests, exactly one row is
 *      inserted and exactly one caller gets a row back, because a unique index
 *      says so. That is the "exactly one execution" guarantee.
 *   2. `UPDATE ... WHERE state = 'in_progress' AND updated_at < now() - ...
 *      RETURNING` — the takeover of a claim abandoned by a crashed process.
 *      Also exactly-one, for exactly the same reason.
 *   3. `UPDATE ... WHERE state = 'in_progress' AND claimed_by = $me` — the
 *      recording. The `claimed_by` guard means a request whose claim was taken
 *      over cannot write its response over the row that superseded it.
 *
 * TABLE NAME, unqualified, on purpose: the pool decides the schema. Production
 * runs in `public`; tests hand in a pool pinned to a throwaway schema with
 * postgres.js's `connection: { search_path }`, which is how every other suite
 * in this repo stays off the dev database.
 */

import type { createPool } from "@eutectic/db";

/**
 * The postgres.js handle, spelled without importing `postgres` — apps/api
 * depends on `@eutectic/db`, not on the driver, and adding the driver to this
 * manifest for a type would be a dependency (rule 12) bought for nothing.
 */
export type IdempotencyPool = ReturnType<typeof createPool>;

/** What identifies a claim: the principal, the client's key, and who holds it. */
export interface ClaimRequest {
  /** The principal. `'anonymous'` until M0-BE-17 lands sessions. */
  readonly scope: string;
  /** The client's `Idempotency-Key`, verbatim. */
  readonly key: string;
  /** The contract operation being claimed. Recorded for forensics. */
  readonly operationId: string;
  /** sha256 hex of the canonicalised request. A mismatch is the contract's 409. */
  readonly fingerprint: string;
  /** This request's `x-request-id`. Guards the recording statement. */
  readonly requestId: string;
}

/** A response held for replay. `body` is the serialised payload, byte for byte. */
export interface RecordedResponse {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: string | null;
}

export type ClaimOutcome =
  /** This request owns the key. Execute, then `complete` or `release`. */
  | { readonly kind: "claimed" }
  /** The key was used for a different request. The contract's `409`. */
  | { readonly kind: "conflict" }
  /** The key already has a recorded outcome. Replay it; do not execute. */
  | { readonly kind: "replay"; readonly record: RecordedResponse }
  /** Someone else holds a live claim. Wait for it; do not execute. */
  | { readonly kind: "in_progress" };

export interface IdempotencyStore {
  claim(request: ClaimRequest, staleAfterMs: number): Promise<ClaimOutcome>;
  /** Record an outcome for replay. No-op if this request no longer owns the claim. */
  complete(request: ClaimRequest, response: RecordedResponse): Promise<void>;
  /** Drop this request's claim so the key is retryable. Used for every outcome we refuse to record. */
  release(request: ClaimRequest): Promise<void>;
}

interface StoredRow {
  readonly request_fingerprint: string;
  readonly state: string;
  readonly response_status: number | null;
  readonly response_content_type: string | null;
  readonly response_body: string | null;
  readonly stale: boolean;
}

/** The Postgres-backed store. The only implementation there should ever be. */
export function createIdempotencyStore(pool: IdempotencyPool): IdempotencyStore {
  return {
    async claim(request: ClaimRequest, staleAfterMs: number): Promise<ClaimOutcome> {
      const inserted = await pool`
        INSERT INTO idempotency_responses
          (scope, idempotency_key, operation_id, request_fingerprint, state, claimed_by)
        VALUES (${request.scope}, ${request.key}, ${request.operationId},
                ${request.fingerprint}, 'in_progress', ${request.requestId})
        ON CONFLICT (scope, idempotency_key) DO NOTHING
        RETURNING scope
      `;
      if (inserted.length === 1) return { kind: "claimed" };

      const rows = (await pool`
        SELECT request_fingerprint, state, response_status, response_content_type, response_body,
               updated_at < now() - make_interval(secs => ${staleAfterMs / 1000}) AS stale
        FROM idempotency_responses
        WHERE scope = ${request.scope} AND idempotency_key = ${request.key}
      `) as unknown as readonly StoredRow[];

      const row = rows[0];
      // Vanishingly rare, and benign: the row was deleted between the two
      // statements — a concurrent request released its claim after failing.
      // Try to claim it again from the top rather than invent an answer.
      if (row === undefined) return this.claim(request, staleAfterMs);

      // The contract's rule, checked before anything else: this key belongs to
      // a different request, whatever state it is in.
      if (row.request_fingerprint !== request.fingerprint) return { kind: "conflict" };

      if (row.state === "completed") {
        return {
          kind: "replay",
          record: {
            // A completed row always carries a status; the fallback exists so a
            // corrupt row degrades to "replay a 200" rather than to a crash.
            status: row.response_status ?? 200,
            contentType: row.response_content_type,
            body: row.response_body,
          },
        };
      }

      if (!row.stale) return { kind: "in_progress" };

      // The holder is gone (a crashed process). Take the claim over — guarded,
      // so ten simultaneous takers still produce one execution.
      const takenOver = await pool`
        UPDATE idempotency_responses
        SET claimed_by = ${request.requestId}, updated_at = now()
        WHERE scope = ${request.scope} AND idempotency_key = ${request.key}
          AND state = 'in_progress'
          AND updated_at < now() - make_interval(secs => ${staleAfterMs / 1000})
        RETURNING scope
      `;
      return takenOver.length === 1 ? { kind: "claimed" } : { kind: "in_progress" };
    },

    async complete(request: ClaimRequest, response: RecordedResponse): Promise<void> {
      await pool`
        UPDATE idempotency_responses
        SET state = 'completed',
            response_status = ${response.status},
            response_content_type = ${response.contentType},
            response_body = ${response.body},
            updated_at = now()
        WHERE scope = ${request.scope} AND idempotency_key = ${request.key}
          AND state = 'in_progress' AND claimed_by = ${request.requestId}
      `;
    },

    async release(request: ClaimRequest): Promise<void> {
      await pool`
        DELETE FROM idempotency_responses
        WHERE scope = ${request.scope} AND idempotency_key = ${request.key}
          AND state = 'in_progress' AND claimed_by = ${request.requestId}
      `;
    },
  };
}
