/**
 * CP-3689 — `editMode=patch` guardrail for `outline_doc_update`.
 *
 * Two independent failure modes motivated this module. Both were reproduced
 * against the dev wiki on 2026-10-23 (see the CP-3689 Jira evidence):
 *
 *   1. ANCHOR AMBIGUITY. The Outline server replaces only the FIRST
 *      occurrence of `findText` (verified: a duplicated anchor left the
 *      second copy untouched). A duplicated anchor therefore silently edits
 *      the wrong region; a stale anchor 404s — but only AFTER a previous
 *      patch has already modified the document.
 *
 *   2. SERVER-SIDE MARKDOWN NORMALIZATION. The server round-trips the
 *      submitted markdown through its own serializer, and that serializer is
 *      NOT the identity for some constructs. The sharpest case: a code span
 *      nested inside bold — submitted `**`code`**` is stored as
 *      `` `**code**` ``. The write returns HTTP 200 and `ok: true`, but the
 *      body comes back mangled, and the same anchor then 404s, so the agent
 *      cannot repair the document with another patch.
 *
 * The guardrail therefore does two things:
 *
 *   - PRE-submit: reads the current body and requires `findText` to match
 *     EXACTLY ONCE (literal, non-fuzzy match). 0 matches or >1 matches is a
 *     hard error and NO `documents.update` call is sent.
 *
 *   - POST-submit: reads the body back and compares the replaced region
 *     with the submitted text. A mismatch is surfaced as an explicit
 *     warning plus a `patchVerification` payload so the caller can see the
 *     server's version without having to re-read the whole document.
 *
 * Both the OpenClaw tool (`src/index.ts`) and the CLI (`src/cli.ts`) call
 * these helpers, so the two paths cannot drift (CP-2060 parity contract).
 */

/** Maximum number of characters echoed back for a mismatching region. */
export const MAX_STORED_REGION_PREVIEW = 300;

/** Result of the pre-submit anchor check. */
export interface PatchPreflightResult {
  ok: boolean;
  /** Number of literal occurrences of `findText` in the current body. */
  occurrences: number;
  /** Present when `ok` is false — a stable, caller-actionable message. */
  error?: string;
}

/** Result of the post-submit read-back check. */
export interface PatchVerificationResult {
  /** true = the stored region matches the submitted text (exactly or after
   *  benign markdown normalization). */
  verified: boolean;
  /** true = the submitted text was found verbatim in the new body. */
  exact: boolean;
  /** true = the region differs from the submitted text only by markdown
   *  normalization the server applies to every document (e.g. `_italic_`
   *  → `*italic*`, `- item` → `* item`). */
  normalized: boolean;
  /** true = the read-back could not be performed at all. */
  skipped: boolean;
  /** Machine-readable reason for `verified: false`. */
  reason?: string;
  /** Bounded preview of what the server actually stored. */
  storedRegion?: string;
}

/**
 * Count the literal (non-fuzzy, non-regex) occurrences of `needle` inside
 * `haystack`. Overlapping occurrences are NOT counted twice — the scan
 * resumes after the end of each hit, matching how a normal string search
 * behaves.
 */
export function countOccurrences(haystack: string, needle: string): number {
  if (typeof haystack !== "string" || typeof needle !== "string") return 0;
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * PRE-submit anchor check: `findText` must occur exactly once in the
 * current document body. Exact (literal) matching on purpose — fuzzy
 * matching would hide the ambiguity that causes wrong-region edits.
 */
export function preflightPatch(
  body: string,
  findText: string,
): PatchPreflightResult {
  const occurrences = countOccurrences(body, findText);
  if (occurrences === 0) {
    return {
      ok: false,
      occurrences,
      error:
        "outline_doc_update patch preflight failed: 404 not_found — `findText` was not found in the current document body " +
        "(0 occurrences) — no update was sent. The Outline server stores a markdown-normalized body, so the anchor " +
        "must be copied VERBATIM from the body returned by `outline_doc_get` (or `outline_doc_get` right before this " +
        "call). Re-read the document, pick a longer unique anchor, and retry.",
    };
  }
  if (occurrences > 1) {
    return {
      ok: false,
      occurrences,
      error:
        `outline_doc_update patch preflight failed: ambiguous anchor — \`findText\` matched ${occurrences} times in the current document body ` +
        "— no update was sent. The Outline server replaces only the FIRST occurrence, which would have edited the " +
        "wrong region. Extend the anchor with surrounding context until it is unique, then retry.",
    };
  }
  return { ok: true, occurrences };
}

/**
 * Canonicalize a markdown fragment so that two fragments that differ only
 * by the server's routine markdown normalization compare EQUAL, while the
 * corruption the Outline server introduces stays VISIBLE.
 *
 * The server rewrites some constructs on every save (`_italic_` →
 * `*italic*`, `- item` → `* item`, table padding, …). Those must not be
 * reported as corruption — otherwise the guardrail is pure noise.
 *
 * Only the emphasis STYLE is normalized (`__x__` → `**x__**`,
 * `_x_` → `*x*`); the PRESENCE of emphasis is kept, so a server that
 * silently dropped the bold markers is still reported as a mismatch.
 *
 * Code spans are kept VERBATIM (including the emphasis markers inside
 * them). That is what makes the WTO-4264 corruption detectable: the server
 * moves the emphasis markers from outside the code span to inside it
 * (`**`code`**` → `` `**code**` ``), and a verbatim code span exposes
 * exactly that change.
 */
export function markdownFingerprint(text: string): string {
  if (typeof text !== "string") return "";
  const codeSpans: string[] = [];
  let plain = text.replace(/`[^`\n]*`/g, (match) => {
    codeSpans.push(match);
    return `\u0000C${codeSpans.length - 1}\u0000`;
  });
  // Emphasis STYLE normalization (outside code spans only).
  plain = plain.replace(/__([^_\n]+)__/g, "**$1**");
  plain = plain.replace(/(^|[^\w*])\_([^_\n]+)\_(?=[^\w]|$)/g, "$1*$2*");
  // List bullets: `-` / `*` / `+` all mean the same thing.
  plain = plain.replace(/^(\s*)([-*+])\s+/gm, "$1- ");
  // Table separator rows get re-padded by the server; compare them loosely.
  plain = plain.replace(/-{2,}/g, "--");
  // Pipe spacing is re-aligned by the server.
  plain = plain.replace(/\s*\|\s*/g, " | ");
  plain = plain.replace(/\s+/g, " ").trim();
  // Restore the code spans WITHOUT touching their inner markers.
  plain = plain.replace(
    /\u0000C(\d+)\u0000/g,
    (_match, index) => `\u0001${codeSpans[Number(index)]}\u0001`,
  );
  return plain;
}

/**
 * Locate the region that changed between two bodies by comparing the
 * common prefix and the common suffix. For a patch this yields exactly the
 * replaced region (the old anchor vs. the server's stored replacement).
 */
export function diffRegion(
  before: string,
  after: string,
): { prefixLen: number; beforeRegion: string; afterRegion: string } {
  const minLen = Math.min(before.length, after.length);
  let prefixLen = 0;
  while (
    prefixLen < minLen &&
    before[prefixLen] === after[prefixLen]
  ) {
    prefixLen += 1;
  }
  let suffixLen = 0;
  while (
    suffixLen < minLen - prefixLen &&
    before[before.length - 1 - suffixLen] === after[after.length - 1 - suffixLen]
  ) {
    suffixLen += 1;
  }
  return {
    prefixLen,
    beforeRegion: before.slice(prefixLen, before.length - suffixLen),
    afterRegion: after.slice(prefixLen, after.length - suffixLen),
  };
}

/**
 * POST-submit read-back check: compare the region the server stored with
 * the text we submitted.
 *
 * - verbatim hit anywhere in the new body → verified, exact.
 * - region differs only by markdown normalization → verified, normalized
 *   (the server rewrites `_italic_` → `*italic*`, `- item` → `* item`, … on
 *   every document; flagging those would make the guardrail pure noise).
 * - otherwise → NOT verified: the server changed the content we submitted
 *   (the `**`code`**` → `` `**code**` `` case).
 */
export function verifyPatch(
  before: string,
  after: string,
  submitted: string,
): PatchVerificationResult {
  if (typeof after !== "string" || typeof submitted !== "string") {
    return {
      verified: false,
      exact: false,
      normalized: false,
      skipped: true,
      reason: "patch verification skipped: the document body could not be read back as a string.",
    };
  }
  // (1) The submitted text is in the body VERBATIM → nothing was rewritten.
  if (after.includes(submitted)) {
    return { verified: true, exact: true, normalized: false, skipped: false };
  }
  // (2) The submitted text is in the body up to the server's routine
  //     markdown normalization → benign, not a corruption.
  const fingerprint = markdownFingerprint(submitted);
  if (
    fingerprint.length > 0 &&
    markdownFingerprint(after).includes(fingerprint)
  ) {
    return { verified: true, exact: false, normalized: true, skipped: false };
  }
  // (3) Neither → the server changed the content we submitted. Report the
  //     region it actually stored so the caller can see the damage.
  const region = diffRegion(before, after);
  return {
    verified: false,
    exact: false,
    normalized: false,
    skipped: false,
    reason:
      "the document WAS updated, but the stored text does not match the submitted replacement text — the Outline " +
      "server rewrote the markdown (e.g. a code span nested inside bold is stored with the emphasis markers moved). " +
      "The original anchor no longer matches, so the change cannot be undone with another patch; read the document, " +
      "repair it with `editMode: \"replace\"`, and avoid nesting code spans inside bold markers.",
    storedRegion: region.afterRegion.slice(0, MAX_STORED_REGION_PREVIEW),
  };
}

/**
 * Read the current body of a document. Throws when the read fails — the
 * caller decides whether to fail closed (patch preflight) or degrade to a
 * warning (post-submit verification).
 */
export type FetchDocText = (id: string) => Promise<string>;

/**
 * PRE-submit guard: read the current body, then require `findText` to
 * match exactly once. On failure the returned object carries a stable
 * `error` message; the caller MUST NOT send `documents.update`.
 */
export async function runPatchPreflight(
  id: string,
  findText: string,
  fetchDocText: FetchDocText,
): Promise<
  | { ok: true; body: string; occurrences: number }
  | { ok: false; error: string; cause?: string }
> {
  let body: string;
  try {
    body = await fetchDocText(id);
  } catch (err) {
    return {
      ok: false,
      error:
        "outline_doc_update patch preflight failed: the current document body could not be read, so the anchor could " +
        "not be verified — no update was sent. Read the document with `outline_doc_get` and retry.",
      cause: err instanceof Error ? err.message : String(err),
    };
  }
  if (typeof body !== "string") {
    return {
      ok: false,
      error:
        "outline_doc_update patch preflight failed: the current document body came back empty — no update was sent. " +
        "Read the document with `outline_doc_get` and retry.",
    };
  }
  const pre = preflightPatch(body, findText);
  if (!pre.ok) {
    return { ok: false, error: pre.error as string };
  }
  return { ok: true, body, occurrences: pre.occurrences };
}

/**
 * POST-submit guard: read the body back and compare the changed region
 * with the submitted text. Never throws — a failed read-back degrades to a
 * `skipped` result so the (already applied) update is still reported.
 */
export async function runPatchVerification(
  id: string,
  before: string,
  submitted: string,
  fetchDocText: FetchDocText,
): Promise<PatchVerificationResult> {
  let after: string;
  try {
    after = await fetchDocText(id);
  } catch (err) {
    return {
      verified: false,
      exact: false,
      normalized: false,
      skipped: true,
      reason:
        "patch verification skipped: the document could not be read back after the update (" +
        (err instanceof Error ? err.message : String(err)) +
        "). Read the document manually to confirm the change landed as intended.",
    };
  }
  return verifyPatch(before, after, submitted);
}
