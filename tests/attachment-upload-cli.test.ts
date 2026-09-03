import { afterEach, describe, expect, test, vi } from "vitest";
import { dispatchAttachment } from "../src/cli";

const cfg = {
  apiToken: "test-token",
  endpoint: "https://outline.example.test/api",
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function unwrapDetails(result: any) {
  return JSON.parse(result.content[0].text);
}

describe("outline-tool attachment.upload url mode (CP-2505 Fix B sync)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

    const result = await dispatchAttachment(
      "upload",
      {
        name: "good.txt",
        url: "https://example.test/good.txt",
        documentId: "doc-id",
      },
      cfg,
    );

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

  test('size="0" → error 源 URL 不可达或抓取失败,附件为空 (no ok:true)', async () => {
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

    const result = await dispatchAttachment(
      "upload",
      {
        name: "bad.txt",
        url: "https://example.test/missing.txt",
        documentId: "doc-id",
      },
      cfg,
    );

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

    const result = await dispatchAttachment(
      "upload",
      {
        name: "nosize.txt",
        url: "https://example.test/nosize.txt",
        documentId: "doc-id",
      },
      cfg,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const details = unwrapDetails(result);
    expect(details.ok).toBeUndefined();
    expect(details.error).toBe("源 URL 不可达或抓取失败,附件为空");
    expect(details.method).toBe("attachments.createFromUrl");
    expect(details.attachment).toMatchObject({ id: "attachment-nosize" });
  });

  test("path branch (size from local file) is unchanged — ok:true with size>0", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "outline-cli-att-test-"));
    const path = join(dir, "upload.txt");
    await writeFile(path, "hello world payload");
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            data: {
              uploadUrl: "https://s3.example.test/upload",
              form: { key: "k", policy: "p" },
              attachment: {
                id: "att-path",
                url: "https://outline.example.test/attachments/att-path",
              },
            },
          }),
        )
        .mockResolvedValueOnce(new Response("", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const result = await dispatchAttachment(
        "upload",
        {
          name: "upload.txt",
          path,
          documentId: "doc-id",
        },
        cfg,
      );

      const details = unwrapDetails(result);
      expect(details.ok).toBe(true);
      expect(details.method).toBe("attachments.create (S3 presigned)");
      expect(details.summary.size).toBe(19);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
