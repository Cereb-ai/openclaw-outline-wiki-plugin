// CP-3752 — outline-wiki plugin parameter normalization.
//
//   AC1: ID-like parameters (`id`, `collectionId`, `parentDocumentId`,
//        `documentId`) accept string | integer, are trimmed, and reach the
//        wire as a normalized string. A non-existent id → ok=false + a
//        clear business error (NOT a schema-level `must be string`).
//   AC2: pagination parameters (`limit` / `offset`) accept number |
//        numeric string; out-of-range values are CLAMPED (never rejected);
//        non-integer / below-minimum values are rejected.
//   AC3: the CLI (`outline-tool`) and the MCP path behave identically.
//   AC4: content parameters stay STRICT — an object / array is rejected,
//        never silently `String()`-ified. The CP-3689 patch guardrail
//        keeps comparing the submitted text byte-for-byte.
//   AC5: the reproduction cases below were RED before the fix and GREEN
//        after it (see the commit history of this file).
//
// The pre-fix failure mode was a schema-level rejection: the TypeBox
// schema declared `id: Type.String()` and `limit: Type.Integer()`, so
// `outline_doc_get {id: 12345}` and `outline_collection_list {limit:
// "10"}` never reached the handler — OpenClaw refused the call with
// `must be string` / `must be integer` before any HTTP request was made.

import { afterEach, describe, expect, test, vi } from "vitest";
import plugin from "../src/index";
import {
  dispatchCollection,
  dispatchDoc,
  dispatchSearch,
} from "../src/cli";
// Outline's server-side pagination ceiling (outline repo
// `shared/constants.ts` → `Pagination.maxLimit`). Kept as a local
// constant so this behavioural suite can also be executed against the
// PRE-fix source tree (where `src/param-normalize.ts` does not exist yet)
// to capture the RED reproduction evidence.
const OUTLINE_MAX_LIMIT = 100;

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

function errorResponse(status = 404): Response {
  return new Response(JSON.stringify({ error: "not_found" }), {
    status,
    statusText: "Not Found",
    headers: { "Content-Type": "application/json" },
  });
}

// OpenClaw's own tool-schema validator — used to assert that the widened
// schemas accept the normalized shapes and reject the invalid ones before
// the handler ever runs.
async function validateAgainstSchema(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
): Promise<boolean> {
  const mod: any = await import(
    "../node_modules/openclaw/dist/schema-validator-B6lYLK9r.js"
  );
  const validate =
    mod.n ?? Object.values(mod).find((x: unknown) => typeof x === "function");
  const result = validate({
    schema,
    cacheKey: `cp3752-${JSON.stringify(value)}`,
    value,
  });
  return result.ok === true;
}

function unwrapDetails(result: any) {
  return JSON.parse(result.content[0].text).details;
}

function unwrapCli(result: any) {
  return JSON.parse(result.content[0].text);
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

describe("CP-3752: parameter normalization", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // ===== AC1: ID normalization =====

  describe("AC1 — ID-like parameters accept string | integer and are trimmed", () => {
    test("outline_doc_get accepts a numeric id and sends it as a string", async () => {
      const bodies = await captureMcpBodies(
        "outline_doc_get",
        { id: 12345 },
        [jsonResponse({ data: { id: "12345", title: "T" } })],
      );
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toEqual({ id: "12345" });
    });

    test("outline_doc_get trims a padded UUID id", async () => {
      const bodies = await captureMcpBodies(
        "outline_doc_get",
        { id: "  413abfdf-f545-42b6-845f-21f526c63ed4  " },
        [jsonResponse({ data: { id: "413abfdf-f545-42b6-845f-21f526c63ed4" } })],
      );
      expect(bodies[0]).toEqual({ id: "413abfdf-f545-42b6-845f-21f526c63ed4" });
    });

    test("a non-existent id yields ok=false + a business error (no schema rejection)", async () => {
      const fetchMock = vi.fn().mockResolvedValue(errorResponse(404));
      vi.stubGlobal("fetch", fetchMock);
      const tool = getMcpTool("outline_doc_get");
      const result = await tool.execute("test-call-id", { id: 999999 });
      const details = unwrapDetails(result);
      expect(details.ok).toBeUndefined();
      expect(details.error).toContain("404");
      // The request WAS sent (the id was normalized, not refused).
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        id: "999999",
      });
    });

    test("an object id is rejected with a clear error (never String()-ified)", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const tool = getMcpTool("outline_doc_get");
      const result = await tool.execute("test-call-id", { id: { a: 1 } });
      const details = unwrapDetails(result);
      expect(details.ok).toBeUndefined();
      expect(details.error).toContain("id");
      expect(details.error).toContain("string or an integer");
      // No HTTP request was made for an invalid id.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test("an array id is rejected with a clear error", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const tool = getMcpTool("outline_doc_get");
      const result = await tool.execute("test-call-id", { id: ["abc"] });
      const details = unwrapDetails(result);
      expect(details.ok).toBeUndefined();
      expect(details.error).toContain("string or an integer");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test("collectionId / parentDocumentId / documentId accept integers too", async () => {
      // outline_collection_documents
      const collectionBodies = await captureMcpBodies(
        "outline_collection_documents",
        { id: 42 },
        [jsonResponse({ data: [] })],
      );
      expect(collectionBodies[0].id).toBe("42");

      // outline_rev_log
      const revBodies = await captureMcpBodies(
        "outline_rev_log",
        { documentId: 77 },
        [jsonResponse({ data: [] })],
      );
      expect(revBodies[0].documentId).toBe("77");

      // outline_doc_create (collectionId + parentDocumentId)
      const created = { id: "doc-id" };
      const createBodies = await captureMcpBodies(
        "outline_doc_create",
        { title: "T", text: "body", collectionId: 7, parentDocumentId: 8 },
        [jsonResponse({ data: created }), jsonResponse({ data: created })],
      );
      expect(createBodies[0].collectionId).toBe("7");
      expect(createBodies[0].parentDocumentId).toBe("8");

      // outline_doc_move
      const moveBodies = await captureMcpBodies(
        "outline_doc_move",
        { id: 1, collectionId: 2 },
        [jsonResponse({ data: { id: "1" } })],
      );
      expect(moveBodies[0]).toEqual({ id: "1", collectionId: "2" });
    });
  });

  // ===== AC2: pagination normalization + clamping =====

  describe("AC2 — pagination accepts number | numeric string and clamps out-of-range values", () => {
    test("outline_collection_list accepts a numeric string limit", async () => {
      const bodies = await captureMcpBodies(
        "outline_collection_list",
        { limit: "10" },
        [jsonResponse({ data: [] })],
      );
      expect(bodies[0].limit).toBe(10);
    });

    test("outline_doc_list accepts a numeric string offset", async () => {
      const bodies = await captureMcpBodies(
        "outline_doc_list",
        { offset: "0" },
        [jsonResponse({ data: [] })],
      );
      expect(bodies[0].offset).toBe(0);
    });

    test("outline_doc_list clamps an over-large limit to the Outline API maximum", async () => {
      const bodies = await captureMcpBodies(
        "outline_doc_list",
        { limit: 5000 },
        [jsonResponse({ data: [] })],
      );
      expect(bodies[0].limit).toBe(OUTLINE_MAX_LIMIT);
    });

    test("outline_search_query clamps an over-large limit too", async () => {
      const bodies = await captureMcpBodies(
        "outline_search_query",
        { query: "x", limit: "5000" },
        [jsonResponse({ data: [] })],
      );
      expect(bodies[0].limit).toBe(OUTLINE_MAX_LIMIT);
    });

    test("outline_rev_log clamps its limit to 20", async () => {
      const bodies = await captureMcpBodies(
        "outline_rev_log",
        { documentId: "doc-id", limit: 999 },
        [jsonResponse({ data: [] })],
      );
      expect(bodies[0].limit).toBe(20);
    });

    test("a non-integer limit is rejected with a clear error", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const tool = getMcpTool("outline_collection_list");
      const result = await tool.execute("test-call-id", { limit: 1.5 });
      const details = unwrapDetails(result);
      expect(details.ok).toBeUndefined();
      expect(details.error).toContain("limit");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test("a limit below the minimum is rejected with a clear error", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const tool = getMcpTool("outline_collection_list");
      const result = await tool.execute("test-call-id", { limit: 0 });
      const details = unwrapDetails(result);
      expect(details.ok).toBeUndefined();
      expect(details.error).toContain("limit");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test("a negative offset is rejected with a clear error", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const tool = getMcpTool("outline_collection_list");
      const result = await tool.execute("test-call-id", { offset: -1 });
      const details = unwrapDetails(result);
      expect(details.ok).toBeUndefined();
      expect(details.error).toContain("offset");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test("the handler refuses limit=0 / limit=\"0\" (CP-3768: the gate moved from schema to handler)", async () => {
      // CP-3768: the registered schema now emits a bare JSON Schema type
      // array (`{ "type": ["integer", "string"] }`), which cannot carry the
      // `minimum: 1` / numeric-pattern constraints the old union schema
      // expressed — and the provider compat hook drops those keywords
      // anyway. The constraint therefore moved to the handler layer
      // (`src/param-normalize.ts`), which is where the pre-CP-3768 schema
      // refused `limit: 0` / `limit: "0"`. The accept-set is unchanged.
      //
      // The schema itself no longer rejects `limit: 0` — it accepts both
      // branches of the type array — but the CALL still fails, with the
      // plugin's own explicit error instead of a schema-level
      // `Invalid arguments`.
      const schema = JSON.parse(
        JSON.stringify(getMcpTool("outline_collection_list").parameters),
      );
      // The schema accepts the numeric and numeric-string branches ...
      expect(await validateAgainstSchema(schema, { limit: 20 })).toBe(true);
      expect(await validateAgainstSchema(schema, { limit: "20" })).toBe(true);
      // ... and the handler refuses the out-of-range values.
      for (const limit of [0, "0"]) {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        const tool = getMcpTool("outline_collection_list");
        const result = await tool.execute("test-call-id", { limit });
        const details = unwrapDetails(result);
        expect(details.ok).toBeUndefined();
        expect(details.error).toContain("limit");
        expect(fetchMock).not.toHaveBeenCalled();
      }
    });

    test("a non-numeric limit string is rejected by the handler (CP-3768)", async () => {
      // CP-3768: the pre-CP-3768 schema's string branch carried the
      // pattern `^\\s*0*[1-9]\\d*\\s*$`, so `"not-a-number"` was
      // refused at the schema layer. The schema no longer carries a
      // pattern, so the handler enforces it — the value is still
      // refused (never silently coerced to the default).
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const tool = getMcpTool("outline_collection_list");
      const result = await tool.execute("test-call-id", { limit: "not-a-number" });
      const details = unwrapDetails(result);
      expect(details.ok).toBeUndefined();
      expect(details.error).toContain("limit");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test("a numeric-string limit with surrounding whitespace is accepted", async () => {
      const bodies = await captureMcpBodies(
        "outline_collection_list",
        { limit: " 20 " },
        [jsonResponse({ data: [] })],
      );
      expect(bodies[0].limit).toBe(20);
    });
  });

  // ===== AC3: CLI ↔ MCP parity =====

  describe("AC3 — CLI and MCP paths behave identically", () => {
    test("doc.get with a numeric id produces the same wire body on both paths", async () => {
      const mcp = await captureMcpBodies(
        "outline_doc_get",
        { id: 12345 },
        [jsonResponse({ data: { id: "12345" } })],
      );
      const cli = await captureCliBodies(
        () => dispatchDoc("get", { id: 12345 }, cfg) as Promise<unknown>,
        [jsonResponse({ data: { id: "12345" } })],
      );
      expect(cli[0]).toEqual(mcp[0]);
      expect(cli[0]).toEqual({ id: "12345" });
    });

    test("doc.get with a padded id produces the same wire body on both paths", async () => {
      const args = { id: "  padded-id  " };
      const mcp = await captureMcpBodies(
        "outline_doc_get",
        args,
        [jsonResponse({ data: { id: "padded-id" } })],
      );
      const cli = await captureCliBodies(
        () => dispatchDoc("get", args, cfg) as Promise<unknown>,
        [jsonResponse({ data: { id: "padded-id" } })],
      );
      expect(cli[0]).toEqual(mcp[0]);
      expect(cli[0]).toEqual({ id: "padded-id" });
    });

    test("collection.list with a numeric-string limit matches on both paths", async () => {
      const args = { limit: "10" };
      const mcp = await captureMcpBodies(
        "outline_collection_list",
        args,
        [jsonResponse({ data: [] })],
      );
      const cli = await captureCliBodies(
        () =>
          dispatchCollection("list", args, cfg) as Promise<unknown>,
        [jsonResponse({ data: [] })],
      );
      expect(cli[0]).toEqual(mcp[0]);
      expect(cli[0].limit).toBe(10);
    });

    test("collection.list clamps an over-large limit on both paths", async () => {
      const args = { limit: 5000 };
      const mcp = await captureMcpBodies(
        "outline_collection_list",
        args,
        [jsonResponse({ data: [] })],
      );
      const cli = await captureCliBodies(
        () =>
          dispatchCollection("list", args, cfg) as Promise<unknown>,
        [jsonResponse({ data: [] })],
      );
      expect(cli[0]).toEqual(mcp[0]);
      expect(cli[0].limit).toBe(OUTLINE_MAX_LIMIT);
    });

    test("search.query with a numeric-string limit matches on both paths", async () => {
      const args = { query: "x", limit: "7", offset: "3" };
      const mcp = await captureMcpBodies(
        "outline_search_query",
        args,
        [jsonResponse({ data: [] })],
      );
      const cli = await captureCliBodies(
        () => dispatchSearch("query", args, cfg) as Promise<unknown>,
        [jsonResponse({ data: [] })],
      );
      expect(cli[0]).toEqual(mcp[0]);
      expect(cli[0]).toEqual({ query: "x", limit: 7, offset: 3 });
    });

    test("an invalid id is rejected identically on both paths", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const mcpTool = getMcpTool("outline_doc_get");
      const mcpResult = await mcpTool.execute("test-call-id", { id: { a: 1 } });
      const mcpDetails = unwrapDetails(mcpResult);

      const cliResult: any = await dispatchDoc("get", { id: { a: 1 } }, cfg);
      const cliDetails = unwrapCli(cliResult);

      expect(mcpDetails.ok).toBeUndefined();
      expect(cliDetails.ok).toBeUndefined();
      expect(mcpDetails.error).toContain("string or an integer");
      expect(cliDetails.error).toContain("string or an integer");
    });

    test("doc.update with a numeric id matches on both paths", async () => {
      const args = { id: 555, text: "new body" };
      const mcp = await captureMcpBodies(
        "outline_doc_update",
        args,
        [jsonResponse({ data: { id: "555" } })],
      );
      const cli = await captureCliBodies(
        () => dispatchDoc("update", args, cfg) as Promise<unknown>,
        [jsonResponse({ data: { id: "555" } })],
      );
      expect(cli[0]).toEqual(mcp[0]);
      expect(cli[0]).toEqual({ id: "555", text: "new body", editMode: "replace" });
    });
  });

  // ===== AC4: content parameters stay strict =====

  describe("AC4 — content parameters stay strict (no silent String()-ification)", () => {
    test("outline_doc_create rejects a non-string title", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const tool = getMcpTool("outline_doc_create");
      const result = await tool.execute("test-call-id", {
        title: { evil: true },
        text: "body",
        collectionId: "c1",
      });
      const details = unwrapDetails(result);
      expect(details.ok).toBeUndefined();
      expect(details.error).toContain("title");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test("outline_doc_create rejects a non-string text", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const tool = getMcpTool("outline_doc_create");
      const result = await tool.execute("test-call-id", {
        title: "T",
        text: ["body"],
        collectionId: "c1",
      });
      const details = unwrapDetails(result);
      expect(details.ok).toBeUndefined();
      expect(details.error).toContain("text");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test("outline_search_query rejects a non-string query", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const tool = getMcpTool("outline_search_query");
      const result = await tool.execute("test-call-id", { query: { q: 1 } });
      const details = unwrapDetails(result);
      expect(details.ok).toBeUndefined();
      expect(details.error).toContain("query");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test("outline_collection_create rejects a non-string name", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const tool = getMcpTool("outline_collection_create");
      const result = await tool.execute("test-call-id", { name: ["n"] });
      const details = unwrapDetails(result);
      expect(details.ok).toBeUndefined();
      expect(details.error).toContain("name");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test("the CLI rejects a non-string title the same way", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const result: any = await dispatchDoc(
        "create",
        { title: { evil: true }, text: "body", collectionId: "c1" },
        cfg,
      );
      const details = unwrapCli(result);
      expect(details.ok).toBeUndefined();
      expect(details.error).toContain("title");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test("the patch guardrail still compares the submitted text byte-for-byte", async () => {
      // A padded / near-miss anchor must still be rejected by the
      // preflight — normalization must not loosen the byte comparison.
      const infoResp = () =>
        jsonResponse({ data: { id: "doc-id", text: "alpha beta gamma" } });
      const fetchMock = vi.fn().mockResolvedValue(infoResp());
      vi.stubGlobal("fetch", fetchMock);
      const tool = getMcpTool("outline_doc_update");
      const result = await tool.execute("test-call-id", {
        id: "doc-id",
        text: "replacement",
        editMode: "patch",
        findText: " alpha beta gamma ",
      });
      const details = unwrapDetails(result);
      expect(details.ok).toBeUndefined();
      expect(details.error).toMatch(/not found|404/);
      // Only the preflight read happened — no update was sent.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

});
