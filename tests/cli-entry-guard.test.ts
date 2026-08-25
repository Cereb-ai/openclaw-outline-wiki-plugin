import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, symlinkSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "vitest";

// CLI entry guard regression tests (CP-2066 — fix for CP-2064 review blocker).
//
// CP-2064 review caught that the `isCliEntry` guard in src/cli.ts failed when
// the CLI was invoked via a symlink (the standard npm install path:
// `node_modules/.bin/<bin>`, global install, npx). The guard compared
// `import.meta.url` to `pathToFileURL(process.argv[1]).href`, but under
// Node ESM `import.meta.url` is the resolved realpath while `process.argv[1]`
// is the symlink path the user typed — the strings never matched, so `main()`
// never ran and the CLI exited 0 with zero output (silent failure).
//
// These tests exercise the real CLI entry gate by spawning a subprocess and
// invoking `dist/cli.js` through (a) a symlink and (b) the real path. They
// assert the CLI actually executes (non-zero or non-empty output) instead of
// silently exiting 0. The previous tests (cli-vs-mcp-parity, doc-create, …)
// only import the module — they never go through `isCliEntry`, so they would
// have missed this regression.

const DIST_CLI = resolve(process.cwd(), "dist/cli.js");

// Skip the whole file if dist/cli.js hasn't been built yet (build runs before
// `npm test` in CI, but local `vitest` invocations on a clean checkout may
// otherwise fail). The build pipeline guarantees dist exists.
const skipIfNoDist = !existsSync(DIST_CLI)
  ? "dist/cli.js missing; run `npm run build` first"
  : false;

// Per-suite scratch dir for the symlink fixture. Created in `before` for the
// whole file, cleaned up in `afterAll`.
const scratchDir = mkdtempSync(join(tmpdir(), "outline-cli-entry-"));

afterAll(() => {
  try {
    rmSync(scratchDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup; CI will reclaim tmp anyway
  }
});

describe("CLI entry guard: isCliEntry under symlink (CP-2066)", () => {
  const symlinkPath = join(scratchDir, "outline-tool-symlink");

  test(
    "symlink invocation does NOT exit 0 with empty output (CP-2064 regression)",
    () => {
      if (skipIfNoDist) return;
      // Recreate symlink (some test runners might wipe the scratchDir).
      try {
        unlinkSync(symlinkPath);
      } catch {
        // ignore
      }
      symlinkSync(DIST_CLI, symlinkPath);

      // Use a fake OUTLINE_ENDPOINT so the request fails fast — what matters is
      // that `main()` actually runs (non-empty stderr/stdout) and the exit
      // code is non-zero (fetch failure → exit 5, not silent 0). Before the
      // CP-2066 fix, the guard short-circuited and the process exited 0 with
      // no output whatsoever.
      const result = spawnSync(
        process.execPath,
        [symlinkPath, "outline_doc_list", '{"limit":1}'],
        {
          env: {
            ...process.env,
            OUTLINE_API_TOKEN: "test-token",
            OUTLINE_ENDPOINT: "https://outline.example.invalid/api",
          },
          encoding: "utf-8",
          timeout: 10_000,
        },
      );

      // CP-2064 regression: silent exit 0, zero output. The fix guarantees
      // `main()` runs under symlink invocation, so we always get either a
      // non-empty stdout (the dispatcher wrote something) or a non-empty
      // stderr (a fetch error bubbled up).
      const combined = (result.stdout ?? "") + (result.stderr ?? "");
      expect(combined.length).toBeGreaterThan(0);
      // And the exit code must NOT be the silent-0 failure mode.
      expect(result.status).not.toBe(0);
    },
  );

  test(
    "direct dist/cli.js invocation produces output (parity baseline)",
    () => {
      if (skipIfNoDist) return;
      const result = spawnSync(
        process.execPath,
        [DIST_CLI, "outline_doc_list", '{"limit":1}'],
        {
          env: {
            ...process.env,
            OUTLINE_API_TOKEN: "test-token",
            OUTLINE_ENDPOINT: "https://outline.example.invalid/api",
          },
          encoding: "utf-8",
          timeout: 10_000,
        },
      );

      const combined = (result.stdout ?? "") + (result.stderr ?? "");
      expect(combined.length).toBeGreaterThan(0);
      expect(result.status).not.toBe(0);
    },
  );

  test(
    "invocation with --help prints help text (entry gate fires)",
    () => {
      if (skipIfNoDist) return;
      const result = spawnSync(
        process.execPath,
        [DIST_CLI, "--help"],
        {
          env: {
            ...process.env,
            OUTLINE_API_TOKEN: "test-token",
            OUTLINE_ENDPOINT: "https://outline.example.invalid/api",
          },
          encoding: "utf-8",
          timeout: 10_000,
        },
      );

      // `--help` is handled inside main() and exits 0. `printUsage()` writes
      // via `console.error`, so the text lands on stderr. The point of this
      // assertion is that main() ran at all — under the broken guard the
      // process would exit 0 with *zero* output on both streams.
      const combined = (result.stdout ?? "") + (result.stderr ?? "");
      expect(combined.length).toBeGreaterThan(0);
      expect(combined).toMatch(/Usage|outline-tool/);
    },
  );
});

describe("CLI entry guard: import path must NOT auto-run main() (regression)", () => {
  // Sanity: importing src/cli (e.g. from the parity test) must not fire
  // main(). The realpath-based guard must still short-circuit when argv[1] is
  // a different file (vitest's runner script) — otherwise every test file
  // would hang on main().
  test("importing the module is a no-op (main() does not run)", async () => {
    // If main() fired, vitest would hang or exit the worker; the fact that
    // this test executes at all is the smoke signal. We additionally import
    // and assert that `dispatch` is exported as a callable function (the
    // module's public surface for the parity tests).
    const mod = await import("../src/cli");
    expect(typeof (mod as any).dispatch).toBe("function");
    expect(typeof (mod as any).dispatchDoc).toBe("function");
    expect(typeof (mod as any).dispatchSearch).toBe("function");
  });
});