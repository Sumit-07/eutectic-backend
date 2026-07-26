-- 0000_extensions
--
-- Bootstrap only. ZERO domain tables — every table in system-design §5 lands in
-- migrations 0001..0011 (tickets M0-BE-02 … M0-BE-12).
--
-- Extension policy (system-design §14): OSS extensions only, nothing
-- Neon/Supabase-proprietary. Postgres must stay swappable in a week.
--
--   pg_trgm — trigram indexes for the search surface (§8). Core Postgres contrib.
--
-- gen_random_uuid() (the §5 default for every `id uuid PRIMARY KEY`) is core in
-- Postgres 13+, so no pgcrypto extension is required.
--
-- The graphile_worker schema is NOT created here. graphile-worker owns its own
-- migration history and is bootstrapped programmatically by `pnpm db:migrate`
-- (src/scripts/migrate.ts) so that its SQL is never hand-copied and never drifts
-- from the installed version.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
