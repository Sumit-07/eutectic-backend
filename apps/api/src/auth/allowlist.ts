/**
 * The admin allowlist (P-09, DIRECTIVE §3).
 *
 * "Admin access is an env-var allowlist of user ids. No admin role in the
 * database, no admin UI for granting admin" — the directive's own scope, and
 * the reason this file is twenty lines of parsing rather than a permissions
 * model. Granting admin is a deploy, which is a change with a reviewer and an
 * audit trail attached, and that is the property worth having at this size.
 *
 * THREE FAIL-CLOSED BEHAVIOURS, all of them deliberate:
 *
 *   1. UNSET or EMPTY denies EVERYTHING. There is no "no allowlist configured,
 *      so let anyone in" branch and there never will be. The failure mode of a
 *      forgotten env var must be "the admin routes 403 and someone notices",
 *      not "the settings that control spend are open to every logged-in user".
 *   2. A MALFORMED ENTRY IS A BOOT-TIME ERROR, not a skipped entry. Silently
 *      dropping `ADMIN_USER_IDS=<uuid>,<typo>` would leave a deployment where
 *      one of two admins works and nobody finds out until the other one tries
 *      at 3am. Refusing to start is loud, immediate, and fixable in one deploy.
 *   3. PARSED ONCE, AT BOOT. Not per request — a per-request read would let a
 *      malformed value fail as a `500` on a live route instead of at startup,
 *      and would make "who is an admin" vary between two requests of the same
 *      deployment.
 *
 * The list holds `users.id` values, not handles: a handle can be changed by
 * its owner (P-08), and an identifier that its subject can edit is not an
 * identifier a permission may hang from.
 */

/** The env var. Comma-separated `users.id` UUIDs. Spelled once, here. */
export const ADMIN_USER_IDS_ENV = "ADMIN_USER_IDS";

/**
 * RFC 4122 canonical form, lowercase or upper, any version. Deliberately
 * stricter than "36 characters with dashes": the whole point of validating is
 * to catch a truncated paste or a handle typed where an id belongs.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Thrown at boot. Named so a start-up failure reads as configuration, not as a crash. */
export class AdminAllowlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminAllowlistError";
  }
}

/**
 * Parse the allowlist from a raw env value.
 *
 * Ids are lowercased so that a differently-cased paste of the same UUID is the
 * same admin — Postgres renders `uuid` lowercase, so the ids this is compared
 * against are always lowercase, and a config file written in upper case must
 * not silently grant nobody.
 *
 * @throws {AdminAllowlistError} on any entry that is not a UUID.
 */
export function parseAdminAllowlist(raw: string | undefined): ReadonlySet<string> {
  if (raw === undefined) return new Set();

  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    // Empty segments are trailing/duplicate commas, not typos: `a,b,` and
    // `a,,b` are formatting, and rejecting them would fail a deploy over
    // whitespace. A non-empty entry that is not a UUID is a different thing —
    // somebody meant something by it and got it wrong.
    .filter((entry) => entry.length > 0);

  const malformed = entries.filter((entry) => !UUID_PATTERN.test(entry));
  if (malformed.length > 0) {
    // The offending values are echoed because they are configuration, not
    // secrets — a user id is in every admin URL — and because "one of your
    // entries is wrong" is not an actionable error message.
    throw new AdminAllowlistError(
      `${ADMIN_USER_IDS_ENV} contains ${malformed.length} entr${malformed.length === 1 ? "y" : "ies"} ` +
        `that are not user ids: ${malformed.map((entry) => JSON.stringify(entry)).join(", ")}`,
    );
  }

  return new Set(entries.map((entry) => entry.toLowerCase()));
}

/**
 * The allowlist for this process, read from `process.env`.
 *
 * Call once, at boot, and hand the result to `buildApp`. See the module doc on
 * why this is not a per-request read.
 */
export function adminAllowlistFromEnv(
  env: Record<string, string | undefined> = process.env,
): ReadonlySet<string> {
  return parseAdminAllowlist(env[ADMIN_USER_IDS_ENV]);
}

/** Whether a user id is on the list. Case-insensitive, for the reason above. */
export function isAllowlistedAdmin(allowlist: ReadonlySet<string>, userId: string): boolean {
  return allowlist.has(userId.toLowerCase());
}
