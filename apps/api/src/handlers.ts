/**
 * The handler seam (M0-BE-15).
 *
 * One entry per `operationId` in the contract, each typed with the handler type
 * the contracts package generates for that operation. This ticket ships the
 * SURFACE only, so every handler is a stub — but the types are not decorative:
 * they are what makes the next ticket's diff a body swap. Replace
 * `() => notImplemented("getFeed")` with a real body and the compiler checks
 * the params, the query, the request body and the response shape against
 * `openapi.yaml` for you.
 *
 * `stubHandlers satisfies HandlerRegistry` is the exhaustiveness gate: a new
 * operation in the contract fails to compile here until it has a handler, and
 * a handler with no operation fails too. Same "a name lands when its handler
 * lands" discipline the worker's task registry uses (D-016 item 5).
 *
 * STUB POLICY — 501, never a mock payload. Justified in the PR body: a stub
 * that returns a plausible-looking feed is indistinguishable from a working
 * endpoint at the network boundary, and the frontend already has a mock that
 * is generated from the spec (Prism, contracts/README). A second, hand-written
 * mock would be a second source of truth that nothing regenerates. `501` is
 * the honest answer and it is impossible to mistake for an implementation.
 *
 * CONTRACT GAP CLOSED (M0-SH-12, M0-BE-23): `ErrorCode` now has a
 * `not_implemented` member, so the envelope carries the exact code for a
 * `501` instead of the closest legal stand-in. The former gap (`internal`
 * under a `501`, tracked from M0-BE-15) is resolved by this change.
 */

import type { OperationId } from "@eutectic/contracts";
import type {
  CastVoteHandler,
  CompleteGithubAuthHandler,
  CreateContributionHandler,
  CreatePostHandler,
  EndSessionHandler,
  FollowAgentHandler,
  GetAgentCalibrationHandler,
  GetAgentHandler,
  GetContributionHandler,
  GetFeedHandler,
  GetFeedNewCountHandler,
  GetPostHandler,
  GetSessionHandler,
  GetThreadHandler,
  ListAgentsHandler,
  RetractVoteHandler,
  SearchHandler,
  StartGithubAuthHandler,
  UnfollowAgentHandler,
} from "@eutectic/contracts/server";

import { ApiFailure } from "./errors.js";

/**
 * Returns `never`, so it satisfies every handler signature without any of them
 * having to fake a payload. Throwing (rather than returning an envelope) keeps
 * every non-2xx in this app on the single error-handler path.
 */
export function notImplemented(operationId: OperationId): never {
  throw new ApiFailure(501, "not_implemented", `${operationId} is not implemented yet`);
}

const getSession: GetSessionHandler = () => notImplemented("getSession");
const endSession: EndSessionHandler = () => notImplemented("endSession");
const startGithubAuth: StartGithubAuthHandler = () => notImplemented("startGithubAuth");
const completeGithubAuth: CompleteGithubAuthHandler = () => notImplemented("completeGithubAuth");
const getFeed: GetFeedHandler = () => notImplemented("getFeed");
const getFeedNewCount: GetFeedNewCountHandler = () => notImplemented("getFeedNewCount");
const createPost: CreatePostHandler = () => notImplemented("createPost");
const getPost: GetPostHandler = () => notImplemented("getPost");
const getThread: GetThreadHandler = () => notImplemented("getThread");
const createContribution: CreateContributionHandler = () => notImplemented("createContribution");
const getContribution: GetContributionHandler = () => notImplemented("getContribution");
const castVote: CastVoteHandler = () => notImplemented("castVote");
const retractVote: RetractVoteHandler = () => notImplemented("retractVote");
const listAgents: ListAgentsHandler = () => notImplemented("listAgents");
const getAgent: GetAgentHandler = () => notImplemented("getAgent");
const getAgentCalibration: GetAgentCalibrationHandler = () =>
  notImplemented("getAgentCalibration");
const followAgent: FollowAgentHandler = () => notImplemented("followAgent");
const unfollowAgent: UnfollowAgentHandler = () => notImplemented("unfollowAgent");
const search: SearchHandler = () => notImplemented("search");

/**
 * What `buildApp` binds. Structurally an object with one handler per
 * operationId — `registerContractRoutes` iterates `ROUTES` and looks each one
 * up, so a missing key cannot be routed around.
 */
export interface HandlerRegistry {
  readonly getSession: GetSessionHandler;
  readonly endSession: EndSessionHandler;
  readonly startGithubAuth: StartGithubAuthHandler;
  readonly completeGithubAuth: CompleteGithubAuthHandler;
  readonly getFeed: GetFeedHandler;
  readonly getFeedNewCount: GetFeedNewCountHandler;
  readonly createPost: CreatePostHandler;
  readonly getPost: GetPostHandler;
  readonly getThread: GetThreadHandler;
  readonly createContribution: CreateContributionHandler;
  readonly getContribution: GetContributionHandler;
  readonly castVote: CastVoteHandler;
  readonly retractVote: RetractVoteHandler;
  readonly listAgents: ListAgentsHandler;
  readonly getAgent: GetAgentHandler;
  readonly getAgentCalibration: GetAgentCalibrationHandler;
  readonly followAgent: FollowAgentHandler;
  readonly unfollowAgent: UnfollowAgentHandler;
  readonly search: SearchHandler;
}

/**
 * COMPILE-TIME EXHAUSTIVENESS. `HandlerRegistry` must have exactly the
 * contract's operation ids as keys — no more, no fewer. Written as a type
 * assertion rather than a mapped type so the interface above stays readable in
 * an editor, and so the failure message names the missing operation.
 */
type Assert<T extends true> = T;
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export type RegistryCoversContract = Assert<Exact<keyof HandlerRegistry, OperationId>>;

/** The default binding: every operation, not implemented. */
export const stubHandlers = {
  getSession,
  endSession,
  startGithubAuth,
  completeGithubAuth,
  getFeed,
  getFeedNewCount,
  createPost,
  getPost,
  getThread,
  createContribution,
  getContribution,
  castVote,
  retractVote,
  listAgents,
  getAgent,
  getAgentCalibration,
  followAgent,
  unfollowAgent,
  search,
} as const satisfies HandlerRegistry;
