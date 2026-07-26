/**
 * Environment access for @eutectic/db.
 *
 * DATABASE_URL is read from `process.env` and nowhere else. There is no default,
 * no fallback and no hardcoded connection string anywhere in this package — the
 * only two places a URL is written down are `.env.example` and
 * `docker-compose.yml`, both at the repo root.
 */

export class MissingEnvError extends Error {
  constructor(name: string, hint: string) {
    super(`${name} is not set. ${hint}`);
    this.name = "MissingEnvError";
  }
}

/**
 * The Postgres connection string. Throws a clear, actionable error when unset —
 * a silent localhost default is how a script ends up writing to the wrong
 * database.
 */
export function requireDatabaseUrl(): string {
  const url = process.env["DATABASE_URL"];
  if (url === undefined || url.trim() === "") {
    throw new MissingEnvError(
      "DATABASE_URL",
      "Copy eutectic-backend/.env.example to eutectic-backend/.env and start the " +
        "local stack with `docker compose up -d --wait`.",
    );
  }
  return url;
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}.`);
  }
  return parsed;
}

/** Pool defaults. Overridable by env, sane without it. */
export const poolDefaults = {
  /** Per-process connection ceiling. Five deployables × 10 stays well inside Postgres 16's default 100. */
  max: (): number => readPositiveInt("DATABASE_POOL_MAX", 10),
  /** Seconds an idle connection is kept before being closed. */
  idleTimeoutSeconds: (): number => readPositiveInt("DATABASE_IDLE_TIMEOUT_SECONDS", 30),
  /** Seconds to wait for a new connection before failing loudly. */
  connectTimeoutSeconds: (): number => readPositiveInt("DATABASE_CONNECT_TIMEOUT_SECONDS", 10),
} as const;
