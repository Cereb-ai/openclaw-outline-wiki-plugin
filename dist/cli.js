#!/usr/bin/env node
// @ts-nocheck
/**
 * outline-tool — CLI wrapper for the @cereb/outline-wiki-openclaw-plugin.
 *
 * Allows the 12+ plugin methods to be invoked from any shell / terminal,
 * independently of OpenClaw / OpenCode / Wecom DM.
 *
 * Reuses the same raw outlineFetch/auth config as the OpenClaw entry point.
 * Reads env (OUTLINE_API_TOKEN / OUTLINE_ENDPOINT / OUTLINE_DEFAULT_COLLECTION_ID)
 * the same way as the plugin.
 *
 * Usage:
 *   outline-tool <category>.<method> '<args-json>'
 *
 * Examples:
 *   outline-tool doc.list '{"limit":2}'
 *   outline-tool doc.get '{"id":"..."}'
 *   outline-tool search.query '{"query":"redis sentinel"}'
 *   outline-tool collection.list '{}'
 *   outline-tool attachment.upload '{"name":"x.png","url":"https://...","preset":"documentAttachment"}'
 *
 * Output: JSON to stdout on success; non-zero exit on failure.
 *
 * Exit codes: 0=ok, 2=JSON parse, 3=dispatch error, 4=shape error, 5=biz error
 */
import * as fs from "node:fs";
import * as os from "node:os";
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
    }
    catch {
        return {};
    }
}
async function main() {
    const argv = process.argv.slice(2);
    if (argv.length === 0) {
        printUsage();
        process.exit(1);
    }
    const raw = argv[0]; // e.g. "doc.list" or "doc list"
    const argsStr = argv.slice(1).join(" ");
    // parse "<category>.<method>" or "<category> <method>"
    const parts = raw.split(/[. ]/);
    if (parts.length < 2) {
        console.error(`outline-tool: invalid target "${raw}". Use <category>.<method> or <category> <method>.`);
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
        }
        catch (e) {
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
        if (oc.apiToken)
            apiToken = oc.apiToken;
        if (oc.endpoint)
            endpoint = oc.endpoint;
        if (oc.mcpEndpoint)
            mcpEndpoint = oc.mcpEndpoint;
        if (oc.defaultCollectionId)
            defaultCollectionId = oc.defaultCollectionId;
    }
    if (!apiToken || !endpoint) {
        console.error("outline-tool: missing required credentials. Set OUTLINE_API_TOKEN + OUTLINE_ENDPOINT env, or config them in openclaw.json plugins.entries.outline-wiki-openclaw-plugin.config");
        process.exit(3);
    }
    const cfg = { apiToken, endpoint, mcpEndpoint, defaultCollectionId };
    let result;
    try {
        result = await dispatch(category, method, args, cfg);
    }
    catch (e) {
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
async function dispatch(category, method, args, cfg) {
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
// --- doc handlers (light, mirror the plugin) ---
async function dispatchDoc(method, args, cfg) {
    switch (method) {
        case "list": {
            const body = { limit: args.limit ?? 25, offset: args.offset ?? 0 };
            if (typeof args.collectionId === "string")
                body.collectionId = args.collectionId;
            if (typeof args.query === "string")
                body.query = args.query;
            const data = await outlineFetch(cfg, "documents.list", body);
            return textResult({ ok: true, method: "documents.list", documents: data?.data ?? [], pagination: data?.pagination ?? null });
        }
        case "get": {
            if (typeof args.id !== "string")
                return textResult({ error: "doc.get requires a non-empty `id` (string)" });
            const data = await outlineFetch(cfg, "documents.info", { id: args.id });
            return textResult({ ok: true, method: "documents.info", ...data?.data ?? {} });
        }
        case "create": {
            const body = { title: args.title, text: args.text, collectionId: args.collectionId, publish: args.publish ?? true };
            if (typeof args.parentDocumentId === "string")
                body.parentDocumentId = args.parentDocumentId;
            const data = await outlineFetch(cfg, "documents.create", body);
            return textResult({ ok: true, method: "documents.create", ...data?.data ?? {} });
        }
        case "update": {
            const body = { id: args.id };
            if (typeof args.text === "string")
                body.text = args.text;
            if (typeof args.title === "string")
                body.title = args.title;
            if (typeof args.parentDocumentId === "string")
                return textResult({ error: "doc.update does not accept parentDocumentId (server silently drops it). Use doc.move to reparent." });
            const data = await outlineFetch(cfg, "documents.update", body);
            return textResult({ ok: true, method: "documents.update", ...data?.data ?? {} });
        }
        case "delete": {
            if (typeof args.id !== "string")
                return textResult({ error: "doc.delete requires a non-empty `id` (string)" });
            const data = await outlineFetch(cfg, "documents.delete", { id: args.id, permanent: args.permanent === true });
            return textResult({ ok: true, method: "documents.delete", ...data?.data ?? {} });
        }
        case "archive": {
            if (typeof args.id !== "string")
                return textResult({ error: "doc.archive requires a non-empty `id` (string)" });
            const data = await outlineFetch(cfg, "documents.archive", { id: args.id });
            return textResult({ ok: true, method: "documents.archive", ...data?.data ?? {} });
        }
        case "restore": {
            if (typeof args.id !== "string")
                return textResult({ error: "doc.restore requires a non-empty `id` (string)" });
            const data = await outlineFetch(cfg, "documents.restore", { id: args.id });
            return textResult({ ok: true, method: "documents.restore", ...data?.data ?? {} });
        }
        case "move": {
            if (typeof args.id !== "string")
                return textResult({ error: "doc.move requires a non-empty `id` (string)" });
            const body = { id: args.id, collectionId: args.collectionId };
            if (typeof args.parentDocumentId === "string")
                body.parentDocumentId = args.parentDocumentId;
            const data = await outlineFetch(cfg, "documents.move", body);
            return textResult({ ok: true, method: "documents.move", ...data?.data ?? {} });
        }
        default:
            return textResult({ error: `Unknown doc method: ${method}` });
    }
}
async function dispatchCollection(method, args, cfg) {
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
    return textResult({ error: `Unknown collection method: ${method}` });
}
async function dispatchSearch(method, args, cfg) {
    const body = { query: args.query, limit: args.limit ?? 10, offset: args.offset ?? 0 };
    if (typeof args.collectionId === "string")
        body.collectionId = args.collectionId;
    const data = await outlineFetch(cfg, "documents.search", body);
    return textResult({ ok: true, method: "documents.search", results: data?.data ?? [], pagination: data?.pagination ?? null });
}
async function dispatchAttachment(method, args, cfg) {
    if (method !== "upload")
        return textResult({ error: `Unknown attachment method: ${method}` });
    if (args.url) {
        const body = { name: args.name, url: args.url, documentId: args.documentId, preset: args.preset ?? "documentAttachment" };
        const data = await outlineFetch(cfg, "attachments.createFromUrl", body);
        return textResult({ ok: true, method: "attachments.createFromUrl", ...data?.data ?? {} });
    }
    if (args.path) {
        return textResult({ error: "path mode is not yet supported in outline-tool; use url mode or outline_wiki call" });
    }
    return textResult({ error: "attachment.upload requires either `url` or `path`" });
}
// --- helpers ---
async function outlineFetch(cfg, action, body) {
    const url = `${cfg.endpoint.replace(/\/+$/, "")}/${action}`;
    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.apiToken}`,
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`Outline API ${res.status}: ${errText.slice(0, 300)}`);
    }
    return res.json();
}
function textResult(data) {
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data, isError: data?.error ? true : false };
}
function validCategories() {
    return ["doc", "collection", "search", "attachment"];
}
function printUsage() {
    const cats = validCategories().join(" | ");
    console.error([
        "Usage: outline-tool <category>.<method> '<args-json>'",
        "",
        `Categories: ${cats}`,
        "",
        "Examples:",
        '  outline-tool doc.list \'{"limit":2}\'',
        '  outline-tool doc.get \'{"id":"..."}\'',
        '  outline-tool search.query \'{"query":"redis sentinel"}\'',
        '  outline-tool collection.list \'{}\'',
        '  outline-tool attachment.upload \'{"name":"x.png","url":"https://...","preset":"documentAttachment"}\'',
        "",
        "Env (same as OpenClaw plugin):",
        "  OUTLINE_API_TOKEN    Bearer token (required)",
        "  OUTLINE_ENDPOINT     API endpoint, e.g. https://wiki.dev.cereb.ai/api (required)",
        "",
        "Exit codes: 0=ok, 2=parse, 3=dispatch, 4=shape, 5=biz error",
    ].join("\n"));
}
main().catch((e) => {
    console.error(`outline-tool: fatal: ${(e).message}`);
    process.exit(99);
});
