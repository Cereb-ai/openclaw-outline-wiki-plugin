#!/usr/bin/env node
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
export {};
