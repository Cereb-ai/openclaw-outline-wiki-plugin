// CP-3768 — registered tool-schema shape for the outline plugin.
//
// Why this file exists
// ────────────────────
//
// CP-3752 widened the ID / pagination aliases with TypeBox's union
// builder. That serializes to a JSON Schema *union keyword*, and the
// `@openclaw/deepseek-provider` tool-compat hook lists that keyword (and
// its "exactly one of" sibling) as UNSUPPORTED: it flattens the union
// down to its FIRST branch (`selected = nonNullVariants[0]`).
//
// The flattened schema is what the model sees AND what the tool-call
// argument validator enforces, so after CP-3752 the plugin still refused
// a numeric `id` / a numeric-string `limit` at the schema layer — the
// exact failure CP-3740's final acceptance check hit
// (`commentId: must be string`).
//
// CP-3768 replaces the union with the JSON Schema **type array** form
// (`{ "type": ["string", "integer"] }`), which carries the same
// accept-set, uses no union keyword, and therefore survives the provider
// hook untouched.
//
// This suite asserts the SHAPE OF THE REGISTERED PRODUCT (the tool
// metadata the plugin actually publishes), not the return value of the
// alias helper functions — a helper-level assertion would keep passing
// even if the wiring were wrong.
//
//   AC1 (structure) — no union keyword survives anywhere in the
//                    registered schema tree; every alias field carries a
//                    `type` ARRAY with the right members.
//   AC2 (shape)     — the field inventory is complete; the optional
//                    semantics of `doc_create.parentDocumentId` and
//                    `attachment_upload.documentId` are preserved.
//   AC3 (behaviour) — the handler still owns the value checks
//                    (reject / clamp), the schema does not.
//   AC4 (guard)     — `outline_doc_update` still fails fast on
//                    `parentDocumentId`.

import { afterEach, describe, expect, test, vi } from "vitest";
import plugin from "../src/index";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import { dispatchDoc } from "../src/cli";

const cfg = {
  apiToken: "test-token",
  endpoint: "https://outline.example.test/api",
};

/**
 * The plugin's REGISTERED tool metadata — i.e. what OpenClaw publishes
 * to the provider and what the tool-call validator checks the agent's
 * arguments against.
 */
function registeredTools(): any[] {
  const metadata = (getToolPluginMetadata as any)(plugin);
  if (!metadata) throw new Error("plugin metadata is unavailable");
  return metadata.tools;
}

function toolMeta(name: string): any {
  const found = registeredTools().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`${name} is not a registered tool`);
  return found;
}

/**
 * The schema a tool is registered with, as the provider sees it (plain
 * JSON — no TypeBox symbols / getters survive serialization).
 */
function registeredSchema(name: string): any {
  return JSON.parse(JSON.stringify(toolMeta(name).parameters));
}

/** Collect every key that appears anywhere in the schema tree. */
function collectKeys(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) collectKeys(item, out);
    return out;
  }
  if (!node || typeof node !== "object") return out;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    out.add(key);
    collectKeys(value, out);
  }
  return out;
}

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

/**
 * The field inventory from CP-3765's conclusion (comment 48185): every
 * ID-like field and every pagination field, with the alias each one uses.
 *
 *   "id"    → type: ["string", "integer"]
 *   "page"  → type: ["integer", "string"]
 */
const ID_FIELDS: Array<[tool: string, field: string]> = [
  ["outline_doc_list", "collectionId"],
  ["outline_doc_get", "id"],
  ["outline_doc_create", "collectionId"],
  ["outline_doc_create", "parentDocumentId"],
  ["outline_doc_update", "id"],
  ["outline_doc_delete", "id"],
  ["outline_doc_archive", "id"],
  ["outline_doc_restore", "id"],
  ["outline_doc_move", "id"],
  ["outline_doc_move", "collectionId"],
  ["outline_doc_move", "parentDocumentId"],
  ["outline_search_query", "collectionId"],
  ["outline_collection_documents", "id"],
  ["outline_collection_update", "id"],
  ["outline_rev_log", "documentId"],
  ["outline_attachment_upload", "documentId"],
];

const PAGE_FIELDS: Array<[tool: string, field: string]> = [
  ["outline_doc_list", "limit"],
  ["outline_doc_list", "offset"],
  ["outline_search_query", "limit"],
  ["outline_search_query", "offset"],
  ["outline_collection_list", "limit"],
  ["outline_collection_list", "offset"],
  ["outline_collection_documents", "limit"],
  ["outline_collection_documents", "offset"],
  ["outline_rev_log", "limit"],
];

describe("CP-3768: registered tool-schema shape", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // ===== AC1 (structure) =====

  describe("AC1 — no union keyword survives in the registered schema", () => {
    test("all 15 tools are registered", () => {
      const names = registeredTools().map((tool) => tool.name);
      expect(names).toHaveLength(15);
      expect(new Set(names).size).toBe(15);
    });

    test("no tool schema contains a union keyword anywhere in its tree", () => {
      for (const tool of registeredTools()) {
        const keys = collectKeys(
          JSON.parse(JSON.stringify(tool.parameters)),
        );
        // The union keyword and its "exactly one of" sibling must be
        // absent — the provider hook flattens them to the first branch.
        expect([...keys]).not.toContain("anyOf");
        expect([...keys]).not.toContain("oneOf");
      }
    });

    test("the source no longer builds any union for the three aliases", () => {
      // A source-level guard: the aliases must not be reintroduced as a
      // TypeBox union (which would re-introduce the union keyword).
      const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");
      expect(source).not.toMatch(/Type\.Union/);
      expect(source).not.toMatch(/anyOf/);
    });

    test("the ID alias carries type:[\"string\",\"integer\"] with its description", () => {
      const schema = registeredSchema("outline_doc_get");
      const id = schema.properties.id;
      expect(id.type).toEqual(["string", "integer"]);
      expect(typeof id.description).toBe("string");
      expect(id.description.length).toBeGreaterThan(0);
    });

    test("the pagination aliases carry type:[\"integer\",\"string\"] with their description", () => {
      for (const [tool, field] of PAGE_FIELDS) {
        const schema = registeredSchema(tool);
        const prop = schema.properties[field];
        expect(prop.type, `${tool}.${field}`).toEqual(["integer", "string"]);
        expect(typeof prop.description, `${tool}.${field}`).toBe("string");
        expect(prop.description.length).toBeGreaterThan(0);
      }
    });

    test("no alias field was left without a type", () => {
      for (const [tool, field] of [...ID_FIELDS, ...PAGE_FIELDS]) {
        const schema = registeredSchema(tool);
        const prop = schema.properties[field];
        expect(prop, `${tool}.${field} must exist`).toBeDefined();
        expect(Array.isArray(prop.type), `${tool}.${field} must have a type ARRAY`).toBe(true);
        expect(prop.type.length, `${tool}.${field}`).toBeGreaterThan(0);
      }
    });
  });

  // ===== AC2 (field inventory + optional semantics) =====

  describe("AC2 — the field inventory is complete and optional semantics are preserved", () => {
    test("every ID-like field in the inventory uses the ID type array", () => {
      for (const [tool, field] of ID_FIELDS) {
        const schema = registeredSchema(tool);
        const prop = schema.properties[field];
        expect(prop, `${tool}.${field}`).toBeDefined();
        expect(prop.type, `${tool}.${field}`).toEqual(["string", "integer"]);
        expect(prop.type).toContain("string");
        expect(prop.type).toContain("integer");
      }
    });

    test("every pagination field in the inventory uses the pagination type array", () => {
      for (const [tool, field] of PAGE_FIELDS) {
        const schema = registeredSchema(tool);
        const prop = schema.properties[field];
        expect(prop, `${tool}.${field}`).toBeDefined();
        expect(prop.type, `${tool}.${field}`).toEqual(["integer", "string"]);
        expect(prop.type).toContain("integer");
        expect(prop.type).toContain("string");
      }
    });

    test("doc_create.parentDocumentId stays OPTIONAL", () => {
      const schema = registeredSchema("outline_doc_create");
      expect(schema.properties.parentDocumentId).toBeDefined();
      expect(schema.required ?? []).not.toContain("parentDocumentId");
    });

    test("attachment_upload.documentId stays OPTIONAL", () => {
      const schema = registeredSchema("outline_attachment_upload");
      expect(schema.properties.documentId).toBeDefined();
      expect(schema.required ?? []).not.toContain("documentId");
    });

    test("the required fields of the ID-bearing tools did not change", () => {
      // The optional/required split is part of the tool contract: the
      // type-array swap must not have flipped it.
      const required: Record<string, string[]> = {
        outline_doc_get: ["id"],
        outline_doc_update: ["id"],
        outline_doc_delete: ["id"],
        outline_doc_archive: ["id"],
        outline_doc_restore: ["id"],
        outline_doc_move: ["id", "collectionId"],
        outline_collection_documents: ["id"],
        outline_collection_update: ["id"],
        outline_rev_log: ["documentId"],
        outline_doc_create: ["title", "text"],
        outline_search_query: ["query"],
        outline_collection_create: ["name"],
        outline_attachment_upload: ["name"],
      };
      for (const [tool, fields] of Object.entries(required)) {
        const schema = registeredSchema(tool);
        expect(schema.required ?? [], tool).toEqual(fields);
      }
    });

    test("content parameters stay strict (a single type, not a type array)", () => {
      // The type-array swap must NOT have widened the content fields.
      const strict: Array<[tool: string, field: string]> = [
        ["outline_doc_create", "title"],
        ["outline_doc_create", "text"],
        ["outline_doc_update", "findText"],
        ["outline_doc_update", "changelog"],
        ["outline_search_query", "query"],
        ["outline_collection_create", "name"],
        ["outline_attachment_upload", "url"],
        ["outline_attachment_upload", "path"],
      ];
      for (const [tool, field] of strict) {
        const schema = registeredSchema(tool);
        const prop = schema.properties[field];
        expect(prop, `${tool}.${field}`).toBeDefined();
        expect(prop.type, `${tool}.${field} must stay a single type`).toBe("string");
      }
    });
  });

  // ===== AC3 (behaviour: the handler owns the value checks) =====

  describe("AC3 — the schema accepts both branches; the handler owns the range checks", () => {
    test("the registered schema accepts an id as a number and as a string", async () => {
      const schema = registeredSchema("outline_doc_get");
      const mod: any = await import(
        "../node_modules/openclaw/dist/schema-validator-B6lYLK9r.js"
      );
      const validate =
        mod.n ?? Object.values(mod).find((x: unknown) => typeof x === "function");
      for (const id of ["abc", 12345, "  12345  "]) {
        const result = validate({
          schema,
          cacheKey: `cp3768-${JSON.stringify(id)}`,
          value: { id },
        });
        expect(result.ok, `id=${JSON.stringify(id)}`).toBe(true);
      }
      // An object / an array is still refused by the schema.
      for (const id of [{ a: 1 }, ["abc"]]) {
        const result = validate({
          schema,
          cacheKey: `cp3768-${JSON.stringify(id)}`,
          value: { id },
        });
        expect(result.ok, `id=${JSON.stringify(id)}`).toBe(false);
      }
    });

    test("an id given as a number reaches the handler and is normalized", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse({ data: { id: "12345" } }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const tool = getMcpTool("outline_doc_get");
      await tool.execute("test-call-id", { id: 12345 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ id: "12345" });
    });

    test("an id given as a padded string is trimmed by the handler", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse({ data: { id: "413abfdf" } }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const tool = getMcpTool("outline_doc_get");
      await tool.execute("test-call-id", { id: "  413abfdf  " });
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        id: "413abfdf",
      });
    });

    test("an id given as an object / an array is refused by the handler", async () => {
      for (const id of [{ a: 1 }, ["abc"]]) {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        const tool = getMcpTool("outline_doc_get");
        const result = await tool.execute("test-call-id", { id });
        const details = unwrapDetails(result);
        expect(details.ok).toBeUndefined();
        expect(details.error).toContain("string or an integer");
        expect(fetchMock).not.toHaveBeenCalled();
      }
    });

    test("limit accepts 20 and \"20\"; limit 0 / \"abc\" are refused by the handler", async () => {
      for (const limit of [20, "20"]) {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
        vi.stubGlobal("fetch", fetchMock);
        const tool = getMcpTool("outline_collection_list");
        await tool.execute("test-call-id", { limit });
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).limit).toBe(20);
      }
      for (const limit of [0, "abc"]) {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        const tool = getMcpTool("outline_collection_list");
        const result = await tool.execute("test-call-id", { limit });
        const details = unwrapDetails(result);
        expect(details.ok, `limit=${JSON.stringify(limit)}`).toBeUndefined();
        expect(details.error).toContain("limit");
        expect(fetchMock).not.toHaveBeenCalled();
      }
    });

    test("a negative offset is refused by the handler", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const tool = getMcpTool("outline_collection_list");
      const result = await tool.execute("test-call-id", { offset: "-1" });
      const details = unwrapDetails(result);
      expect(details.ok).toBeUndefined();
      expect(details.error).toContain("offset");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test("an over-large limit is still clamped to 100 by the handler", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
      vi.stubGlobal("fetch", fetchMock);
      const tool = getMcpTool("outline_collection_list");
      await tool.execute("test-call-id", { limit: 500 });
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).limit).toBe(100);
    });

    test("rev_log still clamps its limit to 20", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
      vi.stubGlobal("fetch", fetchMock);
      const tool = getMcpTool("outline_rev_log");
      await tool.execute("test-call-id", { documentId: "doc-id", limit: 500 });
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).limit).toBe(20);
    });
  });

  // ===== AC4 (guard: doc_update still fails fast on parentDocumentId) =====

  describe("AC4 — the doc_update parentDocumentId guard is intact", () => {
    test("the MCP tool refuses parentDocumentId with a fail-fast error", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const tool = getMcpTool("outline_doc_update");
      const result = await tool.execute("test-call-id", {
        id: "doc-id",
        text: "body",
        parentDocumentId: "parent-id",
      });
      const details = unwrapDetails(result);
      expect(details.ok).toBeUndefined();
      expect(details.error).toContain("parentDocumentId");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test("the CLI refuses parentDocumentId the same way", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const result = await dispatchDoc(
        "update",
        { id: "doc-id", text: "body", parentDocumentId: "parent-id" },
        cfg,
      );
      const details = JSON.parse((result as any).content[0].text);
      expect(details.ok).toBeUndefined();
      expect(details.error).toContain("parentDocumentId");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

// `readFileSync` is imported lazily so the top of the file stays focused on
// the schema assertions.
import { readFileSync } from "node:fs";
