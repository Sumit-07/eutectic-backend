/**
 * Session RESOLUTION (P-09, D-011, system-design §11).
 *
 * Resolution only — reading an existing cookie and answering "whose session is
 * this, if anyone's". Session CREATION (the OAuth exchange that mints the
 * token, sets the cookie and inserts the row) belongs to the GitHub auth
 * ticket. This module is what the admin gate needs and no more, so that P-09
 * does not quietly become the auth ticket.
 *
 * THE RAW TOKEN NEVER LEAVES THIS MODULE'S ARGUMENT LIST. It is not logged,
 * not put in an error message, not stored, and not returned. Only its hash is
 * compared, and `sessions.token_hash` is the only form that ever reaches
 * Postgres (M0-BE-02: "opaque token hash, not JWT"; the column is spelled
 * `token_hash` for exactly this reason). Every function below that takes a
 * token takes it and gives back either a hash or an id — there is no path from
 * a token to a string a human ever reads.
 *
 * THE HASH IS SHA-256, AND THAT IS A JUDGMENT CALL RECORDED HERE. `DECISIONS`
 * and system-design §11 both specify that the token is opaque and stored
 * hashed; neither names an algorithm (§11 is payments and entitlement; D-011
 * settles `agents.ink`, and mentions the sessions shape only as "opaque token
 * hash, not JWT"). SHA-256 is the right default for this specific job and not
 * merely the familiar one: the input is a 256-bit value THIS SERVER generated
 * from a CSPRNG, not a human-chosen password, so there is no dictionary to
 * attack and the slow-KDF argument (bcrypt/argon2) buys nothing while costing
 * a hash on every authenticated request. A stolen `token_hash` still cannot be
 * reversed into a usable cookie. If the token generator ever becomes anything
 * other than high-entropy random, this choice must be revisited — which is why
 * it is written down rather than assumed.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import type { ISql } from "@eutectic/db";

/**
 * The cookie name, from the contract: `securitySchemes.sessionCookie` is an
 * `apiKey` in a cookie named `eutectic_session`. Spelled once, here.
 */
export const SESSION_COOKIE_NAME = "eutectic_session";

/**
 * The stored form of a session token. Hex SHA-256.
 *
 * @param token the raw opaque token from the cookie. Never logged, never
 *        returned, never stored — see the module doc.
 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * The value of one cookie out of a raw `Cookie` header, or `null`.
 *
 * PARSED BY HAND, WITHOUT `@fastify/cookie`, because adding a dependency needs
 * Fable's approval (CLAUDE.md rule 12) and this ticket needs to read exactly
 * one cookie whose value is a token this server generated. The parsing rules
 * that matter are small and are all implemented: `;` separates pairs, the
 * FIRST `=` separates name from value (a base64 token can contain `=`),
 * surrounding whitespace is insignificant, and a quoted value is unwrapped
 * (RFC 6265 permits `name="value"`). Percent-decoding is deliberately NOT
 * performed: this server sets the cookie and will not URL-encode a token, and
 * decoding attacker-controlled input here would only widen what a token is
 * allowed to look like.
 *
 * Returns `null` for absent, empty, or malformed — every one of which means
 * the same thing to the caller: no session.
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined || header.length === 0) return null;

  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;

    const cookieName = pair.slice(0, separator).trim();
    if (cookieName !== name) continue;

    let value = pair.slice(separator + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    return value.length === 0 ? null : value;
  }
  return null;
}

/** The `sessions` columns this module reads. */
interface SessionRowSql {
  user_id: string;
  token_hash: string;
}

/**
 * The user id behind a raw session token, or `null`.
 *
 * `null` covers every failure identically and on purpose — no cookie, an
 * unknown token, an EXPIRED session, a REVOKED session. A caller that could
 * tell "expired" from "never existed" would be an oracle for whether a stolen
 * token was ever real; the gate above only ever needs "yes, this user" or
 * "no", and `401` is the same answer to all of them.
 *
 * `now` IS EXPLICIT (D-014). Expiry is a comparison against a caller-supplied
 * instant rather than SQL `now()`, so a test can put a session an hour into
 * the past without waiting an hour, and so the whole request agrees on one
 * clock reading.
 *
 * The `expires_at`/`revoked_at` predicates are in the WHERE clause rather than
 * checked in JS after the fact: a row that must not authenticate anybody
 * should not be selected at all, and a future edit that drops the JS check
 * would be much easier to miss than one that edits the SQL.
 */
export async function resolveSession(
  sql: ISql,
  token: string,
  now: Date,
): Promise<string | null> {
  const tokenHash = hashSessionToken(token);

  const rows = await sql<SessionRowSql[]>`
    SELECT user_id, token_hash
    FROM sessions
    WHERE token_hash = ${tokenHash}
      AND expires_at > ${now}
      AND revoked_at IS NULL
  `;

  const row = rows[0];
  if (row === undefined) return null;

  // Belt and braces: the WHERE clause already matched on equality, and the
  // column is UNIQUE, so this can only fail if the driver hands back a row it
  // was not asked for. Comparing in constant time costs nothing at one row and
  // means the last comparison in the chain is not a `===` on secret-derived
  // material.
  if (!equalsConstantTime(row.token_hash, tokenHash)) return null;

  return row.user_id;
}

function equalsConstantTime(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // `timingSafeEqual` throws on a length mismatch, which would itself leak the
  // length; both sides here are fixed-width hex, so a mismatch is structural.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
