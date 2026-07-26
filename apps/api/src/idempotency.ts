/**
 * `Idempotency-Key` middleware (M0-BE-16, system-design §3 "Idempotency,
 * everywhere"; openapi.yaml `components.parameters.IdempotencyKey`).
 *
 * Which routes: every operation whose `RouteDescriptor` says `mutating` — the
 * flag `routes.ts` already puts on `request.routeOptions.config`, which is
 * generated from the contract, so this middleware cannot disagree with
 * `openapi.yaml` about what a mutation is. Reads never require the header and
 * never touch the store.
 *
 * The shape is claim → execute → record, with the claim living in Postgres:
 *
 *   1. `preHandler` claims `(scope, key)`. An `INSERT ... ON CONFLICT DO
 *      NOTHING` decides the winner, so "exactly one execution" survives two
 *      processes, which no in-process lock does.
 *   2. The handler runs — once.
 *   3. `onSend` records the serialised response against the claim, or deletes
 *      the claim, per the recording policy below.
 *   4. A later request with the same key and the same fingerprint gets the
 *      recorded bytes back and never reaches the handler.
 *
 * ---------------------------------------------------------------------------
 * FOUR JUDGMENT CALLS, all of them flagged in the PR body
 * ---------------------------------------------------------------------------
 *
 * **(a) Key reuse is `409`, not `422`.** The ticket's acceptance text says
 * `422`; `openapi.yaml` declares `409 → idempotency_conflict` on all seven
 * mutating operations and declares `422` as "well-formed, but fails a domain
 * rule". Rule 1 makes the contract the tiebreaker, so this is `409`. Flagged
 * for Fable, who owns both documents.
 *
 * **(b) The loser of a race waits, it does not get `409`.** A duplicate that
 * arrives while the first is still running is answered by replaying the first
 * request's response once it lands (bounded wait, then `429` + `Retry-After`).
 * Answering `409 idempotency_conflict` would be actively dangerous: a client
 * reading that code is told its key is bad, and the correct client response to
 * a bad key is to generate a NEW one and retry — which is exactly how you
 * double-post. `429` says "same request, same key, in a moment", which is the
 * action we actually want.
 *
 * **(c) Only a 2xx is recorded. Everything else releases the claim.**
 * Idempotency exists to protect a COMMITTED SIDE EFFECT. A non-2xx in this app
 * leaves none — an `ApiFailure` is thrown instead of a reply, and any
 * transaction under it rolls back — so re-executing a retry after a failure is
 * both safe and strictly better than the alternative. The alternative is
 * genuinely bad: recording a `500` pins a client to a crash forever, and
 * recording a `429` or a `401` pins it to a condition that has already passed.
 * The asymmetry decides it — recording too much breaks retries, recording too
 * little costs one harmless re-execution.
 *
 * **(d) `Idempotent-Replay: true` on a replayed response.** Not declared in
 * the contract. Same precedent as `x-request-id` (M0-BE-15), which is also an
 * operational header the contract does not mention: it is additive, no client
 * has to read it, and without it a replay is indistinguishable from a fresh
 * execution in a log or a packet capture.
 *
 * ---------------------------------------------------------------------------
 * KNOWN LIMITATION, stated rather than buried
 * ---------------------------------------------------------------------------
 * The claim is committed in its own transaction, separate from whatever the
 * handler does. A process that dies between committing its work and recording
 * its response leaves a claim that the takeover horizon eventually frees, and a
 * retry then re-executes. The only complete fix is writing the record inside
 * the handler's transaction, which needs handlers that have one — no operation
 * has a body yet (they all `501`). When the first real mutation lands, its
 * ticket should take the claim row into its transaction; the store's statements
 * are already shaped to allow it.
 */

import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { ApiFailure } from "./errors.js";
import type { IdempotencyStore, ClaimRequest, RecordedResponse } from "./idempotency-store.js";
import type { ContractRouteConfig } from "./routes.js";

/** The header, lowercase — Node normalises inbound header names. */
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

/** Set on a response served from the store rather than from the handler. */
export const IDEMPOTENT_REPLAY_HEADER = "idempotent-replay";

/**
 * From `openapi.yaml`'s `IdempotencyKey` schema (`minLength: 8`,
 * `maxLength: 255`). Enforced here rather than by a route schema because it is
 * one rule shared by seven operations, and because the middleware has to read
 * the header before validation runs anyway.
 */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

/**
 * The principal a key is scoped to, until M0-BE-17 lands sessions.
 *
 * The store's primary key is `(scope, idempotency_key)` because the key is
 * client-generated and its namespace is therefore not ours (migration 0012,
 * JUDGMENT 2). There is no principal yet, so every request is `'anonymous'`
 * and the scope column is a constant — deliberately: the column has to exist
 * NOW, because a primary key is the one thing a later migration cannot add
 * additively. When sessions land, this function returns the user id and
 * nothing else changes.
 */
export const ANONYMOUS_SCOPE = "anonymous";

export interface IdempotencyTuning {
  /**
   * How long a duplicate waits for the in-flight original before giving up
   * with a `429`. Below any sensible client or proxy read timeout.
   */
  readonly waitTimeoutMs?: number;
  /** How often the waiter re-reads the claim. */
  readonly pollIntervalMs?: number;
  /**
   * How long a claim may sit `in_progress` before it is treated as abandoned
   * by a crashed process and may be taken over. Must exceed the slowest
   * legitimate request by a wide margin: too low double-executes, too high
   * strands a key.
   */
  readonly staleAfterMs?: number;
}

interface ResolvedTuning {
  readonly waitTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly staleAfterMs: number;
}

const DEFAULT_TUNING: ResolvedTuning = {
  waitTimeoutMs: 2_000,
  pollIntervalMs: 25,
  staleAfterMs: 60_000,
};

/**
 * The claim a request holds, from `preHandler` until `onSend`.
 *
 * A `WeakMap` rather than `decorateRequest`: fastify 5 requires reference-typed
 * decorators to be installed as getters to avoid sharing one object across
 * requests, and the map has none of that hazard — the entry dies with the
 * request object, and a route that never claims never allocates.
 */
const claims = new WeakMap<FastifyRequest, ClaimRequest>();

export interface IdempotencyOptions {
  /** Absent means no store is configured; every mutating route then fails closed. */
  readonly store?: IdempotencyStore;
  readonly tuning?: IdempotencyTuning;
}

/** Installs the two hooks. Called once, from `buildApp`. */
export function registerIdempotency(app: FastifyInstance, options: IdempotencyOptions): void {
  const tuning: ResolvedTuning = { ...DEFAULT_TUNING, ...options.tuning };
  const store = options.store;

  app.addHook("preHandler", async (request, reply) => {
    const config = request.routeOptions.config as ContractRouteConfig | undefined;
    // Not a contract route (the 404 path), or a read. Reads never require the
    // header — the contract declares the parameter on mutating operations only.
    if (config?.operationId === undefined || !config.mutating) return undefined;

    // FAIL CLOSED. A mutating route with no store cannot promise single
    // execution, and the honest failure is to refuse the mutation rather than
    // to perform it undeduplicated. `buildApp()` without a pool still serves
    // every read, which is what keeps the surface testable without a database.
    if (store === undefined) {
      request.log.error(
        { operationId: config.operationId },
        "mutating route refused: no idempotency store configured",
      );
      throw new ApiFailure(500, "internal", "unexpected error");
    }

    const claim: ClaimRequest = {
      scope: ANONYMOUS_SCOPE,
      key: readKey(request),
      operationId: config.operationId,
      fingerprint: fingerprintRequest(request, config.operationId),
      requestId: request.id,
    };

    const deadline = Date.now() + tuning.waitTimeoutMs;
    for (;;) {
      const outcome = await store.claim(claim, tuning.staleAfterMs);

      if (outcome.kind === "claimed") {
        claims.set(request, claim);
        return undefined;
      }

      if (outcome.kind === "conflict") {
        // The contract's own wording for this response.
        throw new ApiFailure(
          409,
          "idempotency_conflict",
          "this key was used for a different request",
        );
      }

      if (outcome.kind === "replay") {
        request.log.info({ operationId: claim.operationId }, "idempotent replay");
        return replay(reply, outcome.record);
      }

      if (Date.now() >= deadline) {
        request.log.warn(
          { operationId: claim.operationId },
          "duplicate request still waiting on an in-flight claim",
        );
        throw new ApiFailure(
          429,
          "rate_limited",
          "a request with this idempotency key is still in flight",
          { headers: { "retry-after": "1" } },
        );
      }
      await sleep(tuning.pollIntervalMs);
    }
  });

  app.addHook("onSend", async (request, reply, payload: unknown) => {
    const claim = claims.get(request);
    if (claim === undefined || store === undefined) return payload;
    // One shot: the hook runs again if anything re-sends, and the claim is
    // resolved exactly once.
    claims.delete(request);

    try {
      const record = recordable(reply, payload);
      if (record === undefined) {
        await store.release(claim);
      } else {
        await store.complete(claim, record);
      }
    } catch (error) {
      // Never turn a completed mutation into an error because the bookkeeping
      // failed: the side effect really did happen and the client is entitled to
      // hear so. The claim is left behind and the takeover horizon reaps it.
      request.log.error(
        { err: error, operationId: claim.operationId },
        "failed to resolve idempotency claim",
      );
    }
    return payload;
  });
}

/** The header, validated against the contract's own bounds. */
function readKey(request: FastifyRequest): string {
  const raw = request.headers[IDEMPOTENCY_KEY_HEADER];
  // Duplicate headers are ambiguous, not mergeable — and here ambiguity would
  // decide which key a mutation is deduplicated under. Refuse it.
  const value = Array.isArray(raw) ? undefined : raw;

  if (value === undefined || value.length === 0) {
    throw new ApiFailure(400, "bad_request", "idempotency-key header is required", {
      details: [{ field: "Idempotency-Key", issue: "required" }],
    });
  }
  if (value.length < IDEMPOTENCY_KEY_MIN_LENGTH || value.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new ApiFailure(400, "bad_request", "idempotency-key header is out of range", {
      details: [{ field: "Idempotency-Key", issue: "length" }],
    });
  }
  return value;
}

/**
 * What makes two requests "the same request".
 *
 * Operation, route template, path parameters, query and body — everything the
 * server would act on. Not included: headers (a retry legitimately carries a
 * new `x-request-id`, a refreshed token, a different `User-Agent`) and not the
 * raw body bytes, because the body is canonicalised first: two retries that
 * serialise the same object with different key order or whitespace are the
 * same request, and answering `409` to one of them would be a false alarm on
 * the one path where a false alarm makes a client generate a new key and
 * double-post.
 */
export function fingerprintRequest(request: FastifyRequest, operationId: string): string {
  const parts = [
    operationId,
    request.method.toUpperCase(),
    request.routeOptions.url ?? request.url,
    canonicalize(request.params),
    canonicalize(request.query),
    canonicalize(request.body),
  ];
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

/**
 * A deterministic rendering of a JSON value: object keys sorted, arrays in
 * order, `undefined` and `null` indistinguishable (they are on the wire).
 * Not a JSON serialiser — nothing parses this back — just a stable string.
 */
export function canonicalize(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const entries = Object.keys(source)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(source[key])}`);
    return `{${entries.join(",")}}`;
  }
  // Functions, symbols, bigints: not reachable from a parsed JSON body, and a
  // stable placeholder beats throwing inside a hook.
  return JSON.stringify(String(value));
}

/**
 * The recording policy, in one function: a 2xx whose payload we can store
 * faithfully, and nothing else. `undefined` means "release the claim".
 */
function recordable(reply: FastifyReply, payload: unknown): RecordedResponse | undefined {
  const status = reply.statusCode;
  if (status < 200 || status >= 300) return undefined;

  // `204` and any empty body: recorded as a null body, which replays as a
  // bodyless response of the same status.
  if (payload === undefined || payload === null || payload === "") {
    return { status, contentType: null, body: null };
  }
  // A stream or a Buffer cannot be replayed from a text column. No operation
  // produces one today; if one ever does, re-executing is safer than replaying
  // an empty body, so the claim is released instead.
  if (typeof payload !== "string") return undefined;

  return { status, contentType: headerString(reply.getHeader("content-type")), body: payload };
}

/** Replays a recorded response verbatim. */
function replay(reply: FastifyReply, record: RecordedResponse): FastifyReply {
  void reply.header(IDEMPOTENT_REPLAY_HEADER, "true");
  void reply.code(record.status);
  if (record.body === null) return reply.send();
  if (record.contentType !== null) void reply.type(record.contentType);
  // A string payload is written through untouched — the bytes the first caller
  // got are the bytes this caller gets.
  return reply.send(record.body);
}

function headerString(value: number | string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}
