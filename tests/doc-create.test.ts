import { afterEach, describe, expect, test, vi } from "vitest";
import plugin from "../src/index";

const cfg = {
  apiToken: "test-token",
  endpoint: "https://outline.example.test/api",
};

function getDocCreateTool() {
  const tools: any[] = [];
  plugin.register({
    pluginConfig: cfg,
    registerTool(definition: any) {
      tools.push(definition);
    },
  } as any);
  const tool = tools.find((candidate) => candidate.name === "outline_doc_create");
  if (!tool) throw new Error("outline_doc_create tool was not registered");
  return tool;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function emptyResponse(): Response {
  return new Response("", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function executeDocCreate() {
  const tool = getDocCreateTool();
  return await tool.execute(
    "test-call-id",
    {
      title: "Created from test",
      // CP-2395: unique sentinel so we can assert the agent's full input
      // body does NOT round-trip into the response (request must be trimmed
      // to {title} only).
      text: "CP-2395 unique input body sentinel that must not round-trip",
      collectionId: "collection-id",
    },
  );
}

function unwrapDetails(result: any) {
  return JSON.parse(result.content[0].text).details;
}

describe("outline_doc_create response validation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test.each([
    ["empty body", emptyResponse()],
    ["empty object", jsonResponse({})],
    ["null data", jsonResponse({ data: null })],
    ["missing id", jsonResponse({ data: { title: "Created from test" } })],
  ])("returns an error when documents.create returns %s", async (_label, response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const result = await executeDocCreate();

    const details = unwrapDetails(result);
    expect(details).toEqual({
      error:
        "documents.create returned empty data — server may have failed silently",
    });
    expect(details).not.toHaveProperty("ok", true);
  });

  test("returns ok with the created document summary when create and verify both succeed", async () => {
    const created = {
      id: "doc-id",
      title: "Created from test",
      url: "https://outline.example.test/doc/doc-id",
      urlId: "doc-id",
      revision: 1,
      publishedAt: "2026-07-18T07:00:00.000Z",
      // Outline also returns a body (`text`) and metadata that we strip on
      // the response (CP-2379 round-trip trim). They're included here to
      // confirm the trim actually drops them — they MUST NOT leak into
      // the response after the trim.
      text: "# Created from test\n\nFull body that the trim should drop.",
      collectionId: "collection-id",
      updatedAt: "2026-07-18T07:00:00.000Z",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: created }))
      .mockResolvedValueOnce(jsonResponse({ data: created }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeDocCreate();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ id: "doc-id" });
    const details = unwrapDetails(result);
    // CP-2379: response `document` is trimmed — only nav fields, no `text`.
    expect(details).toMatchObject({
      ok: true,
      method: "documents.create",
      document: {
        id: "doc-id",
        title: "Created from test",
        url: "https://outline.example.test/doc/doc-id",
        urlId: "doc-id",
        collectionId: "collection-id",
        updatedAt: "2026-07-18T07:00:00.000Z",
      },
      summary: {
        id: "doc-id",
        title: "Created from test",
        url: "https://outline.example.test/doc/doc-id",
        urlId: "doc-id",
        revision: 1,
        publishedAt: "2026-07-18T07:00:00.000Z",
      },
    });
    // CP-2379: the full markdown body MUST NOT round-trip back into the
    // agent's toolResult (the agent just sent it via `text`).
    expect(details.document).not.toHaveProperty("text");
    expect(JSON.stringify(details)).not.toContain("Full body that the trim should drop");
    // CP-2395: response `request` is also trimmed — only {title} is kept.
    // The full agent-input body (text/collectionId/publish/etc) MUST NOT
    // round-trip; otherwise the trim on `document` is undercut by an even
    // bigger echo right next to it.
    expect(details.request).toEqual({ title: "Created from test" });
    expect(details.request).not.toHaveProperty("text");
    expect(details.request).not.toHaveProperty("collectionId");
    expect(details.request).not.toHaveProperty("publish");
    expect(details.request).not.toHaveProperty("parentDocumentId");
    // Reverse assertion: the unique sentinel from the agent's input MUST
    // NOT appear anywhere in the response. The agent just sent it; it does
    // not need to receive it back.
    expect(JSON.stringify(details)).not.toContain(
      "CP-2395 unique input body sentinel that must not round-trip",
    );
  });
});
