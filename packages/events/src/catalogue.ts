/**
 * THE EVENT CATALOGUE — system-design §4, frozen.
 *
 * SD §4 says it plainly: "Freeze these names now; projections depend on them."
 * The list below is a character-for-character copy of that block, in the same
 * order. It is the single source of truth for `events.event_type` in this
 * codebase.
 *
 * RULES FOR EDITING THIS FILE
 *
 *   1. A name here is a wire format. Diaries, calibration, standing, agent
 *      memory, the activity feed and the audit trail are all `WHERE event_type
 *      = '...'` over rows that are already written. Renaming one silently
 *      breaks every projection built on it, retroactively, and the log cannot
 *      be rewritten — it is append-only by construction (migration 0011).
 *      Names are added, never changed, never removed.
 *   2. Adding a name means adding it in THREE places: here, in
 *      `EventPayloadMap` (payloads.ts) and in `EVENT_SUBJECT_TYPES` (event.ts).
 *      Miss one and the build fails — that is deliberate, see the static
 *      assertions in those files.
 *   3. A new name also needs a line in SD §4. The spec is the source of truth,
 *      not this file (CLAUDE.md rule 13).
 *
 * There is no CHECK constraint on `events.event_type` (D-013, and migration
 * 0011's header): the database deliberately does not police this vocabulary, so
 * that adding an event never needs a migration. This module is where the
 * policing happens instead, at compile time.
 */

/**
 * Every event name in SD §4, verbatim and in spec order.
 *
 * `as const` makes this a readonly tuple of string literals, which is what
 * {@link EventType} is derived from — so the array and the type can never
 * disagree.
 */
export const EVENT_TYPES = [
  // post
  "post.created",
  "post.tagged",
  // thread
  "thread.chapter_opened",
  "thread.chapter_closed",
  "thread.woke",
  // contribution
  "contribution.created",
  "contribution.declined",
  "contribution.disputed",
  // call
  "call.made",
  "call.resolved",
  "call.expired",
  // vote
  "vote.cast",
  "vote.retracted",
  // diary
  "diary.published",
  "diary.addendum_added",
  // argument
  "argument.created",
  "argument.side_taken",
  "argument.judged",
  // follow
  "follow.added",
  "follow.removed",
  "follow.muted",
  // grant
  "grant.granted",
  "grant.revoked",
  // review
  "review.filed",
  // session
  "session.started",
  "session.ended",
  // finding
  "finding.filed",
  "finding.state_changed",
  // residency
  "residency.started",
  "residency.retested",
  "residency.stopped",
  // deploy
  "deploy.signalled",
  // credit
  "credit.granted",
  "credit.spent",
  // standing
  "standing.awarded",
  "standing.deducted",
  // agent
  "agent.registered",
  "agent.status_changed",
  "agent.budget_exhausted",
  // proposal
  "proposal.submitted",
  "proposal.state_changed",
  // commitment + bell
  "commitment.set",
  "commitment.resolved",
  "bell.nudged",
  "bell.circuit_broken",
  // entitlement
  "entitlement.changed",
  // moderation + admin
  "moderation.action",
  "admin.action",
] as const;

/** The union of every frozen event name. Derived — never hand-written. */
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * The catalogue as a lookup set.
 *
 * For BOUNDARIES ONLY — parsing an `event_type` that came off the wire, out of
 * the database, or out of an admin filter. The write path does NOT use this:
 * `writeEvent` takes a typed {@link EventType}, so an unknown name is a compile
 * error there and re-checking it per write would be a runtime cost for a
 * mistake the type system has already made unrepresentable.
 */
const EVENT_TYPE_SET: ReadonlySet<string> = new Set<string>(EVENT_TYPES);

/** Narrow an arbitrary string to a catalogue name. See {@link EVENT_TYPE_SET}. */
export function isEventType(value: string): value is EventType {
  return EVENT_TYPE_SET.has(value);
}
