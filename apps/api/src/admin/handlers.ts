/**
 * The `/v1/admin/*` handlers (P-09, D-029, D-040, DIRECTIVE §3 and §5).
 *
 * Three operations, replacing three `501` stubs by the body-swap seam
 * `handlers.ts` was built for: the contract's generated handler types check the
 * params, the body and the reply shape against `openapi.yaml`, so nothing here
 * asserts a wire shape by hand.
 *
 * THIS MODULE IS THE ONLY PLACE IN THE APP THAT MAY IMPORT
 * `serializeAdminUser`, and `__tests__/user-serializer.test.ts` enforces
 * exactly that: P-02-BE's guard used to assert the admin serializer was
 * imported by NOTHING (it had no route yet); this ticket narrows it to "by
 * admin handler code only". The containment invariant survives the wiring —
 * what retires is the "unused" half of it, which was always a placeholder for
 * this ticket.
 *
 * NOTE WHAT IS NOT HERE: not one GitHub column name. `findAdminUser` lives in
 * `@eutectic/db` and hands back a camelCase record that goes straight into the
 * serializer, so the D-029 source-tree guard (`/github[_A-Z]/` over every
 * production file in `apps/api/src`) keeps its full strength even though this
 * app now serves the route that returns those fields. See
 * `packages/db/src/admin-users.ts` for the argument.
 *
 * ERRORS ARE TRANSLATED, NOT INVENTED. `@eutectic/db`'s settings service
 * raises three typed errors and each maps to exactly one contract status:
 * unknown key → `404`, bad value → `422` (carrying the service's own structured
 * issues as `details`), corrupt stored row → nothing caught, so `app.ts`
 * renders it as `500`. The mapping is a `switch`-shaped chain rather than a
 * `catch (e) { throw new ApiFailure(400, ...) }`, because an error this module
 * does not recognise must reach the `500` path rather than be flattened into a
 * client-blaming status.
 */

import {
  findAdminUser,
  isSettingNotFoundError,
  isSettingValueError,
  listPlatformSettings as listSettingsFromDb,
  updatePlatformSetting as updateSettingInDb,
  type PlatformSettingRecord,
  type SettingsCache,
  type Sql,
} from "@eutectic/db";
import type { Schemas } from "@eutectic/contracts";
import type {
  GetAdminUserHandler,
  ListPlatformSettingsHandler,
  UpdatePlatformSettingHandler,
} from "@eutectic/contracts/server";

import { requireActingAdmin } from "../auth/admin-context.js";
import { ApiFailure } from "../errors.js";
import { serializeAdminUser } from "../serializers/user.js";

export interface AdminHandlerOptions {
  /**
   * The pool. `Sql` rather than `ISql` because `updatePlatformSetting` opens
   * its own transaction (the value change and the audit row are one unit).
   */
  readonly sql: Sql;
  /**
   * The settings cache view, already namespaced by the caller. Optional: with
   * no cache every read goes to Postgres, which is correct but slower, and is
   * what a test that is not exercising the cache wants.
   */
  readonly cache?: SettingsCache;
  /**
   * The clock. A handler is the edge where a clock may legitimately be read;
   * everything below it takes `now` explicitly (D-014). Injectable so a test
   * can assert an exact `updated_at`.
   */
  readonly now?: () => Date;
}

/**
 * A syntactically possible user id.
 *
 * `routes.ts` deliberately performs NO request validation ("Fastify schemas
 * derived from the contract are another ticket's business"), so `params.userId`
 * reaches this module exactly as it appeared in the URL. Handed to Postgres,
 * `/v1/admin/users/nonsense` raises `invalid input syntax for type uuid` and
 * renders as a `500` — a server error for a client mistake, and a `500` an
 * unauthenticated caller cannot reach but an allowlisted admin can trip by
 * mistyping. `getAdminUser` declares no `400` in the contract, and `404` is
 * defined there as "the id has never existed", which is exactly and
 * unarguably true of a string that is not a uuid. So: `404`.
 *
 * Spelled here rather than imported from `auth/allowlist.ts` — that one guards
 * an env var at boot and answers to a different ticket; sharing a regex would
 * couple two unrelated failure modes.
 */
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `PlatformSettingRecord` → the contract's `PlatformSetting`. */
function toWire(record: PlatformSettingRecord): Schemas["PlatformSetting"] {
  return {
    key: record.key,
    value: record.value,
    value_type: record.valueType,
    description: record.description,
    min_value: record.minValue,
    max_value: record.maxValue,
    updated_by: record.updatedBy,
    updated_at: record.updatedAt,
  };
}

/**
 * The three handlers, bound to one set of collaborators.
 *
 * A factory rather than module-level constants because the pool, the cache and
 * the clock are all injected — the same reason `buildApp` takes handlers at
 * all. `handlers.ts` composes the result over `stubHandlers`.
 */
export function createAdminHandlers(options: AdminHandlerOptions): {
  listPlatformSettings: ListPlatformSettingsHandler;
  updatePlatformSetting: UpdatePlatformSettingHandler;
  getAdminUser: GetAdminUserHandler;
} {
  const { sql, cache } = options;
  const clock = options.now ?? ((): Date => new Date());
  const settingsOptions = { cache };

  /**
   * The whole table, unpaginated — D-040's deliberate choice, restated in the
   * contract: "the set is seeded and bounded at a few dozen rows, and the
   * admin settings page renders all of it at once". No cursor to thread and
   * no `PageInfo` to fake.
   */
  const listPlatformSettings: ListPlatformSettingsHandler = async () => {
    const settings = await listSettingsFromDb(sql, settingsOptions);
    return { items: settings.map(toWire) };
  };

  const updatePlatformSetting: UpdatePlatformSettingHandler = async (request) => {
    // The acting admin comes from the gate's AsyncLocalStorage context, not
    // from anything the client sent. See `auth/admin-context.ts`.
    const adminUserId = requireActingAdmin();

    // Same reason as `USER_ID_PATTERN`: nothing validated the body. A body that
    // is not an object, or one with no `value` property at all, fails the
    // CONTRACT's own `required: [value]` — a malformed request, `400`. That is
    // a different failure from a `value` that is present and wrong for the
    // row's `value_type`, which is the service's `422`. Note that `value: null`
    // is well-formed here (the property has no declared type) and correctly
    // falls through to the service, which rejects it as a type mismatch.
    const body: unknown = request.body;
    if (typeof body !== "object" || body === null || !("value" in body)) {
      throw new ApiFailure(400, "bad_request", "the request body must have a value property");
    }

    try {
      const updated = await updateSettingInDb(
        sql,
        {
          key: request.params.key,
          value: request.body.value,
          adminUserId,
          now: clock(),
        },
        settingsOptions,
      );
      return toWire(updated);
    } catch (error) {
      throw translateSettingError(error, request.params.key);
    }
  };

  const getAdminUser: GetAdminUserHandler = async (request) => {
    const userId = request.params.userId;
    if (!USER_ID_PATTERN.test(userId)) {
      throw new ApiFailure(404, "not_found", "no such user");
    }

    const record = await findAdminUser(sql, userId);
    // `null` means the id has never existed. A TOMBSTONED user is a row, and
    // it is returned with `deleted: true` — D-040 and the contract are
    // explicit that admins see the record, because moderation attaches to an
    // account that no longer posts.
    if (record === null) throw new ApiFailure(404, "not_found", "no such user");
    return serializeAdminUser(record);
  };

  return { listPlatformSettings, updatePlatformSetting, getAdminUser };
}

/**
 * The service's typed errors, as contract statuses. Anything unrecognised is
 * RETURNED UNCHANGED so it reaches `app.ts`'s `500` path — including
 * `SettingDataError`, which means a stored row is corrupt and is emphatically
 * not the caller's fault.
 */
function translateSettingError(error: unknown, key: string): unknown {
  if (isSettingNotFoundError(error)) {
    // Never an upsert (D-040): an unknown key is a `404`, not a created row.
    return new ApiFailure(404, "not_found", `no setting named ${key}`, { cause: error });
  }

  if (isSettingValueError(error)) {
    return new ApiFailure(422, "unprocessable", "the value is not valid for this setting", {
      // `SettingIssue` was shaped for `ErrorDetail`: `field` / machine-readable
      // `issue` / human `detail`. Passed through rather than re-worded, so the
      // admin UI can branch on `out_of_range` and still render a sentence.
      details: error.issues.map((issue) => ({
        field: issue.field,
        issue: issue.issue,
        detail: issue.detail,
      })),
      cause: error,
    });
  }

  return error;
}
