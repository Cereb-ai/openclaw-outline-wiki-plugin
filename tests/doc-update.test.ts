import { afterEach, describe, expect, test, vi } from "vitest";
import plugin from "../src/index";

const cfg = {
  apiToken: "test-token",
  endpoint: "https://outline.example.test/api",
};

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

function errorResponse(): Response {
  return new Response(JSON.stringify({ error: "boom" }), {
    status: 500,
    statusText: "Internal Server Error",
    headers: { "Content-Type": "application/json" },
  });
}

function unwrapDetails(result: any) {
  return JSON.parse(result.content[0].text).details;
}

describe("outline_doc_update", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("rejects parentDocumentId before calling documents.update", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const tool = getTool("outline_doc_update");

    const result = await tool.execute("test-call-id", {
      id: "doc-id",
      text: "Updated body",
      parentDocumentId: "parent-id",
    });

    const details = unwrapDetails(result);
    expect(details.error).toContain("use outline_doc_move");
    expect(details.error).toContain("use outline_doc_move for reparent");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("updates normally when parentDocumentId is absent", async () => {
    const updated = {
      id: "doc-id",
      title: "Updated title",
      url: "https://outline.example.test/doc/doc-id",
      urlId: "doc-id",
      revision: 2,
      updatedAt: "2026-07-18T08:00:00.000Z",
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: updated }));
    vi.stubGlobal("fetch", fetchMock);
    const tool = getTool("outline_doc_update");

    const result = await tool.execute("test-call-id", {
      id: "doc-id",
      title: "Updated title",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://outline.example.test/api/documents.update",
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      id: "doc-id",
      title: "Updated title",
    });
    const details = unwrapDetails(result);
    expect(details).toMatchObject({
      ok: true,
      method: "documents.update",
      document: updated,
    });
  });

  test.each([
    ["missing strictChangelog", undefined],
    ["strictChangelog=false", false],
  ])("keeps changelog failure as warning when %s", async (_label, strictChangelog) => {
    const updated = { id: "doc-id", title: "Updated title" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: updated }))
      .mockResolvedValueOnce(errorResponse());
    vi.stubGlobal("fetch", fetchMock);
    const tool = getTool("outline_doc_update");

    const args: Record<string, unknown> = {
      id: "doc-id",
      title: "Updated title",
      changelog: "Changed title",
    };
    if (strictChangelog !== undefined) args.strictChangelog = strictChangelog;
    const result = await tool.execute("test-call-id", args);

    const details = unwrapDetails(result);
    expect(details.ok).toBe(true);
    expect(details.warnings[0]).toContain("changelog write skipped");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("returns an error when strictChangelog=true and changelog write fails", async () => {
    const updated = { id: "doc-id", title: "Updated title" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: updated }))
      .mockResolvedValueOnce(errorResponse());
    vi.stubGlobal("fetch", fetchMock);
    const tool = getTool("outline_doc_update");

    const result = await tool.execute("test-call-id", {
      id: "doc-id",
      title: "Updated title",
      changelog: "Changed title",
      strictChangelog: true,
    });

    const details = unwrapDetails(result);
    expect(details.error).toContain("strictChangelog=true");
    expect(details).not.toHaveProperty("ok", true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
