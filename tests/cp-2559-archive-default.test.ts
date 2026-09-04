// CP-2559 — outline-wiki plugin search/list default-excludes archived docs.
//
//   AC1: outline_search_query default (includeArchived=false) → no archivedAt!=null hits.
//   AC2: outline_search_query includeArchived=true → archived hits preserved.
//   AC3: outline_doc_list + outline_collection_documents — same rule (server-side
//        excluded by default for both endpoints; collection.documents has no
//        filter param — see server source `Document.toNavigationNode`
//        defaulting `includeArchived: false`).
//   AC4: response metadata carries `archivedAt` (null for live, ISO for archived).
//   AC5: regression — live docs default untouched; full parity MCP↔CLI.
//   AC6: descriptions declare default-exclude + includeArchived switch.
//
// The dev wiki (`https://wiki.dev.cereb.ai/api`) was used to confirm the
// server behavior — `documents.search` defaults to INCLUDING archived hits
// (no server-side `archivedAt: null` predicate), `documents.list` defaults
// to EXCLUDING them (`where.archivedAt = null` in
// server/routes/api/documents/documents.ts:295-296), and
// `collections.documents` returns a NavigationNode tree (server-side
// `Document.toNavigationNode` defaults `includeArchived: false`).
//
// See the CP-2559 ticket comment for raw curl outputs and the outline
// source-tree line numbers.

import { afterEach, describe, expect, test, vi } from "vitest";
import plugin from "../src/index";
import {
  dispatchDoc,
  dispatchSearch,
  dispatchCollection,
  trimDocBody,
  trimSearchHit,
} from "../src/cli";

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

function unwrapDetails(result: any) {
  return JSON.parse(result.content[0].text).details;
}

function liveDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: "live-id",
    title: "Live doc",
    url: "/doc/live-id",
    urlId: "live-id",
    collectionId: "collection-id",
    updatedAt: "2026-08-30T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

function archivedDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: "archived-id",
    title: "Archived doc",
    url: "/doc/archived-id",
    urlId: "archived-id",
    collectionId: "collection-id",
    updatedAt: "2026-08-27T00:00:00.000Z",
    archivedAt: "2026-08-28T00:00:00.000Z",
    ...overrides,
  };
}

describe("CP-2559 trim helpers: archivedAt metadata surfaces", () => {
  afterEach(() => vi.restoreAllMocks());

  test("trimDocBody passes through `archivedAt` (null when live, ISO when archived)", () => {
    const live = trimDocBody(liveDoc()) as Record<string, unknown>;
    expect(live).toHaveProperty("archivedAt", null);

    const archived = trimDocBody(archivedDoc()) as Record<string, unknown>;
    expect(archived).toHaveProperty("archivedAt", "2026-08-28T00:00:00.000Z");

    // Caller can now distinguish archived vs live docs by archivedAt.
    expect(live.archivedAt).toBeNull();
    expect(archived.archivedAt).not.toBeNull();
    expect(live).not.toEqual(archived);
  });

  test("trimSearchHit propagates archivedAt through the inner `document`", () => {
    const hit = {
      ranking: 0.5,
      context: "...",
      document: archivedDoc(),
    };
    const trimmed = trimSearchHit(hit) as Record<string, unknown>;
    expect((trimmed.document as Record<string, unknown>).archivedAt).toBe(
      "2026-08-28T00:00:00.000Z",
    );
  });
});

describe("CP-2559 AC1 outline_search_query default excludes archived hits", () => {
  afterEach(() => vi.restoreAllMocks());

  test("default (includeArchived omitted) filters out archivedAt!=null hits", async () => {
    const hits = [
      {
        ranking: 0.9,
        context: "...",
        document: liveDoc({ id: "live-1" }),
      },
      {
        ranking: 0.85,
        context: "...",
        document: archivedDoc({ id: "arch-1" }),
      },
      {
        ranking: 0.8,
        context: "...",
        document: liveDoc({ id: "live-2" }),
      },
      {
        ranking: 0.75,
        context: "...",
        document: archivedDoc({ id: "arch-2" }),
      },
    ];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: hits }));
    vi.stubGlobal("fetch", fetchMock);
    const tool = getMcpTool("outline_search_query");

    const result = await tool.execute("test-call-id", { query: "x" });
    const details = unwrapDetails(result);

    expect(details.ok).toBe(true);
    expect(details.documents).toHaveLength(2);
    // All surviving hits must be live.
    for (const hit of details.documents) {
      expect(hit.document.archivedAt).toBeNull();
    }
    // The wire request must NOT include statusFilter when default.
    const wireBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(wireBody).not.toHaveProperty("statusFilter");
  });

  test("explicit includeArchived=false behaves identically to default", async () => {
    const hits = [
      { ranking: 0.9, context: "...", document: liveDoc({ id: "live-1" }) },
      { ranking: 0.85, context: "...", document: archivedDoc({ id: "arch-1" }) },
    ];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: hits }));
    vi.stubGlobal("fetch", fetchMock);
    const tool = getMcpTool("outline_search_query");

    const result = await tool.execute("test-call-id", {
      query: "x",
      includeArchived: false,
    });
    const details = unwrapDetails(result);

    expect(details.documents).toHaveLength(1);
    expect(details.documents[0].document.id).toBe("live-1");
    const wireBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(wireBody).not.toHaveProperty("statusFilter");
  });
});

describe("CP-2559 AC2 outline_search_query includeArchived=true keeps archived hits", () => {
  afterEach(() => vi.restoreAllMocks());

  test("includeArchived=true returns archived hits AND asks server for them via statusFilter", async () => {
    const hits = [
      { ranking: 0.9, context: "...", document: liveDoc({ id: "live-1" }) },
      {
        ranking: 0.85,
        context: "...",
        document: archivedDoc({ id: "arch-1" }),
      },
      { ranking: 0.8, context: "...", document: liveDoc({ id: "live-2" }) },
    ];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: hits }));
    vi.stubGlobal("fetch", fetchMock);
    const tool = getMcpTool("outline_search_query");

    const result = await tool.execute("test-call-id", {
      query: "x",
      includeArchived: true,
    });
    const details = unwrapDetails(result);

    expect(details.documents).toHaveLength(3);
    const ids = details.documents.map((d: any) => d.document.id);
    expect(ids).toEqual(["live-1", "arch-1", "live-2"]);

    // AC2 reverse assertion: the wire body must request archived docs too.
    const wireBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(wireBody.statusFilter).toEqual(
      expect.arrayContaining(["archived", "published", "draft"]),
    );
  });
});

describe("CP-2559 AC3 outline_doc_list default excludes archived", () => {
  afterEach(() => vi.restoreAllMocks());

  test("default (includeArchived omitted) filters out archivedAt!=null docs", async () => {
    const docs = [
      liveDoc({ id: "live-1", title: "Live 1" }),
      archivedDoc({ id: "arch-1", title: "Archived 1" }),
      liveDoc({ id: "live-2", title: "Live 2" }),
    ];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: docs }));
    vi.stubGlobal("fetch", fetchMock);
    const tool = getMcpTool("outline_doc_list");

    const result = await tool.execute("test-call-id", { limit: 10 });
    const details = unwrapDetails(result);

    expect(details.documents).toHaveLength(2);
    expect(details.documents.map((d: any) => d.id)).toEqual(["live-1", "live-2"]);
    const wireBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(wireBody).not.toHaveProperty("statusFilter");
  });

  test("includeArchived=true returns all docs AND asks server for archived", async () => {
    const docs = [
      liveDoc({ id: "live-1" }),
      archivedDoc({ id: "arch-1" }),
    ];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: docs }));
    vi.stubGlobal("fetch", fetchMock);
    const tool = getMcpTool("outline_doc_list");

    const result = await tool.execute("test-call-id", {
      includeArchived: true,
    });
    const details = unwrapDetails(result);

    expect(details.documents).toHaveLength(2);
    const wireBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(wireBody.statusFilter).toEqual(
      expect.arrayContaining(["archived", "published", "draft"]),
    );
  });

  test("empty data array survives both filter modes", async () => {
    for (const includeArchived of [false, true]) {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
      vi.stubGlobal("fetch", fetchMock);
      const tool = getMcpTool("outline_doc_list");
      const result = await tool.execute("test-call-id", { includeArchived });
      const details = unwrapDetails(result);
      expect(details.documents).toEqual([]);
      vi.restoreAllMocks();
    }
  });
});

describe("CP-2559 AC3 outline_collection_documents server-side default excludes archived", () => {
  afterEach(() => vi.restoreAllMocks());

  test("returns server navigation tree as-is (server already excludes archived)", async () => {
    const tree = [
      {
        id: "live-doc-1",
        title: "Live doc 1",
        url: "/doc/live-doc-1",
        children: [],
      },
      {
        id: "live-doc-2",
        title: "Live doc 2",
        url: "/doc/live-doc-2",
        children: [
          {
            id: "live-doc-3",
            title: "Live doc 3 (child of 2)",
            url: "/doc/live-doc-3",
            children: [],
          },
        ],
      },
    ];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: tree }));
    vi.stubGlobal("fetch", fetchMock);
    const tool = getMcpTool("outline_collection_documents");

    const result = await tool.execute("test-call-id", {
      id: "collection-id",
    });
    const details = unwrapDetails(result);

    expect(details.ok).toBe(true);
    expect(details.documents).toEqual(tree);
    // AC3 reverse assertion: navigation tree node shape unchanged.
    expect(details.documents[0]).not.toHaveProperty("archivedAt");
    // Server request: id + limit/offset (Outline's `collections.documents`
    // schema accepts only `{id}` per outline source; limit/offset are
    // pagination hints applied via the framework's `pagination()` middleware
    // — the plugin sends them anyway because the same handler is reused for
    // list-style endpoints. Endpoint cannot honor statusFilter or filter
    // DSL — that's the documented limitation).
    const wireBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(wireBody.id).toBe("collection-id");
    expect(wireBody).not.toHaveProperty("statusFilter");
    expect(wireBody).not.toHaveProperty("filters");
    expect(wireBody).not.toHaveProperty("includeArchived");
  });

  test("includeArchived=true is accepted for API symmetry but has no effect (documented limitation)", async () => {
    const tree = [
      { id: "doc-1", title: "Doc 1", url: "/doc/doc-1", children: [] },
    ];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: tree }));
    vi.stubGlobal("fetch", fetchMock);
    const tool = getMcpTool("outline_collection_documents");

    const result = await tool.execute("test-call-id", {
      id: "collection-id",
      includeArchived: true,
    });
    const details = unwrapDetails(result);

    expect(details.documents).toEqual(tree);
    // Wire body: id only — endpoint can't honor includeArchived.
    const wireBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(wireBody.id).toBe("collection-id");
    expect(wireBody).not.toHaveProperty("includeArchived");
    // But the request echo in the response surfaces the flag for debuggability.
    expect(details.request.includeArchived).toBe(true);
  });
});

describe("CP-2559 AC5 regression: live docs default untouched; MCP↔CLI parity", () => {
  afterEach(() => vi.restoreAllMocks());

  test("default (no archived docs in response) is byte-for-byte identical between MCP and CLI for search", async () => {
    const hits = [
      {
        ranking: 0.5,
        context: "...",
        document: liveDoc({ id: "live-1" }),
      },
    ];
    const mcpFetch = vi.fn().mockResolvedValue(jsonResponse({ data: hits }));
    vi.stubGlobal("fetch", mcpFetch);
    const mcpTool = getMcpTool("outline_search_query");
    const mcpResult = await mcpTool.execute("test-call-id", { query: "x" });
    const mcpDetails = JSON.parse(mcpResult.content[0].text).details;

    const cliFetch = vi.fn().mockResolvedValue(jsonResponse({ data: hits }));
    vi.stubGlobal("fetch", cliFetch);
    const cliResult: any = await dispatchSearch("query", { query: "x" }, cfg);
    const cliDetails = JSON.parse(cliResult.content[0].text);

    expect(cliDetails.documents).toEqual(mcpDetails.documents);
    expect(cliDetails.method).toBe(mcpDetails.method);
  });

  test("default is byte-for-byte identical between MCP and CLI for doc_list", async () => {
    const docs = [liveDoc({ id: "live-1" }), liveDoc({ id: "live-2" })];
    const mcpFetch = vi.fn().mockResolvedValue(jsonResponse({ data: docs }));
    vi.stubGlobal("fetch", mcpFetch);
    const mcpTool = getMcpTool("outline_doc_list");
    const mcpResult = await mcpTool.execute("test-call-id", {});
    const mcpDetails = JSON.parse(mcpResult.content[0].text).details;

    const cliFetch = vi.fn().mockResolvedValue(jsonResponse({ data: docs }));
    vi.stubGlobal("fetch", cliFetch);
    const cliResult: any = await dispatchDoc("list", {}, cfg);
    const cliDetails = JSON.parse(cliResult.content[0].text);

    expect(cliDetails.documents).toEqual(mcpDetails.documents);
  });

  test("includeArchived=true is byte-for-byte identical between MCP and CLI for doc_list", async () => {
    const docs = [liveDoc({ id: "live-1" }), archivedDoc({ id: "arch-1" })];
    const mcpFetch = vi.fn().mockResolvedValue(jsonResponse({ data: docs }));
    vi.stubGlobal("fetch", mcpFetch);
    const mcpTool = getMcpTool("outline_doc_list");
    const mcpResult = await mcpTool.execute("test-call-id", {
      includeArchived: true,
    });
    const mcpDetails = JSON.parse(mcpResult.content[0].text).details;

    const cliFetch = vi.fn().mockResolvedValue(jsonResponse({ data: docs }));
    vi.stubGlobal("fetch", cliFetch);
    const cliResult: any = await dispatchDoc(
      "list",
      { includeArchived: true },
      cfg,
    );
    const cliDetails = JSON.parse(cliResult.content[0].text);

    expect(cliDetails.documents).toEqual(mcpDetails.documents);
  });

  test("includeArchived=true is byte-for-byte identical between MCP and CLI for search", async () => {
    const hits = [
      { ranking: 0.5, context: "...", document: liveDoc({ id: "live-1" }) },
      { ranking: 0.4, context: "...", document: archivedDoc({ id: "arch-1" }) },
    ];
    const mcpFetch = vi.fn().mockResolvedValue(jsonResponse({ data: hits }));
    vi.stubGlobal("fetch", mcpFetch);
    const mcpTool = getMcpTool("outline_search_query");
    const mcpResult = await mcpTool.execute("test-call-id", {
      query: "x",
      includeArchived: true,
    });
    const mcpDetails = JSON.parse(mcpResult.content[0].text).details;

    const cliFetch = vi.fn().mockResolvedValue(jsonResponse({ data: hits }));
    vi.stubGlobal("fetch", cliFetch);
    const cliResult: any = await dispatchSearch(
      "query",
      { query: "x", includeArchived: true },
      cfg,
    );
    const cliDetails = JSON.parse(cliResult.content[0].text);

    expect(cliDetails.documents).toEqual(mcpDetails.documents);
  });

  test("collection.documents includeArchived is byte-for-byte identical between MCP and CLI", async () => {
    const tree = [
      { id: "doc-1", title: "Doc 1", url: "/doc/doc-1", children: [] },
    ];
    const mcpFetch = vi.fn().mockResolvedValue(jsonResponse({ data: tree }));
    vi.stubGlobal("fetch", mcpFetch);
    const mcpTool = getMcpTool("outline_collection_documents");
    const mcpResult = await mcpTool.execute("test-call-id", {
      id: "collection-id",
      includeArchived: true,
    });
    const mcpDetails = JSON.parse(mcpResult.content[0].text).details;

    const cliFetch = vi.fn().mockResolvedValue(jsonResponse({ data: tree }));
    vi.stubGlobal("fetch", cliFetch);
    const cliResult: any = await dispatchCollection(
      "documents",
      { id: "collection-id", includeArchived: true },
      cfg,
    );
    const cliDetails = JSON.parse(cliResult.content[0].text);

    expect(cliDetails.documents).toEqual(mcpDetails.documents);
  });
});

describe("CP-2559 AC6 descriptions declare default-exclude + includeArchived switch", () => {
  test("outline_doc_list description mentions default-exclude + includeArchived", () => {
    const tools: any[] = [];
    plugin.register({
      pluginConfig: cfg,
      registerTool(definition: any) {
        tools.push(definition);
      },
    } as any);
    const tool = tools.find((t) => t.name === "outline_doc_list");
    expect(tool.description).toMatch(/Default excludes archived/i);
    expect(tool.description).toMatch(/includeArchived/);
    // Schema has includeArchived parameter (default false).
    const props = tool.parameters?.properties ?? {};
    expect(props.includeArchived).toBeDefined();
    expect(props.includeArchived.default).toBe(false);
  });

  test("outline_search_query description mentions default-exclude + includeArchived", () => {
    const tools: any[] = [];
    plugin.register({
      pluginConfig: cfg,
      registerTool(definition: any) {
        tools.push(definition);
      },
    } as any);
    const tool = tools.find((t) => t.name === "outline_search_query");
    expect(tool.description).toMatch(/Default excludes archived/i);
    expect(tool.description).toMatch(/includeArchived/);
    const props = tool.parameters?.properties ?? {};
    expect(props.includeArchived).toBeDefined();
    expect(props.includeArchived.default).toBe(false);
  });

  test("outline_collection_documents description notes default-exclude + endpoint capability limitation", () => {
    const tools: any[] = [];
    plugin.register({
      pluginConfig: cfg,
      registerTool(definition: any) {
        tools.push(definition);
      },
    } as any);
    const tool = tools.find((t) => t.name === "outline_collection_documents");
    expect(tool.description).toMatch(/Archived children are excluded by default/i);
    expect(tool.description).toMatch(/includeArchived/);
    expect(tool.description).toMatch(/endpoint capability/i);
    const props = tool.parameters?.properties ?? {};
    expect(props.includeArchived).toBeDefined();
    expect(props.includeArchived.default).toBe(false);
  });
});