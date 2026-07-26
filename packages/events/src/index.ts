/**
 * @eutectic/events — the frozen SD §4 event catalogue and the only writer for
 * the append-only event log.
 *
 * Two things live here and nothing else:
 *
 *   - `catalogue.ts` / `payloads.ts` / `event.ts` — the 48 event names from
 *     system-design §4, verbatim, as a discriminated union with a payload type
 *     and a subject type per name, and compile-time exhaustiveness between all
 *     three.
 *   - `write-event.ts` — `writeEvent(tx, event)`, which writes inside the
 *     caller's transaction and turns a duplicate `idempotency_key` into a clean
 *     no-op.
 *
 * Explicit named exports only — no barrel re-export (CLAUDE.md §4).
 */

export { EVENT_TYPES, isEventType, type EventType } from "./catalogue.js";

export {
  type ActorType,
  type EventActor,
  type EventInput,
  type EventSubject,
  type EventSubjectTypeMap,
  type EventSubjectTypeMapCoversCatalogue,
  type SubjectType,
} from "./event.js";

export {
  type AdminActionPayload,
  type AgentBudgetExhaustedPayload,
  type AgentRegisteredPayload,
  type AgentStatusChangedPayload,
  type ArgumentCreatedPayload,
  type ArgumentJudgedPayload,
  type ArgumentSideTakenPayload,
  type BellCircuitBrokenPayload,
  type BellNudgedPayload,
  type CallExpiredPayload,
  type CallMadePayload,
  type CallResolvedPayload,
  type CommitmentResolvedPayload,
  type CommitmentSetPayload,
  type ContributionCreatedPayload,
  type ContributionDeclinedPayload,
  type ContributionDisputedPayload,
  type CreditGrantedPayload,
  type CreditSpentPayload,
  type DeploySignalledPayload,
  type DiaryAddendumAddedPayload,
  type DiaryPublishedPayload,
  type EmptyPayload,
  type EntitlementChangedPayload,
  type EventPayloadMap,
  type EventPayloadMapCoversCatalogue,
  type FindingFiledPayload,
  type FindingStateChangedPayload,
  type FollowAddedPayload,
  type FollowMutedPayload,
  type FollowRemovedPayload,
  type GrantGrantedPayload,
  type GrantRevokedPayload,
  type ModerationActionPayload,
  type PostCreatedPayload,
  type PostTaggedPayload,
  type ProposalStateChangedPayload,
  type ProposalSubmittedPayload,
  type ResidencyRetestedPayload,
  type ResidencyStartedPayload,
  type ResidencyStoppedPayload,
  type ReviewFiledPayload,
  type SessionEndedPayload,
  type SessionStartedPayload,
  type StandingAwardedPayload,
  type StandingDeductedPayload,
  type StateTransitionPayload,
  type ThreadChapterClosedPayload,
  type ThreadChapterOpenedPayload,
  type ThreadWokePayload,
  type VoteCastPayload,
  type VoteRetractedPayload,
} from "./payloads.js";

export {
  EVENT_IDEMPOTENCY_CONSTRAINT,
  writeEvent,
  type EventDeduplicated,
  type EventWritten,
  type WriteEventResult,
} from "./write-event.js";
