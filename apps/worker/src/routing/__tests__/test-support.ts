/**
 * Shared routing-fixture test infrastructure for `apps/worker/src/routing/`.
 *
 * Follows the same shape as `packages/cache/src/__tests__/test-support.ts`:
 * a plain module of exported constants/helpers, imported by more than one
 * suite in this package, so the fixture and the determinism assertions it
 * backs are defined exactly once.
 *
 * P-10 (M1-BE-05, the real router) is the intended second importer — its own
 * suite can pull in {@link ROUTING_FIXTURE_CANDIDATES} and
 * {@link selectRoutingPanel} to assert the router's actual `route(chapter,
 * { seed })` entry point against the same "same seed ⇒ same panel" contract
 * this file pins for the bare sampling primitives, without redefining the
 * fixture.
 */

import { createRng, weightedSample, uniformSample, type Rng } from "../sampling.js";

/**
 * A routing-shaped candidate: an agent id and its soft affinity weight for
 * one (hypothetical) post, per D-032/DIRECTIVE §4's `score(agent, post)` —
 * "affinity survives as a nudge, never a gate," compressed to the 0.7–1.3
 * band the directive specifies. Real weights will also fold in
 * `standing_factor` and `cooldown_penalty`; irrelevant to sampling, which
 * only ever sees a single final number per candidate.
 */
export interface RoutingCandidate {
  readonly agentId: string;
  readonly weight: number;
}

/**
 * The six launch agents (`capabilities.md` §7), each given a plausible soft
 * weight in the 0.7–1.3 band. Order is fixed and significant —
 * {@link weightedSample}'s determinism contract is "same seed + same item
 * order ⇒ same selection," so a suite that reuses this fixture must reuse
 * the array as-is rather than re-deriving an equivalent one, or the golden
 * assertion below stops meaning anything.
 */
export const ROUTING_FIXTURE_CANDIDATES: readonly RoutingCandidate[] = [
  { agentId: "bricklayer", weight: 1.1 },
  { agentId: "ledger", weight: 1.3 },
  { agentId: "marguerite", weight: 0.9 },
  { agentId: "sprout", weight: 1.0 },
  { agentId: "grouse", weight: 0.7 },
  { agentId: "vellum", weight: 1.2 },
];

/**
 * A ninth-hour edge case sitting alongside the main six: a candidate with a
 * zero weight (e.g. an agent at its daily budget ceiling — CLAUDE.md rule 6)
 * and one with a negative weight (defensive — nothing should ever produce
 * one, but the sampling contract must not silently mis-handle it either).
 * Kept in a SEPARATE fixture rather than folded into the six, so suites that
 * want "the happy-path six" and suites that want "prove exclusion" each get
 * an unambiguous fixture to import.
 */
export const ROUTING_FIXTURE_WITH_INELIGIBLE: readonly RoutingCandidate[] = [
  ...ROUTING_FIXTURE_CANDIDATES,
  { agentId: "budget-exhausted-agent", weight: 0 },
  { agentId: "impossible-negative-agent", weight: -1 },
];

/** `weightFn` for every helper below: a candidate's own `weight` field. */
export function candidateWeight(candidate: RoutingCandidate): number {
  return candidate.weight;
}

/**
 * Build the `Rng` for a routing-shaped selection from `seed`, exactly the
 * way the real router is expected to (`createRng` from `../sampling.js`).
 * Re-exported here so a fixture-consuming suite (P-10's) never has to reach
 * past this file into `sampling.ts` directly for the common case.
 */
export function routingRng(seed: string | number): Rng {
  return createRng(seed);
}

/**
 * A minimal, routing-shaped stand-in for what P-10's `route(chapter, {
 * seed })` will do internally: split `n` into a scored share and an
 * exploration share (DIRECTIVE §4's `n_scored` / `n_explore`), draw the
 * scored share with {@link weightedSample} and the exploration share with
 * {@link uniformSample} from whatever the scored draw did not take, and
 * return the agent ids in selection order.
 *
 * This is deliberately NOT the router — P-10 owns the real
 * `score(agent, post)` formula, cooldowns, coverage-vs-discretionary
 * bookkeeping, and `selected_by` provenance. It exists solely so this
 * ticket (P-04) can assert the determinism CONTRACT
 * ("`route(chapter, { seed })`: same seed, same selection") against
 * something routing-shaped, using only the primitives P-04 delivers, in a
 * form P-10 can point its own suite at without re-deriving the fixture.
 */
export function selectRoutingPanel(
  candidates: readonly RoutingCandidate[],
  n: number,
  seed: string | number,
  explorationRate = 0.25,
): string[] {
  // A zero/negative weight means "not in the running" (sampling.ts's
  // documented ruling) for BOTH sub-passes, not only the weighted one —
  // `uniformSample` has no weight concept of its own, so if the exploration
  // pass drew from the raw candidate list it would happily hand back a
  // budget-exhausted or disabled agent that the scored pass correctly
  // excluded. The real router (P-10) does this filtering upstream, before
  // any sampling call, by only ever constructing its candidate list from
  // agents with budget headroom that are not disabled and not on cooldown
  // (DIRECTIVE §4); this fixture-shaped stand-in does it here so both
  // sub-passes see the identical eligible pool.
  const eligible = candidates.filter((c) => candidateWeight(c) > 0);

  const rng = routingRng(seed);
  const nExplore = Math.round(n * explorationRate);
  const nScored = n - nExplore;

  const scored = weightedSample(eligible, nScored, candidateWeight, rng);
  const remaining = eligible.filter((c) => !scored.includes(c));
  const explored = uniformSample(remaining, nExplore, rng);

  return [...scored, ...explored].map((c) => c.agentId);
}
