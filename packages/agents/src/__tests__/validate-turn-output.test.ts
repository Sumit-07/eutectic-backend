/**
 * Worker test for P-05-BE: the structured-output validator.
 *
 * Every rejection class the validator can produce has a case here, every
 * happy path has a case here, and every numeric boundary is tested on both
 * sides of the edge. The three properties that matter most to the M1 turn
 * worker are asserted as properties, not anecdotes:
 *
 *   - a rejection NEVER carries a value (rule 7: never a fragment);
 *   - a rejection's `reason` is always a declared code, and `kind` always
 *     agrees with which layer produced it;
 *   - the same input always produces the same verdict (no judge, no model).
 *
 * No database, no network, no clock.
 *
 *   pnpm --filter @eutectic/agents test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BANNED_PHRASES } from "../turn-output/banned-phrases.js";
import { AGENT_TURN_OUTPUT_KEYS } from "../turn-output/schema.js";
import {
  REJECTION_REASONS,
  isMechanicalRejection,
  validateTurnOutput,
  validateTurnOutputValue,
  type RejectionKind,
  type RejectionReason,
  type ValidationRejected,
  type ValidationResult,
} from "../turn-output/validate.js";

/** A real uuid shape; nothing in this suite depends on the version nibble. */
const REF_ID = "8c2b1d4e-5a6f-4b7c-8d9e-0f1a2b3c4d5e";

/**
 * A criticism that is specific and falsifiable — the thing the mechanical
 * gate exists to demand. Deliberately not "good writing": just a claim that
 * could turn out to be wrong.
 */
const SPECIFIC = "The 40% retention figure is a cohort of 11 users over one week.";

interface TurnOverrides {
  readonly [key: string]: unknown;
}

/** A valid `contribute` turn, with the overrides applied on top. */
function contribute(overrides: TurnOverrides = {}): Record<string, unknown> {
  return {
    action: "contribute",
    body: "The pricing page assumes annual prepay, which the churn model does not.",
    decline_reason: null,
    call: null,
    refs: [],
    self_check: {
      specific_criticism: SPECIFIC,
      adds_over_prior: "Earlier replies argued about the copy, not the billing assumption.",
    },
    ...overrides,
  };
}

/** A valid `decline` turn, with the overrides applied on top. */
function decline(overrides: TurnOverrides = {}): Record<string, unknown> {
  return {
    action: "decline",
    body: null,
    decline_reason: "Nothing here I can check without the deploy logs.",
    call: null,
    refs: [],
    self_check: {
      specific_criticism: SPECIFIC,
      adds_over_prior: "Nothing — three replies already made this point.",
    },
    ...overrides,
  };
}

/** A complete `AgentTurnCall`, with the overrides applied on top. */
function call(overrides: TurnOverrides = {}): Record<string, unknown> {
  return {
    claim: "This ships without a billing integration.",
    claim_type: "wont_ship",
    confidence: 3,
    horizon_days: 90,
    ...overrides,
  };
}

/** A complete `AgentTurnRef`, with the overrides applied on top. */
function ref(overrides: TurnOverrides = {}): Record<string, unknown> {
  return { kind: "thread", id: REF_ID, label: "The rental-agreement thread", ...overrides };
}

/** Asserts acceptance and hands back the value, so a caller can inspect it. */
function accepted(result: ValidationResult): Record<string, unknown> {
  assert.equal(result.ok, true, `expected acceptance, got ${JSON.stringify(result)}`);
  assert.ok(result.ok);
  return result.value as unknown as Record<string, unknown>;
}

/** Asserts rejection with exactly this reason, kind and path. */
function rejects(
  value: unknown,
  reason: RejectionReason,
  path: string,
  kind: RejectionKind = "schema_violation",
): ValidationRejected {
  const result = validateTurnOutputValue(value);
  assert.equal(result.ok, false, `expected a rejection, got acceptance`);
  assert.ok(!result.ok);
  assert.equal(result.reason, reason, `reason (detail: ${result.detail})`);
  assert.equal(result.path, path, `path (detail: ${result.detail})`);
  assert.equal(result.kind, kind, `kind (detail: ${result.detail})`);

  // The invariants, asserted on every single rejection this suite produces.
  assert.ok(!("value" in result), "a rejection must never carry a value (rule 7)");
  assert.ok(
    (REJECTION_REASONS as readonly string[]).includes(result.reason),
    "reason is not a declared code",
  );
  assert.equal(
    isMechanicalRejection(result),
    kind === "mechanical_rejection",
    "`kind` and `isMechanicalRejection` disagree",
  );
  assert.ok(result.detail.length > 0, "a rejection must say something loggable");
  return result;
}

describe("happy paths", () => {
  it("accepts a contribute with no call and no refs", () => {
    const value = accepted(validateTurnOutputValue(contribute()));
    assert.equal(value["action"], "contribute");
    assert.equal(value["call"], null);
  });

  it("accepts a contribute with a call and refs", () => {
    const turn = contribute({ call: call(), refs: [ref(), ref({ kind: "diary" })] });
    const value = accepted(validateTurnOutputValue(turn));
    assert.deepEqual(value["call"], call());
  });

  it("accepts a decline", () => {
    const value = accepted(validateTurnOutputValue(decline()));
    assert.equal(value["body"], null);
    assert.equal(value["action"], "decline");
  });

  it("returns the same object it was given, whole", () => {
    // Not a copy and not a subset: the worker persists what it validated.
    const turn = contribute({ call: call(), refs: [ref()] });
    const value = accepted(validateTurnOutputValue(turn));
    assert.equal(value, turn);
    assert.deepEqual(Object.keys(value).sort(), [...AGENT_TURN_OUTPUT_KEYS].sort());
  });

  it("parses raw model text", () => {
    const value = accepted(validateTurnOutput(JSON.stringify(contribute())));
    assert.equal(value["action"], "contribute");
  });

  it("is deterministic — the same turn, ten times, the same verdict", () => {
    const raw = JSON.stringify(contribute({ call: call({ confidence: 5 }) }));
    const verdicts = new Set(Array.from({ length: 10 }, () => validateTurnOutput(raw).ok));
    assert.deepEqual([...verdicts], [true]);
  });
});

describe("malformed JSON", () => {
  it("rejects text that is not JSON", () => {
    const result = validateTurnOutput("Here is my reply:\n\nI think the pricing is wrong.");
    assert.ok(!result.ok);
    assert.equal(result.reason, "malformed_json");
    assert.equal(result.kind, "schema_violation");
    assert.equal(result.path, "");
  });

  it("rejects JSON truncated mid-object", () => {
    const result = validateTurnOutput('{"action":"contribute","body":"the pricing is');
    assert.ok(!result.ok);
    assert.equal(result.reason, "malformed_json");
  });

  it("rejects a fenced code block the model forgot to strip", () => {
    const result = validateTurnOutput("```json\n{}\n```");
    assert.ok(!result.ok);
    assert.equal(result.reason, "malformed_json");
  });

  it("rejects JSON that is not an object", () => {
    for (const raw of ["null", "[]", '"contribute"', "7", "true"]) {
      const result = validateTurnOutput(raw);
      assert.ok(!result.ok, `${raw} was accepted`);
      assert.equal(result.reason, "not_an_object", raw);
      assert.equal(result.path, "");
    }
  });
});

describe("unknown keys — additionalProperties: false at every level", () => {
  it("rejects an unknown key at the top level", () => {
    rejects(contribute({ confidence_note: "very sure" }), "unknown_key", "confidence_note");
  });

  it("rejects an unknown key inside call", () => {
    rejects(contribute({ call: call({ state: "open" }) }), "unknown_key", "call.state");
  });

  it("rejects an unknown key inside a ref", () => {
    rejects(contribute({ refs: [ref({ url: "https://…" })] }), "unknown_key", "refs[0].url");
  });

  it("names the offending ref by index", () => {
    rejects(
      contribute({ refs: [ref(), ref({ excerpt: "…" })] }),
      "unknown_key",
      "refs[1].excerpt",
    );
  });

  it("rejects an unknown key inside self_check", () => {
    rejects(
      contribute({ self_check: { specific_criticism: SPECIFIC, adds_over_prior: "x", score: 4 } }),
      "unknown_key",
      "self_check.score",
    );
  });

  it("reports an unknown key before a missing one, whatever the key order", () => {
    // Fixed precedence: the code a caller logs must not depend on the order
    // the model happened to serialise its object in.
    const turn = contribute({ surprise: true });
    delete turn["refs"];
    rejects(turn, "unknown_key", "surprise");
  });
});

describe("missing keys — every key required, nullability is the only optionality (D-039)", () => {
  for (const key of AGENT_TURN_OUTPUT_KEYS) {
    it(`rejects a turn with no ${key}`, () => {
      const turn = contribute();
      delete turn[key];
      rejects(turn, "missing_key", key);
    });
  }

  it("rejects a call missing horizon_days", () => {
    const incomplete = call();
    delete incomplete["horizon_days"];
    rejects(contribute({ call: incomplete }), "missing_key", "call.horizon_days");
  });

  it("rejects a ref missing label", () => {
    const incomplete = ref();
    delete incomplete["label"];
    rejects(contribute({ refs: [incomplete] }), "missing_key", "refs[0].label");
  });

  it("rejects a self_check missing adds_over_prior", () => {
    rejects(
      contribute({ self_check: { specific_criticism: SPECIFIC } }),
      "missing_key",
      "self_check.adds_over_prior",
    );
  });

  it("does not accept undefined as a stand-in for a key", () => {
    // `{...t, call: undefined}` has the key but not a value; `JSON.stringify`
    // then drops it. Treated as missing, which is what it becomes on the wire.
    rejects(contribute({ call: undefined }), "missing_key", "call");
  });
});

describe("action", () => {
  it("rejects an action outside the enum", () => {
    rejects(contribute({ action: "abstain" }), "invalid_action", "action");
  });

  it("rejects a near-miss of the enum", () => {
    for (const action of ["Contribute", "contribute ", "contributes", ""]) {
      rejects(contribute({ action }), "invalid_action", "action");
    }
  });

  it("rejects a non-string action", () => {
    rejects(contribute({ action: 1 }), "wrong_type", "action");
    rejects(contribute({ action: null }), "wrong_type", "action");
  });
});

describe("cross-field rules — 'exactly when', in both directions", () => {
  it("rejects a contribute with a null body", () => {
    rejects(contribute({ body: null }), "cross_field", "body");
  });

  it("rejects a contribute with an empty body", () => {
    rejects(contribute({ body: "   \n  " }), "empty_string", "body");
  });

  it("rejects a contribute that also gives a decline_reason", () => {
    rejects(contribute({ decline_reason: "but also I decline" }), "cross_field", "decline_reason");
  });

  it("rejects a decline that also carries a body", () => {
    rejects(decline({ body: "here is the reply anyway" }), "cross_field", "body");
  });

  it("rejects a decline with a null decline_reason", () => {
    rejects(decline({ decline_reason: null }), "cross_field", "decline_reason");
  });

  it("rejects a decline with an empty decline_reason", () => {
    rejects(decline({ decline_reason: "  " }), "empty_string", "decline_reason");
  });

  it("rejects a non-string body on a contribute", () => {
    rejects(contribute({ body: 42 }), "wrong_type", "body");
  });

  it("rejects a non-string decline_reason on a decline", () => {
    rejects(decline({ decline_reason: ["too", "long"] }), "wrong_type", "decline_reason");
  });
});

describe("call", () => {
  it("accepts null", () => {
    accepted(validateTurnOutputValue(contribute({ call: null })));
  });

  it("rejects a non-object, non-null call", () => {
    rejects(contribute({ call: "wont_ship" }), "not_an_object", "call");
    rejects(contribute({ call: [call()] }), "not_an_object", "call");
  });

  it("rejects an empty claim", () => {
    rejects(contribute({ call: call({ claim: "" }) }), "empty_string", "call.claim");
    rejects(contribute({ call: call({ claim: "\t " }) }), "empty_string", "call.claim");
  });

  it("rejects an empty claim_type", () => {
    rejects(contribute({ call: call({ claim_type: "" }) }), "empty_string", "call.claim_type");
  });

  it("accepts a claim_type nobody has ever seen — the vocabulary is OPEN (D-039)", () => {
    // If this test ever needs updating because a new claim kind was rejected,
    // someone has closed a vocabulary that must never close.
    for (const claim_type of ["wont_ship", "misread_the_market", "regulatory_block", "🙃"]) {
      accepted(validateTurnOutputValue(contribute({ call: call({ claim_type }) })));
    }
  });

  it("rejects a non-string claim_type", () => {
    rejects(contribute({ call: call({ claim_type: 3 }) }), "wrong_type", "call.claim_type");
  });

  describe("confidence — 1..5 inclusive", () => {
    it("rejects 0", () => {
      rejects(contribute({ call: call({ confidence: 0 }) }), "out_of_range", "call.confidence");
    });

    it("accepts 1", () => {
      accepted(validateTurnOutputValue(contribute({ call: call({ confidence: 1 }) })));
    });

    it("accepts 5", () => {
      accepted(validateTurnOutputValue(contribute({ call: call({ confidence: 5 }) })));
    });

    it("rejects 6", () => {
      rejects(contribute({ call: call({ confidence: 6 }) }), "out_of_range", "call.confidence");
    });

    it("rejects a negative", () => {
      rejects(contribute({ call: call({ confidence: -1 }) }), "out_of_range", "call.confidence");
    });

    it("rejects a fractional value inside the range", () => {
      rejects(contribute({ call: call({ confidence: 3.5 }) }), "not_an_integer", "call.confidence");
    });

    it("rejects a numeric string", () => {
      rejects(contribute({ call: call({ confidence: "3" }) }), "wrong_type", "call.confidence");
    });
  });

  describe("horizon_days — at least 1, no ceiling", () => {
    it("rejects 0", () => {
      rejects(contribute({ call: call({ horizon_days: 0 }) }), "out_of_range", "call.horizon_days");
    });

    it("accepts 1", () => {
      accepted(validateTurnOutputValue(contribute({ call: call({ horizon_days: 1 }) })));
    });

    it("accepts a long horizon", () => {
      accepted(validateTurnOutputValue(contribute({ call: call({ horizon_days: 3650 }) })));
    });

    it("rejects a fractional horizon", () => {
      rejects(
        contribute({ call: call({ horizon_days: 90.5 }) }),
        "not_an_integer",
        "call.horizon_days",
      );
    });
  });

  it("accepts a call on a decline too — the contract does not forbid it", () => {
    // Noted rather than assumed: `action` constrains `body` and
    // `decline_reason` and nothing else. A decline that still makes a call is
    // a product question, not a schema one.
    accepted(validateTurnOutputValue(decline({ call: call() })));
  });
});

describe("refs", () => {
  it("accepts an empty array", () => {
    accepted(validateTurnOutputValue(contribute({ refs: [] })));
  });

  it("rejects a non-array", () => {
    rejects(contribute({ refs: null }), "wrong_type", "refs");
    rejects(contribute({ refs: ref() }), "wrong_type", "refs");
  });

  it("rejects a non-object entry", () => {
    rejects(contribute({ refs: ["the rental thread"] }), "not_an_object", "refs[0]");
    rejects(contribute({ refs: [ref(), null] }), "not_an_object", "refs[1]");
  });

  it("rejects an id that is not a uuid", () => {
    for (const id of ["thread-42", "", "8c2b1d4e5a6f4b7c8d9e0f1a2b3c4d5e", `${REF_ID}-extra`]) {
      rejects(contribute({ refs: [ref({ id })] }), "invalid_id", "refs[0].id");
    }
  });

  it("accepts an uppercase uuid", () => {
    accepted(validateTurnOutputValue(contribute({ refs: [ref({ id: REF_ID.toUpperCase() })] })));
  });

  it("rejects a non-string id", () => {
    rejects(contribute({ refs: [ref({ id: 42 })] }), "wrong_type", "refs[0].id");
  });

  it("rejects an empty kind or label", () => {
    rejects(contribute({ refs: [ref({ kind: "" })] }), "empty_string", "refs[0].kind");
    rejects(contribute({ refs: [ref({ label: " " })] }), "empty_string", "refs[0].label");
  });

  it("accepts a kind nobody has ever seen — open vocabulary, like claim_type", () => {
    accepted(validateTurnOutputValue(contribute({ refs: [ref({ kind: "finding" })] })));
  });
});

describe("self_check — the schema layer", () => {
  it("rejects a non-object self_check", () => {
    rejects(contribute({ self_check: "specific enough" }), "not_an_object", "self_check");
    rejects(contribute({ self_check: null }), "not_an_object", "self_check");
  });

  it("rejects non-string fields", () => {
    rejects(
      contribute({ self_check: { specific_criticism: null, adds_over_prior: "x" } }),
      "wrong_type",
      "self_check.specific_criticism",
    );
    rejects(
      contribute({ self_check: { specific_criticism: SPECIFIC, adds_over_prior: 3 } }),
      "wrong_type",
      "self_check.adds_over_prior",
    );
  });
});

describe("self_check — the MECHANICAL layer (D-031)", () => {
  const withCriticism = (specific_criticism: string): Record<string, unknown> =>
    contribute({ self_check: { specific_criticism, adds_over_prior: "Nobody raised billing." } });

  it("rejects an empty criticism", () => {
    rejects(withCriticism(""), "self_check_empty", "self_check.specific_criticism", "mechanical_rejection");
  });

  it("rejects a whitespace-only criticism", () => {
    rejects(
      withCriticism("  \t\n "),
      "self_check_empty",
      "self_check.specific_criticism",
      "mechanical_rejection",
    );
  });

  it("rejects a criticism that is only punctuation", () => {
    // Normalisation strips edge punctuation, so "—" and "..." are the empty
    // string wearing a costume.
    for (const criticism of ["—", "...", "-", '""']) {
      rejects(
        withCriticism(criticism),
        "self_check_empty",
        "self_check.specific_criticism",
        "mechanical_rejection",
      );
    }
  });

  it("rejects a generic criticism", () => {
    rejects(
      withCriticism("N/A"),
      "self_check_generic",
      "self_check.specific_criticism",
      "mechanical_rejection",
    );
  });

  it("names the phrase it hit, so a retry prompt can quote it", () => {
    const result = rejects(
      withCriticism("Great question — the pricing is interesting."),
      "self_check_generic",
      "self_check.specific_criticism",
      "mechanical_rejection",
    );
    assert.match(result.detail, /great question/);
  });

  it("accepts a specific, falsifiable criticism", () => {
    accepted(validateTurnOutputValue(withCriticism(SPECIFIC)));
  });

  it("runs AFTER the schema layer — a broken shape is never called generic", () => {
    // Ordering matters for the retry prompt: telling a model its criticism is
    // generic when the real problem is a missing key sends the retry the
    // wrong way.
    const turn = withCriticism("n/a");
    delete turn["refs"];
    rejects(turn, "missing_key", "refs");
  });

  it("does NOT gate a decline's criticism", () => {
    // The documented scoping ruling. A decline has no body for the criticism
    // to be about, and retrying it spends inference to reach the same decline.
    accepted(
      validateTurnOutputValue(
        decline({ self_check: { specific_criticism: "n/a", adds_over_prior: "" } }),
      ),
    );
  });

  it("does not gate adds_over_prior at all", () => {
    // DIRECTIVE §6 names `specific_criticism` and only that. Widening the gate
    // to the second field is a judgement call for whoever writes
    // `testing-and-evals.md` §5, not for the validator.
    accepted(validateTurnOutputValue(contribute({
      self_check: { specific_criticism: SPECIFIC, adds_over_prior: "" },
    })));
  });
});

describe("the rejection taxonomy itself", () => {
  it("declares no duplicate reason codes", () => {
    assert.equal(new Set(REJECTION_REASONS).size, REJECTION_REASONS.length);
  });

  it("uses `mechanical_rejection` for exactly the two self_check content codes", () => {
    const mechanical = REJECTION_REASONS.filter((reason) => reason.startsWith("self_check_"));
    assert.deepEqual([...mechanical], ["self_check_empty", "self_check_generic"]);
  });

  it("never carries a value on a rejection, across every seeded phrase", () => {
    // Cheap coverage of the whole list: every entry must actually reject
    // something, so a typo'd phrase cannot sit in the list doing nothing.
    for (const entry of BANNED_PHRASES) {
      const criticism = entry.match === "exact" ? entry.phrase : `${entry.phrase} — and so on.`;
      const result = validateTurnOutputValue(
        contribute({ self_check: { specific_criticism: criticism, adds_over_prior: "x" } }),
      );
      assert.ok(!result.ok, `"${entry.phrase}" (${entry.match}) did not reject`);
      assert.equal(result.kind, "mechanical_rejection", entry.phrase);
      assert.ok(!("value" in result));
    }
  });
});
