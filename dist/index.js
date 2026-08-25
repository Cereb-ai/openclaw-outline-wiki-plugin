/**
 * outline-wiki OpenClaw native plugin
 *
 * 0.4.0 migration: switched from a single dispatcher tool `outline_wiki`
 * (definePluginEntry) to 13 independent named tools (defineToolPlugin).
 * Each tool's parameters are a flat TypeBox object of the method's args,
 * and OpenClaw's tool-discovery manifest reads the static metadata without
 * loading this runtime code. Same handler logic, one tool per outline
 * category.method (no more `{category, method, args}` envelope).
 *
 * Tool inventory (13):
 *   - outline_doc_list           — list documents (returns text in payload)
 *   - outline_doc_get            — single document + full markdown body
 *   - outline_doc_create         — create a new document (publish=true default; accepts parentDocumentId)
 *   - outline_doc_update         — update text/title. **parentDocumentId is rejected** (0.4.0 inherits 0.3.1 fail-fast — use outline_doc_move). Optional `changelog` writes a revision name (best-effort).
 *   - outline_doc_delete         — trash (default) or hard-delete (permanent=true)
 *   - outline_doc_archive        — move to archive
 *   - outline_doc_restore        — restore from archive
 *   - outline_doc_move           — move document to another collection (accepts parentDocumentId)
 *   - outline_search_query       — full-text search
 *   - outline_collection_list    — list all collections
 *   - outline_collection_documents — list documents in a collection
 *   - outline_rev_log            — revision metadata (name/timestamp/author) for a document (no body text)
 *   - outline_attachment_upload  — upload via S3 presigned POST (url OR local path)
 *
 * Source-of-truth for the priority list: cereb-pilot (the heaviest user of
 * this plugin). Method set is intentionally narrow; each new method lands
 * in its own commit + restart cycle.
 *
 * Not in MVP: user.
 */
import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
const PLUGIN_ID = "outline-wiki-openclaw-plugin";
const EMPTY_CREATE_RESPONSE_ERROR = "documents.create returned empty data — server may have failed silently";
// Lower-case camelCase to mirror outline server-side AttachmentPreset enum
// (see outline repo shared/types.ts:134). YAGNI: only documentAttachment /
// avatar / emoji are useful for pilot; workspaceImport / import are admin
// bulk-import paths and intentionally NOT exposed here.
const ATTACHMENT_PRESETS = [
    "documentAttachment",
    "avatar",
    "emoji",
];
const configSchema = Type.Object({
    apiToken: Type.Optional(Type.String({
        description: "Outline API bearer token (used for all doc/collection/search/attachment methods).",
    })),
    endpoint: Type.Optional(Type.String({
        description: "Outline API base URL, e.g. https://your-outline.example.com/api",
    })),
    mcpEndpoint: Type.Optional(Type.String({
        description: "Outline MCP endpoint for S3 pre-signed attachment uploads, e.g. https://your-outline.example.com/mcp",
    })),
    defaultCollectionId: Type.Optional(Type.String({
        description: "Optional default collection id for outline_doc_create calls.",
    })),
}, { additionalProperties: false });
export default defineToolPlugin({
    id: PLUGIN_ID,
    name: "Outline Wiki",
    description: "Native Outline Wiki knowledge-base integration for OpenClaw. 15 named tools (one per outline category.method) replace the 0.3.x single-dispatcher `outline_wiki` tool: outline_doc_{list,get,create,update,delete,archive,restore,move}, outline_search_query, outline_collection_{list,documents,create,update}, outline_rev_log, outline_attachment_upload. Two invocation paths: native OpenClaw agents call these MCP tools directly; non-native agents (e.g. codex) use the outline-tool binary with the SAME method names (outline_* or short category.method) — see skills/outline-wiki/SKILL.md. `outline_doc_create` / `outline_doc_move` accept optional `parentDocumentId`. `outline_doc_update` rejects `parentDocumentId` with a fail-fast error (use `outline_doc_move` to reparent — see SKILL.md 避坑清单 15), and accepts an optional `changelog` string that is written to the latest revision's `name` field (best-effort, non-fatal).",
    configSchema,
    activation: { onStartup: true },
    tools: (tool) => [
        tool({
            name: "outline_doc_list",
            label: "Outline List Documents",
            description: "List documents in outline (already returns `text` field in payload). Optional filters: `limit` (default 25), `offset`, `collectionId` (UUID), `query` (substring match on title). Calls `documents.list`.",
            parameters: Type.Object({
                limit: Type.Optional(Type.Integer({
                    minimum: 1,
                    description: "Max documents to return (default 25).",
                })),
                offset: Type.Optional(Type.Integer({
                    minimum: 0,
                    description: "Pagination offset (default 0).",
                })),
                collectionId: Type.Optional(Type.String({ description: "Outline collection UUID to scope the list." })),
                query: Type.Optional(Type.String({ description: "Substring filter on document title." })),
            }),
            async execute(args, cfg) {
                return await docList(args, cfg);
            },
        }),
        tool({
            name: "outline_doc_get",
            label: "Outline Get Document",
            description: "Get a single document with metadata + the full markdown body (one round-trip via `documents.info` — `data.text` is the markdown). Required: `id` (UUID).",
            parameters: Type.Object({
                id: Type.String({ description: "Outline document UUID." }),
            }),
            async execute(args, cfg) {
                return await docGet(args, cfg);
            },
        }),
        tool({
            name: "outline_doc_create",
            label: "Outline Create Document",
            description: "Create a new outline document (publish=true by default). Required: `title` (string), `text` (markdown body, do NOT include the leading `# <title>` line — outline appends it), and `collectionId` (UUID) — falls back to `defaultCollectionId` config if omitted. Optional: `parentDocumentId` (UUID, 0.4.0+) to nest the new doc under a parent.",
            parameters: Type.Object({
                title: Type.String({ description: "Document title." }),
                text: Type.String({ description: "Markdown body (no leading `# <title>` line)." }),
                collectionId: Type.Optional(Type.String({
                    description: "Target collection UUID. Falls back to plugin config `defaultCollectionId` when omitted.",
                })),
                publish: Type.Optional(Type.Boolean({
                    description: "Publish immediately. Default true.",
                    default: true,
                })),
                parentDocumentId: Type.Optional(Type.String({
                    description: "0.4.0+: nest the new document under this parent document UUID.",
                })),
            }),
            async execute(args, cfg) {
                return await docCreate(args, cfg);
            },
        }),
        tool({
            name: "outline_doc_update",
            label: "Outline Update Document",
            description: "Update an existing document's `text` and/or `title` (`editMode=replace` default). Required: `id` (UUID) + at least one of `text` or `title`. **Does NOT accept `parentDocumentId`** — use `outline_doc_move` for reparent. Optional: `publish` (bool), `changelog` (string — after a successful update the plugin best-effort writes this string into the latest revision's `name` field via `revisions.update`; failures are logged in the response `warnings` array but do not fail the main update), `strictChangelog` (bool, default false — when true, changelog write failure hard-fails the update response).",
            parameters: Type.Object({
                id: Type.String({ description: "Outline document UUID." }),
                title: Type.Optional(Type.String({ description: "New title." })),
                text: Type.Optional(Type.String({
                    description: "New markdown body. Strip the leading `# <title>` line if you copied from a `documents.export` round-trip to avoid title duplication.",
                })),
                editMode: Type.Optional(Type.String({
                    description: "Edit mode (default `replace`).",
                    default: "replace",
                })),
                publish: Type.Optional(Type.Boolean({ description: "Publish on update." })),
                changelog: Type.Optional(Type.String({
                    description: "Optional human-readable summary written to the latest revision's `name` field via `revisions.update` after a successful update. Best-effort: failures are non-fatal and surfaced in the response's `warnings`.",
                })),
                strictChangelog: Type.Optional(Type.Boolean({
                    description: "When true, a changelog write failure returns an error instead of ok:true. Default false preserves best-effort behavior.",
                    default: false,
                })),
            }),
            async execute(args, cfg) {
                return await docUpdate(args, cfg);
            },
        }),
        tool({
            name: "outline_doc_delete",
            label: "Outline Delete Document",
            description: "Move a document to trash (default, recoverable for ~30 days) or hard-delete (`permanent: true`, requires the doc to already be in trash). Required: `id` (UUID). Optional: `permanent` (bool, default false).",
            parameters: Type.Object({
                id: Type.String({ description: "Outline document UUID." }),
                permanent: Type.Optional(Type.Boolean({
                    description: "Hard-delete (must trash first via a separate outline_doc_delete call — `permanentDelete` cancan checks `isDeleted`). Default false (trash).",
                    default: false,
                })),
            }),
            async execute(args, cfg) {
                return await docDelete(args, cfg);
            },
        }),
        tool({
            name: "outline_doc_archive",
            label: "Outline Archive Document",
            description: "Archive a document (admin can still read it; recoverable via outline_doc_restore). Required: `id` (UUID).",
            parameters: Type.Object({
                id: Type.String({ description: "Outline document UUID." }),
            }),
            async execute(args, cfg) {
                return await docArchive(args, cfg);
            },
        }),
        tool({
            name: "outline_doc_restore",
            label: "Outline Restore Document",
            description: "Restore a document from the archive. Required: `id` (UUID).",
            parameters: Type.Object({
                id: Type.String({ description: "Outline document UUID." }),
            }),
            async execute(args, cfg) {
                return await docRestore(args, cfg);
            },
        }),
        tool({
            name: "outline_doc_move",
            label: "Outline Move Document",
            description: "Move a document to a different collection (and optionally reparent in the same call). Required: `id` (UUID) + `collectionId` (UUID, no default fallback — moving is an explicit gesture). Optional: `parentDocumentId` (UUID) to nest under a parent doc in the target collection.",
            parameters: Type.Object({
                id: Type.String({ description: "Outline document UUID to move." }),
                collectionId: Type.String({
                    description: "Target collection UUID. No fallback — moving is explicit.",
                }),
                parentDocumentId: Type.Optional(Type.String({
                    description: "0.4.0+: nest the document under this parent document UUID in the target collection.",
                })),
            }),
            async execute(args, cfg) {
                return await docMove(args, cfg);
            },
        }),
        tool({
            name: "outline_search_query",
            label: "Outline Search",
            description: "Full-text search across documents (Bearer-auth works). Required: `query` (non-empty string). Optional: `limit` (default 25), `offset`, `collectionId` (UUID).",
            parameters: Type.Object({
                query: Type.String({ description: "Full-text search query (required, non-empty)." }),
                limit: Type.Optional(Type.Integer({ minimum: 1, description: "Max results (default 25)." })),
                offset: Type.Optional(Type.Integer({ minimum: 0, description: "Pagination offset." })),
                collectionId: Type.Optional(Type.String({ description: "Restrict search to one collection UUID." })),
            }),
            async execute(args, cfg) {
                return await searchQuery(args, cfg);
            },
        }),
        tool({
            name: "outline_collection_list",
            label: "Outline List Collections",
            description: "List all collections. Optional: `limit` (default 25), `offset`.",
            parameters: Type.Object({
                limit: Type.Optional(Type.Integer({ minimum: 1 })),
                offset: Type.Optional(Type.Integer({ minimum: 0 })),
            }),
            async execute(args, cfg) {
                return await collectionList(args, cfg);
            },
        }),
        tool({
            name: "outline_collection_documents",
            label: "Outline List Collection Documents",
            description: "List documents in a collection (includes the children structure). Required: `id` (collection UUID, e.g. WTO = 2539c4a2-1fa8-4f0e-900f-9a5c7f1f72ba). Optional: `limit` (default 25), `offset`.",
            parameters: Type.Object({
                id: Type.String({
                    description: "Collection UUID.",
                }),
                limit: Type.Optional(Type.Integer({ minimum: 1 })),
                offset: Type.Optional(Type.Integer({ minimum: 0 })),
            }),
            async execute(args, cfg) {
                return await collectionDocuments(args, cfg);
            },
        }),
        tool({
            name: "outline_collection_create",
            label: "Outline Create Collection",
            description: "Create a new outline collection. Required: `name` (string, non-empty). Optional: `description` (string), `icon` (string), `color` (hex string, e.g. `#000000`), `permission` (default `read_write` — overrides outline server's `null` default which would make the collection admin-only and cause 'all users cannot see this collection' incidents), `sharing` (bool, default `true`). Calls `collections.create`.",
            parameters: Type.Object({
                name: Type.String({ description: "Collection name (required, non-empty)." }),
                description: Type.Optional(Type.String({ description: "Human-readable collection description." })),
                icon: Type.Optional(Type.String({ description: "Outline icon identifier (string, e.g. emoji name)." })),
                color: Type.Optional(Type.String({
                    description: "Hex color string, e.g. `#000000`.",
                    pattern: "^#?[0-9A-Fa-f]{6}$",
                })),
                permission: Type.Optional(Type.String({
                    description: "Default collection permission. Defaults to `read_write` (NOT `null` — passing null/omitting on outline's REST endpoint makes the collection admin-only and is the root cause of 'I created a collection but nobody can see it' incidents). Pass a different value to override.",
                    default: "read_write",
                    enum: ["read_write", "read", "null"],
                })),
                sharing: Type.Optional(Type.Boolean({
                    description: "Whether the collection can be shared externally. Default `true`.",
                    default: true,
                })),
            }),
            async execute(args, cfg) {
                return await collectionCreate(args, cfg);
            },
        }),
        tool({
            name: "outline_collection_update",
            label: "Outline Update Collection",
            description: "Update an existing outline collection. Required: `id` (collection UUID). Optional: `name`, `description`, `icon`, `color`, `permission`, `sharing` — pass only the fields you want to change. Calls `collections.update`.",
            parameters: Type.Object({
                id: Type.String({ description: "Collection UUID (required)." }),
                name: Type.Optional(Type.String({ description: "New collection name." })),
                description: Type.Optional(Type.String({ description: "New description." })),
                icon: Type.Optional(Type.String({ description: "New icon identifier." })),
                color: Type.Optional(Type.String({
                    description: "New hex color string, e.g. `#000000`.",
                    pattern: "^#?[0-9A-Fa-f]{6}$",
                })),
                permission: Type.Optional(Type.String({
                    description: "New permission. Use to flip an accidentally-admin-only collection back to `read_write` so all users can see it.",
                    enum: ["read_write", "read", "null"],
                })),
                sharing: Type.Optional(Type.Boolean({ description: "New sharing flag." })),
            }),
            async execute(args, cfg) {
                return await collectionUpdate(args, cfg);
            },
        }),
        tool({
            name: "outline_rev_log",
            label: "Outline Revision Log",
            description: "Get revision changelog for a document (metadata only: name, timestamp, author). Returns up to N recent revisions, stripped of body text/data/collaborators — safe to call frequently to surface change history. Calls `revisions.list`. Required: `documentId` (UUID). Optional: `limit` (number, default 5, max 20).",
            parameters: Type.Object({
                documentId: Type.String({ description: "Outline document UUID." }),
                limit: Type.Optional(Type.Integer({
                    minimum: 1,
                    maximum: 20,
                    description: "Max revisions to return (default 5, max 20).",
                    default: 5,
                })),
            }),
            async execute(args, cfg) {
                return await revLog(args, cfg);
            },
        }),
        tool({
            name: "outline_attachment_upload",
            label: "Outline Upload Attachment",
            description: "Upload a file to outline. Two modes: `url` (outline fetches the public URL server-side via `attachments.createFromUrl`, recommended on dev wiki — single round-trip; requires `documentId` + `preset=documentAttachment`) or `path` (plugin reads the local file + PUTs to S3 presigned POST — modern outline only, dev wiki is legacy `files.create` cookie-only so path mode fails fast with a clear hint). Required: `name` + (`url` OR `path`). Optional: `contentType`, `size`, `documentId`, `preset` (default `documentAttachment`).",
            parameters: Type.Object({
                name: Type.String({ description: "Attachment filename." }),
                url: Type.Optional(Type.String({
                    description: "Public URL outline will fetch (url mode — recommended on dev wiki). Requires `documentId`.",
                })),
                path: Type.Optional(Type.String({
                    description: "Local file path the plugin reads (path mode — modern outline only).",
                })),
                contentType: Type.Optional(Type.String({
                    description: "MIME type. Default `application/octet-stream`.",
                    default: "application/octet-stream",
                })),
                size: Type.Optional(Type.Integer({
                    description: "File size in bytes (auto-detected for path mode).",
                })),
                documentId: Type.Optional(Type.String({
                    description: "Outline document UUID to attach to (required for url mode).",
                })),
                preset: Type.Optional(Type.String({
                    description: "Outline AttachmentPreset (lowercase camelCase). One of: documentAttachment, avatar, emoji. Default `documentAttachment`.",
                    default: "documentAttachment",
                })),
            }),
            async execute(args, cfg) {
                return await attachmentUpload(args, cfg);
            },
        }),
    ],
});
// ===== Handlers (1:1 with the previous dispatcher implementations) =====
async function docList(args, cfg) {
    const guard = requireConfig(cfg);
    if (guard)
        return guard;
    const body = {
        limit: pickNumber(args.limit, 25),
        offset: pickNumber(args.offset, 0),
    };
    if (typeof args.collectionId === "string")
        body.collectionId = args.collectionId;
    if (typeof args.query === "string")
        body.query = args.query;
    try {
        const data = await outlineFetch(cfg, "documents.list", body);
        return textResult({
            ok: true,
            method: "documents.list",
            request: body,
            documents: data?.data ?? [],
            pagination: data?.pagination ?? null,
        });
    }
    catch (err) {
        return textResult({ error: `documents.list failed: ${errorMessage(err)}` });
    }
}
async function docGet(args, cfg) {
    const guard = requireConfig(cfg);
    if (guard)
        return guard;
    if (typeof args.id !== "string" || args.id.length === 0) {
        return textResult({
            error: "outline_doc_get requires a non-empty `id` (string) argument.",
        });
    }
    // Single-step: documents.info already returns metadata + the full markdown
    // body in `data.text`. The legacy mcporter path forced a second
    // documents.export call to get the body; the plugin hides that dance.
    // If a future outline revision returns `text=null` for some documents,
    // fall back to documents.export; until then no extra round trip needed.
    try {
        const info = await outlineFetch(cfg, "documents.info", { id: args.id });
        return textResult({
            ok: true,
            method: "documents.get",
            request: { id: args.id },
            document: info?.data ?? null,
        });
    }
    catch (err) {
        return textResult({ error: `documents.get failed: ${errorMessage(err)}` });
    }
}
async function docCreate(args, cfg) {
    const guard = requireConfig(cfg);
    if (guard)
        return guard;
    if (typeof args.title !== "string" || args.title.length === 0) {
        return textResult({
            error: "outline_doc_create requires a non-empty `title` (string) argument.",
        });
    }
    if (typeof args.text !== "string") {
        return textResult({
            error: "outline_doc_create requires `text` (string) argument (markdown body).",
        });
    }
    // collectionId resolution order: explicit args.collectionId > cfg.defaultCollectionId.
    // This makes recurring workflows (e.g. always writing under the WTO
    // collection) ergonomic while still allowing per-call overrides.
    const collectionId = (typeof args.collectionId === "string" && args.collectionId.length > 0
        ? args.collectionId
        : undefined) ??
        cfg.defaultCollectionId;
    if (!collectionId) {
        return textResult({
            error: "outline_doc_create requires `collectionId` (string) — pass it as an arg, or set `defaultCollectionId` in the plugin config.",
        });
    }
    // MVP wires the truly required fields + `publish` (default true so the
    // new doc is immediately visible without a second round-trip) +
    // `parentDocumentId` (0.4.0+ — see踩坑清单 11 in README, was YAGNI
    // until 2026-06-08 because no caller needed it; the WTO 误判复盘 v1
    // child-doc container workflow tipped it over the line).
    // Other fields (templateId, icon, color) are intentionally left out
    // per the YAGNI rule; they can be added in a follow-up.
    const body = {
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
                error: EMPTY_CREATE_RESPONSE_ERROR,
            });
        }
        try {
            await verifyCreatedDocument(cfg, createdId);
        }
        catch (err) {
            return textResult({
                error: `documents.create verify failed for id "${createdId}": ${errorMessage(err)}`,
            });
        }
        return textResult({
            ok: true,
            method: "documents.create",
            request: body,
            document: created,
            // Convenience summary so the agent does not have to re-read the full
            // document object to know "did it work, what id do I have now".
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
    }
    catch (err) {
        if (errorMessage(err).startsWith("Response was not JSON (HTTP 200):")) {
            return textResult({ error: EMPTY_CREATE_RESPONSE_ERROR });
        }
        return textResult({ error: `documents.create failed: ${errorMessage(err)}` });
    }
}
async function verifyCreatedDocument(cfg, id) {
    const info = await outlineFetch(cfg, "documents.info", { id });
    const verifiedId = info?.data?.id;
    if (typeof verifiedId !== "string" || verifiedId.length === 0) {
        throw new Error("documents.info returned empty data");
    }
}
async function docUpdate(args, cfg) {
    const guard = requireConfig(cfg);
    if (guard)
        return guard;
    if (typeof args.id !== "string" || args.id.length === 0) {
        return textResult({
            error: "outline_doc_update requires a non-empty `id` (string) argument.",
        });
    }
    // 0.4.0 inherits the 0.3.1 fail-fast: outline's `documents.update` endpoint
    // schema does NOT include `parentDocumentId` (verified 2026-06-08 against
    // dev wiki: server silently drops the field — revision 2→3, updatedAt
    // unchanged, and the document's parentDocumentId stays null even when
    // explicitly passed). To reparent a document, callers MUST use
    // `outline_doc_move` instead. The plugin surfaces this as a hard error so
    // the silent fail never reaches the user.
    //
    // Note: the TypeBox schema already declared `parentDocumentId` as
    // NOT a parameter on this tool, so OpenClaw will refuse the call before
    // it reaches here. The runtime check is a defense-in-depth backstop in
    // case the schema is loosened in the future.
    if (args.parentDocumentId !== undefined) {
        return textResult({
            error: "outline_doc_update does not accept `parentDocumentId` — the outline server silently drops it. " +
                "To reparent a document, use outline_doc_move for reparent with the new `collectionId` (same collection is fine) and the new `parentDocumentId`. " +
                "Example: outline_doc_move {id, collectionId, parentDocumentId: '<new-parent-uuid>'}.",
            hint: "documents.update's schema does not include parentDocumentId — outline server silently drops it (silent drop verified 2026-06-08). " +
                "To reparent, use `outline_doc_move` with the new `collectionId` and `parentDocumentId`. " +
                "See README 踩坑清单 12 and SKILL.md 避坑清单 15.",
        });
    }
    // At least one of text/title must be present, otherwise the call is a no-op
    // and we want to fail loudly rather than silently bumping the revision.
    // (0.3.1: parentDocumentId is no longer accepted here — see fail-fast above.
    //  The 0.3.0 '三者至少一个' guard was reverted because the third field was
    //  a silent-fail trap.)
    if (typeof args.text !== "string" && typeof args.title !== "string") {
        return textResult({
            error: "outline_doc_update requires at least one of `text` or `title` (string) to change.",
        });
    }
    // MVP wires text/title + editMode (default "replace") + publish.
    // Other fields (append, icon, color, templateId) intentionally left out
    // per YAGNI; they can be added in a follow-up.
    //
    // Quickref gotcha: `documents.export` returns markdown whose first line is
    // `# <title>`. If the caller passes that export as `text` into outline_doc_update,
    // the title will accumulate on every round-trip — so callers should strip
    // the leading `# <title>` line first. We surface this in the error hint
    // when a request that looks like an export-blob comes in unchanged.
    const body = { id: args.id };
    if (typeof args.text === "string") {
        body.text = args.text;
        body.editMode = typeof args.editMode === "string" ? args.editMode : "replace";
    }
    if (typeof args.title === "string") {
        body.title = args.title;
    }
    if (typeof args.publish === "boolean")
        body.publish = args.publish;
    // Track warnings for best-effort post-update side-effects (e.g. changelog
    // writing via revisions.update). Non-fatal — main update succeeds even if
    // these fail; we just collect the messages and surface them in the
    // response so the agent can decide whether to retry.
    const warnings = [];
    try {
        const data = await outlineFetch(cfg, "documents.update", body);
        const updated = data?.data ?? null;
        // Best-effort changelog: if the caller provided `changelog`, look up the
        // latest revision for this document and write the string into its `name`
        // field. Failures here are non-fatal — the main update has already
        // succeeded, so we log into `warnings` and continue.
        if (typeof args.changelog === "string" && args.changelog.length > 0) {
            const changelogResult = await writeChangelog(args.id, args.changelog, cfg);
            if ("warning" in changelogResult) {
                if (args.strictChangelog === true) {
                    return textResult({
                        error: `documents.update changelog write failed with strictChangelog=true: ${changelogResult.warning}`,
                        method: "documents.update",
                        request: body,
                        document: updated,
                    });
                }
                warnings.push(changelogResult.warning);
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
    }
    catch (err) {
        return textResult({ error: `documents.update failed: ${errorMessage(err)}` });
    }
}
async function docDelete(args, cfg) {
    const guard = requireConfig(cfg);
    if (guard)
        return guard;
    if (typeof args.id !== "string" || args.id.length === 0) {
        return textResult({
            error: "outline_doc_delete requires a non-empty `id` (string) argument.",
        });
    }
    // Safety: `permanent: false` (default) → outline REST `documents.delete`
    // without a permanent flag → moves the document to trash, recoverable
    // for ~30 days. The hard-delete path (`permanent: true`) is opt-in
    // because once outline evicts the entry there is no in-product restore
    // (only a global admin can re-import from the audit log). Agents should
    // never set `permanent: true` unless the user has explicitly asked to
    // hard-remove a document.
    //
    // Hard-delete path also requires the document to already be trashed
    // (cancan `permanentDelete` action checks `!!document?.isDeleted`); the
    // typical workflow is therefore two round-trips: trash first, then
    // permanent delete.
    //
    // `archive: true` is intentionally NOT wired — outline's Documents.Archive
    // scope is held by the current Bearer key (scope=`read`+`write` granted
    // 2026-06-08), but `outline_doc_archive` is the dedicated tool for that. If
    // a caller wants the legacy archive-on-delete behavior, they should call
    // `outline_doc_archive` first and then `outline_doc_delete`.
    const permanent = typeof args.permanent === "boolean" ? args.permanent : false;
    const body = { id: args.id };
    if (permanent)
        body.permanent = true;
    try {
        const data = await outlineFetch(cfg, "documents.delete", body);
        return textResult({
            ok: true,
            method: "documents.delete",
            request: { id: args.id, permanent },
            result: data?.data ?? null,
            summary: {
                id: args.id,
                mode: permanent ? "permanent" : "trash",
            },
        });
    }
    catch (err) {
        return textResult({ error: `documents.delete failed: ${errorMessage(err)}` });
    }
}
async function docArchive(args, cfg) {
    const guard = requireConfig(cfg);
    if (guard)
        return guard;
    if (typeof args.id !== "string" || args.id.length === 0) {
        return textResult({
            error: "outline_doc_archive requires a non-empty `id` (string) argument.",
        });
    }
    try {
        const data = await outlineFetch(cfg, "documents.archive", { id: args.id });
        const archived = data?.data ?? null;
        return textResult({
            ok: true,
            method: "documents.archive",
            request: { id: args.id },
            document: archived,
            summary: {
                id: args.id,
                archivedAt: archived?.archivedAt ?? null,
            },
        });
    }
    catch (err) {
        return textResult({ error: `documents.archive failed: ${errorMessage(err)}` });
    }
}
async function docRestore(args, cfg) {
    const guard = requireConfig(cfg);
    if (guard)
        return guard;
    if (typeof args.id !== "string" || args.id.length === 0) {
        return textResult({
            error: "outline_doc_restore requires a non-empty `id` (string) argument.",
        });
    }
    try {
        const data = await outlineFetch(cfg, "documents.restore", { id: args.id });
        return textResult({
            ok: true,
            method: "documents.restore",
            request: { id: args.id },
            document: data?.data ?? null,
            summary: { id: args.id, restored: true },
        });
    }
    catch (err) {
        return textResult({ error: `documents.restore failed: ${errorMessage(err)}` });
    }
}
async function docMove(args, cfg) {
    const guard = requireConfig(cfg);
    if (guard)
        return guard;
    if (typeof args.id !== "string" || args.id.length === 0) {
        return textResult({
            error: "outline_doc_move requires a non-empty `id` (string) argument.",
        });
    }
    // doc.move has no `defaultCollectionId` fallback — moving is an
    // explicit user gesture, the destination must be named in the call.
    if (typeof args.collectionId !== "string" || args.collectionId.length === 0) {
        return textResult({
            error: "outline_doc_move requires `collectionId` (string, UUID) — moving is an explicit gesture, no implicit default.",
        });
    }
    // 0.4.0+: `parentDocumentId` is optional on outline_doc_move so a caller can
    // reparent a doc in the same operation (e.g. "move under the
    // <quality & testing> container"). Omitted → outline server defaults
    // the new doc to the collection root (existing behavior preserved).
    const body = {
        id: args.id,
        collectionId: args.collectionId,
    };
    if (typeof args.parentDocumentId === "string" && args.parentDocumentId.length > 0) {
        body.parentDocumentId = args.parentDocumentId;
    }
    try {
        const data = await outlineFetch(cfg, "documents.move", body);
        return textResult({
            ok: true,
            method: "documents.move",
            request: body,
            document: data?.data ?? null,
            summary: {
                id: args.id,
                collectionId: args.collectionId,
                parentDocumentId: body.parentDocumentId ?? null,
            },
        });
    }
    catch (err) {
        return textResult({ error: `documents.move failed: ${errorMessage(err)}` });
    }
}
async function searchQuery(args, cfg) {
    const guard = requireConfig(cfg);
    if (guard)
        return guard;
    if (typeof args.query !== "string" || args.query.trim().length === 0) {
        return textResult({
            error: "outline_search_query requires a non-empty `query` (string) argument.",
        });
    }
    const body = {
        query: args.query,
        limit: pickNumber(args.limit, 25),
        offset: pickNumber(args.offset, 0),
    };
    if (typeof args.collectionId === "string")
        body.collectionId = args.collectionId;
    try {
        const data = await outlineFetch(cfg, "documents.search", body);
        return textResult({
            ok: true,
            method: "documents.search",
            request: body,
            documents: data?.data ?? [],
            pagination: data?.pagination ?? null,
        });
    }
    catch (err) {
        return textResult({ error: `documents.search failed: ${errorMessage(err)}` });
    }
}
async function attachmentUpload(args, cfg) {
    const guard = requireConfig(cfg);
    if (guard)
        return guard;
    if (typeof args.name !== "string" || args.name.length === 0) {
        return textResult({
            error: "outline_attachment_upload requires a non-empty `name` (string) argument.",
        });
    }
    if (typeof args.url !== "string" && typeof args.path !== "string") {
        return textResult({
            error: "outline_attachment_upload requires either `url` (string, outline fetches it) or `path` (string, plugin reads + uploads).",
        });
    }
    const presetRaw = typeof args.preset === "string" ? args.preset : "documentAttachment";
    if (!ATTACHMENT_PRESETS.includes(presetRaw)) {
        return textResult({
            error: `outline_attachment_upload preset must be one of: ${ATTACHMENT_PRESETS.join(", ")}.`,
        });
    }
    const preset = presetRaw;
    // Branch A: caller provides a URL. outline's `attachments.createFromUrl`
    // endpoint fetches the URL server-side, attaches the resulting file to
    // the given document, and returns the attachment record in one round-trip.
    // Only DocumentAttachment preset supports this path (the endpoint
    // schema enforces `preset === DocumentAttachment` and a non-empty
    // documentId).
    if (typeof args.url === "string") {
        if (preset !== "documentAttachment") {
            return textResult({
                error: "outline_attachment_upload with `url` only supports preset=documentAttachment; use `path` for avatar/emoji.",
            });
        }
        if (typeof args.documentId !== "string" || args.documentId.length === 0) {
            return textResult({
                error: "outline_attachment_upload with `url` requires `documentId` (string, UUID) — outline's createFromUrl endpoint refuses document attachments without a target document.",
            });
        }
        try {
            const data = await outlineFetch(cfg, "attachments.createFromUrl", {
                name: args.name,
                url: args.url,
                documentId: args.documentId,
                preset,
            });
            const attachment = data?.data ?? null;
            return textResult({
                ok: true,
                method: "attachments.createFromUrl",
                request: { name: args.name, url: args.url, documentId: args.documentId, preset },
                attachment,
                summary: attachment
                    ? {
                        id: attachment.id,
                        name: args.name,
                        url: attachment.url ?? null,
                    }
                    : null,
            });
        }
        catch (err) {
            return textResult({
                error: `attachments.createFromUrl failed: ${errorMessage(err)}`,
            });
        }
    }
    // Branch B: caller provides a local file path. The plugin reads the file,
    // calls `attachments.create` to mint an S3 presigned POST (one round-trip),
    // then PUTs the file to S3 with the presigned form fields (second
    // round-trip). This is the canonical S3-presigned-POST upload pattern;
    // we never hit the outline server with the file body, so it scales to
    // large attachments.
    const path = args.path;
    const contentType = typeof args.contentType === "string" && args.contentType.length > 0
        ? args.contentType
        : "application/octet-stream";
    const documentId = typeof args.documentId === "string" && args.documentId.length > 0
        ? args.documentId
        : undefined;
    let buffer;
    try {
        buffer = await readFile(path);
    }
    catch (err) {
        return textResult({
            error: `outline_attachment_upload failed to read local file: ${errorMessage(err)}`,
        });
    }
    const size = buffer.length;
    let step1;
    try {
        step1 = await outlineFetch(cfg, "attachments.create", {
            name: args.name,
            contentType,
            size,
            documentId,
            preset,
        });
    }
    catch (err) {
        return textResult({
            error: `attachments.create (step 1) failed: ${errorMessage(err)}`,
        });
    }
    const { uploadUrl, form, attachment } = step1?.data ?? {};
    if (typeof uploadUrl !== "string" || !form || typeof form !== "object") {
        return textResult({
            error: "attachments.create did not return uploadUrl/form — outline API contract changed?",
            hint: "See outline server source: server/routes/api/attachments/attachments.ts `attachments.create` handler.",
        });
    }
    // Legacy / pre-S3 outline servers hand back a relative
    // `/api/files.create` URL here instead of a real S3 presigned POST.
    // `files.create` is cookie-only auth, so a Bearer-token PUT from this
    // plugin will always 401/403. We detect the legacy URL up front and
    // surface a clear hint so callers know to switch to url mode or the
    // outline web UI instead of seeing a confusing S3 / 401 / 403 trace.
    if (isLegacyFilesCreateUploadUrl(uploadUrl)) {
        return textResult({
            error: "dev wiki is using the legacy files.create endpoint which requires a browser session cookie. " +
                "path mode is not supported on this outline instance; use `url` mode or upload via the outline web UI.",
            hint: "Modern outline versions (post S3 migration) expose a real S3 presigned POST URL here. " +
                "This dev wiki is on the legacy files.create flow. To upload a local file: " +
                "first publish it somewhere Bearer-fetchable (e.g. your own S3 / OSS / a public pastebin), " +
                "then call `outline_attachment_upload {url: <public_url>, name, documentId}`.",
        });
    }
    // Step 2: PUT to S3. S3 presigned POST expects every entry in `form`
    // to appear in the multipart body BEFORE the `file` field, in the
    // same order they were issued. Object.entries preserves insertion
    // order so the loop below emits them in the order outline returned.
    // S3 will 403 with `SignatureDoesNotMatch` if the policy hash fails,
    // and the error from `fetch` is bubbled verbatim in the catch below.
    try {
        const fd = new FormData();
        for (const [k, v] of Object.entries(form)) {
            if (typeof v === "string")
                fd.append(k, v);
        }
        // Wrap the Node Buffer in a Uint8Array so the TypeScript types align
        // with the DOM `BlobPart` (Buffer<ArrayBufferLike> vs Uint8Array<ArrayBuffer>).
        // Runtime is unaffected — both point to the same underlying bytes.
        fd.append("file", new Blob([new Uint8Array(buffer)], { type: contentType }), args.name);
        const res = await fetch(uploadUrl, { method: "POST", body: fd });
        if (!res.ok) {
            const text = await res.text();
            const snippet = text.length > 500 ? `${text.slice(0, 500)}…` : text;
            throw new Error(`S3 PUT failed: HTTP ${res.status} ${res.statusText}: ${snippet}`);
        }
    }
    catch (err) {
        return textResult({
            error: `attachment S3 PUT (step 2) failed: ${errorMessage(err)}`,
        });
    }
    return textResult({
        ok: true,
        method: "attachments.create (S3 presigned)",
        request: {
            name: args.name,
            contentType,
            size,
            documentId,
            preset,
            path,
        },
        attachment: attachment ?? null,
        summary: attachment
            ? {
                id: attachment.id,
                name: args.name,
                contentType,
                size,
                url: attachment.url ?? null,
            }
            : null,
    });
}
function isLegacyFilesCreateUploadUrl(uploadUrl) {
    if (uploadUrl.startsWith("/api/files.create"))
        return true;
    try {
        return new URL(uploadUrl).pathname === "/api/files.create";
    }
    catch {
        return false;
    }
}
async function collectionList(args, cfg) {
    const guard = requireConfig(cfg);
    if (guard)
        return guard;
    const body = {
        limit: pickNumber(args.limit, 25),
        offset: pickNumber(args.offset, 0),
    };
    try {
        const data = await outlineFetch(cfg, "collections.list", body);
        return textResult({
            ok: true,
            method: "collections.list",
            request: body,
            collections: data?.data ?? [],
            pagination: data?.pagination ?? null,
        });
    }
    catch (err) {
        return textResult({ error: `collections.list failed: ${errorMessage(err)}` });
    }
}
async function collectionDocuments(args, cfg) {
    const guard = requireConfig(cfg);
    if (guard)
        return guard;
    if (typeof args.id !== "string" || args.id.length === 0) {
        return textResult({
            error: "outline_collection_documents requires a non-empty `id` (string) argument (collection id, e.g. WTO = 2539c4a2-1fa8-4f0e-900f-9a5c7f1f72ba).",
        });
    }
    const body = {
        id: args.id,
        limit: pickNumber(args.limit, 25),
        offset: pickNumber(args.offset, 0),
    };
    try {
        const data = await outlineFetch(cfg, "collections.documents", body);
        return textResult({
            ok: true,
            method: "collections.documents",
            request: body,
            documents: data?.data ?? [],
            pagination: data?.pagination ?? null,
        });
    }
    catch (err) {
        return textResult({ error: `collections.documents failed: ${errorMessage(err)}` });
    }
}
async function collectionCreate(args, cfg) {
    const guard = requireConfig(cfg);
    if (guard)
        return guard;
    if (typeof args.name !== "string" || args.name.length === 0) {
        return textResult({
            error: "outline_collection_create requires a non-empty `name` (string) argument.",
        });
    }
    // Build the request body. `permission` defaults to "read_write" rather than
    // letting outline's REST endpoint default to `null` (admin-only). The
    // TypeBox schema also declares `default: "read_write"` so OpenClaw-level
    // validation fills it in, but we re-default defensively here in case the
    // schema is bypassed (e.g. via the CLI).
    const body = { name: args.name };
    if (typeof args.description === "string" && args.description.length > 0) {
        body.description = args.description;
    }
    if (typeof args.icon === "string" && args.icon.length > 0) {
        body.icon = args.icon;
    }
    if (typeof args.color === "string" && args.color.length > 0) {
        body.color = args.color;
    }
    if (typeof args.permission === "string" && args.permission.length > 0) {
        body.permission = args.permission;
    }
    else {
        body.permission = "read_write";
    }
    if (typeof args.sharing === "boolean") {
        body.sharing = args.sharing;
    }
    else {
        body.sharing = true;
    }
    try {
        const data = await outlineFetch(cfg, "collections.create", body);
        const created = data?.data ?? null;
        return textResult({
            ok: true,
            method: "collections.create",
            request: body,
            collection: created,
            summary: created
                ? {
                    id: created.id,
                    name: created.name,
                    url: created.url ?? null,
                    urlId: created.urlId ?? null,
                    permission: created.permission ?? null,
                }
                : null,
        });
    }
    catch (err) {
        return textResult({ error: `collections.create failed: ${errorMessage(err)}` });
    }
}
async function collectionUpdate(args, cfg) {
    const guard = requireConfig(cfg);
    if (guard)
        return guard;
    if (typeof args.id !== "string" || args.id.length === 0) {
        return textResult({
            error: "outline_collection_update requires a non-empty `id` (string) argument (collection UUID).",
        });
    }
    // At least one mutable field must be present; otherwise the call is a
    // no-op and we want to fail loudly.
    const mutable = [
        "name",
        "description",
        "icon",
        "color",
        "permission",
        "sharing",
    ];
    const hasAny = mutable.some((k) => typeof args[k] !== "undefined");
    if (!hasAny) {
        return textResult({
            error: "outline_collection_update requires at least one of `name`, `description`, `icon`, `color`, `permission`, `sharing`.",
        });
    }
    const body = { id: args.id };
    for (const k of mutable) {
        const v = args[k];
        if (typeof v !== "undefined")
            body[k] = v;
    }
    try {
        const data = await outlineFetch(cfg, "collections.update", body);
        const updated = data?.data ?? null;
        return textResult({
            ok: true,
            method: "collections.update",
            request: body,
            collection: updated,
            summary: updated
                ? {
                    id: updated.id,
                    name: updated.name,
                    url: updated.url ?? null,
                    urlId: updated.urlId ?? null,
                    permission: updated.permission ?? null,
                }
                : null,
        });
    }
    catch (err) {
        return textResult({ error: `collections.update failed: ${errorMessage(err)}` });
    }
}
async function revLog(args, cfg) {
    const guard = requireConfig(cfg);
    if (guard)
        return guard;
    if (typeof args.documentId !== "string" || args.documentId.length === 0) {
        return textResult({
            error: "outline_rev_log requires a non-empty `documentId` (string) argument.",
        });
    }
    // Clamp limit into [1, 20] with a default of 5. The TypeBox schema already
    // declares maximum: 20, so OpenClaw should refuse larger values before we
    // get here — but clamp defensively in case the schema is loosened later.
    const rawLimit = pickNumber(args.limit, 5);
    const limit = Math.min(20, Math.max(1, Math.trunc(rawLimit)));
    const body = {
        documentId: args.documentId,
        limit,
    };
    try {
        const data = await outlineFetch(cfg, "revisions.list", body);
        const rawRevisions = Array.isArray(data?.data)
            ? data.data
            : [];
        // Strip heavy revision fields (`text`, `data`, `collaborators`, `color`,
        // `deletedAt`, etc.) and return only the metadata useful for a changelog
        // view: id, name (i.e. the human-readable changelog if any), createdAt,
        // and the author's display name. This keeps the response cheap to
        // serialize even on documents with hundreds of revisions.
        const revisions = rawRevisions.map((r) => {
            const rev = r;
            const createdBy = rev.createdBy;
            return {
                id: rev.id ?? null,
                name: rev.name ?? null,
                createdAt: rev.createdAt ?? null,
                createdByName: createdBy?.name ?? null,
            };
        });
        return textResult({
            ok: true,
            method: "revisions.list",
            request: body,
            revisions,
            pagination: data?.pagination ?? null,
        });
    }
    catch (err) {
        return textResult({ error: `revisions.list failed: ${errorMessage(err)}` });
    }
}
/**
 * Best-effort changelog write for outline_doc_update.
 *
 * After a successful `documents.update`, look up the latest revision for the
 * given documentId and write `changelog` into its `name` field via
 * `revisions.update`. Both sub-calls are wrapped in try/catch — any failure
 * is returned as a string instead of thrown, so the caller can surface it
 * via the response `warnings` array without failing the main update.
 *
 * Returns `{ok: true}` on success or `{warning: string}` on failure.
 */
async function writeChangelog(documentId, changelog, cfg) {
    let listed;
    try {
        listed = await outlineFetch(cfg, "revisions.list", {
            documentId,
            limit: 1,
            direction: "DESC",
        });
    }
    catch (err) {
        return {
            warning: `changelog write skipped: revisions.list failed: ${errorMessage(err)}`,
        };
    }
    const latest = listed?.data?.[0];
    if (!latest || typeof latest.id !== "string") {
        return {
            warning: "changelog write skipped: revisions.list returned no revisions for the updated document.",
        };
    }
    try {
        await outlineFetch(cfg, "revisions.update", {
            id: latest.id,
            name: changelog,
        });
        return { ok: true };
    }
    catch (err) {
        return {
            warning: `changelog write skipped: revisions.update failed for revision ${latest.id}: ${errorMessage(err)}`,
        };
    }
}
/**
 * POST a JSON envelope to the Outline REST API. Throws on non-2xx with the
 * response body included (truncated) so the agent sees a useful error.
 */
async function outlineFetch(cfg, path, body) {
    const base = (cfg.endpoint ?? "").replace(/\/+$/, "");
    const cleanPath = path.replace(/^\/+/, "");
    const url = `${base}/${cleanPath}`;
    const res = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${cfg.apiToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
        },
        body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
        const snippet = text.length > 500 ? `${text.slice(0, 500)}…` : text;
        throw new Error(`HTTP ${res.status} ${res.statusText}: ${snippet}`);
    }
    try {
        return JSON.parse(text);
    }
    catch {
        throw new Error(`Response was not JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
}
function requireConfig(cfg) {
    if (!cfg.apiToken || !cfg.endpoint) {
        return textResult({
            error: "Outline Wiki plugin is not configured. Set `apiToken` (Bearer) and `endpoint` (e.g. https://your-outline.example.com/api) under `plugins.entries.outline-wiki-openclaw-plugin.config` in openclaw.json.",
        });
    }
    return null;
}
function pickNumber(v, fallback) {
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
function textResult(data) {
    const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    return {
        content: [{ type: "text", text }],
        details: data,
    };
}
