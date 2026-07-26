/**
 * Filesystem locations that must survive compilation.
 *
 * `migrations/` holds .sql files that tsc does not copy, so paths are resolved
 * from the compiled module's own URL rather than from `process.cwd()` — a script
 * must behave identically whether it is run from the package or from the
 * workspace root.
 *
 * At runtime this module is `<package>/dist/paths.js`, so `../` is the package root.
 */

import { fileURLToPath } from "node:url";

/** Absolute path to the @eutectic/db package root, with trailing separator. */
export const PACKAGE_ROOT: string = fileURLToPath(new URL("../", import.meta.url));

/**
 * The one and only production migrations directory. Ordered, forward-only.
 * Ships 0000 today; 0001..0011 arrive with M0-BE-02 … M0-BE-12.
 */
export const MIGRATIONS_DIR: string = fileURLToPath(new URL("../migrations", import.meta.url));
