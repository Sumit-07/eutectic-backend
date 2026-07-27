/**
 * The banned-phrase list behind the mechanical rejection of a generic
 * `self_check.specific_criticism` (D-031, DIRECTIVE-pre-M1 §6).
 *
 * ─── PROVENANCE, AND A GAP THE REVIEWER MUST SEE ────────────────────────────
 *
 * The directive says: "Maintain the banned-phrase list from
 * `testing-and-evals.md` §5 Layer 2 alongside it."
 *
 * **`docs/testing-and-evals.md` DOES NOT EXIST in eutectic-shared.** It is
 * referenced twice by `DIRECTIVE-pre-M1.md` (§6 for this list, §10 for the
 * Layer 5 similarity metric) and by nothing else in any of the three repos.
 * P-05-BE therefore ships the MECHANISM with a deliberately conservative SEED
 * list, not the real Layer 2 vocabulary.
 *
 * That split is on purpose, and it is the reason this file is data:
 *
 *   - The mechanism — normalisation, the three match modes, where the gate
 *     sits in the pipeline — is engineering, and it is finished.
 *   - The list itself is TASTE, and CLAUDE.md §11 reserves the quality-gate
 *     vocabulary to the human. Growing `BANNED_PHRASES` is a data edit: no
 *     structural change, no new match mode, no validator change.
 *
 * The seed below is scoped to two classes that require no taste to call:
 *
 *   NULL ANSWER        the criticism is a placeholder standing in for the
 *                      absence of one ("n/a", "none", "nothing to add").
 *                      Semantically the empty string with characters in it.
 *   ASSISTANT VOICE    chat-assistant boilerplate that cannot be part of any
 *                      falsifiable claim about a post ("as an AI", "hope this
 *                      helps"), plus the conversational openers that mark a
 *                      turn as pleasantry rather than critique.
 *
 * It contains NO judgement about writing quality — no "this could be better",
 * no "the market is competitive". Those are exactly the calls that belong to
 * whoever writes `testing-and-evals.md` §5, and adding them here would be an
 * implementer quietly authoring the quality gate.
 *
 * ─── MATCHING RULES (the ruling, since the source doc could not supply it) ──
 *
 * Normalisation, applied once to the candidate before any comparison:
 *
 *   1. Unicode NFKC — a fullwidth or compatibility form must not evade a
 *      literal ASCII phrase.
 *   2. Curly quotes and dashes folded to ASCII (`’`→`'`, `—`/`–`→`-`), so
 *      "That's a great question" and "That’s a great question" match alike.
 *   3. Lowercased. **Matching is case-INSENSITIVE**: "Great Question" and
 *      "GREAT QUESTION" are the same slop as "great question".
 *   4. Whitespace of any kind collapsed to single spaces, then trimmed — a
 *      newline between two words must not hide a phrase.
 *   5. Leading and trailing punctuation stripped, so a phrase that IS the
 *      whole answer still matches when it ends in "." or "!" or is wrapped
 *      in quotes.
 *
 * Then, per entry, one of three modes:
 *
 *   `exact`     the whole normalised criticism equals the phrase. For null
 *               answers, where the phrase is the entire non-answer.
 *   `prefix`    the criticism STARTS with the phrase, at a word boundary.
 *               For conversational openers, which are only slop when they
 *               lead — see the false-positive note below.
 *   `contains`  the phrase appears anywhere, bounded by non-word characters
 *               on both sides. Reserved for strings that cannot occur inside
 *               a genuine falsifiable claim.
 *
 * "Word boundary" means the character before and after the match is not a
 * letter or a digit. That is what stops "unclear" from matching "clear" and
 * "nano" from matching "n/a"-adjacent noise.
 *
 * ─── WHY `prefix` AND NOT `contains` FOR THE OPENERS ────────────────────────
 *
 * A mechanical rejection costs a retry, and three of them cost a decline
 * (rule 7) on a contribution that may have been fine. False positives are
 * therefore expensive, and `contains` is where they come from:
 *
 *     "Their pricing makes sense only if churn stays under 3%, which the
 *      post never measures."
 *
 * That is a specific, falsifiable criticism that contains "makes sense".
 * Under `contains` it would be rejected; under `prefix` it is not, and the
 * pleasantry it was meant to catch — "Makes sense, but I'd push back a
 * little" — still is. Same reasoning for "good point", "it depends", "in my
 * opinion". Only phrases with no legitimate mid-sentence use ("as an AI")
 * get `contains`.
 *
 * A phrase promoted from `prefix` to `contains` should come with the sentence
 * that justifies it, in this file, next to the entry.
 */

/** How an entry is compared to the normalised candidate. */
export type BannedPhraseMatch = "exact" | "prefix" | "contains";

export interface BannedPhrase {
  /** Already normalised: lowercase, single-spaced, no edge punctuation. */
  readonly phrase: string;
  readonly match: BannedPhraseMatch;
  /** Which seed class this came from — carried into the rejection detail. */
  readonly note: string;
}

/**
 * SEED LIST — grows as data. See the provenance block above before adding:
 * a judgement about writing quality does not belong here until
 * `testing-and-evals.md` §5 exists to justify it.
 */
export const BANNED_PHRASES: readonly BannedPhrase[] = [
  // ── Null answers. The whole criticism is a placeholder for not having one.
  { phrase: "n/a", match: "exact", note: "null answer" },
  { phrase: "na", match: "exact", note: "null answer" },
  { phrase: "none", match: "exact", note: "null answer" },
  { phrase: "nothing", match: "exact", note: "null answer" },
  { phrase: "nothing specific", match: "exact", note: "null answer" },
  { phrase: "nothing to add", match: "exact", note: "null answer" },
  { phrase: "no criticism", match: "exact", note: "null answer" },
  { phrase: "no specific criticism", match: "exact", note: "null answer" },
  { phrase: "no comment", match: "exact", note: "null answer" },
  { phrase: "no notes", match: "exact", note: "null answer" },
  { phrase: "no issues", match: "exact", note: "null answer" },
  { phrase: "not applicable", match: "exact", note: "null answer" },
  { phrase: "unknown", match: "exact", note: "null answer" },
  { phrase: "tbd", match: "exact", note: "null answer" },
  { phrase: "todo", match: "exact", note: "null answer" },

  // ── Assistant voice. Cannot appear inside a falsifiable claim about a post.
  { phrase: "as an ai", match: "contains", note: "assistant voice" },
  { phrase: "as a language model", match: "contains", note: "assistant voice" },
  { phrase: "i hope this helps", match: "contains", note: "assistant voice" },
  { phrase: "hope that helps", match: "contains", note: "assistant voice" },
  { phrase: "let me know if you", match: "contains", note: "assistant voice" },
  { phrase: "i cannot provide", match: "contains", note: "assistant voice" },
  { phrase: "i am unable to", match: "contains", note: "assistant voice" },

  // ── Conversational openers. Slop when they lead, fine mid-sentence.
  { phrase: "great question", match: "prefix", note: "conversational opener" },
  { phrase: "good question", match: "prefix", note: "conversational opener" },
  { phrase: "great point", match: "prefix", note: "conversational opener" },
  { phrase: "good point", match: "prefix", note: "conversational opener" },
  { phrase: "fair point", match: "prefix", note: "conversational opener" },
  { phrase: "interesting point", match: "prefix", note: "conversational opener" },
  { phrase: "food for thought", match: "prefix", note: "conversational opener" },
  { phrase: "in my opinion", match: "prefix", note: "conversational opener" },
  { phrase: "it depends", match: "prefix", note: "conversational opener" },
  { phrase: "makes sense", match: "prefix", note: "conversational opener" },
];

/** Anything the edge-strip may remove. Not `\W`: that would eat accents. */
const EDGE_PUNCTUATION = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/** Curly punctuation the model may emit where a phrase spells ASCII. */
const QUOTE_FOLDING: readonly (readonly [RegExp, string])[] = [
  [/[‘’‛]/gu, "'"], // left/right/reversed single quote
  [/[“”‟]/gu, '"'], // left/right/reversed double quote
  [/[‐-―]/gu, "-"], // hyphen, non-breaking hyphen, figure/en/em/bar dash
];

/**
 * The one normalisation every comparison goes through. Exported because the
 * tests assert it directly and because a caller logging a rejection wants to
 * show what was actually compared, not the raw string.
 */
export function normalisePhrase(value: string): string {
  let normalised = value.normalize("NFKC");
  for (const [pattern, replacement] of QUOTE_FOLDING) {
    normalised = normalised.replace(pattern, replacement);
  }
  return normalised
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim()
    .replace(EDGE_PUNCTUATION, "");
}

/** True when `char` would continue a word — the boundary test's negation. */
function isWordCharacter(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}]/u.test(char);
}

/** A match at `index` whose neighbours are both non-word characters. */
function matchesAtWordBoundary(candidate: string, phrase: string, index: number): boolean {
  if (isWordCharacter(candidate[index - 1])) return false;
  return !isWordCharacter(candidate[index + phrase.length]);
}

function hits(candidate: string, entry: BannedPhrase): boolean {
  switch (entry.match) {
    case "exact":
      return candidate === entry.phrase;
    case "prefix":
      return candidate.startsWith(entry.phrase) && matchesAtWordBoundary(candidate, entry.phrase, 0);
    case "contains": {
      let index = candidate.indexOf(entry.phrase);
      while (index !== -1) {
        if (matchesAtWordBoundary(candidate, entry.phrase, index)) return true;
        index = candidate.indexOf(entry.phrase, index + 1);
      }
      return false;
    }
  }
}

/**
 * The first banned phrase `value` hits, or `undefined`. First rather than all:
 * the caller needs one precise thing to log and to put in a retry prompt, and
 * list order is stable, so the answer is deterministic.
 *
 * Callers must handle empty/whitespace input themselves — a criticism that
 * normalises to "" is a DIFFERENT rejection (`self_check_empty`, not
 * `self_check_generic`) and this function returns `undefined` for it rather
 * than pretending an empty string matched a phrase.
 */
export function findBannedPhrase(value: string): BannedPhrase | undefined {
  const candidate = normalisePhrase(value);
  if (candidate.length === 0) return undefined;
  return BANNED_PHRASES.find((entry) => hits(candidate, entry));
}
