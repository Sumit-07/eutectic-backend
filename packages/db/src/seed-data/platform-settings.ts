/**
 * Platform settings — the bootstrap posture (P-01, DIRECTIVE §3; D-033, D-036).
 *
 * As with `reserved-handles.ts`, this module is the CANONICAL LIST and
 * migration 0013 seeds exactly the same rows with the same `ON CONFLICT DO
 * NOTHING` semantics; `migration-0013.test.ts` asserts the two agree.
 *
 * The settings SERVICE — Redis cache, 60s TTL, `admin_audit` on every write,
 * range validation against `min_value`/`max_value` — is P-09, not this ticket.
 * What lands here is the table's contents on day one, so that P-09 and the
 * router read a populated table rather than inventing constants.
 *
 * `ON CONFLICT DO NOTHING` is the whole safety property: reseeding after an
 * admin has lowered `routing.coverage_target` must never put it back to 6.
 */

import type { Sql } from "postgres";

/** How the settings service coerces `value`. Text in the database (D-013). */
export type PlatformSettingValueType = "bool" | "int" | "float";

export interface PlatformSetting {
  readonly key: string;
  /** Stored as jsonb. `bool` → boolean, `int`/`float` → number. */
  readonly value: boolean | number;
  readonly valueType: PlatformSettingValueType;
  readonly description: string;
  /** Inclusive bound enforced by the admin UI and the settings service. Null for booleans. */
  readonly minValue: number | null;
  readonly maxValue: number | null;
}

/**
 * Bootstrap values, DIRECTIVE §3's table verbatim.
 *
 * The ranges are this ticket's judgment, not the directive's — it gives values
 * but no bounds, and `min_value`/`max_value` exist to stop an admin typing a
 * digit too many into the most expensive control in the product. Each bound is
 * a *sanity* limit, deliberately wider than any value we expect to use: the
 * operational judgment about what is sensible lives in the admin UI's preview
 * ("estimated cost at current volume"), not in a constraint that would need a
 * migration to relax.
 */
export const BOOTSTRAP_PLATFORM_SETTINGS: readonly PlatformSetting[] = [
  {
    key: "routing.coverage_target",
    value: 6,
    valueType: "int",
    description: "Substantive contributions every post is guaranteed within the coverage window. Lowering this is how bootstrap mode ends; 0 is pure choice-based routing.",
    minValue: 0,
    // No post can draw more responses than there are agents; 50 is far above
    // any plausible roster and is a typo guard, not a policy.
    maxValue: 50,
  },
  {
    key: "routing.coverage_window_hours",
    value: 6,
    valueType: "int",
    description: "How long a post has to reach its coverage target before the guarantee is considered missed.",
    minValue: 1,
    maxValue: 168,
  },
  {
    key: "routing.discretionary_enabled",
    value: true,
    valueType: "bool",
    description: "Agents spend leftover budget on posts they choose. Off means coverage only, and the choosing signal disappears.",
    minValue: null,
    maxValue: null,
  },
  {
    key: "routing.exploration_rate",
    value: 0.25,
    valueType: "float",
    description: "Share of picks made ignoring affinity entirely, so the panel is not predictable from the topic.",
    minValue: 0,
    maxValue: 1,
  },
  {
    key: "routing.affinity_enabled",
    value: true,
    valueType: "bool",
    description: "Apply the 0.7-1.3 affinity weight when scoring candidates. A soft weight only, never a gate.",
    minValue: null,
    maxValue: null,
  },
  {
    key: "routing.decline_counts_as_coverage",
    value: false,
    valueType: "bool",
    description: "Whether a published decline counts toward the coverage target. False: it fills the thread but not the guarantee.",
    minValue: null,
    maxValue: null,
  },
  {
    key: "signup.tier_gate_enabled",
    value: false,
    valueType: "bool",
    description: "Gate posting on GitHub account age and public repos. False at launch: everyone posts. Tiers 2 and 3 stay gated regardless.",
    minValue: null,
    maxValue: null,
  },
  {
    key: "signup.min_account_age_days",
    value: 90,
    valueType: "int",
    description: "Minimum GitHub account age for tier 1, applied only when the tier gate is on.",
    minValue: 0,
    maxValue: 3650,
  },
  {
    key: "signup.min_public_repos",
    value: 1,
    valueType: "int",
    description: "Minimum public repositories for tier 1, applied only when the tier gate is on.",
    minValue: 0,
    maxValue: 1000,
  },
  {
    key: "budget.daily_cents_per_agent",
    value: 500,
    valueType: "int",
    description: "Per-agent daily inference ceiling in cents. Alert at 80% (budget.md).",
    minValue: 0,
    // $1000/agent/day. A ceiling on the ceiling: the whole point of this
    // setting is that spend cannot run away from a typo.
    maxValue: 100000,
  },
];

export interface SyncPlatformSettingsOptions {
  /** Schema to write into. Defaults to `public`; tests pass a scratch schema. */
  readonly schema?: string;
  /** Settings to apply. Defaults to `BOOTSTRAP_PLATFORM_SETTINGS`. */
  readonly settings?: readonly PlatformSetting[];
}

/**
 * Insert any missing settings rows, leaving existing ones exactly as they are.
 *
 * Never an upsert. An admin-changed value is the operator's decision and a
 * deploy must not silently revert it; a genuine change to a *default* is a new
 * migration with an explicit UPDATE, which is visible in review. Returns the
 * keys this call actually inserted.
 */
export async function syncPlatformSettings(
  sql: Sql,
  options: SyncPlatformSettingsOptions = {},
): Promise<readonly string[]> {
  const schema = options.schema ?? "public";
  const settings = options.settings ?? BOOTSTRAP_PLATFORM_SETTINGS;
  const inserted: string[] = [];

  for (const setting of settings) {
    // `sql.json` binds a jsonb parameter directly — never a stringified value
    // into a cast, which lands a jsonb string scalar (jsonb-double-encode-guard).
    const rows = await sql<{ key: string }[]>`
      INSERT INTO ${sql(schema)}.${sql("platform_settings")}
        (key, value, value_type, description, min_value, max_value)
      VALUES (${setting.key}, ${sql.json(setting.value)}, ${setting.valueType}, ${setting.description},
              ${setting.minValue}, ${setting.maxValue})
      ON CONFLICT (key) DO NOTHING
      RETURNING key
    `;
    if (rows.length > 0) inserted.push(setting.key);
  }

  return inserted;
}
