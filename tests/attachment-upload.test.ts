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

describe("outline_attachment_upload url mode (CP-2492 size guard)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("size>0 → ok:true with attachment echoed", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        data: {
          id: "attachment-real",
          url: "/api/attachments.redirect?id=attachment-real",
          size: "128",
          name: "good.txt",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const tool = getTool("outline_attachment_upload");

    const result = await tool.execute("test-call-id", {
      name: "good.txt",
      url: "https://example.test/good.txt",
      documentId: "doc-id",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://outline.example.test/api/attachments.createFromUrl",
    );
    const details = unwrapDetails(result);
    expect(details.ok).toBe(true);
    expect(details.method).toBe("attachments.createFromUrl");
    expect(details.summary).toEqual({
      id: "attachment-real",
      name: "good.txt",
      url: "/api/attachments.redirect?id=attachment-real",
    });
    expect(details.attachment).toMatchObject({ id: "attachment-real", size: "128" });
  });

  test("size=\"0\" → error 源 URL 不可达或抓取失败,附件为空 (no ok:true)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        data: {
          id: "attachment-empty",
          url: "/api/attachments.redirect?id=attachment-empty",
          size: "0",
          name: "bad.txt",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const tool = getTool("outline_attachment_upload");

    const result = await tool.execute("test-call-id", {
      name: "bad.txt",
      url: "https://example.test/missing.txt",
      documentId: "doc-id",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const details = unwrapDetails(result);
    expect(details.ok).toBeUndefined();
    expect(details.error).toBe("源 URL 不可达或抓取失败,附件为空");
    expect(details.method).toBe("attachments.createFromUrl");
    expect(details.attachment).toMatchObject({ id: "attachment-empty", size: "0" });
  });

  test("size missing → error 源 URL 不可达或抓取失败,附件为空 (no ok:true)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        data: {
          id: "attachment-nosize",
          url: "/api/attachments.redirect?id=attachment-nosize",
          name: "nosize.txt",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const tool = getTool("outline_attachment_upload");

    const result = await tool.execute("test-call-id", {
      name: "nosize.txt",
      url: "https://example.test/nosize.txt",
      documentId: "doc-id",
    });

    const details = unwrapDetails(result);
    expect(details.ok).toBeUndefined();
    expect(details.error).toBe("源 URL 不可达或抓取失败,附件为空");
    expect(details.attachment).toMatchObject({ id: "attachment-nosize" });
  });
});
