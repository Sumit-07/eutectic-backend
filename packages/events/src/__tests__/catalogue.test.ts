/**
 * Worker test for M0-BE-13, part 1: the catalogue is frozen.
 *
 * This file is DOUBLE-ENTRY BOOKKEEPING against `catalogue.ts`. The list below
 * is an independent transcription of the SD §4 "Event catalogue" block; the
 * assertions compare it to what the package actually exports. Editing one and
 * not the other fails, which is the point — a rename can then only happen on
 * purpose, in two places, in a diff a reviewer will see.
 *
 * It is also a TYPE test. `as const satisfies readonly EventType[]` means a
 * misspelled name in the list below is a COMPILE error, not a test failure:
 * `pnpm --filter @eutectic/events build` fails before `node --test` ever runs.
 * Same for the static assertions at the bottom, which prove the payload map and
 * the subject map still cover the catalogue exactly.
 *
 *   pnpm --filter @eutectic/events test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EVENT_TYPES, isEventType, type EventType } from "../catalogue.js";
import type { EventInput, EventSubjectTypeMap } from "../event.js";
import type { EventPayloadMap } from "../payloads.js";

/**
 * system-design §4, "Event catalogue", transcribed line by line. Do not derive
 * this from `EVENT_TYPES` — deriving it would make every assertion below
 * tautological.
 */
const SPEC_CATALOGUE = [
  "post.created",
  "post.tagged",
  "thread.chapter_opened",
  "thread.chapter_closed",
  "thread.woke",
  "contribution.created",
  "contribution.declined",
  "contribution.disputed",
  "call.made",
  "call.resolved",
  "call.expired",
  "vote.cast",
  "vote.retracted",
  "diary.published",
  "diary.addendum_added",
  "argument.created",
  "argument.side_taken",
  "argument.judged",
  "follow.added",
  "follow.removed",
  "follow.muted",
  "grant.granted",
  "grant.revoked",
  "review.filed",
  "session.started",
  "session.ended",
  "finding.filed",
  "finding.state_changed",
  "residency.started",
  "residency.retested",
  "residency.stopped",
  "deploy.signalled",
  "credit.granted",
  "credit.spent",
  "standing.awarded",
  "standing.deducted",
  "agent.registered",
  "agent.status_changed",
  "agent.budget_exhausted",
  "proposal.submitted",
  "proposal.state_changed",
  "commitment.set",
  "commitment.resolved",
  "bell.nudged",
  "bell.circuit_broken",
  "entitlement.changed",
  "moderation.action",
  "admin.action",
] as const satisfies readonly EventType[];

describe("the SD §4 event catalogue is frozen", () => {
  it("matches system-design §4 name for name, in spec order", () => {
    assert.deepEqual(
      [...EVENT_TYPES],
      [...SPEC_CATALOGUE],
      "EVENT_TYPES has drifted from the SD §4 catalogue. Names are a wire " +
        "format: every projection, diary, calibration and audit query reads " +
        "them off rows already written, and the log is append-only. Add names; " +
        "never rename one.",
    );
  });

  it("has 48 names and no duplicates", () => {
    assert.equal(EVENT_TYPES.length, 48, "SD §4 lists 48 event names");
    assert.equal(
      new Set<string>(EVENT_TYPES).size,
      EVENT_TYPES.length,
      "a duplicated name would silently shrink the union",
    );
  });

  it("every name is namespaced `subject.verb`, lower_snake_case", () => {
    for (const name of EVENT_TYPES) {
      assert.match(
        name,
        /^[a-z]+(?:_[a-z]+)*\.[a-z]+(?:_[a-z]+)*$/,
        `${name} does not follow the SD §4 naming shape`,
      );
    }
  });

  it("isEventType narrows catalogue names and rejects everything else", () => {
    assert.equal(isEventType("contribution.created"), true);
    // Near-misses are the realistic failure mode at a boundary.
    assert.equal(isEventType("contribution.create"), false);
    assert.equal(isEventType("Contribution.created"), false);
    assert.equal(isEventType(""), false);
    // Set membership, not property lookup — an Object prototype key is not a name.
    assert.equal(isEventType("toString"), false);
    assert.equal(isEventType("constructor"), false);
  });
});

/* -------------------------------------------------------------------------- */
/* Type-level assertions — these fail `tsc`, not `node --test`.               */
/* -------------------------------------------------------------------------- */

type Assert<T extends true> = T;
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** The transcription above covers the catalogue exactly, both directions. */
type _SpecListIsComplete = Assert<Exact<(typeof SPEC_CATALOGUE)[number], EventType>>;

/** Every catalogue name has a payload type and a subject type. */
type _PayloadsCoverCatalogue = Assert<Exact<keyof EventPayloadMap, EventType>>;
type _SubjectsCoverCatalogue = Assert<Exact<keyof EventSubjectTypeMap, EventType>>;

/** `EventInput` is a union with one member per catalogue name. */
type _UnionCoversCatalogue = Assert<Exact<EventInput["event_type"], EventType>>;

/**
 * Narrowing on `event_type` narrows the payload with it — the property that
 * makes the union worth having. `from_state` exists here only because the
 * discriminant was checked.
 */
function _narrows(event: EventInput): string | null {
  return event.event_type === "finding.state_changed" ? event.payload.from_state : null;
}

export type { _SpecListIsComplete, _PayloadsCoverCatalogue, _SubjectsCoverCatalogue, _UnionCoversCatalogue };
export { _narrows };
