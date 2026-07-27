/**
 * A minimal reader for `openapi.yaml`'s `components.schemas` block.
 * TEST SUPPORT ONLY.
 *
 * Same argument, and the same shape, as `apps/api/src/__tests__/
 * openapi-scan.ts` (which reads the `paths` block for the route-drift gate):
 * the validator's key tables must agree with `openapi.yaml` ITSELF, not with a
 * table derived from it. The generated `@eutectic/contracts` types are already
 * bound to those tables at compile time — but that binding goes through a
 * generator and a committed `dist/`, and a stale or buggy either would make
 * the compile-time proof agree with the wrong thing. This reader closes the
 * loop by parsing the source of truth directly.
 *
 * Why hand-rolled: a YAML parser is a new dependency (CLAUDE.md rule 12) for
 * one file with one known layout, in a test. Like its sibling, this reader is
 * deliberately literal about that layout — two spaces for `schemas:`, four for
 * a schema name, six for its keys, eight for a property name, ten for a
 * property's attributes. If the spec is ever reformatted this fails loudly:
 * `readSchema` throws on a name it cannot find, so a reformat cannot make the
 * drift test silently pass by finding nothing.
 *
 * It is NOT a YAML parser and must not grow into one. It reads scalars and
 * single-line flow sequences (`required: [a, b]`, `enum: [x, y]`) because that
 * is all `openapi.yaml` uses for the keys this gate checks. If a future ticket
 * needs real spec introspection at runtime, that is a contracts-package
 * export, not a parser in a backend package.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface ScannedSchema {
  readonly name: string;
  /** Six-space keys with a scalar value: `type`, `format`, `description`… */
  readonly attributes: ReadonlyMap<string, string>;
  /** `required: [...]`, in document order. Empty when the key is absent. */
  readonly required: readonly string[];
  /** Eight-space property names under `properties:`, in document order. */
  readonly properties: readonly string[];
  /** Ten-space attributes per property: `type`, `enum`, `minimum`… */
  readonly propertyAttributes: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /**
   * Every `$ref` target appearing anywhere below a property, at any depth —
   * which is how `oneOf:` branches and `items:` are reached without teaching
   * this reader about nesting.
   */
  readonly propertyRefs: ReadonlyMap<string, readonly string[]>;
}

/** Resolves the spec through the contracts package's `./openapi.yaml` export. */
export function openapiPath(): string {
  return fileURLToPath(import.meta.resolve("@eutectic/contracts/openapi.yaml"));
}

/** `[a, b, c]` → `["a","b","c"]`; anything else → undefined. */
function parseFlowSequence(value: string): string[] | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return undefined;
  const inner = trimmed.slice(1, -1).trim();
  if (inner.length === 0) return [];
  return inner.split(",").map((entry) => entry.trim().replace(/^['"]|['"]$/g, ""));
}

/**
 * Every schema under `components.schemas`, keyed by name.
 *
 * Block scalars (`description: |`) are skipped rather than captured: their
 * continuation lines sit at a deeper indent than any key this reader reports,
 * so they cannot be mistaken for one.
 */
export function scanSchemas(specPath: string = openapiPath()): Map<string, ScannedSchema> {
  const lines = readFileSync(specPath, "utf8").split("\n");

  const schemas = new Map<string, ScannedSchema>();

  let inComponents = false;
  let inSchemas = false;

  let name: string | undefined;
  let attributes = new Map<string, string>();
  let required: string[] = [];
  let properties: string[] = [];
  let propertyAttributes = new Map<string, Map<string, string>>();
  let propertyRefs = new Map<string, string[]>();
  let inProperties = false;
  let property: string | undefined;

  const flush = (): void => {
    if (name === undefined) return;
    schemas.set(name, {
      name,
      attributes,
      required,
      properties,
      propertyAttributes,
      propertyRefs,
    });
    name = undefined;
  };

  const start = (schemaName: string): void => {
    flush();
    name = schemaName;
    attributes = new Map();
    required = [];
    properties = [];
    propertyAttributes = new Map();
    propertyRefs = new Map();
    inProperties = false;
    property = undefined;
  };

  for (const line of lines) {
    if (line.trim().length === 0) continue;

    // A top-level key: enters `components:`, or leaves it again.
    if (/^\S/.test(line)) {
      if (inComponents) {
        flush();
        break;
      }
      inComponents = line.startsWith("components:");
      continue;
    }
    if (!inComponents) continue;

    // Two-space keys: `schemas:` is the only one this reader wants.
    const sectionMatch = /^ {2}(\S+):\s*$/.exec(line);
    if (sectionMatch?.[1] !== undefined) {
      flush();
      inSchemas = sectionMatch[1] === "schemas";
      continue;
    }
    if (!inSchemas) continue;

    const schemaMatch = /^ {4}(\w+):\s*$/.exec(line);
    if (schemaMatch?.[1] !== undefined) {
      start(schemaMatch[1]);
      continue;
    }
    if (name === undefined) continue;

    const schemaKeyMatch = /^ {6}([\w-]+):(.*)$/.exec(line);
    if (schemaKeyMatch?.[1] !== undefined) {
      const key = schemaKeyMatch[1];
      const value = (schemaKeyMatch[2] ?? "").trim();
      inProperties = key === "properties";
      property = undefined;
      if (key === "required") {
        required = parseFlowSequence(value) ?? [];
      } else if (value.length > 0) {
        attributes.set(key, value);
      }
      continue;
    }

    if (!inProperties) continue;

    const propertyMatch = /^ {8}([\w-]+):\s*$/.exec(line);
    if (propertyMatch?.[1] !== undefined) {
      property = propertyMatch[1];
      properties.push(property);
      propertyAttributes.set(property, new Map());
      propertyRefs.set(property, []);
      continue;
    }
    if (property === undefined) continue;

    // Any depth: `$ref` under `oneOf:` sits at twelve spaces, under `items:`
    // at twelve, directly under the property at ten.
    const refMatch = /\$ref:\s*'([^']+)'/.exec(line);
    if (refMatch?.[1] !== undefined) propertyRefs.get(property)?.push(refMatch[1]);

    const propertyKeyMatch = /^ {10}([$\w-]+):(.*)$/.exec(line);
    if (propertyKeyMatch?.[1] !== undefined) {
      const value = (propertyKeyMatch[2] ?? "").trim();
      if (value.length > 0) propertyAttributes.get(property)?.set(propertyKeyMatch[1], value);
    }
  }

  flush();
  return schemas;
}

/** One schema by name, or a loud failure — a silent miss must not pass. */
export function readSchema(schemas: Map<string, ScannedSchema>, name: string): ScannedSchema {
  const schema = schemas.get(name);
  if (schema === undefined) {
    throw new Error(
      `openapi.yaml has no schema \`${name}\`. Either the contract renamed it or this reader's assumptions about the file's layout broke; both need a human.`,
    );
  }
  return schema;
}
