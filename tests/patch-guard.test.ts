import { afterEach, describe, expect, test, vi } from "vitest";
import plugin from "../src/index";
import { dispatchDoc } from "../src/cli";
import {
  countOccurrences,
  diffRegion,
  markdownFingerprint,
  preflightPatch,
  verifyPatch,
} from "../src/patch-guard";

// CP-3689 — `outline_doc_update` editMode=patch guardrail.
//
// Background (reproduced against the dev wiki on 2026-10-23, see the
// CP-3689 Jira evidence):
//
//   * The Outline server replaces only the FIRST occurrence of `findText`.
//     A duplicated anchor therefore edits the wrong region without any
//     error being raised.
//
//   * The server round-trips the submitted markdown through its own
//     serializer, which is not the identity for some constructs. The sharpest
//     case: a code span nested inside bold — submitted `**`code`**` is
//     stored as `` `**code**` ``. The write returns HTTP 200 / ok:true but
//     the body comes back mangled, and the original anchor then 404s, so the
//     agent cannot repair the document with another patch.
//
// The guardrail therefore:
//   * PRE-submit  — reads the current body and requires `findText` to match
//     EXACTLY ONCE. 0 matches or >1 matches → hard error, NO update call.
//   * POST-submit — reads the body back and compares the changed region with
//     the submitted text; a mismatch is reported as a warning + a
//     `patchVerification` payload.
//
// Both the OpenClaw tool and the CLI must behave identically.

const cfg = {
  apiToken: "test-token",
  endpoint: "https://outline.example.test/api",
};

const UPDATE_URL = "https://outline.example.test/api/documents.update";
const INFO_URL = "https://outline.example.test/api/documents.info";

function getTool(name: string) {
  const tools: any[] = [];
  plugin.register({
    pluginConfig: cfg,
    registerTool(definition: any) {
      tools.push(definition);
    },
  } as any);
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`${name} tool was not registered`);
  return tool;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function docInfoResponse(text: string): Response {
  return jsonResponse({ data: { id: "doc-id", title: "T", text } });
}

function updateResponse(extra: Record<string, unknown> = {}): Response {
  return jsonResponse({
    data: {
      id: "doc-id",
      title: "T",
      url: "https://outline.example.test/doc/doc-id",
      urlId: "doc-id",
      revision: 5,
      updatedAt: "2026-10-23T06:00:00.000Z",
      ...extra,
    },
  });
}

function unwrapDetails(result: any) {
  return JSON.parse(result.content[0].text).details;
}

function urlsCalled(fetchMock: any): string[] {
  return fetchMock.mock.calls.map((c: any[]) => c[0]);
}

function updateBodies(fetchMock: any): any[] {
  return fetchMock.mock.calls
    .filter((c: any[]) => c[0] === UPDATE_URL)
    .map((c: any[]) => JSON.parse(c[1].body));
}

describe("CP-3689: patch guardrail — unit level", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("countOccurrences", () => {
    test("counts literal occurrences", () => {
      expect(countOccurrences("aXbXc", "X")).toBe(2);
      expect(countOccurrences("aXbXc", "Y")).toBe(0);
      expect(countOccurrences("aaa", "aa")).toBe(1);
      expect(countOccurrences("abc", "")).toBe(0);
    });

    test("is literal, not a regex — metacharacters are not special", () => {
      expect(countOccurrences("a.b.c", ".")).toBe(2);
      expect(countOccurrences("axbxc", ".")).toBe(0);
      expect(countOccurrences("a+b", "+")).toBe(1);
    });
  });

  describe("preflightPatch — three states", () => {
    test("exactly one occurrence → ok", () => {
      const result = preflightPatch("body with anchor inside", "anchor");
      expect(result.ok).toBe(true);
      expect(result.occurrences).toBe(1);
    });

    test("zero occurrences → error, no update allowed", () => {
      const result = preflightPatch("body without it", "anchor");
      expect(result.ok).toBe(false);
      expect(result.occurrences).toBe(0);
      expect(result.error).toContain("404");
      expect(result.error).toContain("not found");
    });

    test("more than one occurrence → error, no update allowed", () => {
      const result = preflightPatch("anchor here and anchor there", "anchor");
      expect(result.ok).toBe(false);
      expect(result.occurrences).toBe(2);
      expect(result.error).toContain("matched 2 times");
      expect(result.error).toContain("FIRST occurrence");
    });
  });

  describe("verifyPatch — read-back comparison", () => {
    test("verbatim replacement → verified + exact", () => {
      const result = verifyPatch("before anchor", "before NEW", "NEW");
      expect(result.verified).toBe(true);
      expect(result.exact).toBe(true);
      expect(result.normalized).toBe(false);
    });

    test("server moved the code span out of the bold markers -> NOT verified", () => {
      // This is the WTO-4264 corruption, byte-for-byte as the dev wiki
      // stored it on 2026-10-23:
      //   submitted: **`config.yaml`**
      //   stored   : `**config.yaml**`
      const before = "before anchor";
      const after = "before **`config.yaml**`";
      const submitted = "**`config.yaml`**";
      const result = verifyPatch(before, after, submitted);
      expect(result.verified).toBe(false);
      expect(result.exact).toBe(false);
      expect(result.normalized).toBe(false);
      expect(result.reason).toContain("does not match the submitted replacement text");
      expect(result.storedRegion).toContain("config.yaml");
    });

    test("benign normalization (italic underscores → asterisks) → verified as normalized", () => {
      // The server rewrites `_italic_` to `*italic*` on EVERY document — that
      // must not be reported as a corruption, or the guardrail becomes noise.
      const before = "before anchor";
      const after = "before *italic* tail";
      const result = verifyPatch(before, after, "_italic_ tail");
      expect(result.verified).toBe(true);
      expect(result.exact).toBe(false);
      expect(result.normalized).toBe(true);
    });

    test("bold underscores → bold asterisks is benign too", () => {
      const result = verifyPatch("a anchor", "a **bold** tail", "__bold__ tail");
      expect(result.verified).toBe(true);
      expect(result.normalized).toBe(true);
    });

    test("list bullet normalization is treated as benign", () => {
      const result = verifyPatch("a anchor", "a - item one", "- item one");
      expect(result.verified).toBe(true);
    });

    test("dropped emphasis is NOT benign (the server must not lose the bold)", () => {
      const result = verifyPatch("a anchor", "a plain text", "**plain text**");
      expect(result.verified).toBe(false);
    });
  });

  describe("diffRegion", () => {
    test("isolates the changed region", () => {
      const region = diffRegion("aaaBBBccc", "aaaXXXccc");
      expect(region.beforeRegion).toBe("BBB");
      expect(region.afterRegion).toBe("XXX");
    });
  });

  describe("markdownFingerprint", () => {
    test("code span nesting is visible to the fingerprint", () => {
      // The corruption moves the emphasis markers — a fingerprint that only
      // normalized the emphasis style would call these equal.
      expect(markdownFingerprint("**`code`**")).not.toBe(
        markdownFingerprint("`**code**`"),
      );
    });

    test("emphasis style differences are invisible to the fingerprint", () => {
      expect(markdownFingerprint("__bold__")).toBe(markdownFingerprint("**bold**"));
      expect(markdownFingerprint("_italic_")).toBe(markdownFingerprint("*italic*"));
    });

    test("emphasis PRESENCE is visible to the fingerprint", () => {
      expect(markdownFingerprint("**bold**")).not.toBe(markdownFingerprint("bold"));
    });
  });
});

describe("CP-3689: patch guardrail — MCP path (outline_doc_update)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test("preflight: anchor matches exactly once → update is sent and read-back is verified", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(docInfoResponse("intro\n\nTHE ANCHOR\n\noutro"))
      .mockResolvedValueOnce(updateResponse())
      .mockResolvedValueOnce(docInfoResponse("intro\n\nnew wording\n\noutro"));
    vi.stubGlobal("fetch", fetchMock);
    const tool = getTool("outline_doc_update");

    const result = await tool.execute("test-call-id", {
      id: "doc-id",
      text: "new wording",
      editMode: "patch",
      findText: "THE ANCHOR",
    });

    const details = unwrapDetails(result);
    expect(details.ok).toBe(true);
    expect(details.warnings).toBeUndefined();
    expect(details.patchVerification).toMatchObject({
      verified: true,
      exact: true,
      skipped: false,
    });
    // The wire body must still carry the patch fields.
    expect(updateBodies(fetchMock)).toEqual([
      {
        id: "doc-id",
        text: "new wording",
        editMode: "patch",
        findText: "THE ANCHOR",
      },
    ]);
  });

  test("preflight: anchor matches ZERO times → error and NO update call", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(docInfoResponse("body without the anchor"));
    vi.stubGlobal("fetch", fetchMock);
    const tool = getTool("outline_doc_update");

    const result = await tool.execute("test-call-id", {
      id: "doc-id",
      text: "new wording",
      editMode: "patch",
      findText: "no-such-anchor",
    });

    const details = unwrapDetails(result);
    expect(details.ok).toBeUndefined();
    expect(details.error).toContain("404");
    expect(details.error).toContain("not found");
    // The critical assertion: no update was sent.
    expect(updateBodies(fetchMock)).toHaveLength(0);
    expect(urlsCalled(fetchMock)).not.toContain(UPDATE_URL);
  });

  test("preflight: anchor matches MULTIPLE times → error and NO update call", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        docInfoResponse("DUP first\n\nmiddle\n\nDUP second"),
      );
    vi.stubGlobal("fetch", fetchMock);
    const tool = getTool("outline_doc_update");

    const result = await tool.execute("test-call-id", {
      id: "doc-id",
      text: "new wording",
      editMode: "patch",
      findText: "DUP",
    });

    const details = unwrapDetails(result);
    expect(details.ok).toBeUndefined();
    expect(details.error).toContain("matched 2 times");
    expect(details.error).toContain("FIRST occurrence");
    // No update call — a duplicated anchor would have edited the wrong region.
    expect(updateBodies(fetchMock)).toHaveLength(0);
    expect(urlsCalled(fetchMock)).not.toContain(UPDATE_URL);
  });

  test("post-submit: server rewrote the markdown → warning + patchVerification.verified=false", async () => {
    // The server stores `**`code`**` as `` `**code**` `` — the update returns
    // ok:true but the body is mangled and the anchor is now stale.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(docInfoResponse("intro\n\nANCHOR\n\noutro"))
      .mockResolvedValueOnce(updateResponse())
      .mockResolvedValueOnce(
        docInfoResponse("intro\n\n**`config.yaml**`\n\noutro"),
      );
    vi.stubGlobal("fetch", fetchMock);
    const tool = getTool("outline_doc_update");

    const result = await tool.execute("test-call-id", {
      id: "doc-id",
      text: "**`config.yaml`**",
      editMode: "patch",
      findText: "ANCHOR",
    });
    const details = unwrapDetails(result);
    expect(details.ok).toBe(true);
    expect(details.patchVerification.verified).toBe(false);
    expect(details.patchVerification.exact).toBe(false);
    expect(details.patchVerification.storedRegion).toContain("config.yaml");
    expect(details.warnings.join(" ")).toContain("does not match the submitted replacement text");
  });

  test("post-submit: benign server normalization → verified, no warning", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(docInfoResponse("intro\n\nANCHOR\n\noutro"))
      .mockResolvedValueOnce(updateResponse())
      .mockResolvedValueOnce(docInfoResponse("intro\n\n*italic* tail\n\noutro"));
    vi.stubGlobal("fetch", fetchMock);
    const tool = getTool("outline_doc_update");

    const result = await tool.execute("test-call-id", {
      id: "doc-id",
      text: "_italic_ tail",
      editMode: "patch",
      findText: "ANCHOR",
    });

    const details = unwrapDetails(result);
    expect(details.ok).toBe(true);
    expect(details.patchVerification.verified).toBe(true);
    expect(details.patchVerification.normalized).toBe(true);
    expect(details.warnings).toBeUndefined();
  });

  test("post-submit: read-back fails → skipped=true, not a false corruption report", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(docInfoResponse("intro\n\nANCHOR\n\noutro"))
      .mockResolvedValueOnce(updateResponse())
      .mockRejectedValueOnce(new Error("boom"));
    vi.stubGlobal("fetch", fetchMock);
    const tool = getTool("outline_doc_update");

    const result = await tool.execute("test-call-id", {
      id: "doc-id",
      text: "new wording",
      editMode: "patch",
      findText: "ANCHOR",
    });

    const details = unwrapDetails(result);
    expect(details.ok).toBe(true);
    expect(details.patchVerification.skipped).toBe(true);
    expect(details.patchVerification.verified).toBe(false);
  });

  test("preflight: findText missing → 400 wording, no update call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const tool = getTool("outline_doc_update");

    const result = await tool.execute("test-call-id", {
      id: "doc-id",
      text: "replacement",
      editMode: "patch",
    });

    const details = unwrapDetails(result);
    expect(details.error).toContain("findText is required when using patch editMode");
    expect(details.error).toContain("400");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("non-patch edit modes are NOT guarded (no extra read, no verification)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(updateResponse())
      .mockResolvedValueOnce(docInfoResponse("body"));
    vi.stubGlobal("fetch", fetchMock);
    const tool = getTool("outline_doc_update");

    const result = await tool.execute("test-call-id", {
      id: "doc-id",
      text: "new body",
      editMode: "replace",
    });

    const details = unwrapDetails(result);
    expect(details.ok).toBe(true);
    expect(details.patchVerification).toBeUndefined();
    // Only the update call — the guardrail must not add reads for
    // replace / append / prepend.
    expect(urlsCalled(fetchMock)).toEqual([UPDATE_URL]);
  });
});

describe("CP-3689: patch guardrail — CLI path (outline-tool doc.update)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test("preflight + read-back behave identically to the MCP path", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(docInfoResponse("intro\n\nANCHOR\n\noutro"))
      .mockResolvedValueOnce(updateResponse())
      .mockResolvedValueOnce(docInfoResponse("intro\n\nnew wording\n\noutro"));
    vi.stubGlobal("fetch", fetchMock);

    const result: any = await dispatchDoc(
      "update",
      {
        id: "doc-id",
        text: "new wording",
        editMode: "patch",
        findText: "ANCHOR",
      },
      cfg,
    );
    const details = JSON.parse(result.content[0].text);

    expect(details.ok).toBe(true);
    expect(details.patchVerification).toMatchObject({
      verified: true,
      exact: true,
    });
    expect(updateBodies(fetchMock)).toEqual([
      {
        id: "doc-id",
        text: "new wording",
        editMode: "patch",
        findText: "ANCHOR",
      },
    ]);
  });

  test("CLI: zero-match anchor → error and NO update call", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(docInfoResponse("body without the anchor"));
    vi.stubGlobal("fetch", fetchMock);

    const result: any = await dispatchDoc(
      "update",
      {
        id: "doc-id",
        text: "new wording",
        editMode: "patch",
        findText: "no-such-anchor",
      },
      cfg,
    );
    const details = JSON.parse(result.content[0].text);

    expect(details.error).toContain("404");
    expect(details.error).toContain("not found");
    expect(urlsCalled(fetchMock)).not.toContain(UPDATE_URL);
  });

  test("CLI: multi-match anchor → error and NO update call", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(docInfoResponse("DUP a\n\nDUP b"));
    vi.stubGlobal("fetch", fetchMock);

    const result: any = await dispatchDoc(
      "update",
      {
        id: "doc-id",
        text: "new wording",
        editMode: "patch",
        findText: "DUP",
      },
      cfg,
    );
    const details = JSON.parse(result.content[0].text);

    expect(details.error).toContain("matched 2 times");
    expect(urlsCalled(fetchMock)).not.toContain(UPDATE_URL);
  });

  test("CLI: server rewrote the markdown → warning + verified=false", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(docInfoResponse("intro\n\nANCHOR\n\noutro"))
      .mockResolvedValueOnce(updateResponse())
      .mockResolvedValueOnce(
        docInfoResponse("intro\n\n**`config.yaml**`\n\noutro"),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result: any = await dispatchDoc(
      "update",
      {
        id: "doc-id",
        text: "**`config.yaml`**",
        editMode: "patch",
        findText: "ANCHOR",
      },
      cfg,
    );
    const details = JSON.parse(result.content[0].text);

    expect(details.ok).toBe(true);
    expect(details.patchVerification.verified).toBe(false);
    expect(details.warnings.join(" ")).toContain("does not match the submitted replacement text");
  });

  test("CLI: non-patch modes are not guarded", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(updateResponse())
      .mockResolvedValueOnce(docInfoResponse("body"));
    vi.stubGlobal("fetch", fetchMock);

    const result: any = await dispatchDoc(
      "update",
      { id: "doc-id", text: "new body", editMode: "append" },
      cfg,
    );
    const details = JSON.parse(result.content[0].text);

    expect(details.ok).toBe(true);
    expect(details.patchVerification).toBeUndefined();
    expect(urlsCalled(fetchMock)).toEqual([UPDATE_URL]);
  });
});
