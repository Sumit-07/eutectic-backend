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
 * CONTRACT CATCH-UP (PR #24): the P-02 contract merge (D-039) added
 * `checkHandleAvailability`, `suggestHandle` and `setHandle`, and the P-09
 * prelude (D-040) added the `/admin/*` trio. The exhaustiveness gate above did
 * exactly its job — apps/api stopped compiling the moment the contract landed
 * ahead of its implementation — so all six stubs landed in the #24 hotfix
 * under the same 501 policy as every other operation. (P-02-BE's branch
 * independently carried the first three; the duplicate trio the #28 merge
 * produced was removed in the follow-up hotfix.) No behaviour: the P-08/P-09
 * routes are still unimplemented.
 *
 * CONTRACT GAP CLOSED (M0-SH-12, M0-BE-23): `ErrorCode` now has a
 * `not_implemented` member, so the envelope carries the exact code for a
 * `501` instead of the closest legal stand-in. The former gap (`internal`
 * under a `501`, tracked from M0-BE-15) is resolved by this change.
 */

import type { OperationId } from "@eutectic/contracts";
import type {
  CastVoteHandler,
  CheckHandleAvailabilityHandler,
  CompleteGithubAuthHandler,
  CreateContributionHandler,
  CreatePostHandler,
  EndSessionHandler,
  FollowAgentHandler,
  GetAdminUserHandler,
  GetAgentCalibrationHandler,
  GetAgentHandler,
  GetContributionHandler,
  GetFeedHandler,
  GetFeedNewCountHandler,
  GetPostHandler,
  GetSessionHandler,
  GetThreadHandler,
  ListAgentsHandler,
  ListPlatformSettingsHandler,
  RetractVoteHandler,
  SearchHandler,
  SetHandleHandler,
  StartGithubAuthHandler,
  SuggestHandleHandler,
  UnfollowAgentHandler,
  UpdatePlatformSettingHandler,
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
const checkHandleAvailability: CheckHandleAvailabilityHandler = () =>
  notImplemented("checkHandleAvailability");
const suggestHandle: SuggestHandleHandler = () => notImplemented("suggestHandle");
const setHandle: SetHandleHandler = () => notImplemented("setHandle");
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
// /admin/* family (P-09 contract prelude, D-040). The stubs below are still the
// DEFAULT: `buildApp()` with no `admin` option keeps 501 on all three, which is
// what `route-surface.test.ts` and `idempotency.test.ts` assert about a bare app
// and what an API process with no database has no business doing otherwise. The
// real bodies live in `admin/handlers.ts` and are composed in by
// `createHandlers({ admin })` below — see its doc comment.
const listPlatformSettings: ListPlatformSettingsHandler = () =>
  notImplemented("listPlatformSettings");
const updatePlatformSetting: UpdatePlatformSettingHandler = () =>
  notImplemented("updatePlatformSetting");
const getAdminUser: GetAdminUserHandler = () => notImplemented("getAdminUser");

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
  readonly checkHandleAvailability: CheckHandleAvailabilityHandler;
  readonly suggestHandle: SuggestHandleHandler;
  readonly setHandle: SetHandleHandler;
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
  readonly listPlatformSettings: ListPlatformSettingsHandler;
  readonly updatePlatformSetting: UpdatePlatformSettingHandler;
  readonly getAdminUser: GetAdminUserHandler;
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
  checkHandleAvailability,
  suggestHandle,
  setHandle,
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
  listPlatformSettings,
  updatePlatformSetting,
  getAdminUser,
} as const satisfies HandlerRegistry;

/**
 * The registry with real bodies swapped in for whatever a caller can supply
 * (P-09).
 *
 * WHY A COMPOSITION RATHER THAN EDITING `stubHandlers` IN PLACE. The admin
 * handlers need a Postgres pool; a pool is injected, not opened by this module
 * (`main.ts` owns every connection lifecycle). So "implemented" is a property
 * of a particular app instance, not of this file — `buildApp({ admin })` gets
 * real routes, and `buildApp()` gets the 501s that two existing test suites
 * assert on. That is the same conditional-capability shape `app.ts` already
 * uses for the idempotency store (`options.pool === undefined` → no store), and
 * it keeps the exhaustiveness gate above intact: this function spreads over the
 * complete registry rather than rebuilding it, so a new operation still has to
 * be added to `stubHandlers` before anything compiles.
 */
export function createHandlers(overrides: Partial<HandlerRegistry> = {}): HandlerRegistry {
  return { ...stubHandlers, ...overrides };
}
