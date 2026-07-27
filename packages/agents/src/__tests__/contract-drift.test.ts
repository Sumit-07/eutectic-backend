/**
 * The contract-drift gate for the `AgentTurnOutput` family (P-05-BE).
 *
 * Same house pattern as `apps/api`'s route-drift test: `openapi.yaml` is
 * parsed HERE, independently of `@eutectic/contracts`' generator, and compared
 * to the tables `turn-output/schema.ts` validates against. A contract change
 * that this validator does not know about must scream in this file rather than
 * silently pass — a new required key the validator never checks would be a
 * turn accepted with a hole in it, which is rule 7's fragment arriving through
 * the back door.
 *
 * Every comparison is a SET EQUALITY IN BOTH DIRECTIONS. A key in the spec the
 * validator does not know fails; a key the validator knows that the spec has
 * dropped fails just as hard.
 *
 *   pnpm --filter @eutectic/agents test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AGENT_TURN_ACTIONS,
  AGENT_TURN_CALL_KEYS,
  AGENT_TURN_OUTPUT_KEYS,
  AGENT_TURN_REF_KEYS,
  AGENT_TURN_SELF_CHECK_KEYS,
  CONFIDENCE_MAX,
  CONFIDENCE_MIN,
  HORIZON_DAYS_MIN,
  UUID_PATTERN,
} from "../turn-output/schema.js";
import { readSchema, scanSchemas, type ScannedSchema } from "./openapi-schema-scan.js";

const schemas = scanSchemas();

const sorted = (values: readonly string[]): string[] => [...values].sort();

/** `[a, b]` as the spec writes it, unquoted. */
function flowSequence(value: string | undefined, key: string): string[] {
  assert.ok(value !== undefined, `expected a \`${key}\` on this property`);
  assert.ok(value.startsWith("[") && value.endsWith("]"), `\`${key}\` is not a flow sequence`);
  return value
    .slice(1, -1)
    .split(",")
    .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ""));
}

/**
 * The three properties every schema in this family shares, and the D-039
 * invariant that makes ONE key table per schema legitimate: closed object,
 * every declared key required, nothing optional but nullability.
 */
function assertClosedAndFullyRequired(schema: ScannedSchema, keys: readonly string[]): void {
  assert.equal(schema.attributes.get("type"), "object", `${schema.name} is not \`type: object\``);
  assert.equal(
    schema.attributes.get("additionalProperties"),
    "false",
    `${schema.name} is not closed — the validator rejects unknown keys on the strength of this`,
  );
  assert.deepEqual(sorted(schema.properties), sorted(keys), `${schema.name} known-key table`);
  assert.deepEqual(sorted(schema.required), sorted(keys), `${schema.name} required-key table`);
  // Stated separately from the two above so the failure names the RULING, not
  // just a mismatched list, when a future contract adds an optional key.
  assert.deepEqual(
    sorted(schema.required),
    sorted(schema.properties),
    `${schema.name} has an optional key. D-039: nullability is the only optionality — a missing key is a validation failure, not a maybe. The validator cannot express this contract any more.`,
  );
}

describe("openapi.yaml ↔ the validator's key tables", () => {
  it("AgentTurnOutput declares exactly the keys the validator knows", () => {
    assertClosedAndFullyRequired(readSchema(schemas, "AgentTurnOutput"), AGENT_TURN_OUTPUT_KEYS);
  });

  it("AgentTurnCall declares exactly the keys the validator knows", () => {
    assertClosedAndFullyRequired(readSchema(schemas, "AgentTurnCall"), AGENT_TURN_CALL_KEYS);
  });

  it("AgentTurnRef declares exactly the keys the validator knows", () => {
    assertClosedAndFullyRequired(readSchema(schemas, "AgentTurnRef"), AGENT_TURN_REF_KEYS);
  });

  it("AgentTurnSelfCheck declares exactly the keys the validator knows", () => {
    assertClosedAndFullyRequired(
      readSchema(schemas, "AgentTurnSelfCheck"),
      AGENT_TURN_SELF_CHECK_KEYS,
    );
  });
});

describe("openapi.yaml ↔ the validator's value rules", () => {
  const output = readSchema(schemas, "AgentTurnOutput");
  const call = readSchema(schemas, "AgentTurnCall");
  const ref = readSchema(schemas, "AgentTurnRef");
  const selfCheck = readSchema(schemas, "AgentTurnSelfCheck");

  it("agrees on action's closed enum", () => {
    const declared = flowSequence(output.propertyAttributes.get("action")?.get("enum"), "enum");
    assert.deepEqual(sorted(declared), sorted(AGENT_TURN_ACTIONS));
  });

  it("keeps body and decline_reason nullable strings", () => {
    // The cross-field rule ("null exactly when…") is only expressible because
    // both are `type: [string, 'null']`. If either loses null, the validator's
    // decline path is checking something the contract no longer allows.
    for (const key of ["body", "decline_reason"]) {
      const declared = flowSequence(output.propertyAttributes.get(key)?.get("type"), "type");
      assert.deepEqual(sorted(declared), ["null", "string"], `${key} type`);
    }
  });

  it("keeps call nullable and pointed at AgentTurnCall", () => {
    assert.deepEqual(output.propertyRefs.get("call"), ["#/components/schemas/AgentTurnCall"]);
    // The `oneOf` null branch is what makes `call: null` legal — the validator
    // skips the whole AgentTurnCall check on null, and may only do that while
    // the contract still says so.
    assert.ok(
      output.propertyAttributes.get("call")?.has("oneOf") === false,
      "`oneOf` should carry no inline scalar; the branches are what matter",
    );
  });

  it("keeps refs an array of AgentTurnRef", () => {
    assert.equal(output.propertyAttributes.get("refs")?.get("type"), "array");
    assert.deepEqual(output.propertyRefs.get("refs"), ["#/components/schemas/AgentTurnRef"]);
  });

  it("keeps self_check a required AgentTurnSelfCheck", () => {
    assert.deepEqual(output.propertyRefs.get("self_check"), [
      "#/components/schemas/AgentTurnSelfCheck",
    ]);
  });

  it("agrees on confidence's bounds", () => {
    const attributes = call.propertyAttributes.get("confidence");
    assert.equal(attributes?.get("type"), "integer");
    assert.equal(attributes?.get("minimum"), String(CONFIDENCE_MIN));
    assert.equal(attributes?.get("maximum"), String(CONFIDENCE_MAX));
  });

  it("agrees on horizon_days' lower bound, and that it has no upper one", () => {
    const attributes = call.propertyAttributes.get("horizon_days");
    assert.equal(attributes?.get("type"), "integer");
    assert.equal(attributes?.get("minimum"), String(HORIZON_DAYS_MIN));
    assert.equal(attributes?.get("maximum"), undefined);
  });

  it("keeps claim_type an OPEN vocabulary (D-039 ruling 4)", () => {
    const attributes = call.propertyAttributes.get("claim_type");
    assert.equal(attributes?.get("type"), "string");
    // The load-bearing assertion in this file. If `claim_type` ever grows an
    // `enum`, someone has closed a vocabulary that D-039 says must never
    // close — and the validator, which deliberately checks only "non-empty
    // string", would silently stop enforcing a contract that now says more.
    // That is a decision for Fable, not a quiet green build.
    assert.equal(
      attributes?.get("enum"),
      undefined,
      "claim_type has acquired an enum — D-039 ruling 4 says a new claim kind must never need a contract release",
    );
  });

  it("keeps a ref's id an Id, and Id a uuid the validator's pattern accepts", () => {
    assert.deepEqual(ref.propertyRefs.get("id"), ["#/components/schemas/Id"]);

    const id = readSchema(schemas, "Id");
    assert.equal(id.attributes.get("type"), "string");
    assert.equal(id.attributes.get("format"), "uuid");

    // The spec's own example must satisfy the hand-rolled pattern, or the
    // pattern is wrong about what a uuid looks like.
    const examples = flowSequence(id.attributes.get("examples"), "examples");
    for (const example of examples) {
      assert.match(example, UUID_PATTERN, `openapi.yaml's Id example fails UUID_PATTERN`);
    }
  });

  it("keeps both self_check fields plain strings", () => {
    for (const key of AGENT_TURN_SELF_CHECK_KEYS) {
      assert.equal(selfCheck.propertyAttributes.get(key)?.get("type"), "string", `${key} type`);
    }
  });
});
