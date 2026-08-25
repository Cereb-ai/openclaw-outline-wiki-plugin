#!/usr/bin/env node
// @ts-nocheck
/**
 * outline-tool — CLI wrapper for the @cereb/outline-wiki-openclaw-plugin.
 *
 * Allows all 15 plugin methods to be invoked from any shell / terminal,
 * independently of OpenClaw / OpenCode / Wecom DM.
 *
 * Reuses the same raw outlineFetch/auth config as the OpenClaw entry point.
 * Reads env (OUTLINE_API_TOKEN / OUTLINE_ENDPOINT / OUTLINE_DEFAULT_COLLECTION_ID)
 * the same way as the plugin.
 *
 * Method names are 100% aligned with the OpenClaw MCP tools: both the MCP
 * names (outline_doc_list / outline_search_query / ...) and the short
 * category.method names (doc.list / search.query / ...) are accepted.
 *
 * Usage:
 *   outline-tool <method> '<args-json>'
 *
 * Examples (MCP names):
 *   outline-tool outline_doc_list '{"limit":2}'
 *   outline-tool outline_doc_get '{"id":"..."}'
 *   outline-tool outline_search_query '{"query":"redis sentinel"}'
 *   outline-tool outline_collection_list '{}'
 *   outline-tool outline_collection_create '{"name":"Incidents"}'
 *   outline-tool outline_collection_update '{"id":"...","permission":"read_write"}'
 *   outline-tool outline_rev_log '{"documentId":"...","limit":5}'
 *   outline-tool outline_attachment_upload '{"name":"x.png","url":"https://...","preset":"documentAttachment","documentId":"..."}'
 *   outline-tool outline_attachment_upload '{"name":"x.png","path":"/tmp/x.png"}'
 *
 * Examples (short category.method names, backward compat):
 *   outline-tool doc.list '{"limit":2}'
 *   outline-tool doc.get '{"id":"..."}'
 *   outline-tool search.query '{"query":"redis sentinel"}'
 *   outline-tool attachment.upload '{"name":"x.png","url":"https://...","preset":"documentAttachment"}'
 *
 * Output: JSON to stdout on success; non-zero exit on failure.
 *
 * Exit codes: 0=ok, 2=JSON parse, 3=dispatch error, 4=shape error, 5=biz error
 */

import * as fs from "node:fs";
import * as os from "node:os";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";

// 100% parity with the OpenClaw native MCP tool names (outline_*).
const MCP_ALIASES: Record<string, string> = {
  outline_doc_list: "doc.list",
  outline_doc_get: "doc.get",
  outline_doc_create: "doc.create",
  outline_doc_update: "doc.update",
  outline_doc_delete: "doc.delete",
  outline_doc_archive: "doc.archive",
  outline_doc_restore: "doc.restore",
  outline_doc_move: "doc.move",
  outline_search_query: "search.query",
  outline_collection_list: "collection.list",
  outline_collection_documents: "collection.documents",
  outline_collection_create: "collection.create",
  outline_collection_update: "collection.update",
  outline_rev_log: "doc.rev_log",
  outline_attachment_upload: "attachment.upload",
};

const ATTACHMENT_PRESETS = ["documentAttachment", "avatar", "emoji"];

function readOpenClawOutlineConfig() {
  try {
    const p = os.homedir() + "/.openclaw/openclaw.json";
    const raw = fs.readFileSync(p, "utf-8");
    const cfg = JSON.parse(raw);
    const o = cfg?.plugins?.entries?.["outline-wiki-openclaw-plugin"]?.config ?? {};
    return {
      apiToken: typeof o.apiToken === "string" ? o.apiToken : void 0,
      endpoint: typeof o.endpoint === "string" ? o.endpoint : void 0,
      mcpEndpoint: typeof o.mcpEndpoint === "string" ? o.mcpEndpoint : void 0,
      defaultCollectionId: typeof o.defaultCollectionId === "string" ? o.defaultCollectionId : void 0,
    };
  } catch {
    return {};
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    printUsage();
    process.exit(1);
  }
  const raw = argv[0]; // e.g. "doc.list", "doc list", or MCP name "outline_doc_list"
  const argsStr = argv.slice(1).join(" ");

  if (raw === "--help" || raw === "-h" || argsStr === "--help" || argsStr === "-h") {
    printUsage();
    process.exit(0);
  }

  // Resolve MCP tool name (outline_doc_list) → category.method, else use as-is.
  const target = MCP_ALIASES[raw] ?? raw;

  // parse "<category>.<method>" or "<category> <method>"
  const parts = target.split(/[. ]/);
  if (parts.length < 2) {
    console.error(`outline-tool: invalid target "${raw}". Use <category>.<method> or the MCP tool name (outline_doc_list etc).`);
    process.exit(2);
  }
  const category = parts[0];
  const method = parts.slice(1).join(".");
  const supported = validCategories();
  if (!supported.includes(category)) {
    console.error(`outline-tool: unknown category "${category}". Supported: ${supported.join(" | ")}`);
    process.exit(2);
  }

  let args = {};
  if (argsStr.length > 0) {
    try {
      const parsed = JSON.parse(argsStr);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        console.error("outline-tool: args must be a JSON object");
        process.exit(2);
      }
      args = parsed;
    } catch (e) {
      console.error(`outline-tool: failed to parse args JSON: ${(e).message}`);
      process.exit(2);
    }
  }

  // Read config: env first, then fallback to openclaw.json plugins config
  let apiToken = process.env.OUTLINE_API_TOKEN || process.env.OUTLINE_TOKEN || "";
  let endpoint = process.env.OUTLINE_ENDPOINT || "";
  let mcpEndpoint = process.env.OUTLINE_MCP_ENDPOINT || "";
  let defaultCollectionId = process.env.OUTLINE_DEFAULT_COLLECTION_ID || "";
  if (!apiToken || !endpoint) {
    const oc = readOpenClawOutlineConfig();
    if (oc.apiToken) apiToken = oc.apiToken;
    if (oc.endpoint) endpoint = oc.endpoint;
    if (oc.mcpEndpoint) mcpEndpoint = oc.mcpEndpoint;
    if (oc.defaultCollectionId) defaultCollectionId = oc.defaultCollectionId;
  }
  if (!apiToken || !endpoint) {
    console.error("outline-tool: missing required credentials. Set OUTLINE_API_TOKEN + OUTLINE_ENDPOINT env, or config them in openclaw.json plugins.entries.outline-wiki-openclaw-plugin.config");
    process.exit(3);
  }

  const cfg = { apiToken, endpoint, mcpEndpoint, defaultCollectionId };

  let result;
  try {
    result = await dispatch(category, method, args, cfg);
  } catch (e) {
    console.error(`outline-tool: dispatch failed: ${(e).message}`);
    process.exit(3);
  }

  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") {
    console.error("outline-tool: unexpected result shape");
    process.exit(4);
  }
  console.log(text);
  if (result.isError === true) {
    process.exit(5);
  }
}

async function dispatch(
  category: string,
  method: string,
  args: Record<string, unknown>,
  cfg: { apiToken: string; endpoint: string; mcpEndpoint?: string; defaultCollectionId?: string },
) {
  switch (category) {
    case "doc":
      return dispatchDoc(method, args, cfg);
    case "collection":
      return dispatchCollection(method, args, cfg);
    case "search":
      return dispatchSearch(method, args, cfg);
    case "attachment":
      return dispatchAttachment(method, args, cfg);
    default:
      return textResult({ error: `Unknown category: ${category}` });
  }
}

// --- doc handlers (mirror the plugin) ---

async function dispatchDoc(
  method: string,
  args: Record<string, unknown>,
  cfg: { apiToken: string; endpoint: string; defaultCollectionId?: string },
) {
  switch (method) {
    case "list": {
      const body = { limit: args.limit ?? 25, offset: args.offset ?? 0 };
      if (typeof args.collectionId === "string") body.collectionId = args.collectionId;
      if (typeof args.query === "string") body.query = args.query;
      const data = await outlineFetch(cfg, "documents.list", body);
      return textResult({ ok: true, method: "documents.list", documents: data?.data ?? [], pagination: data?.pagination ?? null });
    }
    case "get": {
      if (typeof args.id !== "string") return textResult({ error: "doc.get requires a non-empty `id` (string)" });
      const data = await outlineFetch(cfg, "documents.info", { id: args.id });
      return textResult({ ok: true, method: "documents.info", ...data?.data ?? {} });
    }
    case "create": {
      if (typeof args.title !== "string" || args.title.length === 0) {
        return textResult({ error: "doc.create requires a non-empty `title` (string) argument." });
      }
      if (typeof args.text !== "string") {
        return textResult({ error: "doc.create requires `text` (string) argument (markdown body)." });
      }
      // collectionId resolution order: explicit args.collectionId > cfg.defaultCollectionId.
      // Mirrors outline_doc_create (index.ts:541-551). Falls back to config; if
      // both are missing, surface an explicit error rather than silently sending
      // `collectionId: undefined` to outline (which returns 400 validation_error).
      const collectionId =
        (typeof args.collectionId === "string" && args.collectionId.length > 0
          ? args.collectionId
          : undefined) ?? cfg.defaultCollectionId;
      if (!collectionId) {
        return textResult({
          error:
            "doc.create requires `collectionId` (string) — pass it as an arg, or set `defaultCollectionId` in the plugin config.",
        });
      }
      const body: Record<string, unknown> = {
        title: args.title,
        text: args.text,
        collectionId,
        publish: typeof args.publish === "boolean" ? args.publish : true,
      };
      if (typeof args.parentDocumentId === "string" && args.parentDocumentId.length > 0) {
        body.parentDocumentId = args.parentDocumentId;
      }
      try {
        const data = await outlineFetch(cfg, "documents.create", body);
        const created = data?.data ?? null;
        const createdId = created?.id;
        if (typeof createdId !== "string" || createdId.length === 0) {
          return textResult({
            error: "documents.create returned empty data — server may have failed silently",
          });
        }
        try {
          await verifyCreatedDocument(cfg, createdId);
        } catch (err) {
          return textResult({
            error: `documents.create verify failed for id "${createdId}": ${errorMessage(err)}`,
          });
        }
        return textResult({
          ok: true,
          method: "documents.create",
          request: body,
          document: created,
          summary: created
            ? {
                id: created.id,
                title: created.title,
                url: created.url,
                urlId: created.urlId,
                revision: created.revision,
                publishedAt: created.publishedAt ?? null,
              }
            : null,
        });
      } catch (err) {
        if (errorMessage(err).startsWith("Response was not JSON (HTTP 200):")) {
          return textResult({ error: "documents.create returned empty data — server may have failed silently" });
        }
        return textResult({ error: `documents.create failed: ${errorMessage(err)}` });
      }
    }
    case "update": {
      if (typeof args.id !== "string" || args.id.length === 0) {
        return textResult({ error: "doc.update requires a non-empty `id` (string) argument." });
      }
      // parentDocumentId is rejected (server silently drops it) — mirror outline_doc_update
      // (index.ts:648-659). Reparent via doc.move instead.
      if (args.parentDocumentId !== undefined) {
        return textResult({
          error:
            "doc.update does not accept `parentDocumentId` — the outline server silently drops it. " +
            "To reparent a document, use doc.move with the new `collectionId` (same collection is fine) and the new `parentDocumentId`. " +
            "Example: doc.move {id, collectionId, parentDocumentId: '<new-parent-uuid>'}.",
        });
      }
      if (typeof args.text !== "string" && typeof args.title !== "string") {
        return textResult({
          error: "doc.update requires at least one of `text` or `title` (string) to change.",
        });
      }
      const body: Record<string, unknown> = { id: args.id };
      if (typeof args.text === "string") {
        body.text = args.text;
        body.editMode = typeof args.editMode === "string" ? args.editMode : "replace";
      }
      if (typeof args.title === "string") {
        body.title = args.title;
      }
      if (typeof args.publish === "boolean") body.publish = args.publish;
      // Best-effort changelog (mirrors outline_doc_update: write latest revision's `name`).
      // Non-fatal unless `strictChangelog=true`.
      const warnings: string[] = [];
      try {
        const data = await outlineFetch(cfg, "documents.update", body);
        const updated = data?.data ?? null;
        if (typeof args.changelog === "string" && args.changelog.length > 0) {
          const result = await writeChangelog(args.id, args.changelog, cfg);
          if ("warning" in result) {
            if (args.strictChangelog === true) {
              return textResult({
                error: `documents.update changelog write failed with strictChangelog=true: ${result.warning}`,
                method: "documents.update",
                request: body,
                document: updated,
              });
            }
            warnings.push(result.warning);
          }
        }
        return textResult({
          ok: true,
          method: "documents.update",
          request: body,
          document: updated,
          summary: updated
            ? {
                id: updated.id,
                title: updated.title,
                url: updated.url,
                urlId: updated.urlId,
                revision: updated.revision,
                updatedAt: updated.updatedAt ?? null,
              }
            : null,
          warnings: warnings.length > 0 ? warnings : undefined,
        });
      } catch (err) {
        return textResult({ error: `documents.update failed: ${errorMessage(err)}` });
      }
    }
    case "delete": {
      if (typeof args.id !== "string") return textResult({ error: "doc.delete requires a non-empty `id` (string)" });
      const data = await outlineFetch(cfg, "documents.delete", { id: args.id, permanent: args.permanent === true });
      return textResult({ ok: true, method: "documents.delete", ...data?.data ?? {} });
    }
    case "archive": {
      if (typeof args.id !== "string") return textResult({ error: "doc.archive requires a non-empty `id` (string)" });
      const data = await outlineFetch(cfg, "documents.archive", { id: args.id });
      return textResult({ ok: true, method: "documents.archive", ...data?.data ?? {} });
    }
    case "restore": {
      if (typeof args.id !== "string") return textResult({ error: "doc.restore requires a non-empty `id` (string)" });
      const data = await outlineFetch(cfg, "documents.restore", { id: args.id });
      return textResult({ ok: true, method: "documents.restore", ...data?.data ?? {} });
    }
    case "move": {
      if (typeof args.id !== "string") return textResult({ error: "doc.move requires a non-empty `id` (string)" });
      const body = { id: args.id, collectionId: args.collectionId };
      if (typeof args.parentDocumentId === "string") body.parentDocumentId = args.parentDocumentId;
      const data = await outlineFetch(cfg, "documents.move", body);
      return textResult({ ok: true, method: "documents.move", ...data?.data ?? {} });
    }
    case "rev_log": {
      if (typeof args.documentId !== "string" || args.documentId.length === 0) {
        return textResult({ error: "doc.rev_log requires a non-empty `documentId` (string) argument." });
      }
      const rawLimit = typeof args.limit === "number" ? args.limit : 5;
      const limit = Math.min(20, Math.max(1, Math.trunc(rawLimit)));
      const data = await outlineFetch(cfg, "revisions.list", { documentId: args.documentId, limit });
      return textResult({ ok: true, method: "revisions.list", revisions: data?.data ?? [], pagination: data?.pagination ?? null });
    }
    default:
      return textResult({ error: `Unknown doc method: ${method}` });
  }
}

async function dispatchCollection(
  method: string,
  args: Record<string, unknown>,
  cfg: { apiToken: string; endpoint: string },
) {
  if (method === "list") {
    const body = { limit: args.limit ?? 25, offset: args.offset ?? 0 };
    const data = await outlineFetch(cfg, "collections.list", body);
    return textResult({ ok: true, method: "collections.list", collections: data?.data ?? [], pagination: data?.pagination ?? null });
  }
  if (method === "documents") {
    const body = { id: args.id, limit: args.limit ?? 25, offset: args.offset ?? 0 };
    const data = await outlineFetch(cfg, "collections.documents", body);
    return textResult({ ok: true, method: "collections.documents", documents: data?.data ?? [], pagination: data?.pagination ?? null });
  }
  if (method === "create") {
    if (typeof args.name !== "string" || args.name.length === 0) {
      return textResult({ error: "collection.create requires a non-empty `name` (string)" });
    }
    const body: Record<string, unknown> = { name: args.name };
    if (typeof args.description === "string" && args.description.length > 0) body.description = args.description;
    if (typeof args.icon === "string" && args.icon.length > 0) body.icon = args.icon;
    if (typeof args.color === "string" && args.color.length > 0) body.color = args.color;
    // permission default = "read_write" (not null — that would make the
    // collection admin-only and is the root cause of "I created a collection
    // but nobody can see it" incidents).
    if (typeof args.permission === "string" && args.permission.length > 0) {
      body.permission = args.permission;
    } else {
      body.permission = "read_write";
    }
    if (typeof args.sharing === "boolean") {
      body.sharing = args.sharing;
    } else {
      body.sharing = true;
    }
    const data = await outlineFetch(cfg, "collections.create", body);
    return textResult({ ok: true, method: "collections.create", collection: data?.data ?? null });
  }
  if (method === "update") {
    if (typeof args.id !== "string" || args.id.length === 0) {
      return textResult({ error: "collection.update requires a non-empty `id` (string)" });
    }
    const mutable = ["name", "description", "icon", "color", "permission", "sharing"];
    const hasAny = mutable.some((k) => typeof args[k] !== "undefined");
    if (!hasAny) {
      return textResult({ error: "collection.update requires at least one of " + mutable.join(", ") });
    }
    const body: Record<string, unknown> = { id: args.id };
    for (const k of mutable) {
      if (typeof args[k] !== "undefined") body[k] = args[k];
    }
    const data = await outlineFetch(cfg, "collections.update", body);
    return textResult({ ok: true, method: "collections.update", collection: data?.data ?? null });
  }
  return textResult({ error: `Unknown collection method: ${method}` });
}

async function dispatchSearch(
  method: string,
  args: Record<string, unknown>,
  cfg: { apiToken: string; endpoint: string },
) {
  const body = { query: args.query, limit: pickNumber(args.limit, 25), offset: pickNumber(args.offset, 0) };
  if (typeof args.collectionId === "string") body.collectionId = args.collectionId;
  const data = await outlineFetch(cfg, "documents.search", body);
  return textResult({ ok: true, method: "documents.search", results: data?.data ?? [], pagination: data?.pagination ?? null });
}

async function dispatchAttachment(
  method: string,
  args: Record<string, unknown>,
  cfg: { apiToken: string; endpoint: string },
) {
  if (method !== "upload") return textResult({ error: `Unknown attachment method: ${method}` });
  if (typeof args.name !== "string" || args.name.length === 0) {
    return textResult({ error: "attachment.upload requires a non-empty `name` (string) argument." });
  }
  if (typeof args.url !== "string" && typeof args.path !== "string") {
    return textResult({
      error:
        "attachment.upload requires either `url` (string, outline fetches it) or `path` (string, plugin reads + uploads).",
    });
  }
  const presetRaw = typeof args.preset === "string" ? args.preset : "documentAttachment";
  if (!ATTACHMENT_PRESETS.includes(presetRaw)) {
    return textResult({ error: `attachment.upload preset must be one of: ${ATTACHMENT_PRESETS.join(", ")}.` });
  }
  const preset = presetRaw;

  // Branch A: caller provides a URL. outline's `attachments.createFromUrl`
  // endpoint fetches the URL server-side, attaches the resulting file to
  // the given document, and returns the attachment record in one round-trip.
  if (typeof args.url === "string") {
    if (preset !== "documentAttachment") {
      return textResult({
        error:
          "attachment.upload with `url` only supports preset=documentAttachment; use `path` for avatar/emoji.",
      });
    }
    if (typeof args.documentId !== "string" || args.documentId.length === 0) {
      return textResult({
        error:
          "attachment.upload with `url` requires `documentId` (string, UUID) — outline's createFromUrl endpoint refuses document attachments without a target document.",
      });
    }
    const body = { name: args.name, url: args.url, documentId: args.documentId, preset };
    const data = await outlineFetch(cfg, "attachments.createFromUrl", body);
    const attachment = data?.data ?? null;
    return textResult({
      ok: true,
      method: "attachments.createFromUrl",
      request: { name: args.name, url: args.url, documentId: args.documentId, preset },
      attachment,
      summary: attachment ? { id: attachment.id, name: args.name, url: attachment.url ?? null } : null,
    });
  }

  // Branch B: caller provides a local file path. Read the file, mint an S3
  // presigned POST via `attachments.create` (step 1), then PUT to S3 (step 2).
  const path = args.path as string;
  const contentType =
    typeof args.contentType === "string" && args.contentType.length > 0
      ? args.contentType
      : "application/octet-stream";
  const documentId =
    typeof args.documentId === "string" && args.documentId.length > 0
      ? args.documentId
      : undefined;

  let buffer: Buffer;
  try {
    buffer = await readFile(path);
  } catch (err) {
    return textResult({ error: `attachment.upload failed to read local file: ${(err).message}` });
  }
  const size = buffer.length;

  let step1: any;
  try {
    step1 = await outlineFetch(cfg, "attachments.create", {
      name: args.name,
      contentType,
      size,
      documentId,
      preset,
    });
  } catch (err) {
    return textResult({ error: `attachments.create (step 1) failed: ${(err).message}` });
  }

  const { uploadUrl, form, attachment } = step1?.data ?? {};
  if (typeof uploadUrl !== "string" || !form || typeof form !== "object") {
    return textResult({
      error:
        "attachments.create did not return uploadUrl/form — outline API contract changed?",
      hint: "See outline server source: server/routes/api/attachments/attachments.ts `attachments.create` handler.",
    });
  }

  // Legacy / pre-S3 outline servers hand back a relative `/api/files.create`
  // URL here instead of a real S3 presigned POST. `files.create` is
  // cookie-only auth, so a Bearer-token PUT will always 401/403. Detect the
  // legacy URL up front and surface a clear hint.
  if (isLegacyFilesCreateUploadUrl(uploadUrl)) {
    return textResult({
      error:
        "dev wiki is using the legacy files.create endpoint which requires a browser session cookie. " +
        "path mode is not supported on this outline instance; use `url` mode or upload via the outline web UI.",
      hint:
        "Modern outline versions (post S3 migration) expose a real S3 presigned POST URL here. " +
        "This dev wiki is on the legacy files.create flow. To upload a local file: " +
        "first publish it somewhere Bearer-fetchable (e.g. your own S3 / OSS / a public pastebin), " +
        "then call `outline_attachment_upload {url: <public_url>, name, documentId}`.",
    });
  }

  // Step 2: PUT to S3. S3 presigned POST expects every entry in `form`
  // to appear in the multipart body BEFORE the `file` field, in the
  // same order they were issued. Object.entries preserves insertion order.
  try {
    const fd = new FormData();
    for (const [k, v] of Object.entries(form)) {
      if (typeof v === "string") fd.append(k, v);
    }
    fd.append("file", new Blob([new Uint8Array(buffer)], { type: contentType }), args.name);
    const res = await fetch(uploadUrl, { method: "POST", body: fd });
    if (!res.ok) {
      const text = await res.text();
      const snippet = text.length > 500 ? `${text.slice(0, 500)}…` : text;
      throw new Error(`S3 PUT failed: HTTP ${res.status} ${res.statusText}: ${snippet}`);
    }
  } catch (err) {
    return textResult({ error: `attachment S3 PUT (step 2) failed: ${(err).message}` });
  }

  return textResult({
    ok: true,
    method: "attachments.create (S3 presigned)",
    request: { name: args.name, contentType, size, documentId, preset, path },
    attachment: attachment ?? null,
    summary: attachment
      ? { id: attachment.id, name: args.name, contentType, size, url: attachment.url ?? null }
      : null,
  });
}

function isLegacyFilesCreateUploadUrl(uploadUrl: string): boolean {
  if (uploadUrl.startsWith("/api/files.create")) return true;
  try {
    return new URL(uploadUrl).pathname === "/api/files.create";
  } catch {
    return false;
  }
}

// --- helpers ---

async function verifyCreatedDocument(
  cfg: { apiToken: string; endpoint: string },
  id: string,
): Promise<void> {
  const info = await outlineFetch(cfg, "documents.info", { id });
  const verifiedId = info?.data?.id;
  if (typeof verifiedId !== "string" || verifiedId.length === 0) {
    throw new Error("documents.info returned empty data");
  }
}

/**
 * Best-effort changelog write for doc.update. Mirrors writeChangelog in
 * index.ts: after a successful `documents.update`, look up the latest revision
 * for the given documentId and write `changelog` into its `name` field via
 * `revisions.update`. Failures return `{warning}` instead of throwing, so the
 * caller can decide whether to fail hard (strictChangelog=true) or just
 * surface a warning.
 *
 * Returns `{ok: true}` on success or `{warning: string}` on failure.
 */
async function writeChangelog(
  documentId: string,
  changelog: string,
  cfg: { apiToken: string; endpoint: string },
): Promise<{ ok: true } | { warning: string }> {
  let listed: any;
  try {
    listed = await outlineFetch(cfg, "revisions.list", {
      documentId,
      limit: 1,
      direction: "DESC",
    });
  } catch (err) {
    return {
      warning: `changelog write skipped: revisions.list failed: ${errorMessage(err)}`,
    };
  }
  const latest = listed?.data?.[0];
  if (!latest || typeof latest.id !== "string") {
    return {
      warning:
        "changelog write skipped: revisions.list returned no revisions for the updated document.",
    };
  }
  try {
    await outlineFetch(cfg, "revisions.update", {
      id: latest.id,
      name: changelog,
    });
    return { ok: true };
  } catch (err) {
    return {
      warning: `changelog write skipped: revisions.update failed for revision ${latest.id}: ${errorMessage(err)}`,
    };
  }
}

function pickNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function outlineFetch(
  cfg: { apiToken: string; endpoint: string },
  action: string,
  body: Record<string, unknown>,
) {
  const url = `${cfg.endpoint.replace(/\/+$/, "")}/${action}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiToken}`,
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    const snippet = text.length > 500 ? `${text.slice(0, 500)}…` : text;
    throw new Error(`Outline API ${res.status}: ${snippet}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `Response was not JSON (HTTP ${res.status}): ${text.slice(0, 200)}`,
    );
  }
}

function textResult(data: Record<string, unknown>): { content: { type: string; text: string }[]; details: Record<string, unknown>; isError: boolean } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data, isError: data?.error ? true : false };
}

function validCategories() {
  return ["doc", "collection", "search", "attachment"];
}

function printUsage() {
  const cats = validCategories().join(" | ");
  console.error([
    "Usage: outline-tool <method> '<args-json>'",
    "",
    `Categories: ${cats}`,
    "",
    "Methods (15, 100% aligned with MCP tools — MCP names or short names both accepted):",
    "  MCP name          short name",
    "  outline_doc_list        doc.list",
    "  outline_doc_get         doc.get",
    "  outline_doc_create      doc.create",
    "  outline_doc_update      doc.update",
    "  outline_doc_delete      doc.delete",
    "  outline_doc_archive     doc.archive",
    "  outline_doc_restore     doc.restore",
    "  outline_doc_move        doc.move",
    "  outline_search_query    search.query",
    "  outline_collection_list        collection.list",
    "  outline_collection_documents    collection.documents",
    "  outline_collection_create       collection.create",
    "  outline_collection_update       collection.update",
    "  outline_rev_log         doc.rev_log",
    "  outline_attachment_upload       attachment.upload",
    "",
    "Examples:",
    '  outline-tool doc.list \'{"limit":2}\'',
    '  outline-tool outline_doc_get \'{"id":"..."}\'',
    '  outline-tool outline_search_query \'{"query":"redis sentinel"}\'',
    '  outline-tool outline_rev_log \'{"documentId":"...","limit":5}\'',
    '  outline-tool attachment.upload \'{"name":"x.png","url":"https://...","preset":"documentAttachment"}\'',
    "",
    "Env (same as OpenClaw plugin):",
    "  OUTLINE_API_TOKEN    Bearer token (required)",
    "  OUTLINE_ENDPOINT     API endpoint, e.g. https://your-outline.example.com/api (required)",
    "",
    "Exit codes: 0=ok, 2=parse, 3=dispatch, 4=shape, 5=biz error",
  ].join("\n"));
}

// Only run main() when this file is invoked as the CLI entrypoint (e.g. via
// the `outline-tool` bin) — not when it's imported by a test or other module.
// Without this guard, `vitest` would inherit the process.exit() path and
// parity tests could not import the dispatch surface.
const isCliEntry = (() => {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return import.meta.url === pathToFileURL(argv1).href;
  } catch {
    return false;
  }
})();
if (isCliEntry) {
  main().catch((e) => {
    console.error(`outline-tool: fatal: ${(e).message}`);
    process.exit(99);
  });
}

// Export dispatch surface for parity tests (tests/cli-vs-tools-parity.test.ts).
// When cli.ts is imported by vitest, main() is NOT invoked (see isCliEntry
// guard above), so importing these named exports is side-effect free.
export {
  dispatch,
  dispatchDoc,
  dispatchCollection,
  dispatchSearch,
  dispatchAttachment,
  verifyCreatedDocument,
  writeChangelog,
  outlineFetch,
  pickNumber,
  errorMessage,
  textResult,
  MCP_ALIASES,
};
