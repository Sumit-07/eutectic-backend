/**
 * Hand-declared Node built-ins, exactly the surface this package's tests use.
 *
 * NOT a substitute for `@types/node` and not an attempt at one. D-010 recorded
 * the decision for `packages/tokens`: `@types/node` is NOT added yet
 * (CLAUDE.md rule 12 — no new dependency without Fable's approval), a hand
 * declared surface is used instead, and the whole question is revisited at
 * M0-SH-05 where approving it workspace-wide is expected. This file follows
 * that precedent rather than reopening it inside a backend ticket.
 *
 * `@eutectic/db` typechecks without this only by accident: `graphile-worker`
 * pulls in `@types/pg`, which pulls in `@types/node`, which pnpm links into
 * that package's own `node_modules`. This package depends on neither, so it
 * gets nothing — which is the honest state of affairs, not a regression.
 *
 * DELETE THIS FILE when M0-SH-05 approves `@types/node`. Nothing outside the
 * tests reads it: `src/catalogue.ts`, `src/payloads.ts`, `src/event.ts` and
 * `src/write-event.ts` import no Node built-in at all.
 */

declare module "node:assert/strict" {
  interface AssertStrict {
    (value: unknown, message?: string | Error): asserts value;
    ok(value: unknown, message?: string | Error): asserts value;
    equal(actual: unknown, expected: unknown, message?: string | Error): void;
    notEqual(actual: unknown, expected: unknown, message?: string | Error): void;
    deepEqual(actual: unknown, expected: unknown, message?: string | Error): void;
    match(value: string, regExp: RegExp, message?: string | Error): void;
    rejects(
      block: (() => Promise<unknown>) | Promise<unknown>,
      error?: RegExp | ((error: unknown) => boolean),
      message?: string | Error,
    ): Promise<void>;
    fail(message?: string | Error): never;
  }
  const assert: AssertStrict;
  export default assert;
}

declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  export function describe(name: string, fn: TestFn): void;
  export function it(name: string, fn: TestFn): void;
  export function before(fn: TestFn): void;
  export function after(fn: TestFn): void;
}

declare module "node:crypto" {
  export function randomUUID(): string;
}

declare module "node:timers/promises" {
  export function setTimeout(delayMs: number): Promise<void>;
}
