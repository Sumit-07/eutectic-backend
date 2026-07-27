/**
 * THE D-029 GATE — no GitHub-derived identity field is reachable from any
 * response outside the `/admin/*` path family. P-02-BE, DIRECTIVE §5:
 *
 *   > Integration test: iterate every route in `openapi.yaml` outside
 *   > `/v1/admin/*`, assert no response schema contains `github_id`,
 *   > `github_created_at`, `github_public_repos`, `tier_would_be` or `email`.
 *   > Fails the build.
 *   >
 *   > One test, and it is the entire feature. Write it before the serializer.
 *
 * This is a ONE-WAY DOOR (D-029). Once real users sign up under pseudonymous
 * handles, a field that leaked is a field that was already published. The gate
 * therefore runs in the ordinary `pnpm --filter @eutectic/api test` step — the
 * fast pipeline, no database, no Redis, no network — so it is impossible to
 * merge past it.
 *
 * WHAT "OUTSIDE /v1/admin/*" MEANS HERE. `openapi.yaml` writes paths without
 * the server's `/v1` prefix (`servers:` supplies it), so the directive's
 * `/v1/admin/*` is spelled `/admin/*` in the document. Both spellings are
 * treated as admin by {@link isAdminPath}, so nothing depends on which
 * convention a future ticket picks. At shared develop @ 918c418 the admin
 * family has NO paths yet (they land with P-09), which is exactly why the
 * fixture self-tests below exist: today's "zero findings" must be a real
 * result, not a walker that never walked.
 *
 * HOW THE WALKER COVERS THE SCHEMA GRAPH — the coverage decisions a reviewer
 * should check:
 *
 *   $ref          resolved against the document (any `#/…` pointer, not just
 *                 `components/schemas`), and followed. A `$ref` that does not
 *                 resolve THROWS rather than being skipped.
 *   cycles        a ref is expanded once per operation; a self-referential
 *                 schema terminates instead of hanging.
 *   arrays        `items`, `prefixItems`, and any sequence-valued keyword.
 *   composition   `oneOf` / `anyOf` / `allOf` / `not` — every branch, because
 *                 a leak in ONE branch is still a leak.
 *   nesting       unbounded: inline objects inside `properties` inside `items`
 *                 inside a `oneOf` branch, to any depth.
 *   unknown       recursion is by exclusion, not by an allowlist of keywords:
 *                 every sub-value is walked EXCEPT the documented data-valued
 *                 keys ({@link DATA_KEYWORDS}). A JSON Schema keyword nobody
 *                 here has heard of is covered by default.
 *   names         a `properties` key is a wire field name; so is any entry in
 *                 a `required` array (a field can be required before it is
 *                 declared). Both are checked.
 *   examples      checked too, as DATA (their keys are wire keys). A response
 *                 example is served verbatim by the Prism mock, so a leak in
 *                 an example is a leak the frontend can render.
 *
 * REQUEST bodies are deliberately out of scope: the invariant is about what
 * the API HANDS OUT. `email` in a request body would be a different problem
 * with a different fix.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FORBIDDEN_IDENTITY_FIELDS,
  forbiddenKeysIn,
  isForbiddenIdentityField,
} from "./identity-fields.js";
import { isMapping, parseYamlDocument, parseYamlFile, type YamlMapping, type YamlValue } from "./openapi-document.js";
import { openapiPath, scanOperations } from "./openapi-scan.js";

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

/**
 * Keys whose values are DATA, not schemas. Excluded from the schema walk (and
 * `example`/`examples` are picked up by the data pass instead). Everything not
 * listed here is walked as schema, so an unrecognised keyword fails safe.
 */
const DATA_KEYWORDS: ReadonlySet<string> = new Set(["example", "examples", "enum", "const", "default"]);

interface Finding {
  readonly operation: string;
  readonly status: string;
  readonly field: string;
  readonly location: string;
}

interface ScannedOperationNode {
  readonly path: string;
  readonly method: string;
  readonly operationId: string;
  readonly operation: YamlMapping;
}

/** The `/v1/admin/*` family, in either spelling. `/administration` is NOT admin. */
export function isAdminPath(path: string): boolean {
  const withoutPrefix = path.startsWith("/v1/") ? path.slice(3) : path;
  return withoutPrefix === "/admin" || withoutPrefix.startsWith("/admin/");
}

/** Every operation in the document, admin included. */
function operationsOf(document: YamlMapping): ScannedOperationNode[] {
  const paths = document["paths"];
  assert.ok(isMapping(paths), "openapi.yaml has no paths block");
  const found: ScannedOperationNode[] = [];
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isMapping(pathItem)) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method) || !isMapping(operation)) continue;
      const operationId = operation["operationId"];
      assert.equal(
        typeof operationId,
        "string",
        `${method.toUpperCase()} ${path} has no operationId`,
      );
      found.push({ path, method, operationId: operationId as string, operation });
    }
  }
  return found;
}

/** Resolves a `#/a/b/c` pointer. Throws — never returns undefined — on a dangling ref. */
function resolvePointer(document: YamlMapping, ref: string): YamlValue {
  assert.ok(ref.startsWith("#/"), `only local refs are supported, got ${ref}`);
  let node: YamlValue = document;
  for (const rawSegment of ref.slice(2).split("/")) {
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    assert.ok(isMapping(node), `${ref} does not resolve (stopped at ${segment})`);
    const next = node[segment];
    assert.notEqual(next, undefined, `${ref} does not resolve (missing ${segment})`);
    node = next as YamlValue;
  }
  return node;
}

/**
 * THE WALKER. Every forbidden field name reachable from `node`, following refs
 * through the whole graph. `seenRefs` is per-call, so a shared schema is
 * reported once per operation, and a cycle terminates.
 */
function forbiddenNamesInSchema(
  document: YamlMapping,
  node: YamlValue | undefined,
  location: string,
  seenRefs: Set<string>,
): { field: string; location: string }[] {
  if (node === undefined) return [];
  if (Array.isArray(node)) {
    return node.flatMap((item, index) =>
      forbiddenNamesInSchema(document, item, `${location}[${index}]`, seenRefs),
    );
  }
  if (!isMapping(node)) return [];

  const hits: { field: string; location: string }[] = [];

  const ref = node["$ref"];
  if (typeof ref === "string") {
    if (seenRefs.has(ref)) return hits;
    seenRefs.add(ref);
    hits.push(
      ...forbiddenNamesInSchema(document, resolvePointer(document, ref), `${location} -> ${ref}`, seenRefs),
    );
    // Fall through: a sibling keyword next to `$ref` is legal in OpenAPI 3.1.
  }

  const properties = node["properties"];
  if (isMapping(properties)) {
    for (const name of Object.keys(properties)) {
      if (isForbiddenIdentityField(name)) {
        hits.push({ field: name, location: `${location}.properties.${name}` });
      }
    }
  }

  const required = node["required"];
  if (Array.isArray(required)) {
    for (const name of required) {
      if (typeof name === "string" && isForbiddenIdentityField(name)) {
        hits.push({ field: name, location: `${location}.required[${name}]` });
      }
    }
  }

  for (const [key, child] of Object.entries(node)) {
    if (key === "$ref" || DATA_KEYWORDS.has(key)) continue;
    hits.push(...forbiddenNamesInSchema(document, child, `${location}.${key}`, seenRefs));
  }
  return hits;
}

/** Response examples, as data: their keys are the keys a client will see. */
function forbiddenNamesInExamples(
  document: YamlMapping,
  node: YamlValue | undefined,
  location: string,
  seenRefs: Set<string>,
): { field: string; location: string }[] {
  if (node === undefined) return [];
  if (Array.isArray(node)) {
    return node.flatMap((item, index) =>
      forbiddenNamesInExamples(document, item, `${location}[${index}]`, seenRefs),
    );
  }
  if (!isMapping(node)) return [];

  const hits: { field: string; location: string }[] = [];
  const ref = node["$ref"];
  if (typeof ref === "string" && !seenRefs.has(ref)) {
    seenRefs.add(ref);
    hits.push(
      ...forbiddenNamesInExamples(document, resolvePointer(document, ref), `${location} -> ${ref}`, seenRefs),
    );
  }
  for (const [key, child] of Object.entries(node)) {
    if (key === "$ref") continue;
    if (DATA_KEYWORDS.has(key)) {
      hits.push(
        ...forbiddenKeysIn(child, `${location}.${key}`).map((hit) => ({
          field: hit.field,
          location: hit.location,
        })),
      );
      continue;
    }
    hits.push(...forbiddenNamesInExamples(document, child, `${location}.${key}`, seenRefs));
  }
  return hits;
}

/** THE GATE. Every forbidden field reachable from a non-admin response. */
export function findIdentityLeaks(document: YamlMapping): Finding[] {
  const findings: Finding[] = [];
  for (const node of operationsOf(document)) {
    if (isAdminPath(node.path)) continue;
    const responses = node.operation["responses"];
    if (!isMapping(responses)) continue;
    for (const [status, response] of Object.entries(responses)) {
      const where = `${node.operationId} ${status}`;
      for (const hit of forbiddenNamesInSchema(document, response, where, new Set())) {
        findings.push({ operation: node.operationId, status, ...hit });
      }
      for (const hit of forbiddenNamesInExamples(document, response, where, new Set())) {
        findings.push({ operation: node.operationId, status, ...hit });
      }
    }
  }
  return findings;
}

/** Every `$ref` string the walk expanded — the non-vacuity evidence. */
function refsReachedFromNonAdminResponses(document: YamlMapping): Set<string> {
  const reached = new Set<string>();
  for (const node of operationsOf(document)) {
    if (isAdminPath(node.path)) continue;
    const responses = node.operation["responses"];
    if (!isMapping(responses)) continue;
    for (const response of Object.values(responses)) {
      const seen = new Set<string>();
      forbiddenNamesInSchema(document, response, "", seen);
      for (const ref of seen) reached.add(ref);
    }
  }
  return reached;
}

const document = parseYamlFile(openapiPath());

describe("D-029 — GitHub identity fields never leave /v1/admin/* (P-02-BE)", () => {
  it("finds no forbidden field in any non-admin response, anywhere in the graph", () => {
    const findings = findIdentityLeaks(document);
    assert.deepEqual(
      findings,
      [],
      "a GitHub-derived identity field is reachable from a non-admin response — this is the " +
        "D-029 one-way door, and it fails the build:\n" +
        findings.map((f) => `  ${f.operation} ${f.status}: ${f.field} at ${f.location}`).join("\n"),
    );
  });

  it("guards exactly the five names the directive names", () => {
    // If a future edit empties or renames this list, the assertion above goes
    // trivially green. It cannot: the list is pinned here, in the gate.
    assert.deepEqual(
      [...FORBIDDEN_IDENTITY_FIELDS],
      ["github_id", "github_created_at", "github_public_repos", "tier_would_be", "email"],
      "DIRECTIVE §5's forbidden list changed — that is a D-entry, not an edit",
    );
  });

  it("never reaches AdminUser from a non-admin response", () => {
    // The field scan would catch this anyway. Named separately because THIS is
    // the sentence D-029 actually writes, and a reviewer should see it asserted.
    assert.ok(
      !refsReachedFromNonAdminResponses(document).has("#/components/schemas/AdminUser"),
      "AdminUser is reachable outside /v1/admin/* (D-029)",
    );
  });
});

describe("the gate is not vacuous", () => {
  it("walks the same operations the line scanner finds, and all of them", () => {
    // A second, independent reader of the same file (route-drift's scanner).
    // If this parser silently missed half the document, the sets diverge.
    const structural = operationsOf(document)
      .map((node) => node.operationId)
      .sort();
    const lineScanned = scanOperations()
      .map((operation) => operation.operationId)
      .sort();
    assert.deepEqual(structural, lineScanned);
    assert.ok(structural.length >= 20, `only ${structural.length} operations parsed`);
  });

  it("actually expands the user-bearing schemas", () => {
    const reached = refsReachedFromNonAdminResponses(document);
    for (const ref of [
      "#/components/schemas/PublicUser",
      "#/components/schemas/Session",
      "#/components/schemas/Author",
      "#/components/schemas/FeedPage",
    ]) {
      assert.ok(reached.has(ref), `the walk never reached ${ref}`);
    }
    assert.ok(reached.size >= 40, `only ${reached.size} refs expanded`);
  });

  it("reaches a response schema for every non-admin operation", () => {
    for (const node of operationsOf(document)) {
      if (isAdminPath(node.path)) continue;
      const responses = node.operation["responses"];
      assert.ok(isMapping(responses), `${node.operationId} declares no responses`);
      const seen = new Set<string>();
      for (const response of Object.values(responses)) {
        forbiddenNamesInSchema(document, response, "", seen);
      }
      assert.ok(seen.size > 0, `${node.operationId}: the walk expanded nothing`);
    }
  });

  it("classifies the admin family, and only the admin family", () => {
    assert.equal(isAdminPath("/admin/settings"), true);
    assert.equal(isAdminPath("/admin/users/{userId}"), true);
    assert.equal(isAdminPath("/admin"), true);
    assert.equal(isAdminPath("/v1/admin/users/{userId}"), true);
    assert.equal(isAdminPath("/administration/users"), false, "a prefix match is not a family");
    assert.equal(isAdminPath("/agents/{agentSlug}"), false);
    assert.equal(isAdminPath("/me/handle"), false);
  });
});

/**
 * PLANTED VIOLATIONS. The gate above passes today because the contract is
 * clean; these prove it would not pass if it were not. Same shape as
 * `rank-score-entitlement-guard.test.ts`' fixture self-test: feed the REAL
 * walker a doctored document and assert it bites.
 */
describe("self-test: the walker bites on a planted violation", () => {
  /**
   * The leak sits eight hops down: response ref -> page schema -> array items
   * -> allOf branch -> oneOf branch -> ref -> ref -> inline nested object. A
   * walker that stops at the first schema, ignores composition, or does not
   * follow refs finds nothing here. `LeakyOwner.friend` points back at itself,
   * so a walker without cycle protection hangs instead of failing.
   */
  const planted = parseYamlDocument(`
paths:
  /widgets:
    get:
      operationId: listWidgets
      responses:
        '200':
          $ref: '#/components/responses/WidgetPageResponse'
  /admin/widgets:
    get:
      operationId: listAdminWidgets
      responses:
        '200':
          $ref: '#/components/responses/AdminWidgetResponse'
components:
  responses:
    WidgetPageResponse:
      description: A page of widgets.
      content:
        application/vnd.staffroom.v1+json:
          schema:
            $ref: '#/components/schemas/WidgetPage'
    AdminWidgetResponse:
      description: The admin view.
      content:
        application/vnd.staffroom.v1+json:
          schema:
            $ref: '#/components/schemas/AdminWidget'
  schemas:
    WidgetPage:
      type: object
      properties:
        items:
          type: array
          items:
            $ref: '#/components/schemas/WidgetEnvelope'
    WidgetEnvelope:
      allOf:
        - type: object
          properties:
            kind:
              type: string
        - type: object
          properties:
            payload:
              oneOf:
                - type: 'null'
                - $ref: '#/components/schemas/Widget'
    Widget:
      type: object
      properties:
        owner:
          $ref: '#/components/schemas/LeakyOwner'
    LeakyOwner:
      type: object
      properties:
        friend:
          $ref: '#/components/schemas/LeakyOwner'
        profile:
          type: object
          properties:
            handle:
              type: string
            github_created_at:
              type: string
    AdminWidget:
      type: object
      properties:
        github_id:
          type: integer
        tier_would_be:
          type: integer
`);

  it("finds the deeply nested leak, and names where it is", () => {
    const findings = findIdentityLeaks(planted);
    assert.equal(findings.length, 1, `expected exactly one finding, got ${findings.length}`);
    const finding = findings[0];
    assert.equal(finding?.operation, "listWidgets");
    assert.equal(finding?.status, "200");
    assert.equal(finding?.field, "github_created_at");
    assert.match(finding?.location ?? "", /WidgetPage[\s\S]*WidgetEnvelope[\s\S]*Widget/);
    assert.match(finding?.location ?? "", /allOf\[1\]/, "the leak was found through a composition branch");
    assert.match(finding?.location ?? "", /\.properties\.github_created_at$/);
  });

  it("exempts the admin family — the same fields, and no finding", () => {
    // Proves the exemption is a real branch, not an accident of the fixture:
    // AdminWidget carries two forbidden fields and is reported zero times.
    const findings = findIdentityLeaks(planted);
    assert.deepEqual(
      findings.filter((f) => f.operation === "listAdminWidgets"),
      [],
      "an /admin/* operation must be allowed to serve AdminUser fields",
    );
  });

  it("bites on a field that is required but never declared", () => {
    const requiredOnly = parseYamlDocument(`
paths:
  /widgets:
    get:
      operationId: listWidgets
      responses:
        '200':
          content:
            application/vnd.staffroom.v1+json:
              schema:
                type: object
                required: [handle, email]
                properties:
                  handle:
                    type: string
`);
    const findings = findIdentityLeaks(requiredOnly);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.field, "email");
  });

  it("bites on a leak that exists only in an example", () => {
    // Prism serves examples verbatim (contracts/README), so an example is a
    // wire payload. Data, not schema — a separate pass, separately proven.
    const exampleOnly = parseYamlDocument(`
paths:
  /widgets:
    get:
      operationId: listWidgets
      responses:
        '200':
          content:
            application/vnd.staffroom.v1+json:
              schema:
                type: object
              examples:
                default:
                  value:
                    items:
                      - owner:
                          handle: mira
                          github_public_repos: 41
`);
    const findings = findIdentityLeaks(exampleOnly);
    assert.equal(findings.length, 1, JSON.stringify(findings));
    assert.equal(findings[0]?.field, "github_public_repos");
  });

  it("fails loudly on a dangling $ref instead of walking past it", () => {
    const dangling = parseYamlDocument(`
paths:
  /widgets:
    get:
      operationId: listWidgets
      responses:
        '200':
          $ref: '#/components/responses/DoesNotExist'
components:
  responses: {}
`);
    assert.throws(() => findIdentityLeaks(dangling), /does not resolve/);
  });
});
