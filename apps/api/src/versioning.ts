/**
 * Media-type versioning (system-design §2, openapi.yaml `info.description`).
 *
 * "Every response body is served under `application/vnd.staffroom.v1+json`.
 *  Clients MUST send `Accept: application/vnd.staffroom.v1+json` on every
 *  request; a request that asks for a version the server does not serve gets
 *  `406`."
 *
 * The version lives in the media type and NOT in a route prefix that means
 * something — `/v1` is the server base path from `openapi.yaml#/servers`, and
 * it stays fixed while the media type is what actually negotiates. That is
 * why the check below is strict about the token and indifferent to the path.
 */

import { API_MEDIA_TYPE } from "@eutectic/contracts";

export { API_MEDIA_TYPE };

/**
 * The base path every contract route hangs off, from `openapi.yaml#/servers`
 * (`http://127.0.0.1:4000/v1`). Routes in `ROUTES` are relative to it.
 */
export const API_PREFIX = "/v1";

/**
 * Does this `Accept` explicitly ask for the version we serve?
 *
 * Deliberately strict, and this is the one judgment call in this module:
 *
 * - absent `Accept`  → false
 * - `*​/*` or `application/*` → false
 * - `application/json` → false
 * - the exact media type, with or without parameters → true, unless `q=0`
 *
 * HTTP would let `*​/*` match. We refuse it because the whole point of putting
 * the version in the media type is that a client states which version it can
 * parse: a wildcard client silently receives v1 forever and breaks on the day
 * v2 ships, which is exactly the failure the header exists to prevent. The
 * cost is that a bare `curl` gets a `406` — a legible one, with the header it
 * needs in the message.
 */
export function acceptsApiMediaType(header: string | readonly string[] | undefined): boolean {
  if (header === undefined) return false;
  const raw = Array.isArray(header) ? header.join(",") : (header as string);

  for (const entry of raw.split(",")) {
    const parts = entry.split(";");
    const range = parts[0]?.trim().toLowerCase();
    if (range !== API_MEDIA_TYPE) continue;
    if (quality(parts.slice(1)) === 0) continue;
    return true;
  }
  return false;
}

/** `q` from the media-range parameters; 1 when absent or unparseable. */
function quality(parameters: readonly string[]): number {
  for (const parameter of parameters) {
    const [name, value] = parameter.split("=");
    if (name?.trim().toLowerCase() !== "q") continue;
    const parsed = Number.parseFloat(value ?? "");
    return Number.isNaN(parsed) ? 1 : parsed;
  }
  return 1;
}
