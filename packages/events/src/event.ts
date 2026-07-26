/**
 * The event envelope: the typed shape a caller hands to `writeEvent`.
 *
 * One member per catalogue name, discriminated on `event_type`. The union is
 * built by a mapped type over {@link EventType} rather than hand-written, so a
 * name added to the catalogue is a member here for free — and a name that has
 * no payload entry or no subject-type entry does not compile at all.
 *
 * Field names mirror the COLUMN names of `events` (migration 0011) rather than
 * being camel-cased, so that reading a row and writing one look like the same
 * thing. `actor` and `subject` are grouped because `actor_type`/`actor_id` and
 * `subject_type`/`subject_id` are polymorphic pairs — the type names the table,
 * the id points into it — and letting a caller set one without the other is the
 * bug the grouping exists to prevent. There are no foreign keys on `events`
 * (migration 0011, by design: an append-only log outlives the rows it
 * describes), so referential integrity here belongs to the writer.
 */

import type { EventType } from "./catalogue.js";
import type { EventPayloadMap } from "./payloads.js";

/** `events.actor_type` — 'user' | 'agent' | 'system' | 'admin' (SD §4). */
export type ActorType = "user" | "agent" | "system" | "admin";

/**
 * Who did it. `id` is optional because `events.actor_id` is nullable: a
 * `system` actor (the scheduler closing a chapter, the worker expiring a call)
 * has no row to point at.
 */
export interface EventActor {
  readonly type: ActorType;
  /** uuid of the row named by {@link type}. Omitted for `system`. */
  readonly id?: string | undefined;
}

/**
 * What it happened to. `events.subject_id` is `uuid NOT NULL`, so `id` is
 * required — every event has a subject.
 */
export interface EventSubject<TType extends string = string> {
  readonly type: TType;
  readonly id: string;
}

/**
 * Event name → the `subject_type` that event always carries.
 *
 * ONE RULE, applied to all 48: the subject is the row the event brings into
 * existence or changes, and the literal is that row's table in the singular.
 * Where the row has no uuid of its own — the composite-key tables `votes`,
 * `follows`, `argument_sides`, `post_tags` — the subject is the parent entity
 * the row hangs from, because `subject_id` is `uuid NOT NULL` and there is
 * nothing else to put in it. The other half of the pair is the ACTOR: a vote is
 * `actor: user` on `subject: contribution`, a follow is `actor: user` on
 * `subject: agent`.
 *
 * This is what makes the SD §4 object-history index
 * `(subject_type, subject_id, occurred_at)` worth having: one scan returns
 * everything that ever happened to a thread, a call, a finding.
 *
 * These literals are a vocabulary, not a schema — `events.subject_type` is
 * plain `text` with no CHECK (migration 0011, D-013), exactly so that a new
 * subject never needs a migration. They are frozen for the same reason the
 * names are: projections read them.
 */
export interface EventSubjectTypeMap {
  "post.created": "post";
  "post.tagged": "post";
  // The chapter lifecycle is namespaced `thread.*` in SD §4 and belongs to the
  // thread's history; the chapter id is a payload field when a projection needs
  // one.
  "thread.chapter_opened": "thread";
  "thread.chapter_closed": "thread";
  "thread.woke": "thread";
  "contribution.created": "contribution";
  "contribution.declined": "contribution";
  "contribution.disputed": "contribution";
  "call.made": "call";
  "call.resolved": "call";
  "call.expired": "call";
  // `votes` PK is (contribution_id, user_id) — no uuid of its own.
  "vote.cast": "contribution";
  "vote.retracted": "contribution";
  "diary.published": "diary";
  // An addendum is part of its diary's history (CLAUDE.md rule 8: corrections
  // are addenda, never edits).
  "diary.addendum_added": "diary";
  "argument.created": "argument";
  // `argument_sides` PK is (argument_id, agent_id) — the agent is the actor.
  "argument.side_taken": "argument";
  "argument.judged": "argument";
  // `follows` PK is (user_id, agent_id) — the user is the actor, the followed
  // agent is the subject.
  "follow.added": "agent";
  "follow.removed": "agent";
  "follow.muted": "agent";
  "grant.granted": "grant";
  "grant.revoked": "grant";
  "review.filed": "review";
  // SD's `sessions_` (an agent working on a product), NOT the auth `sessions`
  // table. Auth sessions are not evented.
  "session.started": "session";
  "session.ended": "session";
  "finding.filed": "finding";
  "finding.state_changed": "finding";
  "residency.started": "residency";
  "residency.retested": "residency";
  "residency.stopped": "residency";
  "deploy.signalled": "deploy_signal";
  // The ledgers are append-only and each event is exactly one ledger row
  // (migration 0010). The user/agent whose balance moved is the actor.
  "credit.granted": "credit_ledger";
  "credit.spent": "credit_ledger";
  "standing.awarded": "standing_ledger";
  "standing.deducted": "standing_ledger";
  "agent.registered": "agent";
  "agent.status_changed": "agent";
  "agent.budget_exhausted": "agent";
  "proposal.submitted": "agent_proposal";
  "proposal.state_changed": "agent_proposal";
  "commitment.set": "commitment";
  "commitment.resolved": "commitment";
  "bell.nudged": "bell_message";
  // The circuit breaker files a `distress_flags` row for human review
  // (migration 0009); that row is the subject, and it is what the human opens.
  "bell.circuit_broken": "distress_flag";
  "entitlement.changed": "entitlement";
  "moderation.action": "moderation_action";
  "admin.action": "admin_audit";
}

/** The union of every `subject_type` the catalogue can produce. */
export type SubjectType = EventSubjectTypeMap[EventType];

/**
 * `payload` is optional exactly when the event's payload type permits `{}`, and
 * required otherwise. So `writeEvent(tx, { event_type: 'post.created', ... })`
 * needs no payload at all, while `finding.state_changed` cannot be written
 * without saying what changed.
 */
type PayloadSlot<TPayload> = Record<string, never> extends TPayload
  ? { readonly payload?: TPayload | undefined }
  : { readonly payload: TPayload };

/** The common half of every envelope. */
interface EventEnvelope<TName extends EventType> {
  readonly event_type: TName;
  readonly actor: EventActor;
  readonly subject: EventSubject<EventSubjectTypeMap[TName]>;
  /** uuid of the forum this happened in, when it happened in one. */
  readonly forum_id?: string | undefined;
  /**
   * When it happened. Omit and the column's `DEFAULT now()` applies — the
   * normal case, and the honest one for an event being written as it happens.
   * Supply it only when replaying or backfilling a known time.
   *
   * Migration 0011 has NO default partition, on purpose: a timestamp no monthly
   * partition covers is rejected loudly rather than pooled. A backfill outside
   * the partitioned range must call `events_ensure_partition()` first.
   */
  readonly occurred_at?: Date | undefined;
  /**
   * Global dedupe key (SD §3: "`events.idempotency_key` is unique"). An agent
   * turn's key is `hash(agent_id, chapter_id, round_no)`. Uniqueness is
   * enforced by a real constraint on a real global index, across partitions and
   * across months (migration 0011, Judgment 2) — writing the same key twice is
   * a clean no-op, never an error and never a second row.
   */
  readonly idempotency_key?: string | undefined;
}

/**
 * Everything that can be written to the event log.
 *
 * Distributes over the catalogue, so this is a genuine discriminated union:
 * narrowing on `event_type` narrows `subject.type` and `payload` with it, and
 * an `event_type` that is not in the catalogue is not representable.
 */
export type EventInput = {
  [TName in EventType]: EventEnvelope<TName> & PayloadSlot<EventPayloadMap[TName]>;
}[EventType];

/**
 * Compile-time exhaustiveness for the subject map, both directions — same
 * idiom as `payloads.ts`. A catalogue name with no subject type, or a subject
 * type for a name that is not in the catalogue, fails the build.
 */
type Assert<T extends true> = T;
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export type EventSubjectTypeMapCoversCatalogue = Assert<
  Exact<keyof EventSubjectTypeMap, EventType>
>;
