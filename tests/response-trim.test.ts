import { afterEach, describe, expect, test, vi } from "vitest";
import plugin from "../src/index";
import {
  dispatchDoc,
  dispatchSearch,
  trimCreateRequest,
  trimDocBody,
  trimSearchHit,
  trimUpdateRequest,
} from "../src/cli";

// CP-2379 — response-trim contract for the three handlers that used to
// round-trip the full markdown body in their toolResult payload.
//
//   1. outline_search_query — strip `document.text` per hit, keep
//      ranking + context + nav metadata (id / title / url / urlId /
//      collectionId / updatedAt).
//   2. outline_doc_list     — strip `text` per doc, keep nav metadata.
//   3. outline_doc_create   — round-trip trim: the body the agent just
//      sent via `text` MUST NOT come back in `document.text`.
//   4. outline_doc_update   — same as doc_create.
//
// CP-2395 extends the contract to the request-echo: `request` used to
// carry the full input body (`text`, `editMode`, `publish`,
// `parentDocumentId`, ...). Round-tripping the agent's own input is
// exactly the planner token burn CP-2379 was trying to eliminate, so
// request is now trimmed to {title} (create) or {id[, title]} (update).
// Same shape on MCP and CLI paths — byte-for-byte parity is asserted.
//
// The shared CLI handlers (src/cli.ts) MUST produce byte-for-byte
// identical response shapes to the MCP tools — `cli-vs-mcp-parity` is a
// hard contract (CP-2060). We also assert that here on the byte-for-byte
// `document` shape, not just `toMatchObject`.

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

// Synthetic "full" documents as outline's REST responses return them —
// `text` is the full markdown body. The assertions below MUST confirm
// `text` never appears in the response after the trim.
function fullDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: "doc-id",
    url: "/doc/doc-id",
    urlId: "abc-id",
    title: "Full Doc",
    text: "# Full Doc\n\nThis is the full markdown body that MUST be trimmed from search/list/create/update responses. The agent just sent it (create/update) or doesn't need it (search/list) — round-tripping it bloats the planner toolResult.",
    icon: null,
    color: null,
    tasks: { completed: 0, total: 0 },
    language: "en",
    createdAt: "2026-07-18T06:46:38.973Z",
    createdBy: {
      id: "user-id",
      name: "Leo Wang",
      role: "admin",
    },
    updatedAt: "2026-07-18T07:00:00.000Z",
    updatedBy: {
      id: "user-id",
      name: "Leo Wang",
      role: "admin",
    },
    collectionId: "collection-id",
    publishedAt: "2026-07-18T07:00:00.000Z",
    revision: 7,
    ...overrides,
  };
}

describe("CP-2379 response trim helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("trimDocBody keeps only nav metadata, drops `text`", () => {
    const trimmed = trimDocBody(fullDoc()) as Record<string, unknown>;
    expect(Object.keys(trimmed).sort()).toEqual(
      ["collectionId", "id", "title", "updatedAt", "url", "urlId"].sort(),
    );
    expect(trimmed).not.toHaveProperty("text");
  });

  test("trimDocBody returns null for nullish input", () => {
    expect(trimDocBody(null)).toBeNull();
    expect(trimDocBody(undefined)).toBeNull();
    expect(trimDocBody("string")).toBeNull();
    expect(trimDocBody(42)).toBeNull();
  });

  test("trimSearchHit keeps ranking + context + trimmed document", () => {
    const hit = {
      ranking: 0.9876,
      context: "snippet ... keyword ... snippet",
      document: fullDoc(),
    };
    const trimmed = trimSearchHit(hit) as Record<string, unknown>;
    expect(trimmed).toEqual({
      ranking: 0.9876,
      context: "snippet ... keyword ... snippet",
      document: {
        id: "doc-id",
        url: "/doc/doc-id",
        urlId: "abc-id",
        title: "Full Doc",
        collectionId: "collection-id",
        updatedAt: "2026-07-18T07:00:00.000Z",
      },
    });
    expect(JSON.stringify(trimmed)).not.toContain("trimmed from search");
  });

  test("trimSearchHit returns null for nullish input", () => {
    expect(trimSearchHit(null)).toBeNull();
    expect(trimSearchHit(undefined)).toBeNull();
  });
});

describe("CP-2379 outline_search_query response trim (AC1)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("strips document.text from every hit, keeps ranking/context + nav metadata", async () => {
    const hits = [
      {
        ranking: 0.99,
        context: "...redis sentinel...",
        document: fullDoc({ id: "d1", title: "Doc 1" }),
      },
      {
        ranking: 0.85,
        context: "...sentinel deployment...",
        document: fullDoc({ id: "d2", title: "Doc 2" }),
      },
    ];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: hits }));
    vi.stubGlobal("fetch", fetchMock);
    const tool = getMcpTool("outline_search_query");

    const result = await tool.execute("test-call-id", {
      query: "redis sentinel",
      limit: 10,
    });
    const details = unwrapDetails(result);

    expect(details.ok).toBe(true);
    expect(details.method).toBe("documents.search");
    expect(details.documents).toHaveLength(2);
    // AC1 reverse assertion: NO hit carries the full markdown body.
    expect(JSON.stringify(details)).not.toContain("trimmed from search");
    expect(JSON.stringify(details)).not.toContain("Round-tripping");
    for (const hit of details.documents) {
      expect(hit.document).not.toHaveProperty("text");
      expect(hit.document).not.toHaveProperty("createdBy");
      expect(hit.document).not.toHaveProperty("updatedBy");
      // Ranking + context preserved
      expect(hit).toHaveProperty("ranking");
      expect(hit).toHaveProperty("context");
      // Nav metadata preserved
      expect(hit.document).toHaveProperty("id");
      expect(hit.document).toHaveProperty("title");
      expect(hit.document).toHaveProperty("urlId");
    }
  });

  test("search response shape matches between MCP and CLI", async () => {
    const hits = [
      {
        ranking: 0.5,
        context: "snippet",
        document: fullDoc({ id: "d1" }),
      },
    ];
    const mcpFetch = vi.fn().mockResolvedValue(jsonResponse({ data: hits }));
    vi.stubGlobal("fetch", mcpFetch);
    const mcpTool = getMcpTool("outline_search_query");
    const mcpResult = await mcpTool.execute("test-call-id", {
      query: "x",
    });
    const mcpDetails = JSON.parse(mcpResult.content[0].text).details;

    const cliFetch = vi.fn().mockResolvedValue(jsonResponse({ data: hits }));
    vi.stubGlobal("fetch", cliFetch);
    const cliResult: any = await dispatchSearch(
      "query",
      { query: "x" },
      cfg,
    );
    const cliDetails = JSON.parse(cliResult.content[0].text);

    // Byte-for-byte parity on the trimmed `documents` array.
    expect(cliDetails.documents).toEqual(mcpDetails.documents);
    expect(cliDetails.method).toBe(mcpDetails.method);
  });
});

describe("CP-2379 outline_doc_list response trim (AC2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("strips text from every document, keeps nav metadata", async () => {
    const docs = [fullDoc({ id: "d1", title: "Doc 1" }), fullDoc({ id: "d2", title: "Doc 2" })];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: docs }));
    vi.stubGlobal("fetch", fetchMock);
    const tool = getMcpTool("outline_doc_list");

    const result = await tool.execute("test-call-id", { limit: 10 });
    const details = unwrapDetails(result);

    expect(details.ok).toBe(true);
    expect(details.method).toBe("documents.list");
    expect(details.documents).toHaveLength(2);
    // AC2 reverse assertion: NO doc carries the full markdown body.
    expect(JSON.stringify(details)).not.toContain("trimmed from search");
    for (const doc of details.documents) {
      expect(doc).not.toHaveProperty("text");
      expect(doc).not.toHaveProperty("createdBy");
      expect(doc).not.toHaveProperty("updatedBy");
      // Nav metadata preserved
      expect(doc).toHaveProperty("id");
      expect(doc).toHaveProperty("title");
      expect(doc).toHaveProperty("url");
      expect(doc).toHaveProperty("urlId");
      expect(doc).toHaveProperty("collectionId");
      expect(doc).toHaveProperty("updatedAt");
    }
  });

  test("doc_list response shape matches between MCP and CLI", async () => {
    const docs = [fullDoc({ id: "d1" })];
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

  test("doc_list handles empty data array without crashing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const tool = getMcpTool("outline_doc_list");

    const result = await tool.execute("test-call-id", {});
    const details = unwrapDetails(result);
    expect(details.documents).toEqual([]);
  });
});

describe("CP-2379 outline_doc_create round-trip trim (AC3)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("response `document` is trimmed — `text` from server must not round-trip", async () => {
    // The agent's input text is intentionally different from the server's
    // returned text so we can tell them apart in the assertion below.
    const created = fullDoc({
      id: "new-doc",
      title: "Brand new",
      revision: 1,
      text: "# Brand new\n\nServer-returned body that must be trimmed.",
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: created }))
      .mockResolvedValueOnce(jsonResponse({ data: created }));
    vi.stubGlobal("fetch", fetchMock);
    const tool = getMcpTool("outline_doc_create");

    const result = await tool.execute("test-call-id", {
      title: "Brand new",
      text: "# Brand new\n\nAgent input body (echoed in request).",
      collectionId: "collection-id",
    });
    const details = unwrapDetails(result);

    expect(details.ok).toBe(true);
    // AC3 reverse assertion: server-returned body MUST NOT round-trip.
    expect(details.document).not.toHaveProperty("text");
    expect(JSON.stringify(details.document)).not.toContain(
      "Server-returned body that must be trimmed",
    );
    // CP-2395: response `request` is also trimmed — the agent's own input
    // body MUST NOT round-trip back into the toolResult. Only {title} is
    // preserved (input breadcrumb, nav-level).
    expect(details.request).toEqual({ title: "Brand new" });
    expect(details.request).not.toHaveProperty("text");
    expect(details.request).not.toHaveProperty("collectionId");
    expect(JSON.stringify(details.request)).not.toContain("Agent input body");
    // But summary + nav metadata are preserved.
    expect(details.summary).toMatchObject({
      id: "new-doc",
      title: "Brand new",
    });
  });

  test("doc_create response shape matches between MCP and CLI", async () => {
    const created = fullDoc({ id: "new-doc", title: "Brand new" });
    const mcpFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: created }))
      .mockResolvedValueOnce(jsonResponse({ data: created }));
    vi.stubGlobal("fetch", mcpFetch);
    const mcpTool = getMcpTool("outline_doc_create");
    const mcpResult = await mcpTool.execute("test-call-id", {
      title: "Brand new",
      text: "body",
      collectionId: "c1",
    });
    const mcpDetails = JSON.parse(mcpResult.content[0].text).details;

    const cliFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: created }))
      .mockResolvedValueOnce(jsonResponse({ data: created }));
    vi.stubGlobal("fetch", cliFetch);
    const cliResult: any = await dispatchDoc(
      "create",
      { title: "Brand new", text: "body", collectionId: "c1" },
      cfg,
    );
    const cliDetails = JSON.parse(cliResult.content[0].text);

    expect(cliDetails.document).toEqual(mcpDetails.document);
    expect(cliDetails.summary).toEqual(mcpDetails.summary);
    // CP-2395: byte-for-byte parity on the trimmed `request` shape.
    expect(cliDetails.request).toEqual(mcpDetails.request);
  });
});

describe("CP-2379 outline_doc_update round-trip trim (AC3)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("response `document` is trimmed — `text` from server must not round-trip", async () => {
    // Server returns a different body from the one we sent in args so we
    // can tell which one leaks into the response.
    const updated = fullDoc({
      id: "doc-id",
      title: "Updated title",
      revision: 2,
      updatedAt: "2026-07-18T08:00:00.000Z",
      text: "# Updated title\n\nServer-returned body that must be trimmed.",
    });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: updated }));
    vi.stubGlobal("fetch", fetchMock);
    const tool = getMcpTool("outline_doc_update");

    const result = await tool.execute("test-call-id", {
      id: "doc-id",
      title: "Updated title",
      text: "# Updated title\n\nAgent input body (echoed in request).",
    });
    const details = unwrapDetails(result);

    expect(details.ok).toBe(true);
    // AC3 reverse assertion: server-returned body MUST NOT round-trip.
    expect(details.document).not.toHaveProperty("text");
    expect(JSON.stringify(details.document)).not.toContain(
      "Server-returned body that must be trimmed",
    );
    // CP-2395: response `request` is also trimmed — the agent's own input
    // body MUST NOT round-trip back. Only {id, title} preserved (nav-level
    // breadcrumb).
    expect(details.request).toEqual({ id: "doc-id", title: "Updated title" });
    expect(details.request).not.toHaveProperty("text");
    expect(JSON.stringify(details.request)).not.toContain("Agent input body");
    // Summary + nav metadata preserved.
    expect(details.summary).toMatchObject({
      id: "doc-id",
      title: "Updated title",
      revision: 2,
    });
  });

  test("doc_update response shape matches between MCP and CLI", async () => {
    const updated = fullDoc({
      id: "doc-id",
      title: "Updated title",
      revision: 2,
    });
    const mcpFetch = vi.fn().mockResolvedValue(jsonResponse({ data: updated }));
    vi.stubGlobal("fetch", mcpFetch);
    const mcpTool = getMcpTool("outline_doc_update");
    const mcpResult = await mcpTool.execute("test-call-id", {
      id: "doc-id",
      title: "Updated title",
    });
    const mcpDetails = JSON.parse(mcpResult.content[0].text).details;

    const cliFetch = vi.fn().mockResolvedValue(jsonResponse({ data: updated }));
    vi.stubGlobal("fetch", cliFetch);
    const cliResult: any = await dispatchDoc(
      "update",
      { id: "doc-id", title: "Updated title" },
      cfg,
    );
    const cliDetails = JSON.parse(cliResult.content[0].text);

    expect(cliDetails.document).toEqual(mcpDetails.document);
    expect(cliDetails.summary).toEqual(mcpDetails.summary);
    // CP-2395: byte-for-byte parity on the trimmed `request` shape.
    expect(cliDetails.request).toEqual(mcpDetails.request);
  });
});

describe("CP-2379 outline_doc_get still returns full body (regression — non-goal)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("outline_doc_get response includes `text` (we did NOT trim the single-doc fetch)", async () => {
    const full = fullDoc({ id: "doc-id", title: "Doc" });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: full }));
    vi.stubGlobal("fetch", fetchMock);
    const tool = getMcpTool("outline_doc_get");

    const result = await tool.execute("test-call-id", { id: "doc-id" });
    const details = unwrapDetails(result);

    expect(details.document).toHaveProperty("text");
    expect(details.document.text).toContain("trimmed from search");
  });
});

describe("CP-2395 request-echo trim helpers (AC1/AC2 — text MUST NOT round-trip)", () => {
  test("trimCreateRequest keeps only {title}, drops text + all heavy fields", () => {
    const trimmed = trimCreateRequest({
      title: "Brand new",
      text: "Full markdown body — this MUST NOT round-trip back",
      collectionId: "collection-id",
      publish: true,
      parentDocumentId: "parent-id",
    }) as Record<string, unknown>;

    expect(trimmed).toEqual({ title: "Brand new" });
    expect(trimmed).not.toHaveProperty("text");
    expect(trimmed).not.toHaveProperty("collectionId");
    expect(trimmed).not.toHaveProperty("publish");
    expect(trimmed).not.toHaveProperty("parentDocumentId");
    expect(JSON.stringify(trimmed)).not.toContain("Full markdown body");
  });

  test("trimUpdateRequest keeps {id, title?}, drops text + all heavy fields", () => {
    const withTitle = trimUpdateRequest({
      id: "doc-id",
      title: "Updated title",
      text: "Full markdown body — this MUST NOT round-trip back",
      editMode: "replace",
      publish: false,
    }) as Record<string, unknown>;

    expect(withTitle).toEqual({ id: "doc-id", title: "Updated title" });
    expect(withTitle).not.toHaveProperty("text");
    expect(withTitle).not.toHaveProperty("editMode");
    expect(withTitle).not.toHaveProperty("publish");
    expect(JSON.stringify(withTitle)).not.toContain("Full markdown body");

    const titleOnly = trimUpdateRequest({
      id: "doc-id",
      text: "Full markdown body — this MUST NOT round-trip back",
      editMode: "replace",
    }) as Record<string, unknown>;

    expect(titleOnly).toEqual({ id: "doc-id" });
    expect(titleOnly).not.toHaveProperty("text");
    expect(titleOnly).not.toHaveProperty("editMode");
  });

  test("trimCreateRequest / trimUpdateRequest are defensive on nullish input", () => {
    expect(trimCreateRequest(null)).toEqual({});
    expect(trimCreateRequest(undefined)).toEqual({});
    expect(trimCreateRequest("string")).toEqual({});
    expect(trimCreateRequest(42)).toEqual({});
    expect(trimUpdateRequest(null)).toEqual({});
    expect(trimUpdateRequest(undefined)).toEqual({});
  });
});

describe("CP-2395 MCP ↔ CLI byte-for-byte parity on trimmed `request`", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("doc_create request shape matches between MCP and CLI", async () => {
    const created = fullDoc({ id: "new-doc", title: "Brand new" });
    const mcpFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: created }))
      .mockResolvedValueOnce(jsonResponse({ data: created }));
    vi.stubGlobal("fetch", mcpFetch);
    const mcpTool = getMcpTool("outline_doc_create");
    const mcpResult = await mcpTool.execute("test-call-id", {
      title: "Brand new",
      text: "agent-input-body-must-not-round-trip",
      collectionId: "c1",
      publish: true,
    });
    const mcpDetails = JSON.parse(mcpResult.content[0].text).details;

    const cliFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: created }))
      .mockResolvedValueOnce(jsonResponse({ data: created }));
    vi.stubGlobal("fetch", cliFetch);
    const cliResult: any = await dispatchDoc(
      "create",
      {
        title: "Brand new",
        text: "agent-input-body-must-not-round-trip",
        collectionId: "c1",
        publish: true,
      },
      cfg,
    );
    const cliDetails = JSON.parse(cliResult.content[0].text);

    // Byte-for-byte parity on `request` after CP-2395 trim.
    expect(cliDetails.request).toEqual(mcpDetails.request);
    // Reverse: the agent's input body MUST NOT leak into either response.
    expect(JSON.stringify(mcpDetails.request)).not.toContain("agent-input-body-must-not-round-trip");
    expect(JSON.stringify(cliDetails.request)).not.toContain("agent-input-body-must-not-round-trip");
  });

  test("doc_update request shape matches between MCP and CLI", async () => {
    const updated = fullDoc({ id: "doc-id", title: "Updated title" });
    const mcpFetch = vi.fn().mockResolvedValue(jsonResponse({ data: updated }));
    vi.stubGlobal("fetch", mcpFetch);
    const mcpTool = getMcpTool("outline_doc_update");
    const mcpResult = await mcpTool.execute("test-call-id", {
      id: "doc-id",
      title: "Updated title",
      text: "agent-input-body-must-not-round-trip",
      editMode: "replace",
    });
    const mcpDetails = JSON.parse(mcpResult.content[0].text).details;

    const cliFetch = vi.fn().mockResolvedValue(jsonResponse({ data: updated }));
    vi.stubGlobal("fetch", cliFetch);
    const cliResult: any = await dispatchDoc(
      "update",
      {
        id: "doc-id",
        title: "Updated title",
        text: "agent-input-body-must-not-round-trip",
        editMode: "replace",
      },
      cfg,
    );
    const cliDetails = JSON.parse(cliResult.content[0].text);

    // Byte-for-byte parity on `request` after CP-2395 trim.
    expect(cliDetails.request).toEqual(mcpDetails.request);
    expect(cliDetails.request).toEqual({ id: "doc-id", title: "Updated title" });
    // Reverse: the agent's input body MUST NOT leak into either response.
    expect(JSON.stringify(mcpDetails.request)).not.toContain("agent-input-body-must-not-round-trip");
    expect(JSON.stringify(cliDetails.request)).not.toContain("agent-input-body-must-not-round-trip");
  });
});