import { afterEach, describe, expect, test, vi } from "vitest";
import plugin from "../src/index";
import { dispatchDoc, dispatchSearch } from "../src/cli";

// CLI ↔ MCP parity (CP-2060):
//
// Both call paths MUST build the same Outline REST request body for the same
// args. This file asserts byte-for-byte parity on the wire — anything that
// drifts is a bug (and used to be: cli.ts used limit=10 while MCP used 25,
// cli.ts dropped cfg.defaultCollectionId, cli.ts lacked editMode/publish/
// changelog/strictChangelog, cli.ts skipped the post-create verify).

const cfg = {
  apiToken: "test-token",
  endpoint: "https://outline.example.test/api",
};

function getMcpTool(name: string) {
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

function okEmptyResponse(): Response {
  return new Response("", {
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

async function captureMcpBodies(
  toolName: string,
  args: Record<string, unknown>,
  responses: Response[],
): Promise<any[]> {
  const fetchMock = vi.fn();
  for (const r of responses) fetchMock.mockResolvedValueOnce(r);
  vi.stubGlobal("fetch", fetchMock);
  const tool = getMcpTool(toolName);
  await tool.execute("test-call-id", args);
  return fetchMock.mock.calls.map((c) => JSON.parse(c[1].body));
}

async function captureCliBodies(
  fn: () => Promise<unknown>,
  responses: Response[],
): Promise<any[]> {
  const fetchMock = vi.fn();
  for (const r of responses) fetchMock.mockResolvedValueOnce(r);
  vi.stubGlobal("fetch", fetchMock);
  await fn();
  return fetchMock.mock.calls.map((c) => JSON.parse(c[1].body));
}

describe("CLI ↔ MCP parity: request body construction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("outline_doc_create", () => {
    test("default publish=true, no parentDocumentId (both call paths match)", async () => {
      const created = { id: "doc-id", title: "T", text: "body" };
      const args = { title: "T", text: "body", collectionId: "c1" };
      const mcp = await captureMcpBodies("outline_doc_create", args, [
        jsonResponse({ data: created }),
        jsonResponse({ data: created }),
      ]);
      const cli = await captureCliBodies(
        () =>
          dispatchDoc("create", args, cfg) as Promise<unknown>,
        [jsonResponse({ data: created }), jsonResponse({ data: created })],
      );
      // Both paths issue two requests: documents.create + documents.info (verify).
      expect(mcp).toHaveLength(2);
      expect(cli).toHaveLength(2);
      // First body (documents.create) must match byte-for-byte.
      expect(cli[0]).toEqual(mcp[0]);
      expect(cli[0]).toEqual({
        title: "T",
        text: "body",
        collectionId: "c1",
        publish: true,
      });
      // Verify body (documents.info) must match.
      expect(cli[1]).toEqual(mcp[1]);
      expect(cli[1]).toEqual({ id: "doc-id" });
    });

    test("explicit publish=false passes through (both paths match)", async () => {
      const created = { id: "doc-id", title: "T" };
      const args = {
        title: "T",
        text: "body",
        collectionId: "c1",
        publish: false,
        parentDocumentId: "p1",
      };
      const mcp = await captureMcpBodies("outline_doc_create", args, [
        jsonResponse({ data: created }),
        jsonResponse({ data: created }),
      ]);
      const cli = await captureCliBodies(
        () => dispatchDoc("create", args, cfg) as Promise<unknown>,
        [jsonResponse({ data: created }), jsonResponse({ data: created })],
      );
      expect(cli[0]).toEqual(mcp[0]);
      expect(cli[0]).toEqual({
        title: "T",
        text: "body",
        collectionId: "c1",
        publish: false,
        parentDocumentId: "p1",
      });
    });

    test("falls back to cfg.defaultCollectionId when args.collectionId omitted (both paths match)", async () => {
      const created = { id: "doc-id" };
      const cfgWithDefault = { ...cfg, defaultCollectionId: "default-c" };
      const args = { title: "T", text: "body" };
      // MCP path uses the plugin cfg (which we set via pluginConfig), so we
      // re-register the plugin with defaultCollectionId to mirror that.
      const tools: any[] = [];
      plugin.register({
        pluginConfig: cfgWithDefault,
        registerTool(definition: any) {
          tools.push(definition);
        },
      } as any);
      const tool = tools.find((t: any) => t.name === "outline_doc_create");
      const fetchMockMcp = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ data: created }))
        .mockResolvedValueOnce(jsonResponse({ data: created }));
      vi.stubGlobal("fetch", fetchMockMcp);
      await tool.execute("test-call-id", args);
      const mcpBodies = fetchMockMcp.mock.calls.map((c) =>
        JSON.parse(c[1].body),
      );

      const cli = await captureCliBodies(
        () => dispatchDoc("create", args, cfgWithDefault) as Promise<unknown>,
        [jsonResponse({ data: created }), jsonResponse({ data: created })],
      );

      expect(cli[0]).toEqual(mcpBodies[0]);
      expect(cli[0]).toEqual({
        title: "T",
        text: "body",
        collectionId: "default-c",
        publish: true,
      });
    });

    test("args.collectionId wins over cfg.defaultCollectionId (both paths match)", async () => {
      const created = { id: "doc-id" };
      const cfgWithDefault = { ...cfg, defaultCollectionId: "default-c" };
      const args = { title: "T", text: "body", collectionId: "arg-c" };
      const tools: any[] = [];
      plugin.register({
        pluginConfig: cfgWithDefault,
        registerTool(definition: any) {
          tools.push(definition);
        },
      } as any);
      const tool = tools.find((t: any) => t.name === "outline_doc_create");
      const fetchMockMcp = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ data: created }))
        .mockResolvedValueOnce(jsonResponse({ data: created }));
      vi.stubGlobal("fetch", fetchMockMcp);
      await tool.execute("test-call-id", args);
      const mcpBodies = fetchMockMcp.mock.calls.map((c) =>
        JSON.parse(c[1].body),
      );
      const cli = await captureCliBodies(
        () => dispatchDoc("create", args, cfgWithDefault) as Promise<unknown>,
        [jsonResponse({ data: created }), jsonResponse({ data: created })],
      );
      expect(cli[0]).toEqual(mcpBodies[0]);
      expect(cli[0].collectionId).toBe("arg-c");
    });

    test("verify: documents.info is called after create (both paths match)", async () => {
      const created = { id: "doc-id", title: "T" };
      const args = { title: "T", text: "body", collectionId: "c1" };
      const mcp = await captureMcpBodies("outline_doc_create", args, [
        jsonResponse({ data: created }),
        jsonResponse({ data: created }),
      ]);
      const cli = await captureCliBodies(
        () => dispatchDoc("create", args, cfg) as Promise<unknown>,
        [jsonResponse({ data: created }), jsonResponse({ data: created })],
      );
      // Both paths issue exactly two fetch calls — create + verify.
      expect(cli.length).toBe(mcp.length);
      expect(cli.length).toBe(2);
      // Verify endpoint hit is documents.info with the created id.
      expect(cli[1]).toEqual({ id: "doc-id" });
      expect(mcp[1]).toEqual({ id: "doc-id" });
    });

    test("verify failure surfaces as error in both paths", async () => {
      const created = { id: "doc-id" };
      const args = { title: "T", text: "body", collectionId: "c1" };
      // MCP path
      const mcpFetch = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ data: created }))
        .mockResolvedValueOnce(okEmptyResponse());
      vi.stubGlobal("fetch", mcpFetch);
      const mcpTool = getMcpTool("outline_doc_create");
      const mcpResult = await mcpTool.execute("test-call-id", args);
      const mcpDetails = JSON.parse(mcpResult.content[0].text).details;

      // CLI path
      const cliFetch = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ data: created }))
        .mockResolvedValueOnce(okEmptyResponse());
      vi.stubGlobal("fetch", cliFetch);
      const cliResult: any = await dispatchDoc("create", args, cfg);
      // CLI textResult wraps the data directly as text content (no separate
      // `details` field on the wire envelope), so parse the text.
      const cliDetails = JSON.parse(cliResult.content[0].text);

      // Both paths must surface a verify-failure error, not an "ok:true".
      expect(mcpDetails.ok).toBeUndefined();
      expect(mcpDetails.error).toMatch(/verify|empty data/);
      expect(cliDetails.error).toMatch(/verify|empty data/);
    });
  });

  describe("outline_doc_update", () => {
    test("editMode defaults to 'replace' when text provided (both paths match)", async () => {
      const updated = { id: "doc-id", title: "T2" };
      const args = { id: "doc-id", text: "new body" };
      const mcp = await captureMcpBodies("outline_doc_update", args, [
        jsonResponse({ data: updated }),
      ]);
      const cli = await captureCliBodies(
        () => dispatchDoc("update", args, cfg) as Promise<unknown>,
        [jsonResponse({ data: updated })],
      );
      expect(cli[0]).toEqual(mcp[0]);
      expect(cli[0]).toEqual({
        id: "doc-id",
        text: "new body",
        editMode: "replace",
      });
    });

    test("explicit editMode passes through (both paths match)", async () => {
      const updated = { id: "doc-id" };
      const args = {
        id: "doc-id",
        text: "appended",
        editMode: "append",
      };
      const mcp = await captureMcpBodies("outline_doc_update", args, [
        jsonResponse({ data: updated }),
      ]);
      const cli = await captureCliBodies(
        () => dispatchDoc("update", args, cfg) as Promise<unknown>,
        [jsonResponse({ data: updated })],
      );
      expect(cli[0]).toEqual(mcp[0]);
      expect(cli[0]).toEqual({
        id: "doc-id",
        text: "appended",
        editMode: "append",
      });
    });

    test("publish boolean passes through (both paths match)", async () => {
      const updated = { id: "doc-id" };
      const args = {
        id: "doc-id",
        title: "T2",
        publish: false,
      };
      const mcp = await captureMcpBodies("outline_doc_update", args, [
        jsonResponse({ data: updated }),
      ]);
      const cli = await captureCliBodies(
        () => dispatchDoc("update", args, cfg) as Promise<unknown>,
        [jsonResponse({ data: updated })],
      );
      expect(cli[0]).toEqual(mcp[0]);
      expect(cli[0]).toEqual({
        id: "doc-id",
        title: "T2",
        publish: false,
      });
    });

    test("changelog triggers revisions.list + revisions.update (both paths match)", async () => {
      const updated = { id: "doc-id", title: "T2" };
      const args = {
        id: "doc-id",
        title: "T2",
        changelog: "what changed",
      };
      const mcp = await captureMcpBodies("outline_doc_update", args, [
        jsonResponse({ data: updated }),
        jsonResponse({
          data: [{ id: "rev-id" }],
        }),
        jsonResponse({ data: { ok: true } }),
      ]);
      const cli = await captureCliBodies(
        () => dispatchDoc("update", args, cfg) as Promise<unknown>,
        [
          jsonResponse({ data: updated }),
          jsonResponse({ data: [{ id: "rev-id" }] }),
          jsonResponse({ data: { ok: true } }),
        ],
      );
      expect(cli).toHaveLength(3);
      expect(mcp).toHaveLength(3);
      expect(cli[0]).toEqual(mcp[0]);
      expect(cli[1]).toEqual(mcp[1]);
      expect(cli[2]).toEqual(mcp[2]);
      expect(cli[2]).toEqual({ id: "rev-id", name: "what changed" });
    });

    test("strictChangelog=true + changelog failure surfaces error in both paths", async () => {
      const updated = { id: "doc-id", title: "T2" };
      const args = {
        id: "doc-id",
        title: "T2",
        changelog: "what changed",
        strictChangelog: true,
      };
      // MCP path
      const mcpFetch = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ data: updated }))
        .mockResolvedValueOnce(errorResponse());
      vi.stubGlobal("fetch", mcpFetch);
      const mcpTool = getMcpTool("outline_doc_update");
      const mcpResult = await mcpTool.execute("test-call-id", args);
      const mcpDetails = JSON.parse(mcpResult.content[0].text).details;

      // CLI path
      const cliFetch = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ data: updated }))
        .mockResolvedValueOnce(errorResponse());
      vi.stubGlobal("fetch", cliFetch);
      const cliResult: any = await dispatchDoc("update", args, cfg);
      const cliDetails = JSON.parse(cliResult.content[0].text);

      // Both surfaces an error containing "strictChangelog=true" (no
      // distinction in the wire body — this is a response-shape parity
      // check).
      expect(mcpDetails.error).toMatch(/strictChangelog=true/);
      expect(cliDetails.error).toMatch(/strictChangelog=true/);
    });

    test("no changelog → no extra requests (both paths match)", async () => {
      const updated = { id: "doc-id", title: "T2" };
      const args = { id: "doc-id", title: "T2" };
      const mcp = await captureMcpBodies("outline_doc_update", args, [
        jsonResponse({ data: updated }),
      ]);
      const cli = await captureCliBodies(
        () => dispatchDoc("update", args, cfg) as Promise<unknown>,
        [jsonResponse({ data: updated })],
      );
      expect(cli).toHaveLength(1);
      expect(mcp).toHaveLength(1);
      expect(cli[0]).toEqual(mcp[0]);
    });
  });

  describe("outline_search_query", () => {
    test("limit defaults to 25 when args.limit omitted (both paths match)", async () => {
      const args = { query: "redis sentinel" };
      const mcp = await captureMcpBodies("outline_search_query", args, [
        jsonResponse({ data: [] }),
      ]);
      const cli = await captureCliBodies(
        () => dispatchSearch("query", args, cfg) as Promise<unknown>,
        [jsonResponse({ data: [] })],
      );
      expect(cli[0]).toEqual(mcp[0]);
      expect(cli[0]).toEqual({
        query: "redis sentinel",
        limit: 25,
        offset: 0,
      });
    });

    test("explicit limit + offset + collectionId (both paths match)", async () => {
      const args = {
        query: "x",
        limit: 7,
        offset: 14,
        collectionId: "c1",
      };
      const mcp = await captureMcpBodies("outline_search_query", args, [
        jsonResponse({ data: [] }),
      ]);
      const cli = await captureCliBodies(
        () => dispatchSearch("query", args, cfg) as Promise<unknown>,
        [jsonResponse({ data: [] })],
      );
      expect(cli[0]).toEqual(mcp[0]);
      expect(cli[0]).toEqual({
        query: "x",
        limit: 7,
        offset: 14,
        collectionId: "c1",
      });
    });

    test("non-numeric limit falls back to 25 (both paths match)", async () => {
      const args = { query: "x", limit: "not-a-number" as unknown as number };
      const mcp = await captureMcpBodies("outline_search_query", args, [
        jsonResponse({ data: [] }),
      ]);
      const cli = await captureCliBodies(
        () => dispatchSearch("query", args, cfg) as Promise<unknown>,
        [jsonResponse({ data: [] })],
      );
      expect(cli[0]).toEqual(mcp[0]);
      expect(cli[0].limit).toBe(25);
    });
  });

  describe("regression: pre-fix cli behaviors that should stay fixed", () => {
    test("cli.ts no longer uses limit=10 for search", async () => {
      const args = { query: "x" };
      const cli = await captureCliBodies(
        () => dispatchSearch("query", args, cfg) as Promise<unknown>,
        [jsonResponse({ data: [] })],
      );
      expect(cli[0].limit).not.toBe(10);
      expect(cli[0].limit).toBe(25);
    });

    test("cli.ts no longer silently drops cfg.defaultCollectionId", async () => {
      // Without the fix, cli.ts would have sent { collectionId: undefined,
      // ... } which outline would reject with a 400 (or worse, succeed
      // against the wrong collection). Now both paths must substitute
      // cfg.defaultCollectionId into the body.
      const cfgWithDefault = { ...cfg, defaultCollectionId: "default-c" };
      const args = { title: "T", text: "body" };
      const created = { id: "doc-id" };
      const cli = await captureCliBodies(
        () => dispatchDoc("create", args, cfgWithDefault) as Promise<unknown>,
        [jsonResponse({ data: created }), jsonResponse({ data: created })],
      );
      expect(cli[0].collectionId).toBe("default-c");
      expect(cli[0].collectionId).not.toBeUndefined();
    });
  });
});
