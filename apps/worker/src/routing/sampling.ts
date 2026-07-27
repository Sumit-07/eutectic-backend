/**
 * P-04 — Injectable router seed: deterministic sampling utilities.
 *
 * This is where the turn-worker router (P-10 / M1-BE-05, DIRECTIVE-pre-M1 §4)
 * will live (`apps/worker/src/routing/`). Routing decides, twice a day at
 * scale, which agents are enqueued against which posts — CLAUDE.md rule 6
 * ("budget is reserved before inference, atomically") and D-032/D-033
 * (generalist agents, two-pass coverage-then-discretion) both depend on that
 * selection being REPRODUCIBLE: the same seed must yield the same pick, so a
 * routing decision can be replayed, tested, and reasoned about without a live
 * database. `Math.random` cannot do that — it is why this file, and every
 * future file under `routing/`, is forbidden from calling it (enforced by
 * `__tests__/math-random-guard.test.ts`).
 *
 * Nothing here reads a clock, generates a UUID, or otherwise reaches outside
 * its arguments: every function is pure, and all randomness is the caller's
 * `Rng`, injected. That is the whole of the "injectable router seed" idea —
 * the router (P-10) will construct one `Rng` per routing job from a seed it
 * derives from stable job inputs (e.g. chapter id + round number), and every
 * sampling call in that job shares it.
 */

// ---------------------------------------------------------------------------
// PRNG
// ---------------------------------------------------------------------------

/** A deterministic source of floats in [0, 1). Call it to advance the stream by one step. */
export type Rng = () => number;

/**
 * FNV-1a, 32-bit variant. Public-domain, non-cryptographic hash (Fowler /
 * Noll / Vo, 1991) — chosen over anything fancier because a router seed only
 * needs to turn an arbitrary string (e.g. `${chapterId}:${roundNo}`) into a
 * well-mixed 32-bit integer, and FNV-1a is a handful of lines with no
 * dependency (CLAUDE.md rule 12) and no surprises.
 *
 * Reference algorithm (http://www.isthe.com/chongo/tech/comp/fnv/):
 *   hash = offset_basis
 *   for each byte b of the input:
 *     hash = hash XOR b
 *     hash = hash * FNV_prime
 *   (32-bit: offset_basis = 0x811c9dc5, prime = 0x01000193, mod 2^32)
 *
 * Operates on UTF-16 code units via `charCodeAt`, not UTF-8 bytes — the
 * distinction is irrelevant here (we need *a* stable deterministic mixing,
 * not FNV-1a's published test vectors) and avoids an encode step.
 */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // Math.imul keeps the multiply in 32-bit space (a plain `*` would lose
    // precision above 2^53 and drift into float rounding well before that).
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * mulberry32 — a 32-bit state, 32-bit output PRNG by Tommy Ettinger (public
 * domain; widely circulated reference implementation, e.g.
 * https://github.com/bryc/code/blob/master/jshash/PRNGs.md#mulberry32).
 * Picked over `Math.random` (not seedable, and rule "no Math.random anywhere
 * in routing code paths" bans it outright) and over anything requiring a
 * dependency (rule 12): it is ~5 lines, has no known short-cycle weaknesses
 * for this scale of use (agent-panel sampling, not cryptography), and is
 * fast enough that seeding it fresh per routing job costs nothing.
 *
 * `seed` is consumed as a raw 32-bit integer (`>>> 0` truncates/wraps it into
 * range) — string seeding goes through {@link fnv1a32} first, in
 * {@link createRng}, so this function itself only ever deals in integers.
 */
export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build the one `Rng` a routing job needs, from a seed the caller derives
 * however it likes (P-10's contract: `route(chapter, { seed })` — the seed is
 * the caller's choice of stable identifier, e.g. a hash of chapter id and
 * round number, so re-running the same job reproduces the same panel).
 *
 * Seed type is `string | number`, by design:
 *   - `number` seeds are taken as a raw 32-bit integer (truncated via `>>> 0`
 *     the same way {@link mulberry32} does) — useful for tests and fixtures
 *     that want a literal, memorable seed.
 *   - `string` seeds are hashed through {@link fnv1a32} first. This is the
 *     path the real router is expected to use, since job-stable identifiers
 *     (chapter id, round number) compose naturally as strings.
 */
export function createRng(seed: string | number): Rng {
  const seedInt = typeof seed === "string" ? fnv1a32(seed) : seed >>> 0;
  return mulberry32(seedInt);
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

/**
 * A uniform float strictly inside (0, 1) — never exactly 0 or 1. Guards
 * {@link weightedSample}'s `u ** (1 / weight)` step: `mulberry32` can (very
 * rarely) emit exactly 0, and `0 ** (1 / weight)` is a valid float (0) but
 * would deterministically rank that draw as the lowest possible key
 * regardless of weight, which is a bias, not a crash. Clamping to a
 * half-open interval anchored at `Number.EPSILON` removes the edge case at
 * a cost far below floating-point sampling noise.
 */
function openUnit(rng: Rng): number {
  const u = rng();
  return Math.min(Math.max(u, Number.EPSILON), 1 - Number.EPSILON);
}

/**
 * Sample `n` DISTINCT items from `items`, WITHOUT replacement, with
 * probability proportional to `weightFn(item)`.
 *
 * Algorithm: Efraimidis–Spirakis weighted reservoir sampling (Efraimidis &
 * Spirakis, "Weighted random sampling with a reservoir", Information
 * Processing Letters 97 (2006) 181–185). For each eligible item, draw
 * `u ~ Uniform(0,1)` and compute `key = u ** (1 / weight)`; the `n` items
 * with the largest keys are exactly a probability-proportional-to-size
 * sample without replacement. Chosen over a naive "roulette wheel then
 * remove and renormalize" approach because it is O(m log m) with no
 * renormalization loop, and because it consumes exactly one `rng()` call per
 * eligible item in a fixed pass — which is what makes the result reproduce
 * byte-identically for a given seed and a given item ORDER (this function
 * makes no attempt to be order-independent; same seed + same `items` order
 * + same weights ⇒ same selection, which is the contract P-10 needs).
 *
 * Edge-case rulings (documented, not just implemented):
 *   - `n <= 0` or `items` empty → `[]`.
 *   - `n >= ` the number of ELIGIBLE items (weight > 0) → returns every
 *     eligible item, in their original relative order. No randomness is
 *     consumed in this path (nothing to choose between).
 *   - Items with `weightFn(item) <= 0` (including `NaN`) are EXCLUDED from
 *     the candidate pool entirely — never selected, regardless of `n`, and
 *     never counted toward "how many are there to return". Ruling: a
 *     zero/negative weight reads as "this candidate is not in the running"
 *     (e.g. an agent at its budget ceiling, or on cooldown), not as "an
 *     extremely unlikely pick" — a true near-zero-but-positive weight is how
 *     you spell "unlikely but eligible" instead.
 */
export function weightedSample<T>(
  items: readonly T[],
  n: number,
  weightFn: (item: T) => number,
  rng: Rng,
): T[] {
  if (n <= 0 || items.length === 0) return [];

  const eligible: Array<{ item: T; weight: number }> = [];
  for (const item of items) {
    const weight = weightFn(item);
    if (weight > 0) eligible.push({ item, weight });
  }

  if (n >= eligible.length) return eligible.map((e) => e.item);

  const keyed = eligible.map(({ item, weight }) => ({
    item,
    key: Math.pow(openUnit(rng), 1 / weight),
  }));
  keyed.sort((a, b) => b.key - a.key);
  return keyed.slice(0, n).map((k) => k.item);
}

/**
 * Sample `n` DISTINCT items from `items`, uniformly, WITHOUT replacement.
 *
 * Algorithm: partial Fisher–Yates shuffle (Durstenfeld's array-based
 * variant), stopped after `n` swaps — standard, dependency-free, and it
 * consumes exactly `n` `rng()` calls (none at all on the "return everything"
 * path below), same determinism story as {@link weightedSample}.
 *
 * Edge-case rulings, matching {@link weightedSample}'s discipline:
 *   - `n <= 0` or `items` empty → `[]`.
 *   - `n >= items.length` → returns every item, in original order, no
 *     randomness consumed.
 *   - There is no weight concept here, so there is no exclusion ruling to
 *     make — every item is equally eligible by definition.
 */
export function uniformSample<T>(items: readonly T[], n: number, rng: Rng): T[] {
  if (n <= 0 || items.length === 0) return [];
  if (n >= items.length) return items.slice();

  const pool = items.slice();
  const picked = Math.min(n, pool.length);
  for (let i = 0; i < picked; i++) {
    const j = i + Math.floor(rng() * (pool.length - i));
    const tmp = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = tmp;
  }
  return pool.slice(0, picked);
}
