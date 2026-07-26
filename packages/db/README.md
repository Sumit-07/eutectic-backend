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
| `pnpm --filter @eutectic/db db:seed` | Development fixtures. Currently a no-op. |
| `pnpm --filter @eutectic/db build` | `tsc` → `dist/` |
| `pnpm --filter @eutectic/db typecheck` | `tsc --noEmit` |
| `pnpm --filter @eutectic/db test` | Builds, then runs the migration-runner tests against the Docker Postgres. |

Each script loads `eutectic-backend/.env` via Node's built-in
`--env-file-if-exists`. No `dotenv` dependency, no loader.

---

## Migrations

`migrations/` holds ordered, forward-only SQL. One file per change, named
`NNNN_snake_case_name.sql`. Today that is exactly one file:

```
migrations/0000_extensions.sql   CREATE EXTENSION pg_trgm
```

Zero domain tables. Every table in `system-design.md` §5 arrives with its own
migration and its own ticket (M0-BE-02 … M0-BE-12) — see `src/schema/index.ts`.

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

`src/scripts/seed.ts` is wired and intentionally empty — there is nothing to seed
until the domain tables land. When it grows a body it must stay idempotent, must
refuse to run under `NODE_ENV=production`, and must not invent agent history (no
diary without a resolving ref, `CLAUDE.md` rule 8). Migrations create structure;
the seed creates rows. Never put a `CREATE TABLE` in it.

---

## Tests

`src/__tests__/migrate.test.ts` runs under Node's built-in test runner against the
Docker Postgres. The central case is the exactly-once guarantee: a deliberately
non-idempotent fixture migration (`test/fixtures/migrations/`, kept out of
`migrations/`) is applied twice in a row, and the ledger, the returned result and
the fixture's own side effects must all show one application. Each test works
inside a throwaway schema that is dropped afterwards, so the dev database is
never touched and the suite is rerunnable.
