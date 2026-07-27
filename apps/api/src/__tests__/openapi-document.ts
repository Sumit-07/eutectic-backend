/**
 * A YAML-subset document parser for `openapi.yaml`. TEST SUPPORT ONLY.
 *
 * WHY THIS EXISTS, GIVEN `openapi-scan.ts` ALREADY READS THE SPEC
 * -------------------------------------------------------------------------
 * `openapi-scan.ts` answers "which operations exist" — a flat question a
 * line-at-a-time reader can answer. The D-029 leak gate
 * (`github-leak-gate.test.ts`) asks a structural one: *follow every response
 * of every non-admin operation through `$ref`s, arrays, `oneOf`/`allOf` and
 * nested objects, and tell me every property name reachable that way*. That
 * needs a document, not a line scan, so this module builds one.
 *
 * WHY NOT A YAML DEPENDENCY: CLAUDE.md rule 12. A parser for one file with one
 * known layout, used only by tests, is not worth a dependency — and the leak
 * gate must be runnable by this app (route-drift.ts makes the same argument
 * for its own reader). The contracts package also has its own spec tests, but
 * those run in a different repo.
 *
 * WHY NOT PARSE THE GENERATED TYPES INSTEAD: because a generator bug, a stale
 * `dist/`, or a hand-edit to `generated/` would then be invisible to the gate.
 * `openapi.yaml` is the source of truth (system-design §2); the gate reads it.
 *
 * SUPPORTED SUBSET — exactly what `openapi.yaml` uses today:
 *   - block mappings          `key:` / `key: value`
 *   - block sequences         `- value` / `- key: value` / `- {}`
 *   - block scalars           `key: |`, `key: >-` (and the `+`/`-` chomps)
 *   - flow sequences          `key: [a, b, 'c']` — single line, no nesting
 *   - flow mappings           `{}` only (the empty-security-requirement idiom)
 *   - quoted scalars          `'…'` and `"…"`; `null`/`true`/`false`; numbers
 *
 * DELIBERATELY UNSUPPORTED, AND LOUD ABOUT IT: anchors and aliases, multi-line
 * plain scalars, nested or multi-line flow collections, complex keys,
 * multi-document streams, tags. Every one of them THROWS with a line number
 * rather than being skipped. That is the whole safety posture of this file: a
 * leak gate that silently fails to parse the part of the spec where the leak
 * is would be worse than no gate at all, so this parser never guesses.
 */

import { readFileSync } from "node:fs";

export type YamlScalar = string | number | boolean | null;
export type YamlValue = YamlScalar | YamlValue[] | YamlMapping;
export interface YamlMapping {
  [key: string]: YamlValue;
}

/** `key:` or `key: rest`. The key is quoted, or runs to the FIRST colon. */
const KEY_LINE = /^(\s*)('[^']*'|"[^"]*"|[^\s:][^:]*?):(?:[ \t]+(.*?))?\s*$/;
/** `- `, `-` alone, or `- rest`. */
const SEQ_LINE = /^(\s*)-(?:[ \t]+(.*?))?\s*$/;
const BLOCK_SCALAR = /^[|>][-+]?$/;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

/** A comment only when the line is nothing but a comment — no inline `#` in this spec. */
function isComment(line: string): boolean {
  return line.trimStart().startsWith("#");
}

function unquote(token: string): string | undefined {
  if (token.length >= 2 && token.startsWith("'") && token.endsWith("'")) {
    return token.slice(1, -1).replaceAll("''", "'");
  }
  if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
    return token.slice(1, -1);
  }
  return undefined;
}

function splitFlowItems(inner: string, lineNo: number): string[] {
  const items: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (const char of inner) {
    if (quote !== undefined) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === "[" || char === "{") {
      throw new Error(`line ${lineNo}: nested flow collections are not supported`);
    }
    if (char === ",") {
      items.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (quote !== undefined) throw new Error(`line ${lineNo}: unterminated quote in flow sequence`);
  const last = current.trim();
  if (last.length > 0 || items.length > 0) items.push(last);
  return items.filter((item, index) => !(item === "" && index === items.length - 1));
}

function parseScalar(raw: string, lineNo: number): YamlValue {
  const token = raw.trim();
  if (token.startsWith("&") || token.startsWith("*") || token.startsWith("!")) {
    throw new Error(`line ${lineNo}: anchors, aliases and tags are not supported (${token})`);
  }
  if (token.startsWith("[")) {
    if (!token.endsWith("]")) {
      throw new Error(`line ${lineNo}: multi-line flow sequences are not supported`);
    }
    return splitFlowItems(token.slice(1, -1), lineNo).map((item) => parseScalar(item, lineNo));
  }
  if (token.startsWith("{")) {
    if (token.replaceAll(" ", "") !== "{}") {
      throw new Error(`line ${lineNo}: non-empty flow mappings are not supported`);
    }
    return {};
  }
  const unquoted = unquote(token);
  if (unquoted !== undefined) return unquoted;
  if (token === "null" || token === "~" || token === "") return null;
  if (token === "true") return true;
  if (token === "false") return false;
  if (/^-?\d+$/.test(token)) return Number.parseInt(token, 10);
  if (/^-?\d*\.\d+$/.test(token)) return Number.parseFloat(token);
  return token;
}

interface Parser {
  readonly lines: readonly string[];
  index: number;
}

/** Advances past blank and comment lines. Returns false at end of document. */
function skipFiller(parser: Parser): boolean {
  while (parser.index < parser.lines.length) {
    const line = parser.lines[parser.index] ?? "";
    if (!isBlank(line) && !isComment(line)) return true;
    parser.index += 1;
  }
  return false;
}

/** Consumes a `|`/`>` block, returning its text. Content is anything indented deeper than `indent`. */
function readBlockScalar(parser: Parser, indent: number): string {
  const collected: string[] = [];
  while (parser.index < parser.lines.length) {
    const line = parser.lines[parser.index] ?? "";
    if (isBlank(line)) {
      collected.push("");
      parser.index += 1;
      continue;
    }
    if (indentOf(line) <= indent) break;
    collected.push(line.trimStart());
    parser.index += 1;
  }
  return collected.join("\n").trim();
}

function parseSequence(parser: Parser, indent: number): YamlValue[] {
  const items: YamlValue[] = [];
  while (skipFiller(parser)) {
    const line = parser.lines[parser.index] ?? "";
    if (indentOf(line) !== indent) break;
    const match = SEQ_LINE.exec(line);
    if (match === null) break;
    const lineNo = parser.index + 1;
    const rest = match[2];
    if (rest === undefined || rest.length === 0) {
      parser.index += 1;
      items.push(parseNode(parser, indent + 1));
      continue;
    }
    // `- key: value` is a mapping whose first key sits two columns in. Rewriting
    // the dash to spaces keeps every column intact, so the mapping parser sees
    // the item exactly as it is written.
    if (KEY_LINE.test(`${" ".repeat(indent + 2)}${rest}`)) {
      const rewritten = [...parser.lines];
      rewritten[parser.index] = `${" ".repeat(indent + 2)}${rest}`;
      const nested: Parser = { lines: rewritten, index: parser.index };
      items.push(parseMapping(nested, indent + 2));
      parser.index = nested.index;
      continue;
    }
    items.push(parseScalar(rest, lineNo));
    parser.index += 1;
  }
  return items;
}

function parseMapping(parser: Parser, indent: number): YamlMapping {
  const mapping: YamlMapping = {};
  while (skipFiller(parser)) {
    const line = parser.lines[parser.index] ?? "";
    if (indentOf(line) < indent) break;
    if (indentOf(line) > indent) {
      throw new Error(`line ${parser.index + 1}: unexpected indentation (expected ${indent})`);
    }
    // A dash at this indent is a sequence item belonging to the caller. Checked
    // BEFORE the key match on purpose: `- name: admin` satisfies both patterns,
    // and reading it as a key called "- name" would silently lose the item.
    if (SEQ_LINE.test(line)) break;
    const match = KEY_LINE.exec(line);
    if (match === null) {
      throw new Error(`line ${parser.index + 1}: not a mapping entry: ${line.trim()}`);
    }
    const rawKey = match[2] ?? "";
    const key = unquote(rawKey) ?? rawKey;
    const rest = match[3];
    const lineNo = parser.index + 1;
    parser.index += 1;

    if (rest !== undefined && BLOCK_SCALAR.test(rest)) {
      mapping[key] = readBlockScalar(parser, indent);
      continue;
    }
    if (rest !== undefined && rest.length > 0) {
      mapping[key] = parseScalar(rest, lineNo);
      continue;
    }
    mapping[key] = parseNode(parser, indent + 1);
  }
  return mapping;
}

/** A mapping, a sequence or `null` — whatever sits at or beyond `minIndent`. */
function parseNode(parser: Parser, minIndent: number): YamlValue {
  if (!skipFiller(parser)) return null;
  const line = parser.lines[parser.index] ?? "";
  const indent = indentOf(line);
  if (indent < minIndent) return null;
  if (SEQ_LINE.test(line)) return parseSequence(parser, indent);
  return parseMapping(parser, indent);
}

/** The whole document as plain JS values. Throws, with a line number, on anything unsupported. */
export function parseYamlDocument(text: string): YamlMapping {
  const lines = text.split("\n");
  for (const [offset, line] of lines.entries()) {
    if (line.trimStart().startsWith("---") || line.trimStart().startsWith("...")) {
      throw new Error(`line ${offset + 1}: multi-document streams are not supported`);
    }
  }
  const parser: Parser = { lines, index: 0 };
  const document = parseMapping(parser, 0);
  if (skipFiller(parser)) {
    throw new Error(`line ${parser.index + 1}: trailing content after the document`);
  }
  return document;
}

export function parseYamlFile(path: string): YamlMapping {
  return parseYamlDocument(readFileSync(path, "utf8"));
}

/** Accepts `undefined` because `noUncheckedIndexedAccess` makes every mapping read optional. */
export function isMapping(value: YamlValue | undefined): value is YamlMapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
