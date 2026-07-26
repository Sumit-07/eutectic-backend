/**
 * `/healthz` and `/readyz` (M0-BE-20, system-design §13).
 *
 * Deliberately OUTSIDE `/v1` and outside `openapi.yaml`: these answer "is the
 * process alive" / "can it serve traffic," not "what does this API do" — an
 * orchestrator's liveness/readiness probe, not a client-facing operation.
 * `route-drift.test.ts`'s allowlist names exactly these two paths for exactly
 * this reason; nothing else may use that exemption. Because neither route is
 * registered with a contract `operationId`, `app.ts`'s Accept-negotiation hook
 * already skips them (`config?.operationId === undefined` — see that hook) —
 * a plain `curl localhost:4000/healthz` with no `Accept` header at all gets a
 * `200`, which is the point of a liveness probe.
 *
 * RESPONSE SHAPE (not contract-governed; documented here since it is the only
 * place a caller can learn it):
 *
 *   GET /healthz  -> 200 always, while the process is serving at all.
 *     { "status": "ok" }
 *
 *   GET /readyz   -> 200 { "status": "ready" | "degraded", "checks": {...} }
 *                    503 { "status": "down", "checks": {...} }
 *     checks.postgres: "ok" | "down" | "skipped"
 *     checks.redis:    "ok" | "down" | "skipped"
 *
 * SEMANTICS (D-001: "Redis is cache only — every helper degrades, never
 * fails"):
 *   - Postgres unreachable -> overall "down", HTTP 503. Postgres is the
 *     system of record (system-design §3); nothing meaningful is servable
 *     without it, so readiness must say so.
 *   - Redis unreachable, Postgres fine -> overall "degraded", HTTP 200.
 *     Readiness must NOT fail on cache loss: a Redis outage means slower,
 *     uncached reads and a fail-open rate limiter (see `packages/cache`),
 *     not an outage. An orchestrator that pulled this instance out of rotation
 *     over a cold cache would be doing exactly the harm D-001 exists to
 *     prevent.
 *   - Neither dependency injected (see below) -> that check reports
 *     "skipped" and does not by itself pull status down from "ready".
 *
 * INJECTION, AND THE "NO POOL INJECTED" JUDGMENT CALL:
 * Both checks run against handles passed in through `BuildAppOptions`
 * (`db`, `cache`) rather than ones this module opens itself — `app.ts`
 * already follows this pattern for `handlers`, and it is what lets a test
 * build an app against a scratch schema or a closed-port cache without this
 * module reaching for `process.env` on its own.
 *
 * `main.ts` (production) always injects both. The question is what an
 * instance built WITHOUT one — a unit test exercising something unrelated to
 * readiness, e.g. route surface or Accept negotiation, that just calls
 * `buildApp()` with no options — should see at `/readyz`. Decided: report
 * that check "skipped" and do not let its absence alone push status below
 * "ready". Rationale: an un-injected dependency here is a caller's choice
 * about what this particular instance was wired to check, not evidence that
 * a wired dependency is unreachable; conflating "nobody asked me to check
 * this" with "I checked and it's down" would make `/readyz` lie about the one
 * thing (Postgres reachability) it exists to report honestly. The path
 * production actually runs always has both injected, so this branch is a
 * test/dev-only escape hatch, never live traffic's.
 */

import type { Cache } from "@eutectic/cache";
import type { Sql } from "@eutectic/db";
import type { FastifyInstance } from "fastify";

export interface HealthCheckOptions {
  /** The Postgres pool `/readyz` runs `select 1` against. Omitted -> that check reports "skipped". */
  readonly db?: Sql;
  /** The Redis handle `/readyz` pings. Omitted -> that check reports "skipped". */
  readonly cache?: Cache;
}

type CheckResult = "ok" | "down" | "skipped";

async function checkPostgres(db: Sql | undefined): Promise<CheckResult> {
  if (db === undefined) return "skipped";
  try {
    await db`select 1`;
    return "ok";
  } catch {
    return "down";
  }
}

async function checkRedis(cache: Cache | undefined): Promise<CheckResult> {
  if (cache === undefined) return "skipped";
  // `Cache.ping()` is itself loss-tolerant (never throws, honours the
  // configured command timeout — see `packages/cache/src/client.ts`); no
  // try/catch is needed here, only the true/false -> ok/down mapping.
  return (await cache.ping()) ? "ok" : "down";
}

/** Registers `/healthz` and `/readyz` on `app`, outside `/v1`. */
export function registerHealthRoutes(app: FastifyInstance, options: HealthCheckOptions = {}): void {
  app.get("/healthz", async () => ({ status: "ok" as const }));

  app.get("/readyz", async (_request, reply) => {
    const [postgres, redis] = await Promise.all([checkPostgres(options.db), checkRedis(options.cache)]);

    if (postgres === "down") {
      return reply.code(503).send({ status: "down", checks: { postgres, redis } });
    }

    const status = redis === "down" ? ("degraded" as const) : ("ready" as const);
    return reply.code(200).send({ status, checks: { postgres, redis } });
  });
}
