/**
 * drizzle-kit configuration.
 *
 * Used for `drizzle-kit generate` (diff `src/schema` into a .sql file) and
 * `drizzle-kit check`. It is NOT the migration runner — that is `src/migrate.ts`,
 * driven by `pnpm db:migrate`. drizzle-kit writes SQL; our runner decides what
 * has been applied.
 *
 * NUMBERING: drizzle-kit numbers generated files from its own journal and will
 * happily emit a second `0000_*.sql`. `migrations/0000_extensions.sql` already
 * owns 0000, and the runner treats a duplicate sequence as a hard error.
 * Rename generated output to the next free sequence before committing.
 *
 * Excluded from `tsc` (tsconfig includes `src` only); drizzle-kit loads it itself.
 */

import { defineConfig } from "drizzle-kit";

const url = process.env["DATABASE_URL"];
if (url === undefined || url.trim() === "") {
  throw new Error(
    "DATABASE_URL is not set. Copy eutectic-backend/.env.example to .env and run " +
      "`docker compose up -d --wait`.",
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
