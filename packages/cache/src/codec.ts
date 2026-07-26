/**
 * The JSON codec every typed helper in this package uses.
 *
 * One rule: a value that does not round-trip through `JSON.stringify` /
 * `JSON.parse` cleanly is treated as absent, never as a thrown error. That
 * covers two distinct situations the same way, on purpose:
 *
 *   - a value some OTHER writer (a different app version, a manual `redis-cli
 *     SET`) put under this key in a shape this codec cannot parse
 *   - a value truncated or corrupted in flight
 *
 * Both are "this key is not usable cache data" and the loss-tolerance
 * invariant (D-001, system-design §3 — a cache miss, never a crash) applies
 * to a corrupt read exactly as it applies to Redis being down.
 */

/** `undefined` means "could not encode" — callers turn that into "not stored". */
export function encode<T>(value: T): string | undefined {
  try {
    const json = JSON.stringify(value);
    // `JSON.stringify(undefined)` returns `undefined`, not a string — the
    // caller passed a value that has no JSON representation at all (a bare
    // `undefined`, a function, a symbol). There is nothing to store.
    if (json === undefined) return undefined;
    return json;
  } catch {
    // Circular structures and bigints throw here. Same outcome: nothing to
    // store, never a throw out of this module.
    return undefined;
  }
}

/** `undefined` means "not usable" — a miss, whether the key was absent or the value was junk. */
export function decode<T>(raw: string | null): T | undefined {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}
