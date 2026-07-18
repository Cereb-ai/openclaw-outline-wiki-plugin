import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function unwrapDetails(result: any) {
  return JSON.parse(result.content[0].text).details;
}

async function withTempFile(run: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "outline-attachment-test-"));
  const path = join(dir, "upload.txt");
  await writeFile(path, "hello");
  try {
    await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("outline_attachment_upload path mode", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns an error for legacy files.create before any S3 POST", async () => {
    await withTempFile(async (path) => {
      const fetchMock = vi.fn().mockResolvedValueOnce(
        jsonResponse({
          data: {
            uploadUrl: "/api/files.create",
            form: { key: "legacy" },
            attachment: { id: "attachment-id" },
          },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const tool = getTool("outline_attachment_upload");

      const result = await tool.execute("test-call-id", {
        name: "upload.txt",
        path,
        documentId: "doc-id",
      });

      const details = unwrapDetails(result);
      expect(details.error).toContain("legacy files.create endpoint");
      expect(details.error).toContain("use `url` mode");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe(
        "https://outline.example.test/api/attachments.create",
      );
    });
  });

  test("keeps modern presigned upload behavior unchanged", async () => {
    await withTempFile(async (path) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            data: {
              uploadUrl: "https://s3.example.test/upload",
              form: { key: "modern", policy: "policy" },
              attachment: {
                id: "attachment-id",
                url: "https://outline.example.test/attachments/attachment-id",
              },
            },
          }),
        )
        .mockResolvedValueOnce(new Response("", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const tool = getTool("outline_attachment_upload");

      const result = await tool.execute("test-call-id", {
        name: "upload.txt",
        path,
        documentId: "doc-id",
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toBe(
        "https://outline.example.test/api/attachments.create",
      );
      expect(fetchMock.mock.calls[1][0]).toBe("https://s3.example.test/upload");
      expect(fetchMock.mock.calls[1][1].method).toBe("POST");
      const details = unwrapDetails(result);
      expect(details).toMatchObject({
        ok: true,
        method: "attachments.create (S3 presigned)",
      });
    });
  });
});
