/**
 * A minimal reader for `openapi.yaml`'s `paths` block. TEST SUPPORT ONLY.
 *
 * system-design §2 says "CI fails if openapi.yaml and the API's registered
 * routes disagree" — openapi.yaml, not a table derived from it. The generated
 * `ROUTES` table is derived from the spec and the contracts package has its
 * own staleness gate, but that gate runs in a different repo, and a gate this
 * app depends on should be one this app can run. So the drift test reads the
 * spec file itself and checks it three ways: spec ↔ ROUTES ↔ fastify.
 *
 * Why hand-rolled: a YAML parser is a new dependency (CLAUDE.md rule 12) for
 * one file with one known layout, in a test. This reader is deliberately
 * literal about that layout — two spaces for a path, four for a method, six
 * for `operationId` and `responses`, eight for a status. If the spec is ever
 * reformatted, this fails loudly rather than silently finding nothing: the
 * drift test asserts set equality against `ROUTES`, so an empty scan fails.
 *
 * It is NOT a YAML parser and must not grow into one. If a future ticket needs
 * real spec introspection at runtime, that is a contracts-package export, not
 * a parser in apps/api.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The methods a path item may declare. `parameters` sits at the same indent. */
const HTTP_METHODS: ReadonlySet<string> = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);

export interface ScannedOperation {
  /** Lowercase, as the spec writes it. */
  readonly method: string;
  /** OpenAPI syntax, `{param}` braces intact. */
  readonly path: string;
  readonly operationId: string;
  /** Every response status the operation declares, as written. */
  readonly statuses: readonly string[];
}

/** Resolves the spec through the contracts package's `./openapi.yaml` export. */
export function openapiPath(): string {
  return fileURLToPath(import.meta.resolve("@eutectic/contracts/openapi.yaml"));
}

/** Every operation in `paths`, in document order. */
export function scanOperations(specPath: string = openapiPath()): ScannedOperation[] {
  const lines = readFileSync(specPath, "utf8").split("\n");

  const operations: ScannedOperation[] = [];
  let inPaths = false;
  let path: string | undefined;
  let current: { method: string; path: string; operationId?: string; statuses: string[] } | undefined;
  let inResponses = false;

  const flush = (): void => {
    if (current === undefined) return;
    if (current.operationId === undefined) {
      throw new Error(`operation ${current.method} ${current.path} has no operationId`);
    }
    operations.push({
      method: current.method,
      path: current.path,
      operationId: current.operationId,
      statuses: current.statuses,
    });
    current = undefined;
  };

  for (const line of lines) {
    if (line.trim().length === 0) continue;

    // A top-level key ends the paths block (`components:` follows it).
    if (/^\S/.test(line)) {
      if (inPaths) break;
      inPaths = line.startsWith("paths:");
      continue;
    }
    if (!inPaths) continue;

    const pathMatch = /^ {2}(\/\S*):\s*$/.exec(line);
    if (pathMatch?.[1] !== undefined) {
      flush();
      path = pathMatch[1];
      inResponses = false;
      continue;
    }

    const methodMatch = /^ {4}([a-z]+):\s*$/.exec(line);
    if (methodMatch?.[1] !== undefined && HTTP_METHODS.has(methodMatch[1])) {
      flush();
      if (path === undefined) throw new Error(`method ${methodMatch[1]} outside any path`);
      current = { method: methodMatch[1], path, statuses: [] };
      inResponses = false;
      continue;
    }

    if (current === undefined) continue;

    const operationIdMatch = /^ {6}operationId:\s*(\S+)\s*$/.exec(line);
    if (operationIdMatch?.[1] !== undefined) {
      current.operationId = operationIdMatch[1];
      continue;
    }

    // Any other key at the operation's own indent closes `responses`.
    if (/^ {6}\S/.test(line)) {
      inResponses = /^ {6}responses:\s*$/.test(line);
      continue;
    }

    if (!inResponses) continue;
    const statusMatch = /^ {8}'(\d{3})':\s*$/.exec(line);
    if (statusMatch?.[1] !== undefined) current.statuses.push(statusMatch[1]);
  }

  flush();
  return operations;
}
