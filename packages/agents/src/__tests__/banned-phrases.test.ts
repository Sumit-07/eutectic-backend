/**
 * Worker test for P-05-BE's banned-phrase list and its matching rules.
 *
 * Two jobs. First, the matching RULING is asserted rather than described:
 * case-insensitivity, whitespace collapsing, edge-punctuation stripping,
 * unicode folding, and the word-boundary requirement that keeps `contains`
 * from firing on a substring inside a longer word.
 *
 * Second — and this is the one that earns its keep — the FALSE-POSITIVE
 * cases. A mechanical rejection costs a retry, and three cost a decline
 * (rule 7) on a contribution that may have been fine. Every sentence in
 * `SPECIFIC_CRITICISMS` below is a genuinely falsifiable criticism that
 * happens to contain a banned phrase mid-sentence; each one must pass. If a
 * future edit to `BANNED_PHRASES` promotes an opener to `contains`, these
 * fail, and that is the alarm working.
 *
 *   pnpm --filter @eutectic/agents test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BANNED_PHRASES, findBannedPhrase, normalisePhrase } from "../turn-output/banned-phrases.js";

const banned = (value: string): string | undefined => findBannedPhrase(value)?.phrase;

describe("normalisation", () => {
  it("lowercases", () => {
    assert.equal(normalisePhrase("GREAT Question"), "great question");
  });

  it("collapses every kind of whitespace", () => {
    assert.equal(normalisePhrase("great\n\tquestion   here"), "great question here");
  });

  it("strips leading and trailing punctuation, not internal", () => {
    assert.equal(normalisePhrase('  "n/a."  '), "n/a");
    assert.equal(normalisePhrase("…nothing to add!"), "nothing to add");
  });

  it("folds curly quotes and dashes to ASCII", () => {
    assert.equal(normalisePhrase("that’s it"), "that's it");
    assert.equal(normalisePhrase("a — b"), "a - b");
  });

  it("applies NFKC, so a fullwidth form cannot evade an ASCII phrase", () => {
    assert.equal(normalisePhrase("ｎｏｎｅ"), "none");
  });

  it("normalises a criticism of only punctuation to nothing", () => {
    for (const value of ["", "   ", "—", "...", "!!", '""']) {
      assert.equal(normalisePhrase(value), "", JSON.stringify(value));
    }
  });
});

describe("matching — case", () => {
  it("matches regardless of case", () => {
    for (const value of ["n/a", "N/A", "N/a"]) {
      assert.equal(banned(value), "n/a", value);
    }
  });

  it("matches a shouted opener", () => {
    assert.equal(banned("GREAT QUESTION! Here is what I think."), "great question");
  });
});

describe("matching — exact", () => {
  it("hits when the phrase is the whole answer", () => {
    assert.equal(banned("None"), "none");
    assert.equal(banned("Nothing to add."), "nothing to add");
  });

  it("misses when the phrase is only part of the answer", () => {
    // "none" as a whole answer is a non-answer; "none of the three pricing
    // tiers…" is the start of a real one.
    assert.equal(banned("None of the three pricing tiers covers the storage cost."), undefined);
  });

  it("returns undefined for an empty candidate rather than claiming a hit", () => {
    // Emptiness is a DIFFERENT rejection code, and the caller distinguishes
    // them; this function must not swallow the distinction.
    for (const value of ["", "   ", "—"]) {
      assert.equal(findBannedPhrase(value), undefined, JSON.stringify(value));
    }
  });
});

describe("matching — prefix", () => {
  it("hits when the opener leads", () => {
    assert.equal(banned("Good point, though the churn maths is off."), "good point");
    assert.equal(banned("It depends on how they price seats."), "it depends");
  });

  it("misses when the same words appear mid-sentence", () => {
    assert.equal(banned("The retention claim is a good point badly evidenced."), undefined);
  });

  it("respects the word boundary at the end of the phrase", () => {
    // "good pointer" is not "good point".
    assert.equal(banned("Good pointers on the onboarding flow are missing entirely."), undefined);
  });
});

describe("matching — contains", () => {
  it("hits anywhere in the string", () => {
    assert.equal(
      banned("The pricing is wrong, and as an AI I should say I am not certain."),
      "as an ai",
    );
  });

  it("respects word boundaries at both ends", () => {
    // The exact false positive the boundary rule exists for: "as an ai" is a
    // prefix of "as an air-gapped…".
    assert.equal(banned("They describe it as an air-gapped deployment, which contradicts §3."), undefined);
  });
});

/**
 * Real criticisms that contain a banned phrase somewhere. NONE of these may be
 * rejected. Each is falsifiable: it names something that could be checked and
 * found wrong.
 */
const SPECIFIC_CRITICISMS: readonly string[] = [
  "Their pricing makes sense only if churn stays under 3%, which the post never measures.",
  "The retention claim is a good point about cohort framing, but the cohort is 11 users.",
  "None of the three tiers covers the storage cost they quote in the second paragraph.",
  "Whether this ships in Q3 depends on a migration they have not scoped.",
  "They describe it as an air-gapped deployment, which contradicts the SaaS billing model.",
  "The unknown here is the CAC, and the post asserts a payback period without it.",
  "It is not applicable to the EU market because of the data-residency rule they skip.",
  "Nothing in the traffic numbers supports the 8% conversion they assume.",
];

describe("false positives — the expensive failure mode", () => {
  for (const criticism of SPECIFIC_CRITICISMS) {
    it(`accepts: ${criticism.slice(0, 52)}…`, () => {
      assert.equal(
        findBannedPhrase(criticism),
        undefined,
        "a specific, falsifiable criticism was called generic",
      );
    });
  }
});

describe("the list itself", () => {
  it("stores every phrase already normalised", () => {
    // An entry that is not in normal form can never match, because the
    // candidate always is. A silent no-op entry is worse than no entry.
    for (const entry of BANNED_PHRASES) {
      assert.equal(normalisePhrase(entry.phrase), entry.phrase, `\`${entry.phrase}\` is not normalised`);
    }
  });

  it("declares no duplicate phrases", () => {
    const phrases = BANNED_PHRASES.map((entry) => entry.phrase);
    assert.equal(new Set(phrases).size, phrases.length);
  });

  it("gives every entry a provenance note", () => {
    for (const entry of BANNED_PHRASES) {
      assert.ok(entry.note.length > 0, `\`${entry.phrase}\` has no note`);
    }
  });

  it("returns the FIRST hit, deterministically", () => {
    const first = BANNED_PHRASES[0];
    assert.ok(first !== undefined);
    assert.equal(findBannedPhrase(first.phrase)?.phrase, first.phrase);
  });

  it("makes every entry actually reachable", () => {
    for (const entry of BANNED_PHRASES) {
      const candidate = entry.match === "exact" ? entry.phrase : `${entry.phrase} and then some.`;
      const hit = findBannedPhrase(candidate);
      assert.ok(hit !== undefined, `\`${entry.phrase}\` (${entry.match}) matches nothing`);
    }
  });
});
