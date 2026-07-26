/**
 * Request correlation id (M0-BE-15).
 *
 * JUDGMENT CALL, flagged for ratification: neither `openapi.yaml` nor
 * system-design names a correlation header. `x-request-id` is the conventional
 * one and the one every proxy already understands, so it is what we accept and
 * echo. The value ends up in three places and they always agree:
 *
 *   1. the `x-request-id` response header, on every response including errors
 *   2. `error.request_id` in the envelope (the schema makes it required)
 *   3. `request_id` on every log line (fastify's `requestIdLogLabel`)
 *
 * An inbound id is honoured so a trace started at the edge survives into our
 * logs — but only if it is safe to put back into a header and a log line. A
 * client-controlled value that reaches `setHeader` unchecked is a header
 * injection; one that reaches a JSON log line unchecked is a log-forging bug.
 * Anything that fails the pattern is silently replaced with a fresh id rather
 * than rejected: a bad trace header is not the caller's request being wrong.
 */

/**
 * Conservative on purpose: the intersection of what ULIDs, UUIDs, W3C
 * trace ids and the usual proxy formats produce. No spaces, no CR/LF, no
 * unbounded length.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/** The header we read on the way in and write on the way out. Lowercase: Node normalises. */
export const REQUEST_ID_HEADER = "x-request-id";

/** The key the id is logged under, and the field name in the error envelope. */
export const REQUEST_ID_LOG_LABEL = "request_id";

/** Returns the inbound id if it is safe to echo and to log, otherwise undefined. */
export function sanitizeRequestId(raw: string | readonly string[] | undefined): string | undefined {
  if (raw === undefined) return undefined;
  // Duplicate headers are ambiguous, not mergeable — take the first.
  const candidate = Array.isArray(raw) ? raw[0] : (raw as string);
  if (candidate === undefined) return undefined;
  return SAFE_REQUEST_ID.test(candidate) ? candidate : undefined;
}
