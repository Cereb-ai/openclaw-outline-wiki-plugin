#!/usr/bin/env node
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
declare const MCP_ALIASES: Record<string, string>;
declare function dispatch(category: string, method: string, args: Record<string, unknown>, cfg: {
    apiToken: string;
    endpoint: string;
    mcpEndpoint?: string;
    defaultCollectionId?: string;
}): Promise<{
    content: {
        type: string;
        text: string;
    }[];
    details: Record<string, unknown>;
    isError: boolean;
}>;
declare function dispatchDoc(method: string, args: Record<string, unknown>, cfg: {
    apiToken: string;
    endpoint: string;
    defaultCollectionId?: string;
}): Promise<{
    content: {
        type: string;
        text: string;
    }[];
    details: Record<string, unknown>;
    isError: boolean;
}>;
declare function dispatchCollection(method: string, args: Record<string, unknown>, cfg: {
    apiToken: string;
    endpoint: string;
}): Promise<{
    content: {
        type: string;
        text: string;
    }[];
    details: Record<string, unknown>;
    isError: boolean;
}>;
declare function dispatchSearch(method: string, args: Record<string, unknown>, cfg: {
    apiToken: string;
    endpoint: string;
}): Promise<{
    content: {
        type: string;
        text: string;
    }[];
    details: Record<string, unknown>;
    isError: boolean;
}>;
declare function dispatchAttachment(method: string, args: Record<string, unknown>, cfg: {
    apiToken: string;
    endpoint: string;
}): Promise<{
    content: {
        type: string;
        text: string;
    }[];
    details: Record<string, unknown>;
    isError: boolean;
}>;
declare function verifyCreatedDocument(cfg: {
    apiToken: string;
    endpoint: string;
}, id: string): Promise<void>;
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
declare function writeChangelog(documentId: string, changelog: string, cfg: {
    apiToken: string;
    endpoint: string;
}): Promise<{
    ok: true;
} | {
    warning: string;
}>;
declare function pickNumber(v: unknown, fallback: number): number;
declare function errorMessage(err: unknown): string;
declare function outlineFetch(cfg: {
    apiToken: string;
    endpoint: string;
}, action: string, body: Record<string, unknown>): Promise<any>;
declare function textResult(data: Record<string, unknown>): {
    content: {
        type: string;
        text: string;
    }[];
    details: Record<string, unknown>;
    isError: boolean;
};
export { dispatch, dispatchDoc, dispatchCollection, dispatchSearch, dispatchAttachment, verifyCreatedDocument, writeChangelog, outlineFetch, pickNumber, errorMessage, textResult, MCP_ALIASES, };
