/**
 * CLI vs OpenClaw named tools parity test (CP-2062 AC2).
 *
 * Contract: every method exposed via `outline-tool <category>.<method>` must
 * produce the SAME outline REST request body (and the SAME post-success
 * behavior such as `documents.info` verify) as the equivalent
 * `outline_<category>_<method>` OpenClaw tool. The body sent to outline
 * (i.e. the JSON-stringified second argument of `fetch`) is the single
 * source of truth for "did CLI and tool produce equivalent work?".
 *
 * If this test ever turns red, either:
 *   - the CLI dispatcher in src/cli.ts diverged from src/index.ts (likely a
 *     bug — fix src/cli.ts to mirror src/index.ts), or
 *   - the OpenClaw tool handler in src/index.ts changed without updating
 *     the CLI dispatcher.
 *
 * Either way, restoring parity here is required by the AC3 contract in
 * skills/outline-wiki/SKILL.md and README.md.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import plugin from "../src/index";
import {
  dispatch as cliDispatch,
  dispatchDoc as cliDispatchDoc,
  dispatchSearch as cliDispatchSearch,
} from "../src/cli";

const cfg = {
  apiToken: "test-token",
  endpoint: "https://outline.example.test/api",
  defaultCollectionId: "default-collection-uuid",
};

function getTool(name: string): any {
  const tools: any[] = [];
  (plugin as any).register({
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

function errorResponse(): Response {
  return new Response(JSON.stringify({ error: "boom" }), {
    status: 500,
    statusText: "Internal Server Error",
    headers: { "Content-Type": "application/json" },
  });
}

async function emptyResponse(): Promise<Response> {
  return new Response("", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function fetchBodies(mock: any): any[] {
  return mock.mock.calls.map((c: any[]) => JSON.parse(c[1].body));
}

function fetchUrls(mock: any): string[] {
  return mock.mock.calls.map((c: any[]) => c[0]);
}

/**
 * CLI dispatch returns `{content, details: data, isError}` directly (no
 * OpenClaw-side wrapping). For these calls, `result.details` IS the data dict.
 *
 * OpenClaw tool calls go through `jsonResult` wrapping which produces
 * `{content: [{text: JSON.stringify(payload)}], details: payload}`. For these
 * calls, `result.details` is the inner payload object that itself has
 * `{content, details: data, isError}` — so `result.details.details` is the
 * data dict.
 */
function unwrapData(result: any): any {
  return result?.details?.details ?? result?.details;
}

async function unwrap(result: any): Promise<any> {
  return unwrapData(result);
}

describe("CLI <-> OpenClaw named tool parity (CP-2062 AC2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ============ AC1.1: doc.create collectionId fallback + error ============
  describe("doc.create: collectionId resolution", () => {
    test("CLI falls back to cfg.defaultCollectionId when args.collectionId is omitted", async () => {
      const created = {
        id: "doc-id",
        title: "Created",
        url: "https://outline.example.test/doc/doc-id",
        urlId: "doc-id",
        revision: 1,
      };
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ data: created }))
        .mockResolvedValueOnce(jsonResponse({ data: created }));
      vi.stubGlobal("fetch", fetchMock);

      await cliDispatchDoc(
        "create",
        { title: "Created", text: "body" },
        cfg,
      );

      const bodies = fetchBodies(fetchMock);
      // First body sent to documents.create MUST carry the cfg fallback id.
      expect(bodies[0]).toMatchObject({
        title: "Created",
        text: "body",
        collectionId: "default-collection-uuid",
        publish: true,
      });
    });

    test("CLI prefers args.collectionId over cfg.defaultCollectionId", async () => {
      const created = { id: "doc-id", title: "Created", revision: 1 };
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ data: created }))
        .mockResolvedValueOnce(jsonResponse({ data: created }));
      vi.stubGlobal("fetch", fetchMock);

      await cliDispatchDoc(
        "create",
        { title: "Created", text: "body", collectionId: "explicit-uuid" },
        cfg,
      );

      const bodies = fetchBodies(fetchMock);
      expect(bodies[0].collectionId).toBe("explicit-uuid");
    });

    test("CLI returns explicit error when neither args nor cfg has collectionId", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const result = await cliDispatchDoc(
        "create",
        { title: "Created", text: "body" },
        { apiToken: cfg.apiToken, endpoint: cfg.endpoint },
      );

      expect(fetchMock).not.toHaveBeenCalled();
      const details = await unwrap(result);
      expect(details.error).toContain("collectionId");
      expect(details.error).toContain("defaultCollectionId");
    });

    test("OpenClaw tool has the same resolution order (parity baseline)", async () => {
      const created = { id: "doc-id", title: "Created", revision: 1 };
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ data: created }))
        .mockResolvedValueOnce(jsonResponse({ data: created }));
      vi.stubGlobal("fetch", fetchMock);

      const tool = getTool("outline_doc_create");
      await tool.execute("id", { title: "Created", text: "body" });

      const bodies = fetchBodies(fetchMock);
      expect(bodies[0]).toMatchObject({
        title: "Created",
        text: "body",
        collectionId: "default-collection-uuid",
        publish: true,
      });
    });

    test("OpenClaw tool error path: missing collectionId surfaces an error and does not call outline", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      // Re-register the plugin with no defaultCollectionId so the resolution
      // chain falls through to the explicit-error branch.
      const tools: any[] = [];
      (plugin as any).register({
        pluginConfig: { apiToken: cfg.apiToken, endpoint: cfg.endpoint },
        registerTool(definition: any) {
          tools.push(definition);
        },
      } as any);
      const tool = tools.find((t) => t.name === "outline_doc_create");
      if (!tool) throw new Error("outline_doc_create not registered");

      const result = await tool.execute("id", {
        title: "Created",
        text: "body",
      });
      expect(fetchMock).not.toHaveBeenCalled();
      const details = await unwrap(result);
      expect(details.error).toContain("collectionId");
    });
  });

  // ============ AC1.4: doc.create verify via documents.info ============
  describe("doc.create: verify on success", () => {
    test("CLI calls documents.info after a successful create", async () => {
      const created = {
        id: "doc-id",
        title: "Created",
        url: "https://outline.example.test/doc/doc-id",
        urlId: "doc-id",
        revision: 1,
      };
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ data: created }))
        .mockResolvedValueOnce(jsonResponse({ data: created }));
      vi.stubGlobal("fetch", fetchMock);

      const result = await cliDispatchDoc(
        "create",
        { title: "Created", text: "body", collectionId: "c" },
        cfg,
      );

      const urls = fetchUrls(fetchMock);
      expect(urls[0]).toBe("https://outline.example.test/api/documents.create");
      expect(urls[1]).toBe("https://outline.example.test/api/documents.info");
      const bodies = fetchBodies(fetchMock);
      expect(bodies[1]).toEqual({ id: "doc-id" });

      const details = await unwrap(result);
      expect(details.ok).toBe(true);
      expect(details.summary.id).toBe("doc-id");
    });

    test("CLI returns an error when verify (documents.info) fails", async () => {
      const created = { id: "doc-id", title: "Created", revision: 1 };
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ data: created }))
        .mockResolvedValueOnce(errorResponse());
      vi.stubGlobal("fetch", fetchMock);

      const result = await cliDispatchDoc(
        "create",
        { title: "Created", text: "body", collectionId: "c" },
        cfg,
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const details = await unwrap(result);
      expect(details.error).toContain("verify failed");
    });

    test("CLI returns an error when documents.create returns empty data", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(await emptyResponse()));

      const result = await cliDispatchDoc(
        "create",
        { title: "Created", text: "body", collectionId: "c" },
        cfg,
      );

      const details = await unwrap(result);
      expect(details.error).toContain("empty data");
    });

    test("parity: OpenClaw tool uses the same verify pattern (2 fetches)", async () => {
      const created = { id: "doc-id", title: "Created", revision: 1 };
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ data: created }))
        .mockResolvedValueOnce(jsonResponse({ data: created }));
      vi.stubGlobal("fetch", fetchMock);

      const tool = getTool("outline_doc_create");
      await tool.execute("id", {
        title: "Created",
        text: "body",
        collectionId: "c",
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const urls = fetchUrls(fetchMock);
      expect(urls[1]).toBe("https://outline.example.test/api/documents.info");
    });
  });

  // ============ AC1.2: doc.update editMode/publish/changelog/strictChangelog ============
  describe("doc.update: optional params", () => {
    test("CLI sends editMode=replace when text is set without explicit editMode", async () => {
      const updated = { id: "doc-id", title: "t", revision: 2 };
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: updated }));
      vi.stubGlobal("fetch", fetchMock);

      await cliDispatchDoc("update", { id: "doc-id", text: "new body" }, cfg);

      const bodies = fetchBodies(fetchMock);
      expect(bodies[0]).toMatchObject({
        id: "doc-id",
        text: "new body",
        editMode: "replace",
      });
    });

    test("CLI forwards explicit editMode override", async () => {
      const updated = { id: "doc-id", title: "t", revision: 2 };
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: updated }));
      vi.stubGlobal("fetch", fetchMock);

      await cliDispatchDoc(
        "update",
        { id: "doc-id", text: "new body", editMode: "append" },
        cfg,
      );

      expect(fetchBodies(fetchMock)[0].editMode).toBe("append");
    });

    test("CLI forwards publish when explicitly provided", async () => {
      const updated = { id: "doc-id", title: "t", revision: 2 };
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: updated }));
      vi.stubGlobal("fetch", fetchMock);

      await cliDispatchDoc(
        "update",
        { id: "doc-id", title: "t", publish: false },
        cfg,
      );

      expect(fetchBodies(fetchMock)[0].publish).toBe(false);
    });

    test("CLI omits publish when not provided (matches OpenClaw tool)", async () => {
      const updated = { id: "doc-id", title: "t", revision: 2 };
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: updated }));
      vi.stubGlobal("fetch", fetchMock);

      const tool = getTool("outline_doc_update");
      await tool.execute("id", { id: "doc-id", title: "t" });

      const toolBodies = fetchBodies(fetchMock);
      expect(toolBodies[0]).not.toHaveProperty("publish");

      fetchMock.mockClear();
      await cliDispatchDoc("update", { id: "doc-id", title: "t" }, cfg);
      const cliBodies = fetchBodies(fetchMock);
      expect(cliBodies[0]).not.toHaveProperty("publish");
    });

    test("CLI rejects parentDocumentId with fail-fast error (mirrors OpenClaw tool)", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const result = await cliDispatchDoc(
        "update",
        { id: "doc-id", text: "x", parentDocumentId: "p" },
        cfg,
      );
      const details = await unwrap(result);
      expect(details.error).toContain("parentDocumentId");
      expect(details.error).toContain("doc.move");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test("CLI requires at least one of text/title", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const result = await cliDispatchDoc("update", { id: "doc-id" }, cfg);
      const details = await unwrap(result);
      expect(details.error).toContain("text");
      expect(details.error).toContain("title");
    });

    test("CLI changelog writes revision name on success (parity with tool)", async () => {
      const updated = { id: "doc-id", title: "t", revision: 2 };
      const latestRev = { id: "rev-id", name: "" };
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ data: updated }))
        .mockResolvedValueOnce(jsonResponse({ data: [latestRev] }))
        .mockResolvedValueOnce(jsonResponse({ data: { id: "rev-id", name: "my changelog" } }));
      vi.stubGlobal("fetch", fetchMock);

      const result = await cliDispatchDoc(
        "update",
        { id: "doc-id", title: "t", changelog: "my changelog" },
        cfg,
      );

      expect(fetchMock).toHaveBeenCalledTimes(3);
      const urls = fetchUrls(fetchMock);
      expect(urls[1]).toBe("https://outline.example.test/api/revisions.list");
      expect(urls[2]).toBe("https://outline.example.test/api/revisions.update");
      const revUpdateBody = fetchBodies(fetchMock)[2];
      expect(revUpdateBody).toEqual({ id: "rev-id", name: "my changelog" });

      const details = await unwrap(result);
      expect(details.ok).toBe(true);
      expect(details.warnings).toBeUndefined();
    });

    test("CLI changelog write failure surfaces as warning by default (parity with tool)", async () => {
      const updated = { id: "doc-id", title: "t", revision: 2 };
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ data: updated }))
        .mockResolvedValueOnce(errorResponse());
      vi.stubGlobal("fetch", fetchMock);

      const result = await cliDispatchDoc(
        "update",
        { id: "doc-id", title: "t", changelog: "msg" },
        cfg,
      );
      const details = await unwrap(result);
      expect(details.ok).toBe(true);
      expect(details.warnings?.[0]).toContain("changelog write skipped");
    });

    test("CLI strictChangelog=true hard-fails on changelog write failure", async () => {
      const updated = { id: "doc-id", title: "t", revision: 2 };
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ data: updated }))
        .mockResolvedValueOnce(errorResponse());
      vi.stubGlobal("fetch", fetchMock);

      const result = await cliDispatchDoc(
        "update",
        { id: "doc-id", title: "t", changelog: "msg", strictChangelog: true },
        cfg,
      );
      const details = await unwrap(result);
      expect(details.error).toContain("strictChangelog=true");
      expect(details.ok).toBeUndefined();
    });
  });

  // ============ AC1.3: search default limit=25 ============
  describe("search.query: limit defaults", () => {
    test("CLI defaults limit to 25 (parity with OpenClaw tool)", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
      vi.stubGlobal("fetch", fetchMock);

      await cliDispatchSearch("query", { query: "foo" }, cfg);

      const body = fetchBodies(fetchMock)[0];
      expect(body.limit).toBe(25);
      expect(body.query).toBe("foo");
    });

    test("CLI honours explicit limit when provided", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
      vi.stubGlobal("fetch", fetchMock);

      await cliDispatchSearch("query", { query: "foo", limit: 7 }, cfg);
      expect(fetchBodies(fetchMock)[0].limit).toBe(7);
    });

    test("parity baseline: OpenClaw tool also defaults limit to 25", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
      vi.stubGlobal("fetch", fetchMock);

      const tool = getTool("outline_search_query");
      await tool.execute("id", { query: "foo" });
      expect(fetchBodies(fetchMock)[0].limit).toBe(25);
    });
  });

  // ============ method-name parity (CLI <category>.<method> resolves to MCP outline_<category>_<method>) ============
  describe("dispatch routing", () => {
  test("CLI dispatch routes doc.create to the same handler as outline_doc_create", async () => {
    const created = { id: "doc-id", title: "x", revision: 1 };

    // CLI path
    const cliFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: created }))
      .mockResolvedValueOnce(jsonResponse({ data: created }));
    vi.stubGlobal("fetch", cliFetch);
    await cliDispatch("doc", "create", { title: "x", text: "y" }, cfg);
    const cliUrls = fetchUrls(cliFetch);

    // OpenClaw tool path (fresh mock to avoid queue interference)
    const toolFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: created }))
      .mockResolvedValueOnce(jsonResponse({ data: created }));
    vi.stubGlobal("fetch", toolFetch);
    const tool = getTool("outline_doc_create");
    await tool.execute("id", { title: "x", text: "y" });
    const toolUrls = fetchUrls(toolFetch);

    // Both call documents.create then documents.info on success.
    expect(cliUrls).toHaveLength(2);
    expect(toolUrls).toHaveLength(2);
    expect(cliUrls[0]).toBe(toolUrls[0]);
    expect(cliUrls[1]).toBe(toolUrls[1]);
  });

    test("CLI dispatch routes search.query to outline_search_query handler", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
      vi.stubGlobal("fetch", fetchMock);

      await cliDispatch("search", "query", { query: "abc" }, cfg);
      const cliBody = fetchBodies(fetchMock)[0];

      fetchMock.mockClear();
      const tool = getTool("outline_search_query");
      await tool.execute("id", { query: "abc" });
      const toolBody = fetchBodies(fetchMock)[0];

      expect(cliBody).toEqual(toolBody);
    });
  });
});
