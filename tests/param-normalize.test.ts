// CP-3752 — unit tests for the shared parameter-normalization helpers
// (`src/param-normalize.ts`).
//
// These helpers are used by BOTH call paths (the OpenClaw MCP tools in
// `src/index.ts` and the `outline-tool` CLI in `src/cli.ts`), so the two
// paths cannot drift on ID / pagination handling.

import { describe, expect, test } from "vitest";
import {
  normalizeId,
  normalizeLimit,
  normalizeOffset,
  normalizeOptionalId,
  OUTLINE_MAX_LIMIT,
  REV_LOG_MAX_LIMIT,
} from "../src/param-normalize";

describe("CP-3752: param-normalize helpers", () => {

  describe("AC5 — shared normalization helpers", () => {
    test("normalizeId accepts strings and integers, trims, and rejects the rest", () => {
      expect(normalizeId("abc", "id")).toEqual({ ok: true, value: "abc" });
      expect(normalizeId("  abc  ", "id")).toEqual({ ok: true, value: "abc" });
      expect(normalizeId(42, "id")).toEqual({ ok: true, value: "42" });
      expect(normalizeId("   ", "id").ok).toBe(false);
      expect(normalizeId({}, "id").ok).toBe(false);
      expect(normalizeId([], "id").ok).toBe(false);
      expect(normalizeId(null, "id").ok).toBe(false);
      expect(normalizeId(true, "id").ok).toBe(false);
      expect(normalizeId(1.5, "id").ok).toBe(false);
      expect(normalizeId(Number.NaN, "id").ok).toBe(false);
      expect(normalizeId(Number.POSITIVE_INFINITY, "id").ok).toBe(false);
    });

    test("normalizeLimit clamps above the maximum and rejects below the minimum", () => {
      expect(
        normalizeLimit(5000, { label: "limit", fallback: 25, max: 100 }),
      ).toEqual({ ok: true, value: 100 });
      expect(
        normalizeLimit("5000", { label: "limit", fallback: 25, max: 100 }),
      ).toEqual({ ok: true, value: 100 });
      expect(
        normalizeLimit("12", { label: "limit", fallback: 25, max: 100 }),
      ).toEqual({ ok: true, value: 12 });
      expect(
        normalizeLimit(undefined, { label: "limit", fallback: 25, max: 100 }),
      ).toEqual({ ok: true, value: 25 });
      expect(
        normalizeLimit(0, { label: "limit", fallback: 25, max: 100 }).ok,
      ).toBe(false);
      expect(
        normalizeLimit(1.5, { label: "limit", fallback: 25, max: 100 }).ok,
      ).toBe(false);
    });

    test("normalizeOffset has no upper bound but rejects negatives", () => {
      expect(normalizeOffset("7", { label: "offset", fallback: 0 })).toEqual({
        ok: true,
        value: 7,
      });
      expect(
        normalizeOffset(999999, { label: "offset", fallback: 0 }),
      ).toEqual({ ok: true, value: 999999 });
      expect(normalizeOffset(-1, { label: "offset", fallback: 0 }).ok).toBe(false);
    });
  });
});
