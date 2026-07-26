/**
 * Environment access for @eutectic/cache.
 *
 * Deliberately the opposite shape of `@eutectic/db`'s `requireDatabaseUrl`.
 * Postgres is the system of record (system-design §3) — a missing
 * `DATABASE_URL` throws, loudly, before anything is attempted. Redis is
 * cache-only (D-001): a missing or wrong `REDIS_URL` must NOT stop a process
 * from starting. Every helper in this package already turns "Redis is
 * unreachable" into a miss / not-stored signal, so the one thing this
 * function must never do is throw.
 *
 * When unset, the dev default `redis://localhost:6380` is used — the address
 * `docker-compose.yml` and `.env.example` document for the `eutectic-redis`
 * container. In an environment where that default is simply wrong (staging,
 * CI without Redis), the client fails to connect and every helper degrades to
 * a miss — which the loss-tolerance invariant makes SAFE, not silently
 * incorrect, unlike defaulting a Postgres URL would be.
 */
export function readRedisUrl(): string {
  const url = process.env["REDIS_URL"];
  if (url === undefined || url.trim() === "") return "redis://localhost:6380";
  return url;
}
