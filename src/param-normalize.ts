/**
 * CP-3752 — shared parameter normalization for the outline plugin.
 *
 * The OpenClaw tool schema is the first gate an agent's arguments pass
 * through, and it used to be strict about types: `id` had to be a string
 * and `limit` / `offset` had to be integers. An agent that guessed wrong
 * (a numeric id, a numeric string for `limit`, an id copied with
 * surrounding whitespace) got a schema-level rejection (`must be string`
 * / `must be integer`) before the plugin ever ran.
 *
 * This module centralizes the lenient-but-safe normalization that BOTH
 * call paths share (the OpenClaw MCP tools in `src/index.ts` and the
 * `outline-tool` CLI in `src/cli.ts`):
 *
 *   - ID parameters (`id`, `collectionId`, `parentDocumentId`,
 *     `documentId`, …) accept a string or an integer and are normalized
 *     to a trimmed string. Objects / arrays / booleans / null /
 *     non-integer numbers are rejected with an explicit error — they are
 *     never coerced through `String(value)`.
 *   - Pagination parameters (`limit`, `offset`) accept a number or a
 *     numeric string. Numeric-but-invalid values (non-integer, below the
 *     minimum) are rejected; values above the maximum are clamped (never
 *     rejected) so an over-large page size degrades instead of failing.
 *
 * Content parameters (`title`, `text`, `query`, `url`, `path`, `name`,
 * `changelog`, `findText`, …) are deliberately NOT handled here: they
 * stay byte-exact so the patch guardrail (`src/patch-guard.ts`) keeps
 * comparing the submitted text verbatim (CP-3689).
 */

/**
 * Maximum page size accepted by the Outline REST API.
 *
 * Source: outline server `shared/constants.ts` → `Pagination.maxLimit`
 * (100); the pagination middleware rejects `limit > maxLimit` with
 * `Pagination limit is too large (max 100)`. We clamp instead of
 * rejecting so an over-large page size degrades to the server maximum
 * rather than failing the call.
 */
export const OUTLINE_MAX_LIMIT = 100;

/**
 * Maximum number of revisions returned by `outline_rev_log`.
 *
 * Pre-existing plugin contract (`limit` default 5, max 20) — kept as the
 * clamp ceiling for `revisions.list`.
 */
export const REV_LOG_MAX_LIMIT = 20;

export type NormalizeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function ok<T>(value: T): NormalizeResult<T> {
  return { ok: true, value };
}

function fail<T>(error: string): NormalizeResult<T> {
  return { ok: false, error };
}

/**
 * Normalize an ID-like parameter to a trimmed string.
 *
 * Accepts:
 *   - a string (trimmed; empty / whitespace-only is rejected)
 *   - an integer (converted to its decimal string)
 *
 * Rejects everything else — objects, arrays, booleans, null, NaN,
 * Infinity and non-integer numbers — with an explicit error. The error
 * never contains a `String(value)` of the offending input.
 */
export function normalizeId(
  value: unknown,
  label: string,
): NormalizeResult<string> {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return fail(`\`${label}\` must be a non-empty string.`);
    }
    return ok(trimmed);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      return fail(
        `\`${label}\` must be an integer (or a string containing an integer).`,
      );
    }
    return ok(String(value));
  }
  return fail(
    `\`${label}\` must be a string or an integer (objects, arrays, booleans and null are not accepted).`,
  );
}

/**
 * Normalize an optional ID-like parameter.
 *
 * `undefined` / `null` → `undefined` (caller decides whether the
 * parameter is required). Anything else is delegated to `normalizeId`.
 */
export function normalizeOptionalId(
  value: unknown,
  label: string,
): NormalizeResult<string | undefined> {
  if (value === undefined || value === null) return ok(undefined);
  const result = normalizeId(value, label);
  return result.ok ? ok(result.value) : fail(result.error);
}

/**
 * Normalize a pagination parameter (`limit` / `offset`).
 *
 * Accepts a number or a numeric string (with optional surrounding
 * whitespace).
 *
 * Failure modes (all rejected with an explicit error):
 *   - a numeric value that is not an integer (`1.5`, `"1.5"`)
 *   - a numeric value below `min` (`0` for limit, `-1` for offset)
 *   - a value of an unsupported type (object / array / boolean)
 *
 * A string that is not numeric at all (`"not-a-number"`) falls back to
 * the default — that is the pre-existing plugin contract
 * (`pickNumber(args.limit, 25)`), preserved verbatim so the CLI and the
 * MCP path keep behaving identically.
 *
 * A value above `max` is clamped to `max` (never rejected).
 */
export function normalizePagination(
  value: unknown,
  opts: { label: string; fallback: number; min: number; max?: number },
): NormalizeResult<number> {
  const { label, fallback, min } = opts;
  const max = opts.max;

  if (value === undefined || value === null) return ok(fallback);

  let parsed: number;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return fail(`\`${label}\` must be a finite integer.`);
    }
    parsed = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return ok(fallback);
    const asNumber = Number(trimmed);
    if (!Number.isFinite(asNumber)) {
      // Not numeric at all — pre-existing contract: fall back to the
      // default instead of failing the call.
      return ok(fallback);
    }
    parsed = asNumber;
  } else {
    return fail(
      `\`${label}\` must be an integer (or a numeric string) — objects, arrays and booleans are not accepted.`,
    );
  }

  if (!Number.isInteger(parsed)) {
    return fail(`\`${label}\` must be an integer — got ${parsed}.`);
  }
  if (!Number.isSafeInteger(parsed)) {
    return fail(`\`${label}\` must be a safe integer.`);
  }
  if (parsed < min) {
    return fail(`\`${label}\` must be >= ${min} — got ${parsed}.`);
  }
  if (max !== undefined && parsed > max) {
    return ok(max);
  }
  return ok(parsed);
}

/**
 * Normalize a `limit` parameter.
 */
export function normalizeLimit(
  value: unknown,
  opts: { label: string; fallback: number; max: number; min?: number },
): NormalizeResult<number> {
  return normalizePagination(value, {
    label: opts.label,
    fallback: opts.fallback,
    min: opts.min ?? 1,
    max: opts.max,
  });
}

/**
 * Normalize an `offset` parameter. `offset` has no upper bound in the
 * Outline pagination middleware, so it is only lower-bounded.
 */
export function normalizeOffset(
  value: unknown,
  opts: { label: string; fallback: number; min?: number },
): NormalizeResult<number> {
  return normalizePagination(value, {
    label: opts.label,
    fallback: opts.fallback,
    min: opts.min ?? 0,
  });
}
