/**
 * Per-event payload types for `events.payload` (jsonb, NOT NULL DEFAULT '{}').
 *
 * WHAT THIS FILE DELIBERATELY IS NOT
 *
 * SD §4 freezes the event NAMES and says nothing about payload shapes. Payload
 * shapes are therefore not frozen, and inventing rich ones here would be
 * inventing spec. Every payload below starts EMPTY except for one family: the
 * events whose name says a state moved (`*.state_changed`, `*.status_changed`,
 * `entitlement.changed`). For those the transition IS the event — a
 * `finding.state_changed` row that does not say what it changed from and to is
 * not worth writing — and the column the transition reads is named explicitly
 * by the schema, so nothing is invented there either.
 *
 * GROWTH RULE
 *
 * Every event gets its OWN exported interface, even when that interface is
 * empty. That is the extension point: a later ticket that needs `chapter_id` on
 * `thread.chapter_opened` adds a field to `ThreadChapterOpenedPayload` and
 * nothing else in the codebase moves. Payload shapes are expected to grow.
 * NAMES never change (catalogue.ts).
 *
 * Fields are added, and only added: a payload field that has ever been written
 * is in the log forever, so removing or retyping one makes old rows
 * unreadable. Add a new optional field; leave the old one alone.
 *
 * Every shape here must survive `JSON.stringify` → jsonb → `JSON.parse`: no
 * `Date`, no `undefined` inside the object, no `bigint`. Timestamps go in as
 * ISO strings; the event's own time is `occurred_at`, a real column.
 */

import type { EventType } from "./catalogue.js";

/**
 * The default payload: no fields.
 *
 * `Record<string, never>` and not `{}` on purpose — `{}` accepts any object at
 * all, which would let a caller smuggle untyped fields into the log and defeat
 * the point of this file. `Record<string, never>` accepts exactly `{}`.
 */
export type EmptyPayload = Record<string, never>;

/**
 * A state transition, as written by the column that holds the state.
 * `from` is nullable because a row's first transition has nothing behind it.
 */
export interface StateTransitionPayload {
  readonly from_state: string | null;
  readonly to_state: string;
}

/* -------------------------------------------------------------------------- */
/* post                                                                       */
/* -------------------------------------------------------------------------- */

export interface PostCreatedPayload extends EmptyPayload {}
export interface PostTaggedPayload extends EmptyPayload {}

/* -------------------------------------------------------------------------- */
/* thread                                                                     */
/* -------------------------------------------------------------------------- */

export interface ThreadChapterOpenedPayload extends EmptyPayload {}
export interface ThreadChapterClosedPayload extends EmptyPayload {}
export interface ThreadWokePayload extends EmptyPayload {}

/* -------------------------------------------------------------------------- */
/* contribution                                                               */
/* -------------------------------------------------------------------------- */

export interface ContributionCreatedPayload extends EmptyPayload {}
export interface ContributionDeclinedPayload extends EmptyPayload {}
export interface ContributionDisputedPayload extends EmptyPayload {}

/* -------------------------------------------------------------------------- */
/* call                                                                       */
/* -------------------------------------------------------------------------- */

export interface CallMadePayload extends EmptyPayload {}
export interface CallResolvedPayload extends EmptyPayload {}
export interface CallExpiredPayload extends EmptyPayload {}

/* -------------------------------------------------------------------------- */
/* vote                                                                       */
/* -------------------------------------------------------------------------- */

export interface VoteCastPayload extends EmptyPayload {}
export interface VoteRetractedPayload extends EmptyPayload {}

/* -------------------------------------------------------------------------- */
/* diary                                                                      */
/* -------------------------------------------------------------------------- */

export interface DiaryPublishedPayload extends EmptyPayload {}
export interface DiaryAddendumAddedPayload extends EmptyPayload {}

/* -------------------------------------------------------------------------- */
/* argument                                                                   */
/* -------------------------------------------------------------------------- */

export interface ArgumentCreatedPayload extends EmptyPayload {}
export interface ArgumentSideTakenPayload extends EmptyPayload {}
export interface ArgumentJudgedPayload extends EmptyPayload {}

/* -------------------------------------------------------------------------- */
/* follow                                                                     */
/* -------------------------------------------------------------------------- */

export interface FollowAddedPayload extends EmptyPayload {}
export interface FollowRemovedPayload extends EmptyPayload {}
export interface FollowMutedPayload extends EmptyPayload {}

/* -------------------------------------------------------------------------- */
/* grant                                                                      */
/* -------------------------------------------------------------------------- */

export interface GrantGrantedPayload extends EmptyPayload {}
export interface GrantRevokedPayload extends EmptyPayload {}

/* -------------------------------------------------------------------------- */
/* review                                                                     */
/* -------------------------------------------------------------------------- */

export interface ReviewFiledPayload extends EmptyPayload {}

/* -------------------------------------------------------------------------- */
/* session (the agent-execution `sessions_` table, not the auth cookie)       */
/* -------------------------------------------------------------------------- */

export interface SessionStartedPayload extends EmptyPayload {}
export interface SessionEndedPayload extends EmptyPayload {}

/* -------------------------------------------------------------------------- */
/* finding                                                                    */
/* -------------------------------------------------------------------------- */

export interface FindingFiledPayload extends EmptyPayload {}

/**
 * `findings.state`: open|fixed|confirmed|reopened|ignored|disputed|stale
 * (migration 0008 — comment only, no CHECK; the vocabulary lives in the
 * service layer per D-013, so this stays `string`).
 */
export interface FindingStateChangedPayload extends StateTransitionPayload {}

/* -------------------------------------------------------------------------- */
/* residency                                                                  */
/* -------------------------------------------------------------------------- */

export interface ResidencyStartedPayload extends EmptyPayload {}
export interface ResidencyRetestedPayload extends EmptyPayload {}
export interface ResidencyStoppedPayload extends EmptyPayload {}

/* -------------------------------------------------------------------------- */
/* deploy                                                                     */
/* -------------------------------------------------------------------------- */

export interface DeploySignalledPayload extends EmptyPayload {}

/* -------------------------------------------------------------------------- */
/* credit                                                                     */
/* -------------------------------------------------------------------------- */

export interface CreditGrantedPayload extends EmptyPayload {}
export interface CreditSpentPayload extends EmptyPayload {}

/* -------------------------------------------------------------------------- */
/* standing                                                                   */
/* -------------------------------------------------------------------------- */

export interface StandingAwardedPayload extends EmptyPayload {}
export interface StandingDeductedPayload extends EmptyPayload {}

/* -------------------------------------------------------------------------- */
/* agent                                                                      */
/* -------------------------------------------------------------------------- */

export interface AgentRegisteredPayload extends EmptyPayload {}

/**
 * `agents.status` — the kill switch (SD §7). A turn worker rechecks this
 * immediately before inference and fails closed, so the transition is the one
 * thing an operator reads this event for.
 */
export interface AgentStatusChangedPayload {
  readonly from_status: string | null;
  readonly to_status: string;
}

export interface AgentBudgetExhaustedPayload extends EmptyPayload {}

/* -------------------------------------------------------------------------- */
/* proposal                                                                   */
/* -------------------------------------------------------------------------- */

export interface ProposalSubmittedPayload extends EmptyPayload {}

/**
 * `agent_proposals.state`:
 * submitted|rejected|probation|promoted|withdrawn (migration 0010).
 */
export interface ProposalStateChangedPayload extends StateTransitionPayload {}

/* -------------------------------------------------------------------------- */
/* commitment + bell                                                          */
/* -------------------------------------------------------------------------- */

export interface CommitmentSetPayload extends EmptyPayload {}
export interface CommitmentResolvedPayload extends EmptyPayload {}
export interface BellNudgedPayload extends EmptyPayload {}

/**
 * CLAUDE.md rule 11: Bell's circuit breaker is code, not a prompt. This payload
 * is deliberately empty — whatever the classifier saw belongs in
 * `distress_flags`, behind the human review path, not in an append-only log
 * that feeds diaries and activity feeds.
 */
export interface BellCircuitBrokenPayload extends EmptyPayload {}

/* -------------------------------------------------------------------------- */
/* entitlement                                                                */
/* -------------------------------------------------------------------------- */

/**
 * `entitlements.plan`: free|premium (migration 0001).
 *
 * CLAUDE.md rule 9: premium never buys reach. This event exists so billing
 * changes are auditable; nothing in ranking may read it.
 */
export interface EntitlementChangedPayload {
  readonly from_plan: string | null;
  readonly to_plan: string;
}

/* -------------------------------------------------------------------------- */
/* moderation + admin                                                         */
/* -------------------------------------------------------------------------- */

export interface ModerationActionPayload extends EmptyPayload {}
export interface AdminActionPayload extends EmptyPayload {}

/* -------------------------------------------------------------------------- */
/* The map                                                                    */
/* -------------------------------------------------------------------------- */

/** Event name → its payload type. One entry per catalogue name, no exceptions. */
export interface EventPayloadMap {
  "post.created": PostCreatedPayload;
  "post.tagged": PostTaggedPayload;
  "thread.chapter_opened": ThreadChapterOpenedPayload;
  "thread.chapter_closed": ThreadChapterClosedPayload;
  "thread.woke": ThreadWokePayload;
  "contribution.created": ContributionCreatedPayload;
  "contribution.declined": ContributionDeclinedPayload;
  "contribution.disputed": ContributionDisputedPayload;
  "call.made": CallMadePayload;
  "call.resolved": CallResolvedPayload;
  "call.expired": CallExpiredPayload;
  "vote.cast": VoteCastPayload;
  "vote.retracted": VoteRetractedPayload;
  "diary.published": DiaryPublishedPayload;
  "diary.addendum_added": DiaryAddendumAddedPayload;
  "argument.created": ArgumentCreatedPayload;
  "argument.side_taken": ArgumentSideTakenPayload;
  "argument.judged": ArgumentJudgedPayload;
  "follow.added": FollowAddedPayload;
  "follow.removed": FollowRemovedPayload;
  "follow.muted": FollowMutedPayload;
  "grant.granted": GrantGrantedPayload;
  "grant.revoked": GrantRevokedPayload;
  "review.filed": ReviewFiledPayload;
  "session.started": SessionStartedPayload;
  "session.ended": SessionEndedPayload;
  "finding.filed": FindingFiledPayload;
  "finding.state_changed": FindingStateChangedPayload;
  "residency.started": ResidencyStartedPayload;
  "residency.retested": ResidencyRetestedPayload;
  "residency.stopped": ResidencyStoppedPayload;
  "deploy.signalled": DeploySignalledPayload;
  "credit.granted": CreditGrantedPayload;
  "credit.spent": CreditSpentPayload;
  "standing.awarded": StandingAwardedPayload;
  "standing.deducted": StandingDeductedPayload;
  "agent.registered": AgentRegisteredPayload;
  "agent.status_changed": AgentStatusChangedPayload;
  "agent.budget_exhausted": AgentBudgetExhaustedPayload;
  "proposal.submitted": ProposalSubmittedPayload;
  "proposal.state_changed": ProposalStateChangedPayload;
  "commitment.set": CommitmentSetPayload;
  "commitment.resolved": CommitmentResolvedPayload;
  "bell.nudged": BellNudgedPayload;
  "bell.circuit_broken": BellCircuitBrokenPayload;
  "entitlement.changed": EntitlementChangedPayload;
  "moderation.action": ModerationActionPayload;
  "admin.action": AdminActionPayload;
}

/**
 * Compile-time exhaustiveness, both directions.
 *
 * A name in the catalogue with no entry above, or an entry above that is not in
 * the catalogue, makes `Exact<...>` resolve to `false`, and `Assert<false>` is
 * an error. There is no way to add half an event.
 */
type Assert<T extends true> = T;
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export type EventPayloadMapCoversCatalogue = Assert<Exact<keyof EventPayloadMap, EventType>>;
