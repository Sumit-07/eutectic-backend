/**
 * Drizzle table definitions for migration 0008 (ticket M0-BE-09).
 *
 * Mirrors `migrations/0008_grants_products_findings.sql` exactly — all ten
 * tables: grants, repos, reviews, products, connections, sessions_, findings,
 * finding_events, residencies, deploy_signals. This file is
 * documentation-as-types for `@eutectic/db` consumers; **the SQL migration is
 * authoritative** — drizzle-kit is not wired into the runner (see
 * `drizzle.config.ts`), so nothing here shapes the database.
 *
 * `grants` carries the system-design §1 seam: `targetType` + `targetId`
 * ('repo' | 'product') let one table serve both a repo grant and a product
 * grant.
 *
 * The three named `unique()` constraints below are for the names Postgres
 * generates from the migration's inline `UNIQUE (...)` — verified against
 * `pg_constraint` in a scratch schema, the convention `threads.ts` and
 * `diaries.ts` document: `repos_github_repo_id_key`,
 * `reviews_repo_id_pr_number_agent_id_key`,
 * `residencies_product_id_agent_id_key`.
 */

import { bigint, boolean, integer, jsonb, pgTable, smallint, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { agents } from "./agents.js";
import { contributions } from "./threads.js";
import { users } from "./identity.js";

/**
 * SD §1's second seam row: a repo grant and a product grant are the same
 * shape — a user handing an agent scoped, revocable access to something the
 * user owns — so `targetType` + `targetId` let one table serve both instead
 * of forking into two. No CHECK on `targetType` (comment only, D-011's ink
 * reasoning): a third grantable object must not require a migration.
 * `scopes` is `text[]`. Revocation is an UPDATE that flips `revokedAt` in
 * place, never a DELETE — hence `updatedAt` alongside SD's own `grantedAt`.
 */
export const grants = pgTable("grants", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  targetType: text("target_type").notNull(), // 'repo' | 'product' (SD §1 seam; comment only, no CHECK)
  targetId: uuid("target_id").notNull(),
  scopes: text("scopes").array().notNull(),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

/**
 * One row per installed GitHub repo. `fullName` and `installationId` track
 * GitHub's own state and mutate in place, hence `updatedAt`. `githubRepoId`
 * is the stable external key GitHub never reassigns, so it is the UNIQUE.
 */
export const repos = pgTable("repos", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  githubRepoId: bigint("github_repo_id", { mode: "bigint" }).notNull().unique(),
  fullName: text("full_name").notNull(),
  installationId: bigint("installation_id", { mode: "bigint" }).notNull(),
});

/**
 * A filed review is an immutable record once written — no `updatedAt`.
 * `unprompted` distinguishes an agent reviewing on its own initiative from
 * one asked to; `files`/`adds`/`dels` are nullable, exactly as SD writes them.
 * Named for the constraint Postgres generates from the migration's inline
 * `UNIQUE (repo_id, pr_number, agent_id)`: one review per agent per PR.
 */
export const reviews = pgTable(
  "reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    prNumber: integer("pr_number").notNull(),
    contributionId: uuid("contribution_id")
      .notNull()
      .references(() => contributions.id),
    unprompted: boolean("unprompted").notNull().default(true),
    files: integer("files"),
    adds: integer("adds"),
    dels: integer("dels"),
  },
  (table) => [
    unique("reviews_repo_id_pr_number_agent_id_key").on(table.repoId, table.prNumber, table.agentId),
  ],
);

/**
 * A thing the user owns that an agent can be resident in and work on — the
 * residency surface's root. `sandboxDeclaration` is the allowed-hosts /
 * destructive-verb denylist the sandbox is bound to; `dryRunApprovedAt`
 * starts null and is set later, in place, once a dry run clears — residency
 * stays blocked until then — hence `updatedAt`.
 */
export const products = pgTable("products", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  ownerUserId: uuid("owner_user_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  purpose: text("purpose").notNull(),
  sandboxDeclaration: jsonb("sandbox_declaration").notNull(), // allowed hosts, destructive-verb denylist
  dryRunApprovedAt: timestamp("dry_run_approved_at", { withTimezone: true }), // residency blocked until set
});

/**
 * How an agent actually reaches a product. `credentialsRef` is a KMS
 * reference, never the secret — the secret itself never touches this table.
 * `verifiedAt` starts null and is set later, in place, hence `updatedAt`.
 */
export const connections = pgTable("connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id),
  kind: text("kind").notNull(), // 'mcp' | 'http' | 'cli' | 'browser' (comment only, no CHECK)
  endpoint: text("endpoint").notNull(),
  credentialsRef: text("credentials_ref"), // KMS reference, never the secret
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
});

/**
 * The exported name is `productSessions`, not `sessions` — the table itself
 * is named `sessions_`, trailing underscore and all, SD's deliberate
 * disambiguation from the auth `sessions` table (`identity.ts`, migration
 * 0001), which is an unrelated concept (a login token, not an agent's working
 * session inside a product). One row per agent working a product for one
 * task; `endedAt`/`outcome`/`stalledStep` are set at close, in place, hence
 * `updatedAt`. `transcriptRef` is an object storage key (SD §0: output only,
 * no full reasoning traces retained).
 */
export const productSessions = pgTable("sessions_", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id),
  task: text("task").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  outcome: text("outcome"), // 'completed'|'stalled'|'error'|'refused' (comment only, no CHECK)
  stalledStep: smallint("stalled_step"),
  stepsTotal: smallint("steps_total"),
  transcriptRef: text("transcript_ref"), // object storage key
  runnerId: text("runner_id"),
});

/**
 * What a session turns up. `state` starts 'open' and mutates in place, hence
 * `updatedAt`. The seven states SD names: open|fixed|confirmed|reopened|
 * ignored|disputed|stale — comment only, deliberately no CHECK (D-011's ink
 * reasoning). Finding state transitions are guarded by row lock + transition
 * whitelist in the service layer, not by the schema — `findingEvents` is the
 * audit trail those guarded transitions write to.
 */
export const findings = pgTable("findings", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id),
  sessionId: uuid("session_id").references(() => productSessions.id),
  title: text("title").notNull(),
  body: text("body").notNull(),
  severity: smallint("severity").notNull(),
  state: text("state").notNull().default("open"),
  // open|fixed|confirmed|reopened|ignored|disputed|stale (comment only, no CHECK)
});

/**
 * Append-only log of every state change a finding goes through — no
 * `updatedAt`. `fromState` is nullable (the row created when a finding opens
 * has no prior state); `toState` is always known. `actorId` is deliberately
 * un-FK'd because it is polymorphic across actor types (agent, user, system),
 * same shape as SD's other polymorphic refs (SD §1).
 */
export const findingEvents = pgTable("finding_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  findingId: uuid("finding_id")
    .notNull()
    .references(() => findings.id),
  fromState: text("from_state"),
  toState: text("to_state").notNull(),
  actorType: text("actor_type").notNull(),
  actorId: uuid("actor_id"),
  note: text("note"),
});

/**
 * One row per (product, agent): SD gives this table a UNIQUE, not a PRIMARY
 * KEY, so it gets the standard surrogate `id` like every other table in this
 * migration (D-013) while the UNIQUE (product_id, agent_id) still stands.
 * Named for the constraint Postgres generates from the migration's inline
 * `UNIQUE (product_id, agent_id)`. `active` flips and `lastRetestAt` mutates
 * in place, hence `updatedAt`.
 */
export const residencies = pgTable(
  "residencies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    active: boolean("active").notNull().default(true),
    lastRetestAt: timestamp("last_retest_at", { withTimezone: true }),
  },
  (table) => [unique("residencies_product_id_agent_id_key").on(table.productId, table.agentId)],
);

/**
 * Append-only: every inbound signal that a product deployed is its own row,
 * never edited — no `updatedAt`. `source` names the channel (comment only, no
 * CHECK); `creditCost` is what the signal cost to observe.
 */
export const deploySignals = pgTable("deploy_signals", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id),
  source: text("source").notNull(), // 'webhook'|'poll'|'owner_declared' (comment only, no CHECK)
  ref: text("ref"),
  creditCost: integer("credit_cost").notNull().default(0),
});
