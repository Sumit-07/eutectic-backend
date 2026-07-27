/**
 * The cache seam for the platform-settings service (P-09, DIRECTIVE §3
 * "Cached in Redis, 60s TTL, busted on write").
 *
 * WHY AN INTERFACE DECLARED HERE RATHER THAN AN IMPORT OF `@eutectic/cache`
 * -------------------------------------------------------------------------
 * `packages/db` must never depend on `@eutectic/cache` — M0-BE-19's
 * dependency-direction rule, restated in `../entitlements.ts`'s module doc:
 * Postgres access is this package's job, and the cache is an `apps/api`
 * concern. M0-BE-18 honoured that by keeping the query here and the cached
 * wrapper in `apps/api`.
 *
 * This service cannot take that split, and the reason is the WRITE path, not
 * the read path. The bust is not an optional decoration a caller may forget:
 * DIRECTIVE §3 makes "busted on write" part of what a settings write IS, and
 * the write itself has to be here because it is one transaction with an
 * `admin_audit` append. Splitting them would mean `apps/api` remembering to
 * bust after every write — exactly the "whoever writes MUST call
 * `bustEntitlement`" hazard `../entitlements.ts` documents and accepts for a
 * value where bounded staleness is harmless. It is not harmless here:
 * `budget.daily_cents_per_agent` and `routing.coverage_target` are spend
 * controls, and an operator who lowers a ceiling and watches the old one stay
 * in force for another 60s has been lied to by the admin UI.
 *
 * So the cache is INJECTED as this three-method structural interface, and the
 * package manifest gains nothing. `@eutectic/cache`'s `NamespacedCache`
 * satisfies it structurally — `apps/api` passes `cache.namespace("settings")`
 * with no adapter — and every test here passes a fake. `packages/db` still
 * knows nothing about Redis, ioredis, or `@eutectic/cache`; it knows that
 * something can hold a value for a while, which is the only part of a cache a
 * query layer has any business knowing.
 *
 * FAIL OPEN, ALWAYS. Every method here is allowed to throw as far as this
 * interface is concerned (an injected implementation is somebody else's code),
 * and `service.ts` treats a throw exactly like a miss. A Redis outage must
 * never take settings reads down — the routing job would stop, and the
 * platform would stop. That is the ONE thing the cache is permitted to fail
 * open on; see `service.ts` for the equally firm rule that VALIDATION never
 * does.
 */

/**
 * The narrow view of a cache this module needs. Deliberately not `del`-less
 * and deliberately not `incr`-ful: three methods, each of which the service
 * actually calls.
 *
 * Return types are widened to `Promise<unknown>` on `set`/`del` so that an
 * implementation returning `boolean` (`@eutectic/cache`), `void` (a fake), or
 * anything else all satisfy it. The service ignores the value: there is no
 * useful branch on "the cache write failed", because the next read simply
 * misses.
 */
export interface SettingsCache {
  /**
   * `undefined` means "no usable value" — a true miss, an outage, or a payload
   * this codec could not parse. All three lead to the same place: read
   * Postgres.
   */
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/**
 * DIRECTIVE §3, verbatim: "Cached in Redis, 60s TTL, busted on write". The
 * number is the directive's, not a tuning knob — a test asserts the service
 * calls `set` with exactly this.
 */
export const PLATFORM_SETTINGS_CACHE_TTL_SECONDS = 60;

/**
 * ONE cache key for the WHOLE table, not one key per setting.
 *
 * The table is "seeded, admin-curated and bounded at a few dozen rows"
 * (openapi.yaml, `/admin/settings`) and DIRECTIVE §3 says it is "read once per
 * routing job, never per agent" — the access pattern is a snapshot read, not a
 * point lookup. One key makes the bust exact (a write invalidates one key, and
 * no per-key bust can be forgotten as the table grows) and makes every reader
 * see a mutually-consistent set of settings rather than a mixture of ages,
 * which matters when two knobs are changed together and the routing job reads
 * both.
 *
 * The cost — a single-key read pulls the whole snapshot — is a few dozen rows
 * of JSON, and it is the same read the caller would have made anyway.
 */
export const PLATFORM_SETTINGS_CACHE_KEY = "all";
