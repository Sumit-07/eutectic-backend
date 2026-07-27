# @eutectic/db

Postgres access for the Eutectic backend: connection pool, Drizzle handle,
migration runner, queue schema bootstrap, seed entry point.

Postgres is both the database and the job queue (`system-design.md` §3). Redis is
cache, counters and rate limiting only, and is never the queue.

---

## Getting a database

Everything runs locally (`DECISIONS.md` D-006). From the repo root:

```sh
cp .env.example .env
docker compose up -d --wait
```

`docker-compose.yml` starts Postgres 16 and Redis 7 with named volumes and
healthchecks. **Redis is published on host port 6380**, not 6379 — 6379 was
already taken by a host-local `redis-server` on the machine this was built on.
Postgres is on the default 5432. `.env.example` already matches.

`DATABASE_URL` is read from the environment and nowhere else. There is no
fallback and no connection string anywhere in `src/` — the only two places a URL
is written down are `.env.example` and `docker-compose.yml`.

---

## Commands

Run from the repo root, or from this directory without the `--filter`.

| Command | What it does |
|---|---|
| `pnpm --filter @eutectic/db db:migrate` | Applies pending `.sql` migrations, then bootstraps the `graphile_worker` schema. Idempotent. |
| `pnpm --filter @eutectic/db db:seed` | Reapplies the `src/seed-data/` bootstrap lists (reserved handles, platform settings). Idempotent; refuses to run under `NODE_ENV=production`. |
| `pnpm --filter @eutectic/db build` | `tsc` → `dist/` |
| `pnpm --filter @eutectic/db typecheck` | `tsc --noEmit` |
| `pnpm --filter @eutectic/db test` | Builds, then runs the migration-runner tests against the Docker Postgres. |

Each script loads `eutectic-backend/.env` via Node's built-in
`--env-file-if-exists`. No `dotenv` dependency, no loader.

---

## Migrations

`migrations/` holds ordered, forward-only SQL. One file per change, named
`NNNN_snake_case_name.sql`. See the `migrations/` directory itself for the
current set, and `board/tickets.md` ("M0 backend wave 2") for the
ticket-to-migration mapping — every table in `system-design.md` §5 arrives with
its own migration and its own ticket. `src/schema/index.ts` mirrors whatever
has landed.

### What the runner guarantees

- **Ordered** — ascending `NNNN`. A duplicate or malformed prefix aborts the run.
- **Forward-only** — there is no `down`. An applied migration is never re-run and
  never edited: a checksum mismatch or a missing file aborts the run. Fixes go
  forward as a new file (expand → migrate → contract, `CLAUDE.md` rule 5).
- **Recorded in-database** — the applied set is the table
  `_eutectic_migrations (id, filename, checksum, applied_at, duration_ms)`, so it
  is true of the database you actually pointed at, not of a lockfile.
- **Idempotent** — a second `db:migrate` applies nothing and exits 0.
- **Serialized** — a session-level advisory lock keyed on the schema means two
  concurrent runs cannot interleave.
- **Atomic per migration** — each file runs in a transaction with the insert of
  its own ledger row, so a failure leaves neither the change nor the record.

### Writing one

```sql
-- migrations/0001_users.sql
CREATE TABLE users ( ... );
```

A migration that genuinely cannot run inside a transaction (`CREATE INDEX
CONCURRENTLY`, `ALTER TYPE ... ADD VALUE` on older servers) opts out with a
directive on its own line, and accepts that it is then not atomic with its ledger
row:

```sql
-- eutectic:no-transaction
CREATE INDEX CONCURRENTLY ...;
```

Extensions are limited to OSS contrib modules (`system-design.md` §14) — nothing
Neon- or Supabase-specific may appear here, or Postgres stops being swappable.

Destructive migrations are a human decision (`CLAUDE.md` §6).

### drizzle-kit

`drizzle.config.ts` wires `drizzle-kit generate` to diff `src/schema` into
`migrations/`. drizzle-kit writes SQL; this package's runner decides what has
been applied. drizzle-kit numbers from its own journal and will emit a second
`0000_*.sql` — rename generated output to the next free sequence before
committing, or the runner rejects the duplicate.

---

## The queue

`graphile_worker` is not created by `0000`. graphile-worker owns that schema and
its own migration history, so `db:migrate` calls its programmatic migrator
(`src/queue.ts`) rather than copying its SQL, which would drift on the next
upgrade.

The reason the queue lives in Postgres at all is that enqueue is then part of the
write transaction:

```sql
BEGIN;
  INSERT INTO contributions (...) VALUES (...);
  INSERT INTO events (...) VALUES (...);
  SELECT graphile_worker.add_job('projection.contribution', ...);
COMMIT;
```

Because that is plain SQL on our own connection, graphile-worker's internal `pg`
pool never needs to be shared with this package's pool.

### `withJob` — the only way to enqueue

Nothing calls `add_job` directly. `src/jobs.ts` exports one helper, and it takes
the caller's transaction handle:

```ts
import { withJob } from "@eutectic/db";

await sql.begin(async (tx) => {
  const [row] = await tx`INSERT INTO contributions (...) RETURNING id`;
  await writeEvent(tx, { event_type: "contribution.created", ... });
  await withJob(tx, "projection.contribution", { contribution_id: row.id });
});
```

`tx` is a `TransactionSql`, not a pool — a plain `Sql` does not typecheck. The
row, the event and the job commit together or not at all; that is the whole
reliability argument for putting the queue in Postgres and it only holds because
no code path opens its own connection to enqueue.

Options are deliberately narrow: `jobKey` (dedupe; graphile-worker's default
`replace` mode, so the later payload wins and the pending job is rescheduled),
`runAt`, and `schema` (tests only). `queue_name`, `max_attempts`, `priority`,
`flags` and `job_key_mode` are not exposed — each is a per-job-type policy that
should arrive with the ticket that needs it.

### The job registry

`JOB_NAMES` and `JobPayloadMap` in `src/jobs.ts` are the shared vocabulary: the
API enqueues against them, `apps/worker` handles against them, and both
directions are checked at compile time (a name with no payload type, or a payload
type with no name, does not build; the same for a name with no handler in
`apps/worker`).

**A job name lands here when its handler lands, and not before.** A queued job
row outlives the deploy that wrote it, so names are added, never renamed and
never removed — the same rule the event catalogue lives under.

### Which schema

`resolveQueueSchema()` is the one answer for all three of the bootstrap, the
runner and `withJob`: an explicit argument, else `GRAPHILE_WORKER_SCHEMA`, else
`graphile_worker` — graphile-worker's own resolution order. If they ever
disagree, enqueues land in a schema nothing polls, and there is no error to see.

---

## Driver

One driver: **postgres.js** (`postgres`), via `drizzle-orm/postgres-js`. It ships
its own TypeScript types, so the package needs no `@types/*`. graphile-worker
carries `pg` internally for its own use; nothing here imports it.

Pool defaults: `max: 10`, `idle_timeout: 30s`, `connect_timeout: 10s`, prepared
statements off (so a connection pooler can be introduced later without a rewrite).
Override with `DATABASE_POOL_MAX`, `DATABASE_IDLE_TIMEOUT_SECONDS`,
`DATABASE_CONNECT_TIMEOUT_SECONDS`.

```ts
import { getDb, closeDb } from "@eutectic/db";

const { db, sql } = getDb();   // one pool per process, created on first use
await closeDb();               // on shutdown
```

---

## Seeding

`src/scripts/seed.ts` is idempotent, refuses to run under `NODE_ENV=production`,
and must not invent agent history (no diary without a resolving ref,
`CLAUDE.md` rule 8). Migrations create structure; the seed creates rows. Never
put a `CREATE TABLE` in it.

### Bootstrap data vs development fixtures

`src/seed-data/` holds the two lists production is *wrong* without — the
reserved-handle denylist and `platform_settings` (P-01, `DIRECTIVE-pre-M1` §2
and §3). Because `db:seed` is development-only, **migration 0013 seeds both**,
and `migration-0013.test.ts` asserts the SQL and the TypeScript agree exactly,
so they are one list checked against itself rather than two that drift.

`db:seed` reapplies the same lists, which is how data *added* to them after 0013
ran — the deferred founder/investor handles (D-038(c)) — reaches a development
database without a migration. Both helpers (`syncReservedHandles`,
`syncPlatformSettings`) are `ON CONFLICT DO NOTHING` and never `DO UPDATE`: a
deploy silently restoring `routing.coverage_target` to its default after an
operator lowered it would be a spend incident with no fingerprints on it.

### Handles: one namespace, three sources

`users.handle` (spent, including tombstoned accounts), `reserved_handles`
(permanent denylist) and `handle_history` (90-day rename cooldown) are disjoint
and are read by ONE availability predicate — spelled out in
`migrations/0013_provenance_identity_settings.sql`'s RULING 1 and executed by
the migration test. Do not add a fourth source, and do not write a second
predicate.

---

## Tests

`src/__tests__/migrate.test.ts` runs under Node's built-in test runner against the
Docker Postgres. The central case is the exactly-once guarantee: a deliberately
non-idempotent fixture migration (`test/fixtures/migrations/`, kept out of
`migrations/`) is applied twice in a row, and the ledger, the returned result and
the fixture's own side effects must all show one application. Each test works
inside a throwaway schema that is dropped afterwards, so the dev database is
never touched and the suite is rerunnable.
