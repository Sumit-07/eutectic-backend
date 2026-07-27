/**
 * The banned-phrase MECHANISM behind the mechanical rejection of a generic
 * `self_check.specific_criticism` (D-031, DIRECTIVE-pre-M1 §6).
 *
 * ─── WIRED, AND EMPTY ON PURPOSE (D-042 item 2) ─────────────────────────────
 *
 * The directive says: "Maintain the banned-phrase list from
 * `testing-and-evals.md` §5 Layer 2 alongside it."
 *
 * **`docs/testing-and-evals.md` does not exist.** P-05-BE flagged this; Fable
 * ruled on it in D-042 item 2 (shared develop @ c708921):
 *
 *     "The banned-phrase list the directive cites (§5 Layer 2) is eval taste
 *      — human-owned under CLAUDE.md §11, same class as M1-HU-02. Interim
 *      rule: any Layer-2 phrase check ships wired but EMPTY (list read from a
 *      data file, zero entries), and nothing may hard-code an invented list.
 *      Added to the missing-inputs list for Sumit."
 *
 * So the split is now policy, not preference:
 *
 *   MECHANISM (this file)   normalisation, the three match modes, the word
 *                           boundary rule, where the gate sits in the
 *                           pipeline. Engineering. Finished and fully tested.
 *   VOCABULARY (the data)   which phrases are slop. Taste. Human-owned, and
 *                           an earlier draft of this file that seeded it with
 *                           an implementer's guesses was removed under D-042.
 *
 * The list is read from `data/banned-phrases.json`, which ships with ZERO
 * entries. Populating it is a data edit with no code change — that property is
 * the point of the ruling and the tests below pin it.
 *
 * ─── CONSEQUENCE THE REVIEWER MUST SEE ──────────────────────────────────────
 *
 * Until the human authors §5 Layer 2, the `self_check_generic` rejection code
 * is UNREACHABLE IN PRODUCTION. It is deliberately kept — reserved, exported,
 * documented and exercised by tests through an injected list — because the
 * day the vocabulary lands it must start firing without a release. The
 * `self_check_empty` code is unaffected: a whitespace-only criticism is caught
 * by normalisation, owes nothing to the phrase list, and works today.
 *
 * ─── MATCHING RULES (mechanism, not vocabulary) ─────────────────────────────
 *
 * These are rulings about HOW a phrase is compared, and they will govern the
 * human's list when it arrives. They imply nothing about which phrases belong.
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
 * letter or a digit. That is what stops `contains` firing on a substring
 * buried inside a longer word.
 *
 * ─── WHY THREE MODES AND NOT JUST `contains` ────────────────────────────────
 *
 * A mechanical rejection costs a retry, and three cost a decline (rule 7) on a
 * contribution that may have been fine. False positives are therefore
 * expensive, and `contains` is where they come from:
 *
 *     "Their pricing makes sense only if churn stays under 3%, which the
 *      post never measures."
 *
 * That is a specific, falsifiable criticism containing "makes sense". Under
 * `contains` it is rejected; under `prefix` it is not, while the pleasantry
 * the entry was meant to catch — "Makes sense, but I'd push back a little" —
 * still is. Whoever writes §5 Layer 2 chooses a mode per phrase, and the rule
 * of thumb is: `contains` only for strings with no legitimate mid-sentence
 * use. A phrase given `contains` should arrive with the sentence justifying
 * it. The false-positive suite in the tests guards this property against an
 * injected list, and will guard the real one unchanged.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * How an entry is compared to the normalised candidate. This IS a closed set —
 * it is mechanism, and a fourth mode would be code, not data. Contrast
 * `claim_type` (D-039 ruling 4), which is vocabulary and stays open.
 */
export const BANNED_PHRASE_MATCHES = ["exact", "prefix", "contains"] as const;

export type BannedPhraseMatch = (typeof BANNED_PHRASE_MATCHES)[number];

export interface BannedPhrase {
  /** Already normalised: lowercase, single-spaced, no edge punctuation. */
  readonly phrase: string;
  readonly match: BannedPhraseMatch;
  /** Why this phrase is slop — carried into the rejection detail. */
  readonly note: string;
}

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
 * The first phrase in `phrases` that `value` hits, or `undefined`. First rather
 * than all: the caller needs one precise thing to log and to put in a retry
 * prompt, and list order is stable, so the answer is deterministic.
 *
 * The list is a PARAMETER, not a module-level lookup. D-042 item 2 requires
 * that the shipped vocabulary be empty, which would make this function
 * untestable if it read the production list itself; injection lets the tests
 * exercise the mechanism against a clearly-marked fixture while production
 * passes `BANNED_PHRASES` and gets today's answer, which is always
 * `undefined`. There is deliberately no default value: an implicit empty list
 * would let a call site silently opt out of a gate it thought it had.
 *
 * Callers must handle empty/whitespace input themselves — a criticism that
 * normalises to "" is a DIFFERENT rejection (`self_check_empty`, not
 * `self_check_generic`) and this function returns `undefined` for it rather
 * than pretending an empty string matched a phrase.
 */
export function findBannedPhrase(
  value: string,
  phrases: readonly BannedPhrase[],
): BannedPhrase | undefined {
  const candidate = normalisePhrase(value);
  if (candidate.length === 0) return undefined;
  return phrases.find((entry) => hits(candidate, entry));
}

/** Every rejection of the data file is thrown as this, never returned. */
export class BannedPhraseFileError extends Error {
  override readonly name = "BannedPhraseFileError";
}

function fail(origin: string, detail: string): never {
  throw new BannedPhraseFileError(`${origin}: ${detail}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  container: Record<string, unknown>,
  key: string,
  origin: string,
  where: string,
): string {
  const value = container[key];
  if (typeof value !== "string") {
    fail(origin, `${where} \`${key}\` must be a string; got ${value === undefined ? "nothing" : typeof value}.`);
  }
  return value;
}

function requireOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  origin: string,
  where: string,
): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      fail(origin, `${where} carries unknown key \`${key}\`; expected only ${keys.join(", ")}.`);
    }
  }
}

/**
 * Parse and validate the data file's text. Exported so the tests can exercise
 * every malformed shape without touching the filesystem.
 *
 * FAILS LOUDLY, by throwing. A phrase list that silently degrades to empty
 * because a comma was misplaced is the worst outcome available: the gate would
 * appear to be running and would pass everything. A boot-time crash naming the
 * file and the fault is strictly better than a quality gate that is off and
 * says nothing.
 */
export function parseBannedPhraseFile(text: string, origin: string): readonly BannedPhrase[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(origin, `not valid JSON: ${message}`);
  }

  if (!isPlainObject(parsed)) {
    fail(origin, "must be a JSON object with `source` and `phrases`.");
  }
  requireOnlyKeys(parsed, ["source", "phrases"], origin, "the file");

  // `source` is required even while empty-listed: it is where the human records
  // WHICH section of the eval doc the vocabulary came from, and a list with no
  // stated provenance is exactly what D-042 item 2 forbids.
  requireString(parsed, "source", origin, "the file's");

  const phrases = parsed["phrases"];
  if (!Array.isArray(phrases)) {
    fail(origin, `\`phrases\` must be an array; got ${phrases === undefined ? "nothing" : typeof phrases}.`);
  }

  const seen = new Set<string>();
  const entries: BannedPhrase[] = [];

  for (const [index, raw] of phrases.entries()) {
    const where = `phrases[${index}]`;
    if (!isPlainObject(raw)) {
      fail(origin, `${where} must be an object; got ${raw === null ? "null" : typeof raw}.`);
    }
    requireOnlyKeys(raw, ["phrase", "match", "note"], origin, where);

    const phrase = requireString(raw, "phrase", origin, `${where}'s`);
    if (phrase.length === 0) {
      fail(origin, `${where} has an empty \`phrase\`.`);
    }
    // An entry not in normal form can never match, because the candidate always
    // is. A silent no-op entry is worse than no entry, so it is a hard error
    // rather than a normalise-on-load, which would hide the author's typo.
    if (normalisePhrase(phrase) !== phrase) {
      fail(
        origin,
        `${where} \`${phrase}\` is not in normal form — write it as \`${normalisePhrase(phrase)}\` (lowercase, single-spaced, no edge punctuation).`,
      );
    }
    if (seen.has(phrase)) {
      fail(origin, `${where} repeats \`${phrase}\`; the later entry could never be reached.`);
    }
    seen.add(phrase);

    const match = requireString(raw, "match", origin, `${where}'s`);
    if (!(BANNED_PHRASE_MATCHES as readonly string[]).includes(match)) {
      fail(origin, `${where} has match \`${match}\`; expected one of ${BANNED_PHRASE_MATCHES.join(", ")}.`);
    }

    const note = requireString(raw, "note", origin, `${where}'s`);
    if (note.trim().length === 0) {
      fail(origin, `${where} has an empty \`note\`; say why the phrase is slop.`);
    }

    entries.push({ phrase, match: match as BannedPhraseMatch, note });
  }

  return entries;
}

/**
 * The data file. Two directories above this module in both `src/` and `dist/`,
 * which is why it lives at the package root rather than beside the source: the
 * one relative path is correct before and after the build, with no copy step.
 */
export const BANNED_PHRASE_FILE_URL = new URL("../../data/banned-phrases.json", import.meta.url);

/**
 * The shipped vocabulary, read and validated once at module load.
 *
 * **It has zero entries today** (D-042 item 2) and `self_check_generic` is
 * therefore unreachable in production. Do not add entries here in code — this
 * const has no literal to edit, by design.
 */
export const BANNED_PHRASES: readonly BannedPhrase[] = parseBannedPhraseFile(
  readFileSync(BANNED_PHRASE_FILE_URL, "utf8"),
  fileURLToPath(BANNED_PHRASE_FILE_URL),
);
