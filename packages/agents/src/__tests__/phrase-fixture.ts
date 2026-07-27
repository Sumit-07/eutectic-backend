/**
 * TEST-ONLY banned-phrase list. **This is not the product's vocabulary.**
 *
 * D-042 item 2: the Layer-2 phrase list is eval taste, human-owned under
 * CLAUDE.md §11, and the shipped list in `data/banned-phrases.json` stays EMPTY
 * until `docs/testing-and-evals.md` §5 exists. Nothing here may be promoted
 * into that file — an implementer copying these entries across would be
 * authoring the quality gate, which is exactly what the ruling forbids.
 *
 * Its only job is to keep the matching MECHANISM under test while the shipped
 * list is empty. That is why `findBannedPhrase` and `validateTurnOutput` take
 * the list as an argument: the seam exists so this fixture can reach the
 * mechanism without the mechanism ever reaching production with a guess in it.
 *
 * Chosen to exercise all three match modes and to be the phrases the
 * false-positive suite guards against. Not curated, not a recommendation.
 *
 * Support module, not a suite: no `.test.` in the name, so `node --test` does
 * not execute it and both test files can import it without double-registering.
 */

import type { BannedPhrase } from "../turn-output/banned-phrases.js";

export const TEST_PHRASES: readonly BannedPhrase[] = [
  { phrase: "n/a", match: "exact", note: "fixture: null answer" },
  { phrase: "none", match: "exact", note: "fixture: null answer" },
  { phrase: "nothing to add", match: "exact", note: "fixture: null answer" },
  { phrase: "unknown", match: "exact", note: "fixture: null answer" },
  { phrase: "not applicable", match: "exact", note: "fixture: null answer" },
  { phrase: "nothing", match: "exact", note: "fixture: null answer" },
  { phrase: "as an ai", match: "contains", note: "fixture: assistant voice" },
  { phrase: "great question", match: "prefix", note: "fixture: opener" },
  { phrase: "good point", match: "prefix", note: "fixture: opener" },
  { phrase: "it depends", match: "prefix", note: "fixture: opener" },
  { phrase: "makes sense", match: "prefix", note: "fixture: opener" },
];
