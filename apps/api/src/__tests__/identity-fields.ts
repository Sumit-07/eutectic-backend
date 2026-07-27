/**
 * The D-029 forbidden list, in one place. TEST SUPPORT ONLY.
 *
 * `DIRECTIVE-pre-M1.md` §5, "Forbidden outside `/v1/admin/*`":
 *
 *   github_id · github_created_at · github_public_repos · tier_would_be ·
 *   email · any GitHub-derived field
 *
 * `github_created_at` and `github_public_repos` are fingerprints — account age
 * plus repo count narrows a user to a handful of GitHub accounts. `tier` is
 * the public signal instead.
 *
 * `email` IS ON THE LIST DELIBERATELY, even though `users.email` does not
 * exist in the database (D-037 item 3). Asserting the absence of a column
 * nobody has is free, and it means the day somebody adds one, the gates say
 * so before it reaches a wire format.
 *
 * `github_login` is NOT on this list: it is a legal `PublicUser` field, opt-in
 * per user via `show_github_login`. The serializer, not the gate, is what
 * keeps it honest.
 *
 * Two consumers, one list: `github-leak-gate.test.ts` walks the contract's
 * response schemas with it, and `user-serializer.test.ts` walks the objects
 * the serializers actually produce. A field that has to get past both a
 * spec-level and a runtime-level check is hard to leak by accident.
 */

/** Exact wire names, compared case-insensitively — `github_ID` is the same leak. */
export const FORBIDDEN_IDENTITY_FIELDS: readonly string[] = [
  "github_id",
  "github_created_at",
  "github_public_repos",
  "tier_would_be",
  "email",
];

const FORBIDDEN_LOOKUP: ReadonlySet<string> = new Set(
  FORBIDDEN_IDENTITY_FIELDS.map((field) => field.toLowerCase()),
);

export function isForbiddenIdentityField(name: string): boolean {
  return FORBIDDEN_LOOKUP.has(name.trim().toLowerCase());
}

export interface ForbiddenKeyHit {
  readonly field: string;
  /** Dotted path to the offending key, from the root of the value scanned. */
  readonly location: string;
}

/**
 * Every forbidden KEY anywhere in a plain JS value — objects, arrays, any
 * depth. Used against serializer output (and against contract examples, which
 * are data, not schemas). Deliberately structural: it does not care what the
 * value is, only that the key exists, because an explicit `github_id: null` is
 * as much of a leak as a populated one — it confirms the field is real.
 */
export function forbiddenKeysIn(value: unknown, path = "$"): ForbiddenKeyHit[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => forbiddenKeysIn(item, `${path}[${index}]`));
  }
  if (typeof value !== "object" || value === null) return [];
  const hits: ForbiddenKeyHit[] = [];
  for (const [key, child] of Object.entries(value)) {
    const here = `${path}.${key}`;
    if (isForbiddenIdentityField(key)) hits.push({ field: key, location: here });
    hits.push(...forbiddenKeysIn(child, here));
  }
  return hits;
}
