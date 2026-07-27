/**
 * P-04 — deterministic sampling utilities.
 *
 * Four groups:
 *   1. PRNG (`fnv1a32`, `mulberry32`, `createRng`) — determinism, range, and
 *      a golden pin on the raw stream so an accidental algorithm change is
 *      caught immediately rather than surfacing later as a routing flake.
 *   2. `weightedSample` — edge cases (empty, n<=0, n>=eligible, exclusion of
 *      non-positive weights), determinism, and a loose statistical sanity
 *      check.
 *   3. `uniformSample` — the same edge-case discipline, without weights.
 *   4. The routing-shaped fixture contract from `./test-support.js`
 *      (`route(chapter, { seed })`-equivalent: same seed ⇒ same selection),
 *      including the golden-file style pin P-10 (M1-BE-05) is expected to
 *      import rather than re-derive.
 *
 *   pnpm --filter @eutectic/worker test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createRng, fnv1a32, mulberry32, uniformSample, weightedSample } from "../sampling.js";
import {
  candidateWeight,
  ROUTING_FIXTURE_CANDIDATES,
  ROUTING_FIXTURE_WITH_INELIGIBLE,
  selectRoutingPanel,
} from "./test-support.js";

// ---------------------------------------------------------------------------
// 1. PRNG
// ---------------------------------------------------------------------------

describe("fnv1a32", () => {
  it("is deterministic for the same input", () => {
    assert.equal(fnv1a32("chapter-42:round-1"), fnv1a32("chapter-42:round-1"));
  });

  it("differs across these fixture inputs (no trivial collision)", () => {
    assert.notEqual(fnv1a32("chapter-42:round-1"), fnv1a32("chapter-42:round-2"));
  });

  it("returns a 32-bit unsigned integer", () => {
    const hash = fnv1a32("anything at all");
    assert.ok(Number.isInteger(hash));
    assert.ok(hash >= 0 && hash <= 0xffffffff);
  });

  it("PINNED — golden hash values (screams if the hash implementation changes)", () => {
    assert.equal(fnv1a32(""), 0x811c9dc5);
    assert.equal(fnv1a32("chapter-fixture-001:round-1"), 2772445068);
    assert.equal(fnv1a32("chapter-fixture-002:round-1"), 1045311289);
  });
});

describe("mulberry32 / createRng — determinism", () => {
  it("same numeric seed produces the identical stream", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    assert.deepEqual(
      Array.from({ length: 10 }, () => a()),
      Array.from({ length: 10 }, () => b()),
    );
  });

  it("different seeds produce different streams", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    assert.notEqual(a(), b());
  });

  it("createRng with a string seed hashes deterministically", () => {
    const a = createRng("chapter-abc:round-1");
    const b = createRng("chapter-abc:round-1");
    assert.deepEqual(
      Array.from({ length: 5 }, () => a()),
      Array.from({ length: 5 }, () => b()),
    );
  });

  it("createRng(string) and createRng(number) both produce values in [0, 1)", () => {
    for (const rng of [createRng("seed-x"), createRng(12345)]) {
      for (let i = 0; i < 200; i++) {
        const v = rng();
        assert.ok(v >= 0 && v < 1, `${v} out of [0, 1)`);
      }
    }
  });

  it("PINNED — mulberry32(1)'s first five outputs (screams if the PRNG changes)", () => {
    const rng = mulberry32(1);
    const values = Array.from({ length: 5 }, () => rng());
    assert.deepEqual(values, [
      0.6270739405881613, 0.002735721180215478, 0.5274470399599522, 0.9810509674716741,
      0.9683778982143849,
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. weightedSample
// ---------------------------------------------------------------------------

describe("weightedSample", () => {
  it("empty items -> []", () => {
    assert.deepEqual(weightedSample([], 3, () => 1, createRng(1)), []);
  });

  it("n <= 0 -> [] (zero and negative)", () => {
    const rng = createRng(1);
    assert.deepEqual(weightedSample([1, 2, 3], 0, () => 1, rng), []);
    assert.deepEqual(weightedSample([1, 2, 3], -5, () => 1, rng), []);
  });

  it("n >= eligible items.length returns every eligible item, original order, no rng consumed", () => {
    const items = [1, 2, 3];
    let calls = 0;
    const countingRng = (): number => {
      calls++;
      return 0.5;
    };
    const result = weightedSample(items, 5, () => 1, countingRng);
    assert.deepEqual(result, [1, 2, 3]);
    assert.equal(calls, 0, "nothing to choose between — must not consume the rng");
  });

  it("ruling: zero and negative weight items are excluded entirely, regardless of n", () => {
    const items = [
      { id: "a", w: 1 },
      { id: "b", w: 0 },
      { id: "c", w: -5 },
      { id: "d", w: 2 },
    ];
    const result = weightedSample(items, 10, (i) => i.w, createRng(1));
    assert.deepEqual(
      result.map((i) => i.id).sort(),
      ["a", "d"],
    );
  });

  it("a weight of exactly 0 among otherwise-fine weights never appears even across many seeds", () => {
    for (const seed of ["s1", "s2", "s3", "s4", "s5"]) {
      const result = weightedSample(ROUTING_FIXTURE_WITH_INELIGIBLE, 3, candidateWeight, createRng(seed));
      assert.ok(!result.some((c) => c.weight <= 0), `seed ${seed} selected a non-positive-weight candidate`);
    }
  });

  it("deterministic given the same seed", () => {
    const draw = (): string[] =>
      weightedSample(ROUTING_FIXTURE_CANDIDATES, 3, candidateWeight, createRng("seed-A")).map(
        (c) => c.agentId,
      );
    assert.deepEqual(draw(), draw());
  });

  it("different seed -> (almost surely) a different selection or order", () => {
    const a = weightedSample(ROUTING_FIXTURE_CANDIDATES, 3, candidateWeight, createRng("seed-A")).map(
      (c) => c.agentId,
    );
    const b = weightedSample(ROUTING_FIXTURE_CANDIDATES, 3, candidateWeight, createRng("seed-B")).map(
      (c) => c.agentId,
    );
    assert.notDeepEqual(a, b);
  });

  it("statistical sanity: empirical pick frequency roughly tracks weight (loose tolerance — a sanity check, not a chi-squared proof)", () => {
    const rng = createRng("stat-sanity-weighted");
    const draws = 6000;
    const counts = new Map<string, number>(ROUTING_FIXTURE_CANDIDATES.map((c) => [c.agentId, 0]));

    for (let i = 0; i < draws; i++) {
      const [picked] = weightedSample(ROUTING_FIXTURE_CANDIDATES, 1, candidateWeight, rng);
      assert.ok(picked);
      counts.set(picked.agentId, (counts.get(picked.agentId) ?? 0) + 1);
    }

    const totalWeight = ROUTING_FIXTURE_CANDIDATES.reduce((sum, c) => sum + c.weight, 0);
    for (const candidate of ROUTING_FIXTURE_CANDIDATES) {
      const expected = draws * (candidate.weight / totalWeight);
      const actual = counts.get(candidate.agentId) ?? 0;
      // Deliberately loose: +/- 35% relative plus a flat 100-draw floor, so
      // this can never flake — it exists to catch a badly broken weighting
      // (e.g. weights ignored, or inverted), not to validate the sampler's
      // statistics precisely.
      const tolerance = expected * 0.35 + 100;
      assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `${candidate.agentId}: expected ~${expected.toFixed(0)} (weight ${candidate.weight}), got ${actual}, tolerance ${tolerance.toFixed(0)}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 3. uniformSample
// ---------------------------------------------------------------------------

describe("uniformSample", () => {
  it("empty items -> []", () => {
    assert.deepEqual(uniformSample([], 3, createRng(1)), []);
  });

  it("n <= 0 -> [] (zero and negative)", () => {
    const rng = createRng(1);
    assert.deepEqual(uniformSample([1, 2, 3], 0, rng), []);
    assert.deepEqual(uniformSample([1, 2, 3], -2, rng), []);
  });

  it("n >= items.length returns every item, original order, no rng consumed", () => {
    const items = [1, 2, 3];
    let calls = 0;
    const countingRng = (): number => {
      calls++;
      return 0.5;
    };
    const result = uniformSample(items, 10, countingRng);
    assert.deepEqual(result, [1, 2, 3]);
    assert.equal(calls, 0, "nothing to choose between — must not consume the rng");
  });

  it("returns distinct items (no repeats) for n < items.length", () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const result = uniformSample(items, 7, createRng("distinctness"));
    assert.equal(result.length, 7);
    assert.equal(new Set(result).size, 7);
  });

  it("deterministic given the same seed", () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const draw = (): number[] => uniformSample(items, 6, createRng("seed-A"));
    assert.deepEqual(draw(), draw());
  });

  it("different seed -> (almost surely) a different selection or order", () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const a = uniformSample(items, 6, createRng("seed-A"));
    const b = uniformSample(items, 6, createRng("seed-B"));
    assert.notDeepEqual(a, b);
  });

  it("statistical sanity: every item is picked roughly equally often over many draws (loose tolerance)", () => {
    const items = ROUTING_FIXTURE_CANDIDATES.map((c) => c.agentId);
    const rng = createRng("stat-sanity-uniform");
    const draws = 6000;
    const counts = new Map<string, number>(items.map((id) => [id, 0]));

    for (let i = 0; i < draws; i++) {
      const [picked] = uniformSample(items, 1, rng);
      assert.ok(picked);
      counts.set(picked, (counts.get(picked) ?? 0) + 1);
    }

    const expected = draws / items.length;
    for (const id of items) {
      const actual = counts.get(id) ?? 0;
      const tolerance = expected * 0.35 + 100;
      assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `${id}: expected ~${expected.toFixed(0)}, got ${actual}, tolerance ${tolerance.toFixed(0)}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 4. The routing-shaped fixture — the determinism contract P-10 reuses
// ---------------------------------------------------------------------------

describe("routing-shaped fixture (test-support.ts) — route(chapter, { seed }) determinism contract", () => {
  it("same seed => byte-identical selection", () => {
    const a = selectRoutingPanel(ROUTING_FIXTURE_CANDIDATES, 4, "chapter-fixture-001:round-1");
    const b = selectRoutingPanel(ROUTING_FIXTURE_CANDIDATES, 4, "chapter-fixture-001:round-1");
    assert.deepEqual(a, b);
  });

  it("different seed => (almost surely) a different selection", () => {
    const a = selectRoutingPanel(ROUTING_FIXTURE_CANDIDATES, 4, "chapter-fixture-001:round-1");
    const b = selectRoutingPanel(ROUTING_FIXTURE_CANDIDATES, 4, "chapter-fixture-002:round-1");
    assert.notDeepEqual(a, b);
  });

  it("GOLDEN — pins the exact panel for seed \"chapter-fixture-001:round-1\", n=4 (any future PRNG/algorithm change MUST update this deliberately)", () => {
    const result = selectRoutingPanel(ROUTING_FIXTURE_CANDIDATES, 4, "chapter-fixture-001:round-1");
    assert.deepEqual(result, ["sprout", "marguerite", "bricklayer", "ledger"]);
  });

  it("n >= candidates.length returns every candidate", () => {
    const result = selectRoutingPanel(
      ROUTING_FIXTURE_CANDIDATES,
      ROUTING_FIXTURE_CANDIDATES.length + 3,
      "any-seed-at-all",
    );
    assert.deepEqual(
      result.slice().sort(),
      ROUTING_FIXTURE_CANDIDATES.map((c) => c.agentId).sort(),
    );
  });

  it("ineligible (zero/negative weight) candidates never appear, across several seeds", () => {
    for (const seed of ["s1", "s2", "s3"]) {
      const result = selectRoutingPanel(ROUTING_FIXTURE_WITH_INELIGIBLE, 4, seed);
      assert.ok(!result.includes("budget-exhausted-agent"));
      assert.ok(!result.includes("impossible-negative-agent"));
    }
  });
});
