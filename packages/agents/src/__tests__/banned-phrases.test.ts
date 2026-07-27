/**
 * Worker test for P-05-BE's banned-phrase mechanism, its data-file parser, and
 * the shipped (empty) state of the vocabulary.
 *
 * ─── READ THIS BEFORE ADDING A PHRASE ───────────────────────────────────────
 *
 * `TEST_PHRASES` (in `phrase-fixture.ts`) is a TEST-ONLY FIXTURE. It is not the
 * product's banned phrase list, it is never loaded by production code, and
 * nothing may promote it into `data/banned-phrases.json`. D-042 item 2 rules
 * that the Layer-2 vocabulary is eval taste, human-owned under CLAUDE.md §11,
 * and that the shipped list stays empty until `docs/testing-and-evals.md` §5
 * exists. The fixture's only job is to keep the MECHANISM under test while
 * that is true — it is injected, which is why `findBannedPhrase` takes the
 * list as an argument.
 *
 * Three jobs here:
 *
 *   1. The matching RULING is asserted rather than described: case, whitespace,
 *      edge punctuation, unicode folding, and the word boundary that keeps
 *      `contains` from firing inside a longer word.
 *   2. The FALSE-POSITIVE cases. A mechanical rejection costs a retry and three
 *      cost a decline (rule 7) on a contribution that may have been fine. Every
 *      sentence in `SPECIFIC_CRITICISMS` is a genuinely falsifiable criticism
 *      containing a fixture phrase mid-sentence; each must pass. These survive
 *      unchanged when the human's real list arrives, and are the alarm if it
 *      gives an opener `contains`.
 *   3. The data file: that a malformed one fails loudly, and that the shipped
 *      one parses, validates, and has ZERO entries.
 *
 *   pnpm --filter @eutectic/agents test
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  BANNED_PHRASES,
  BANNED_PHRASE_FILE_URL,
  BANNED_PHRASE_MATCHES,
  BannedPhraseFileError,
  findBannedPhrase,
  normalisePhrase,
  parseBannedPhraseFile,
  type BannedPhrase,
} from "../turn-output/banned-phrases.js";
import { TEST_PHRASES } from "./phrase-fixture.js";

const banned = (value: string): string | undefined =>
  findBannedPhrase(value, TEST_PHRASES)?.phrase;

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
      assert.equal(findBannedPhrase(value, TEST_PHRASES), undefined, JSON.stringify(value));
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
    assert.equal(
      banned("They describe it as an air-gapped deployment, which contradicts §3."),
      undefined,
    );
  });
});

describe("the injection seam", () => {
  it("finds nothing in an empty list — the shipped production posture", () => {
    // This is what every production call returns today under D-042 item 2.
    assert.equal(findBannedPhrase("n/a", []), undefined);
    assert.equal(findBannedPhrase("Great question!", []), undefined);
  });

  it("consults the list it was given and no other", () => {
    const only: readonly BannedPhrase[] = [{ phrase: "asdf", match: "exact", note: "fixture" }];
    assert.equal(findBannedPhrase("asdf", only)?.phrase, "asdf");
    // In TEST_PHRASES but not in `only` — proof the module holds no hidden list.
    assert.equal(findBannedPhrase("n/a", only), undefined);
  });

  it("returns the FIRST hit, deterministically", () => {
    const both: readonly BannedPhrase[] = [
      { phrase: "it depends", match: "prefix", note: "fixture: first" },
      { phrase: "it", match: "prefix", note: "fixture: second" },
    ];
    assert.equal(findBannedPhrase("It depends on the tier.", both)?.note, "fixture: first");
  });
});

/**
 * Real criticisms that contain a fixture phrase somewhere. NONE may be
 * rejected. Each is falsifiable: it names something that could be checked and
 * found wrong. These outlive the fixture — they are the acceptance test for
 * whatever vocabulary the human eventually writes.
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
        findBannedPhrase(criticism, TEST_PHRASES),
        undefined,
        "a specific, falsifiable criticism was called generic",
      );
    });
  }
});

describe("the fixture itself", () => {
  it("stores every phrase already normalised", () => {
    for (const entry of TEST_PHRASES) {
      assert.equal(normalisePhrase(entry.phrase), entry.phrase, `\`${entry.phrase}\` is not normalised`);
    }
  });

  it("makes every entry actually reachable", () => {
    for (const entry of TEST_PHRASES) {
      const candidate = entry.match === "exact" ? entry.phrase : `${entry.phrase} and then some.`;
      assert.ok(
        findBannedPhrase(candidate, TEST_PHRASES) !== undefined,
        `\`${entry.phrase}\` (${entry.match}) matches nothing`,
      );
    }
  });

  it("covers all three match modes, so the mechanism is fully exercised", () => {
    const modes = new Set(TEST_PHRASES.map((entry) => entry.match));
    for (const mode of BANNED_PHRASE_MATCHES) {
      assert.ok(modes.has(mode), `no fixture entry exercises \`${mode}\``);
    }
  });
});

const FIXTURE_SOURCE = "test fixture";
const parse = (text: string): readonly BannedPhrase[] => parseBannedPhraseFile(text, FIXTURE_SOURCE);

/** Every malformed file must throw, and the message must name the fault. */
const MALFORMED: readonly (readonly [string, string, RegExp])[] = [
  ["not JSON at all", "{nope", /not valid JSON/],
  ["a bare array", '["n/a"]', /must be a JSON object/],
  ["a string", '"n/a"', /must be a JSON object/],
  ["null", "null", /must be a JSON object/],
  ["an unknown top-level key", '{"source":"s","phrases":[],"extra":1}', /unknown key `extra`/],
  ["a missing source", '{"phrases":[]}', /`source` must be a string/],
  ["a non-string source", '{"source":3,"phrases":[]}', /`source` must be a string/],
  ["missing phrases", '{"source":"s"}', /`phrases` must be an array/],
  ["phrases as an object", '{"source":"s","phrases":{}}', /`phrases` must be an array/],
  ["an entry that is a string", '{"source":"s","phrases":["n/a"]}', /phrases\[0\] must be an object/],
  ["an entry that is null", '{"source":"s","phrases":[null]}', /phrases\[0\] must be an object/],
  [
    "an unknown key on an entry",
    '{"source":"s","phrases":[{"phrase":"n/a","match":"exact","note":"n","x":1}]}',
    /unknown key `x`/,
  ],
  ["a missing phrase", '{"source":"s","phrases":[{"match":"exact","note":"n"}]}', /`phrase` must be a string/],
  ["an empty phrase", '{"source":"s","phrases":[{"phrase":"","match":"exact","note":"n"}]}', /empty `phrase`/],
  [
    "a phrase not in normal form",
    '{"source":"s","phrases":[{"phrase":"Great Question","match":"prefix","note":"n"}]}',
    /not in normal form — write it as `great question`/,
  ],
  [
    "a duplicate phrase",
    '{"source":"s","phrases":[{"phrase":"n/a","match":"exact","note":"n"},{"phrase":"n/a","match":"exact","note":"n"}]}',
    /repeats `n\/a`/,
  ],
  ["a missing match", '{"source":"s","phrases":[{"phrase":"n/a","note":"n"}]}', /`match` must be a string/],
  [
    "an unknown match mode",
    '{"source":"s","phrases":[{"phrase":"n/a","match":"regex","note":"n"}]}',
    /match `regex`; expected one of exact, prefix, contains/,
  ],
  ["a missing note", '{"source":"s","phrases":[{"phrase":"n/a","match":"exact"}]}', /`note` must be a string/],
  [
    "a blank note",
    '{"source":"s","phrases":[{"phrase":"n/a","match":"exact","note":"  "}]}',
    /empty `note`/,
  ],
];

describe("the data file parser — fails loudly, never silently", () => {
  // A list that degrades to empty because of a misplaced comma is the worst
  // outcome available: the gate looks like it is running and passes everything.
  for (const [label, text, message] of MALFORMED) {
    it(`throws on ${label}`, () => {
      assert.throws(() => parse(text), (error: unknown) => {
        assert.ok(error instanceof BannedPhraseFileError, `threw ${String(error)}`);
        assert.match(error.message, message);
        // The origin is in every message, so a boot crash names the file.
        assert.ok(error.message.startsWith(`${FIXTURE_SOURCE}: `), error.message);
        return true;
      });
    });
  }

  it("accepts an empty list", () => {
    assert.deepEqual(parse('{"source":"none yet","phrases":[]}'), []);
  });

  it("accepts a well-formed list and preserves order", () => {
    const parsed = parse(
      '{"source":"§5","phrases":[{"phrase":"n/a","match":"exact","note":"a"},{"phrase":"as an ai","match":"contains","note":"b"}]}',
    );
    assert.deepEqual(parsed, [
      { phrase: "n/a", match: "exact", note: "a" },
      { phrase: "as an ai", match: "contains", note: "b" },
    ]);
  });

  it("round-trips through the matcher, so a parsed list is usable as-is", () => {
    const parsed = parse('{"source":"§5","phrases":[{"phrase":"n/a","match":"exact","note":"a"}]}');
    assert.equal(findBannedPhrase("N/A.", parsed)?.note, "a");
  });
});

/**
 * The shipped state. This test exists so that a future hand-edit sneaking
 * vocabulary in before `testing-and-evals.md` §5 exists must also edit a test,
 * deliberately — which is the audit trail D-042 item 2 is owed.
 */
describe("the shipped vocabulary (D-042 item 2)", () => {
  it("parses the file that actually ships", () => {
    const text = readFileSync(BANNED_PHRASE_FILE_URL, "utf8");
    assert.doesNotThrow(() => parseBannedPhraseFile(text, "shipped"));
  });

  it("ships ZERO entries — wired but empty until the human writes §5 Layer 2", () => {
    assert.deepEqual(
      [...BANNED_PHRASES],
      [],
      "the banned-phrase list is human-owned taste (CLAUDE.md §11, D-042 item 2); " +
        "it may only be populated once docs/testing-and-evals.md §5 exists, and " +
        "changing this test is how that decision gets recorded",
    );
  });

  it("records a source string, even while empty", () => {
    const parsed = JSON.parse(readFileSync(BANNED_PHRASE_FILE_URL, "utf8")) as { source: string };
    assert.ok(parsed.source.length > 0, "the data file must say where its vocabulary came from");
  });

  it("means self_check_generic cannot fire in production today", () => {
    // The consequence, pinned. When this starts failing, the vocabulary has
    // landed and the gate is live — which is the intended future, not a bug.
    assert.equal(findBannedPhrase("n/a", BANNED_PHRASES), undefined);
  });
});
