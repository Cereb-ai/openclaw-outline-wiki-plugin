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
 *   - outline_doc_list           — list documents (metadata only — `text` stripped, see CP-2379)
 *   - outline_doc_get            — single document + full markdown body
 *   - outline_doc_create         — create a new document (publish=true default; accepts parentDocumentId; response echoes summary only — no `document.text` round-trip)
 *   - outline_doc_update         — update text/title. **parentDocumentId is rejected** (0.4.0 inherits 0.3.1 fail-fast — use outline_doc_move). Optional `changelog` writes a revision name (best-effort). Response echoes summary only — no `document.text` round-trip.
 *   - outline_doc_delete         — trash (default) or hard-delete (permanent=true)
 *   - outline_doc_archive        — move to archive
 *   - outline_doc_restore        — restore from archive
 *   - outline_doc_move           — move document to another collection (accepts parentDocumentId)
 *   - outline_search_query       — full-text search (per-hit `document.text` stripped — keep ranking/context + nav metadata)
 *   - outline_collection_list    — list all collections
 *   - outline_collection_documents — list documents in a collection
 *   - outline_rev_log            — revision metadata (name/timestamp/author) for a document (no body text)
 *   - outline_attachment_upload  — upload via S3 presigned POST (url OR local path)
 *
 * Response-trimming contract (CP-2379, master 2026-09-01+): search / list /
 * create / update responses no longer round-trip full document bodies.
 * Callers that need the body MUST call `outline_doc_get {id}` explicitly.
 * This is a planner-token optimization (toolResult accounts for 77-86% of
 * per-task token spend — see CP-2378). The trim is uniform across the
 * shared handler so the CLI (`outline-tool`) inherits the same shape.
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
import {
  runPatchPreflight,
  runPatchVerification,
  type PatchVerificationResult,
} from "./patch-guard.js";
import {
  normalizeId,
  normalizeLimit,
  normalizeOffset,
  normalizeOptionalId,
  OUTLINE_MAX_LIMIT,
  REV_LOG_MAX_LIMIT,
} from "./param-normalize.js";

const PLUGIN_ID = "outline-wiki-openclaw-plugin";
const EMPTY_CREATE_RESPONSE_ERROR =
  "documents.create returned empty data — server may have failed silently";
// Lower-case camelCase to mirror outline server-side AttachmentPreset enum
// (see outline repo shared/types.ts:134). YAGNI: only documentAttachment /
// avatar / emoji are useful for pilot; workspaceImport / import are admin
// bulk-import paths and intentionally NOT exposed here.
const ATTACHMENT_PRESETS = [
  "documentAttachment",
  "avatar",
  "emoji",
] as const;

// ===== CP-3752 / CP-3768: lenient parameter schemas =====
//
// ID-like parameters (`id`, `collectionId`, `parentDocumentId`,
// `documentId`) accept a string OR an integer; pagination parameters
// (`limit`, `offset`) accept an integer OR a numeric string. The
// normalization itself lives in `src/param-normalize.ts` and is shared
// with the CLI so both call paths behave identically.
//
// Content parameters (`title`, `text`, `query`, `url`, `path`, `name`,
// `changelog`, `findText`) deliberately stay strict `Type.String()` —
// silently stringifying an object/array would corrupt document bodies
// and would break the CP-3689 patch guardrail, which compares the
// submitted text byte-for-byte against the stored body.
//
// ===== CP-3768: why the JSON Schema "type array" form =====
//
// CP-3752 originally widened these aliases with TypeBox's union builder,
// which serializes to the JSON Schema *union keyword* (a list of
// alternative per-type schemas under a single keyword). The
// `@openclaw/deepseek-provider` tool-compat hook lists that keyword —
// and its "exactly one of" sibling — as unsupported, and flattens the
// union down to its FIRST branch (`selected = nonNullVariants[0]`). The
// flattened schema is what the model sees AND what the `tool_call`
// argument validator enforces, so a numeric `id` or a numeric-string
// `limit` was still rejected at the schema layer even though the handler
// would have accepted it.
//
// The fix is to emit the JSON Schema **type array** form instead:
// `{ "type": ["string", "integer"] }`. It carries the same "either of
// these two types" meaning, but it uses no union keyword at all, so the
// provider hook leaves it untouched and the model-visible signature stays
// `string | integer`.
//
// Type-level note: `Type.Unsafe<T>(...)` keeps the static type `T` (it is
// the TypeBox escape hatch for schemas whose static type cannot be
// inferred from the JSON Schema shape). The runtime shape is exactly the
// JSON Schema we hand in — no extra keys are added.
//
// The `minimum` / `pattern` constraints that the old union branches
// carried are NOT silently dropped: they are enforced by the handler in
// `src/param-normalize.ts` (`limit < 1` and `offset < 0` are rejected
// with an explicit error, over-large values are clamped), which is the
// same layer that already owned the normalization semantics.

/** ID-like parameter: string or integer (trimmed to a string). */
function IdSchema(description: string) {
  return Type.Unsafe<string | number>({
    type: ["string", "integer"],
    description,
  });
}

/**
 * Pagination `limit`: integer or numeric string. Values above the
 * server maximum are clamped by the handler (never rejected).
 *
 * The handler in `src/param-normalize.ts` owns the range check: a
 * `limit` below 1 is rejected with an explicit error and an over-large
 * `limit` is clamped to the Outline API maximum (100; 20 for
 * `outline_rev_log`).
 */
function LimitSchema(description: string) {
  return Type.Unsafe<number | string>({
    type: ["integer", "string"],
    description,
  });
}

/**
 * Pagination `offset`: integer or numeric string. `offset` has no upper
 * bound in the Outline pagination middleware; a negative `offset` is
 * rejected by the handler.
 */
function OffsetSchema(description: string) {
  return Type.Unsafe<number | string>({
    type: ["integer", "string"],
    description,
  });
}

interface OutlineWikiConfig {
  apiToken?: string;
  endpoint?: string;
  mcpEndpoint?: string;
  defaultCollectionId?: string;
}

const configSchema = Type.Object(
  {
    apiToken: Type.Optional(
      Type.String({
        description: "Outline API bearer token (used for all doc/collection/search/attachment methods).",
      }),
    ),
    endpoint: Type.Optional(
      Type.String({
        description:
          "Outline API base URL, e.g. https://your-outline.example.com/api",
      }),
    ),
    mcpEndpoint: Type.Optional(
      Type.String({
        description:
          "Outline MCP endpoint for S3 pre-signed attachment uploads, e.g. https://your-outline.example.com/mcp",
      }),
    ),
    defaultCollectionId: Type.Optional(
      Type.String({
        description: "Optional default collection id for outline_doc_create calls.",
      }),
    ),
  },
  { additionalProperties: false },
);

export default defineToolPlugin({
  id: PLUGIN_ID,
  name: "Outline Wiki",
  description:
    "Native Outline Wiki knowledge-base integration for OpenClaw. 15 named tools (one per outline category.method) replace the 0.3.x single-dispatcher `outline_wiki` tool: outline_doc_{list,get,create,update,delete,archive,restore,move}, outline_search_query, outline_collection_{list,documents,create,update}, outline_rev_log, outline_attachment_upload. Two invocation paths: native OpenClaw agents call these MCP tools directly; non-native agents (e.g. codex) use the outline-tool binary with the SAME method names (outline_* or short category.method) — see skills/outline-wiki/SKILL.md. `outline_doc_create` / `outline_doc_move` accept optional `parentDocumentId`. `outline_doc_update` rejects `parentDocumentId` with a fail-fast error (use `outline_doc_move` to reparent — see SKILL.md 避坑清单 15), and accepts an optional `changelog` string that is written to the latest revision's `name` field (best-effort, non-fatal).",
  configSchema,
  activation: { onStartup: true },
  tools: (tool) => [
    tool({
      name: "outline_doc_list",
      label: "Outline List Documents",
      description:
        "List documents in outline. Response contains metadata only — `text` (markdown body) is stripped from every document to keep toolResult payload small (CP-2379 planner-token fix: see `outline_doc_get` for the body). **Default excludes archived documents** — each document's `archivedAt` is preserved (null when live) so callers can inspect; pass `includeArchived: true` to surface archived docs alongside live ones. Optional filters: `limit` (default 25), `offset`, `collectionId` (UUID), `query` (substring match on title), `includeArchived` (default false). Calls `documents.list`.",
      parameters: Type.Object({
        limit: Type.Optional(
          LimitSchema("Max documents to return (default 25). Numeric strings are accepted; values above 100 are clamped to the Outline API maximum."),
        ),
        offset: Type.Optional(
          OffsetSchema("Pagination offset (default 0). Numeric strings are accepted."),
        ),
        collectionId: Type.Optional(
          IdSchema("Outline collection UUID to scope the list (string or integer; trimmed)."),
        ),
        query: Type.Optional(
          Type.String({ description: "Substring filter on document title." }),
        ),
        includeArchived: Type.Optional(
          Type.Boolean({
            description:
              "Include archived documents in the result. Default false — archived docs are filtered out (Outline's `documents.list` defaults to excluding archived; this is a defensive client-side filter on top). Each surviving document carries `archivedAt` (null for live docs).",
            default: false,
          }),
        ),
      }),
      async execute(args, cfg) {
        return await docList(args, cfg as OutlineWikiConfig);
      },
    }),
    tool({
      name: "outline_doc_get",
      label: "Outline Get Document",
      description:
        "Get a single document with metadata + the full markdown body (one round-trip via `documents.info` — `data.text` is the markdown). Required: `id` (UUID).",
      parameters: Type.Object({
        id: IdSchema("Outline document UUID (string or integer; trimmed)."),
      }),
      async execute(args, cfg) {
        return await docGet(args, cfg as OutlineWikiConfig);
      },
    }),
    tool({
      name: "outline_doc_create",
      label: "Outline Create Document",
      description:
        "Create a new outline document (publish=true by default). Required: `title` (string), `text` (markdown body, do NOT include the leading `# <title>` line — outline appends it), and `collectionId` (UUID) — falls back to `defaultCollectionId` config if omitted. Optional: `parentDocumentId` (UUID, 0.4.0+) to nest the new doc under a parent.",
      parameters: Type.Object({
        title: Type.String({ description: "Document title." }),
        text: Type.String({ description: "Markdown body (no leading `# <title>` line)." }),
        collectionId: Type.Optional(
          IdSchema(
            "Target collection UUID. Falls back to plugin config `defaultCollectionId` when omitted (string or integer; trimmed).",
          ),
        ),
        publish: Type.Optional(
          Type.Boolean({
            description: "Publish immediately. Default true.",
            default: true,
          }),
        ),
        parentDocumentId: Type.Optional(
          IdSchema(
            "0.4.0+: nest the new document under this parent document UUID (string or integer; trimmed).",
          ),
        ),
      }),
      async execute(args, cfg) {
        return await docCreate(args, cfg as OutlineWikiConfig);
      },
    }),
    tool({
      name: "outline_doc_update",
      label: "Outline Update Document",
      description:
        "Update an existing document's `text` and/or `title`. `editMode` (default `replace`) selects how `text` is applied — see below. Required: `id` (UUID) + at least one of `text` or `title`. **Does NOT accept `parentDocumentId`** — use `outline_doc_move` for reparent. Optional: `editMode` (one of `replace`|`append`|`prepend`|`patch`, default `replace`), `findText` (required when `editMode=patch` — the markdown substring to locate and replace; server returns 400 if missing or 404 if not found, **never** silently falls back to replace), `publish` (bool), `changelog` (string — after a successful update the plugin best-effort writes this string into the latest revision's `name` field via `revisions.update`; failures are logged in the response `warnings` array but do not fail the main update), `strictChangelog` (bool, default false — when true, changelog write failure hard-fails the update response).\n\n" +
        "**editMode semantics** (mirrors Outline shared `TextEditMode`):\n" +
        "- `replace` (default) — overwrite the entire document body with `text`. Most expensive in tokens (caller sends full body, server echoes it back); preferred only when rewriting the whole doc.\n" +
        "- `append` — append `text` to the end of the document. Cheap (caller sends only the delta); preferred for adding new sections.\n" +
        "- `prepend` — prepend `text` to the start of the document. Cheap; preferred for adding a header block above existing content.\n" +
        "- `patch` — find `findText` in the existing document and replace it with `text`. Cheapest for in-place edits (caller sends only the changed region). **Requires `findText`**; server returns `400 validation_error: findText is required when using patch editMode` when missing, or `404 not_found` when `findText` does not match — never silently replaces the whole document. Use `outline_doc_get` first to read the current body and pick an exact, unique substring.\n\n" +
        "**CP-3689 patch guardrail** (applies to `editMode=patch` only; MCP and CLI behave identically):\n" +
        "- PRE-submit: the plugin reads the current body and requires `findText` to match EXACTLY ONCE (literal, non-fuzzy). 0 matches or >1 matches → the call fails with a clear error and **no `documents.update` request is sent**. The server replaces only the FIRST occurrence, so a duplicated anchor would otherwise edit the wrong region silently.\n" +
        "- POST-submit: the plugin reads the body back and compares the replaced region with the submitted text. A mismatch is reported in `warnings[]` plus `patchVerification` (`verified: false` + `storedRegion` = what the server actually stored). Routine server-side markdown normalization (e.g. `_italic_` → `*italic*`) is reported as `verified: true, normalized: true` — it is NOT an error.\n" +
        "- IMPORTANT: the server rewrites some markdown. A code span nested inside bold (submitted `` **`code`** ``) is stored with the emphasis markers moved (`` `**code**` ``) — the write still returns `ok: true`, but the body comes back mangled and the original anchor then 404s, so the change can no longer be undone with another patch. Write bold and code spans SEPARATELY (`**bold** `code``) instead of nesting them.\n" +
        "- When `patchVerification.verified` is `false`, do NOT retry with the same anchor — it is stale. Re-read the document and repair it with `editMode: \"replace\"`.",
      parameters: Type.Object({
        id: IdSchema("Outline document UUID (string or integer; trimmed)."),
        title: Type.Optional(Type.String({ description: "New title." })),
        text: Type.Optional(
          Type.String({
            description:
              "New markdown body. Strip the leading `# <title>` line if you copied from a `documents.export` round-trip to avoid title duplication. Required for `editMode` values `append` / `prepend` / `patch`; for `patch` it is the replacement text (must be inline-compatible with the surrounding block — multi-block replacements are rejected server-side).",
          }),
        ),
        editMode: Type.Optional(
          Type.String({
            description:
              "How to apply `text`. One of `replace` (default — overwrite whole body), `append` (add to end), `prepend` (add to start), `patch` (replace `findText` substring in place). Deprecated: the legacy boolean `append` flag is no longer accepted here; pass `editMode: \"append\"` instead.",
            default: "replace",
          }),
        ),
        findText: Type.Optional(
          Type.String({
            description:
              "Required when `editMode=patch`. The exact markdown substring to locate and replace in the current document body. Server returns `400 validation_error: findText is required when using patch editMode` when missing, or `404 not_found` when not matched — it NEVER silently falls back to a full-document replace. Read the body via `outline_doc_get` first to pick a substring that is unique enough to be a safe anchor. CP-3689: the plugin additionally requires the anchor to match EXACTLY ONCE in the current body (literal match) before sending any update; 0 or >1 matches → hard error, no update is sent.",
          }),
        ),
        publish: Type.Optional(Type.Boolean({ description: "Publish on update." })),
        changelog: Type.Optional(
          Type.String({
            description:
              "Optional human-readable summary written to the latest revision's `name` field via `revisions.update` after a successful update. Best-effort: failures are non-fatal and surfaced in the response's `warnings`.",
          }),
        ),
        strictChangelog: Type.Optional(
          Type.Boolean({
            description:
              "When true, a changelog write failure returns an error instead of ok:true. Default false preserves best-effort behavior.",
            default: false,
          }),
        ),
      }),
      async execute(args, cfg) {
        return await docUpdate(args, cfg as OutlineWikiConfig);
      },
    }),
    tool({
      name: "outline_doc_delete",
      label: "Outline Delete Document",
      description:
        "Move a document to trash (default, recoverable for ~30 days) or hard-delete (`permanent: true`, requires the doc to already be in trash). Required: `id` (UUID). Optional: `permanent` (bool, default false).",
      parameters: Type.Object({
        id: IdSchema("Outline document UUID (string or integer; trimmed)."),
        permanent: Type.Optional(
          Type.Boolean({
            description:
              "Hard-delete (must trash first via a separate outline_doc_delete call — `permanentDelete` cancan checks `isDeleted`). Default false (trash).",
            default: false,
          }),
        ),
      }),
      async execute(args, cfg) {
        return await docDelete(args, cfg as OutlineWikiConfig);
      },
    }),
    tool({
      name: "outline_doc_archive",
      label: "Outline Archive Document",
      description:
        "Archive a document (admin can still read it; recoverable via outline_doc_restore). Required: `id` (UUID).",
      parameters: Type.Object({
        id: IdSchema("Outline document UUID (string or integer; trimmed)."),
      }),
      async execute(args, cfg) {
        return await docArchive(args, cfg as OutlineWikiConfig);
      },
    }),
    tool({
      name: "outline_doc_restore",
      label: "Outline Restore Document",
      description:
        "Restore a document from the archive. Required: `id` (UUID).",
      parameters: Type.Object({
        id: IdSchema("Outline document UUID (string or integer; trimmed)."),
      }),
      async execute(args, cfg) {
        return await docRestore(args, cfg as OutlineWikiConfig);
      },
    }),
    tool({
      name: "outline_doc_move",
      label: "Outline Move Document",
      description:
        "Move a document to a different collection (and optionally reparent in the same call). Required: `id` (UUID) + `collectionId` (UUID, no default fallback — moving is an explicit gesture). Optional: `parentDocumentId` (UUID) to nest under a parent doc in the target collection.",
      parameters: Type.Object({
        id: IdSchema("Outline document UUID to move (string or integer; trimmed)."),
        collectionId: IdSchema(
          "Target collection UUID. No fallback — moving is explicit (string or integer; trimmed).",
        ),
        parentDocumentId: Type.Optional(
          IdSchema(
            "0.4.0+: nest the document under this parent document UUID in the target collection (string or integer; trimmed).",
          ),
        ),
      }),
      async execute(args, cfg) {
        return await docMove(args, cfg as OutlineWikiConfig);
      },
    }),
    tool({
      name: "outline_search_query",
      label: "Outline Search",
      description:
        "Full-text search across documents (Bearer-auth works). **Default excludes archived documents** — Outline's `documents.search` endpoint does NOT exclude archived by default, so the plugin applies a defensive `archivedAt != null` filter on top; pass `includeArchived: true` to keep archived hits. Each surviving hit's `document` carries `archivedAt` (null when live) so callers can still inspect archive state. Required: `query` (non-empty string). Optional: `limit` (default 25), `offset`, `collectionId` (UUID), `includeArchived` (default false).",
      parameters: Type.Object({
        query: Type.String({ description: "Full-text search query (required, non-empty)." }),
        limit: Type.Optional(
          LimitSchema("Max results (default 25). Numeric strings are accepted; values above 100 are clamped to the Outline API maximum."),
        ),
        offset: Type.Optional(
          OffsetSchema("Pagination offset. Numeric strings are accepted."),
        ),
        collectionId: Type.Optional(
          IdSchema("Restrict search to one collection UUID (string or integer; trimmed)."),
        ),
        includeArchived: Type.Optional(
          Type.Boolean({
            description:
              "Include archived documents in the search hits. Default false — archived docs (archivedAt != null) are filtered out client-side. Each surviving hit's `document` carries `archivedAt` (null when live).",
            default: false,
          }),
        ),
      }),
      async execute(args, cfg) {
        return await searchQuery(args, cfg as OutlineWikiConfig);
      },
    }),
    tool({
      name: "outline_collection_list",
      label: "Outline List Collections",
      description:
        "List all collections. Optional: `limit` (default 25), `offset`.",
      parameters: Type.Object({
        limit: Type.Optional(
          LimitSchema("Max collections to return (default 25). Numeric strings are accepted; values above 100 are clamped to the Outline API maximum."),
        ),
        offset: Type.Optional(
          OffsetSchema("Pagination offset (default 0). Numeric strings are accepted."),
        ),
      }),
      async execute(args, cfg) {
        return await collectionList(args, cfg as OutlineWikiConfig);
      },
    }),
    tool({
      name: "outline_collection_documents",
      label: "Outline List Collection Documents",
      description:
        "List documents in a collection (returns the cached navigation tree: `{id, url, title, children}` per node). **Archived children are excluded by default** — the underlying endpoint returns a navigation tree where `Document.toNavigationNode` defaults to `includeArchived: false`, so the response never surfaces archived docs. `includeArchived` is accepted for API symmetry with `outline_search_query` / `outline_doc_list` but currently has no effect (endpoint capability — the response shape does not carry `archivedAt` to filter on). Required: `id` (collection UUID, e.g. WTO = 2539c4a2-1fa8-4f0e-900f-9a5c7f1f72ba). Optional: `limit` (default 25), `offset`, `includeArchived` (default false; informational, see above).",
      parameters: Type.Object({
        id: IdSchema("Collection UUID (string or integer; trimmed)."),
        limit: Type.Optional(
          LimitSchema("Max documents to return (default 25). Numeric strings are accepted; values above 100 are clamped to the Outline API maximum."),
        ),
        offset: Type.Optional(
          OffsetSchema("Pagination offset (default 0). Numeric strings are accepted."),
        ),
        includeArchived: Type.Optional(
          Type.Boolean({
            description:
              "Accepted for API symmetry with `outline_search_query` / `outline_doc_list`. Default false. Note: the underlying `collections.documents` endpoint returns a navigation tree that already excludes archived children and does not surface `archivedAt`, so this flag has no effect on the response today.",
            default: false,
          }),
        ),
      }),
      async execute(args, cfg) {
        return await collectionDocuments(args, cfg as OutlineWikiConfig);
      },
    }),
    tool({
      name: "outline_collection_create",
      label: "Outline Create Collection",
      description:
        "Create a new outline collection. Required: `name` (string, non-empty). Optional: `description` (string), `icon` (string), `color` (hex string, e.g. `#000000`), `permission` (default `read_write` — overrides outline server's `null` default which would make the collection admin-only and cause 'all users cannot see this collection' incidents), `sharing` (bool, default `true`). Calls `collections.create`.",
      parameters: Type.Object({
        name: Type.String({ description: "Collection name (required, non-empty)." }),
        description: Type.Optional(
          Type.String({ description: "Human-readable collection description." }),
        ),
        icon: Type.Optional(
          Type.String({ description: "Outline icon identifier (string, e.g. emoji name)." }),
        ),
        color: Type.Optional(
          Type.String({
            description: "Hex color string, e.g. `#000000`.",
            pattern: "^#?[0-9A-Fa-f]{6}$",
          }),
        ),
        permission: Type.Optional(
          Type.String({
            description:
              "Default collection permission. Defaults to `read_write` (NOT `null` — passing null/omitting on outline's REST endpoint makes the collection admin-only and is the root cause of 'I created a collection but nobody can see it' incidents). Pass a different value to override.",
            default: "read_write",
            enum: ["read_write", "read", "null"],
          }),
        ),
        sharing: Type.Optional(
          Type.Boolean({
            description: "Whether the collection can be shared externally. Default `true`.",
            default: true,
          }),
        ),
      }),
      async execute(args, cfg) {
        return await collectionCreate(args, cfg as OutlineWikiConfig);
      },
    }),
    tool({
      name: "outline_collection_update",
      label: "Outline Update Collection",
      description:
        "Update an existing outline collection. Required: `id` (collection UUID). Optional: `name`, `description`, `icon`, `color`, `permission`, `sharing` — pass only the fields you want to change. Calls `collections.update`.",
      parameters: Type.Object({
        id: IdSchema("Collection UUID (string or integer; trimmed; required)."),
        name: Type.Optional(
          Type.String({ description: "New collection name." }),
        ),
        description: Type.Optional(
          Type.String({ description: "New description." }),
        ),
        icon: Type.Optional(
          Type.String({ description: "New icon identifier." }),
        ),
        color: Type.Optional(
          Type.String({
            description: "New hex color string, e.g. `#000000`.",
            pattern: "^#?[0-9A-Fa-f]{6}$",
          }),
        ),
        permission: Type.Optional(
          Type.String({
            description:
              "New permission. Use to flip an accidentally-admin-only collection back to `read_write` so all users can see it.",
            enum: ["read_write", "read", "null"],
          }),
        ),
        sharing: Type.Optional(
          Type.Boolean({ description: "New sharing flag." }),
        ),
      }),
      async execute(args, cfg) {
        return await collectionUpdate(args, cfg as OutlineWikiConfig);
      },
    }),
    tool({
      name: "outline_rev_log",
      label: "Outline Revision Log",
      description:
        "Get revision changelog for a document (metadata only: name, timestamp, author). Returns up to N recent revisions, stripped of body text/data/collaborators — safe to call frequently to surface change history. Calls `revisions.list`. Required: `documentId` (UUID). Optional: `limit` (number, default 5, max 20).",
      parameters: Type.Object({
        documentId: IdSchema("Outline document UUID (string or integer; trimmed)."),
        limit: Type.Optional(
          LimitSchema("Max revisions to return (default 5, max 20). Numeric strings are accepted; values above 20 are clamped to 20."),
        ),
      }),
      async execute(args, cfg) {
        return await revLog(args, cfg as OutlineWikiConfig);
      },
    }),
    tool({
      name: "outline_attachment_upload",
      label: "Outline Upload Attachment",
      description:
        "Upload a file to outline. Two modes: `url` (outline fetches the public URL server-side via `attachments.createFromUrl`, recommended on dev wiki — single round-trip; requires `documentId` + `preset=documentAttachment`) or `path` (plugin reads the local file + PUTs to S3 presigned POST — modern outline only, dev wiki is legacy `files.create` cookie-only so path mode fails fast with a clear hint). Required: `name` + (`url` OR `path`). Optional: `contentType`, `size`, `documentId`, `preset` (default `documentAttachment`).",
      parameters: Type.Object({
        name: Type.String({ description: "Attachment filename." }),
        url: Type.Optional(
          Type.String({
            description:
              "Public URL outline will fetch (url mode — recommended on dev wiki). Requires `documentId`.",
          }),
        ),
        path: Type.Optional(
          Type.String({
            description:
              "Local file path the plugin reads (path mode — modern outline only).",
          }),
        ),
        contentType: Type.Optional(
          Type.String({
            description: "MIME type. Default `application/octet-stream`.",
            default: "application/octet-stream",
          }),
        ),
        size: Type.Optional(
          Type.Integer({
            description: "File size in bytes (auto-detected for path mode).",
          }),
        ),
        documentId: Type.Optional(
          IdSchema(
            "Outline document UUID to attach to (string or integer; trimmed; required for url mode).",
          ),
        ),
        preset: Type.Optional(
          Type.String({
            description:
              "Outline AttachmentPreset (lowercase camelCase). One of: documentAttachment, avatar, emoji. Default `documentAttachment`.",
            default: "documentAttachment",
          }),
        ),
      }),
      async execute(args, cfg) {
        return await attachmentUpload(args, cfg as OutlineWikiConfig);
      },
    }),
  ],
});

// ===== Handlers (1:1 with the previous dispatcher implementations) =====

async function docList(
  args: Record<string, unknown>,
  cfg: OutlineWikiConfig,
) {
  const guard = requireConfig(cfg);
  if (guard) return guard;

  // CP-2559: includeArchived defaults to false — Outline's `documents.list`
  // endpoint already defaults to excluding archived docs server-side
  // (`where.archivedAt = null`), but we re-enforce client-side as a defensive
  // filter and so the response shape is consistent across outline versions.
  const includeArchived = pickBoolean(args.includeArchived, false);

  // CP-3752: pagination accepts a number or a numeric string; values
  // above the Outline API maximum are clamped (never rejected).
  const limit = normalizeLimit(args.limit, {
    label: "limit",
    fallback: 25,
    max: OUTLINE_MAX_LIMIT,
  });
  if (!limit.ok) return textResult({ error: limit.error });
  const offset = normalizeOffset(args.offset, {
    label: "offset",
    fallback: 0,
  });
  if (!offset.ok) return textResult({ error: offset.error });

  const body: Record<string, unknown> = {
    limit: limit.value,
    offset: offset.value,
  };
  // CP-3752: `collectionId` is an ID-like parameter — string or integer,
  // trimmed. Invalid types are rejected instead of being stringified.
  const collectionId = normalizeOptionalId(args.collectionId, "collectionId");
  if (!collectionId.ok) return textResult({ error: collectionId.error });
  if (collectionId.value !== undefined) body.collectionId = collectionId.value;
  if (typeof args.query === "string") body.query = args.query;
  // When the caller opts in to archived docs, ask the server for them too
  // (otherwise the server may honor its default-exclude behavior and return
  // an empty result even when archived matches exist).
  if (includeArchived) {
    body.statusFilter = ["archived", "published", "draft"];
  }

  try {
    const data = await outlineFetch(cfg, "documents.list", body);
    let trimmedDocs = Array.isArray(data?.data)
      ? data.data.map(trimDocBody)
      : [];
    // CP-2559: defensive client-side archive filter — drop any doc whose
    // archivedAt is set unless the caller opted in via includeArchived=true.
    if (!includeArchived) {
      trimmedDocs = trimmedDocs.filter(
        (d: Record<string, unknown> | null) =>
          d == null || d.archivedAt == null,
      );
    }
    return textResult({
      ok: true,
      method: "documents.list",
      request: body,
      // CP-2379: strip the full markdown body (`text`) from every doc to
      // shrink toolResult payload — outline's `documents.list` returns the
      // complete body in `text`, which is overkill for a list view (use
      // `outline_doc_get` to fetch a body). Metadata fields kept match the
      // navigation set the agent needs to follow up with `outline_doc_get`
      // / `outline_doc_move` / `outline_doc_update`. CP-2559 also passes
      // through `archivedAt` so callers can see archive state (null for live).
      documents: trimmedDocs,
      pagination: data?.pagination ?? null,
    });
  } catch (err) {
    return textResult({ error: `documents.list failed: ${errorMessage(err)}` });
  }
}

async function docGet(
  args: Record<string, unknown>,
  cfg: OutlineWikiConfig,
) {
  const guard = requireConfig(cfg);
  if (guard) return guard;
  // CP-3752: `id` accepts a string or an integer and is trimmed.
  const id = normalizeId(args.id, "id");
  if (!id.ok) {
    return textResult({
      error: `outline_doc_get requires a non-empty \`id\` (string or integer) argument. ${id.error}`,
    });
  }

  // Single-step: documents.info already returns metadata + the full markdown
  // body in `data.text`. The legacy mcporter path forced a second
  // documents.export call to get the body; the plugin hides that dance.
  // If a future outline revision returns `text=null` for some documents,
  // fall back to documents.export; until then no extra round trip needed.
  try {
    const info = await outlineFetch(cfg, "documents.info", { id: id.value });
    return textResult({
      ok: true,
      method: "documents.get",
      request: { id: id.value },
      document: info?.data ?? null,
    });
  } catch (err) {
    return textResult({ error: `documents.get failed: ${errorMessage(err)}` });
  }
}

async function docCreate(
  args: Record<string, unknown>,
  cfg: OutlineWikiConfig,
) {
  const guard = requireConfig(cfg);
  if (guard) return guard;
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
  //
  // CP-3752: `collectionId` accepts a string or an integer and is trimmed.
  const argCollectionId = normalizeOptionalId(args.collectionId, "collectionId");
  if (!argCollectionId.ok) {
    return textResult({
      error: `outline_doc_create requires \`collectionId\` (string or integer). ${argCollectionId.error}`,
    });
  }
  const collectionId = argCollectionId.value ?? cfg.defaultCollectionId;
  if (!collectionId) {
    return textResult({
      error:
        "outline_doc_create requires `collectionId` (string) — pass it as an arg, or set `defaultCollectionId` in the plugin config.",
    });
  }

  // CP-3752: `parentDocumentId` accepts a string or an integer and is trimmed.
  const parentDocumentId = normalizeOptionalId(
    args.parentDocumentId,
    "parentDocumentId",
  );
  if (!parentDocumentId.ok) {
    return textResult({ error: parentDocumentId.error });
  }

  // MVP wires the truly required fields + `publish` (default true so the
  // new doc is immediately visible without a second round-trip) +
  // `parentDocumentId` (0.4.0+ — see踩坑清单 11 in README, was YAGNI
  // until 2026-06-08 because no caller needed it; the WTO 误判复盘 v1
  // child-doc container workflow tipped it over the line).
  // Other fields (templateId, icon, color) are intentionally left out
  // per the YAGNI rule; they can be added in a follow-up.
  const body: Record<string, unknown> = {
    title: args.title,
    text: args.text,
    collectionId,
    publish: typeof args.publish === "boolean" ? args.publish : true,
  };
  if (parentDocumentId.value !== undefined) {
    body.parentDocumentId = parentDocumentId.value;
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
    } catch (err) {
      return textResult({
        error: `documents.create verify failed for id "${createdId}": ${errorMessage(err)}`,
      });
    }

    return textResult({
      ok: true,
      method: "documents.create",
      // CP-2395: round-trip trim — `request` used to echo `body` (which
      // includes the full markdown body under `text`). Strip everything
      // except `{title}` so the agent doesn't see its own input round-trip
      // back. The server-returned document was already trimmed by CP-2379
      // via `trimDocBody(created)` below.
      request: trimCreateRequest(body),
      // CP-2379: round-trip trim — `document.text` is dropped from the
      // response to avoid blasting the full markdown body back into the
      // agent's toolResult (the agent just sent that body via `text`; it
      // doesn't need to receive it again). `summary` below holds the
      // navigation fields the agent needs to follow up.
      document: created ? trimDocBody(created) : null,
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
  } catch (err) {
    if (errorMessage(err).startsWith("Response was not JSON (HTTP 200):")) {
      return textResult({ error: EMPTY_CREATE_RESPONSE_ERROR });
    }
    return textResult({ error: `documents.create failed: ${errorMessage(err)}` });
  }
}

async function verifyCreatedDocument(
  cfg: OutlineWikiConfig,
  id: string,
): Promise<void> {
  const info = await outlineFetch(cfg, "documents.info", { id });
  const verifiedId = info?.data?.id;
  if (typeof verifiedId !== "string" || verifiedId.length === 0) {
    throw new Error("documents.info returned empty data");
  }
}

async function docUpdate(
  args: Record<string, unknown>,
  cfg: OutlineWikiConfig,
) {
  const guard = requireConfig(cfg);
  if (guard) return guard;
  // CP-3752: `id` accepts a string or an integer and is trimmed.
  const id = normalizeId(args.id, "id");
  if (!id.ok) {
    return textResult({
      error: `outline_doc_update requires a non-empty \`id\` (string or integer) argument. ${id.error}`,
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
      error:
        "outline_doc_update does not accept `parentDocumentId` — the outline server silently drops it. " +
        "To reparent a document, use outline_doc_move for reparent with the new `collectionId` (same collection is fine) and the new `parentDocumentId`. " +
        "Example: outline_doc_move {id, collectionId, parentDocumentId: '<new-parent-uuid>'}.",
      hint:
        "documents.update's schema does not include parentDocumentId — outline server silently drops it (silent drop verified 2026-06-08). " +
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
      error:
        "outline_doc_update requires at least one of `text` or `title` (string) to change.",
    });
  }

  // MVP wires text/title + editMode (default "replace") + publish + findText
  // (the last is required for `editMode=patch`; the server returns a 400 if
  // it is missing, or a 404 if it does not match — never a silent full-doc
  // replace). Other fields (append, icon, color, templateId) intentionally
  // left out per YAGNI; they can be added in a follow-up.
  //
  // Quickref gotcha: `documents.export` returns markdown whose first line is
  // `# <title>`. If the caller passes that export as `text` into outline_doc_update,
  // the title will accumulate on every round-trip — so callers should strip
  // the leading `# <title>` line first. We surface this in the error hint
  // when a request that looks like an export-blob comes in unchanged.
  const body: Record<string, unknown> = { id: id.value };
  if (typeof args.text === "string") {
    body.text = args.text;
    body.editMode = typeof args.editMode === "string" ? args.editMode : "replace";
  }
  if (typeof args.title === "string") {
    body.title = args.title;
  }
  if (typeof args.publish === "boolean") body.publish = args.publish;
  // findText passthrough — only meaningful when editMode=patch (the server
  // ignores it for the other three modes). We forward it whenever the caller
  // supplied a non-empty string so the wire body matches what the caller
  // asked for; the server-side schema check decides whether to apply it.
  if (typeof args.findText === "string") {
    body.findText = args.findText;
  }

  // ===== CP-3689: patch guardrail =====
  //
  // Two server-side behaviours make a naive patch dangerous (both reproduced
  // against the dev wiki on 2026-10-23):
  //
  //   (1) The server replaces only the FIRST occurrence of `findText`. A
  //       duplicated anchor therefore silently edits the wrong region.
  //   (2) The server round-trips the submitted markdown through its own
  //       serializer, which is not the identity for some constructs — most
  //       dangerously a code span nested inside bold (submitted
  //       `**`code`**` is stored as `` `**code**` ``). The write returns
  //       HTTP 200 / ok:true, but the body comes back mangled and the
  //       original anchor then 404s, so the agent cannot repair the
  //       document with another patch.
  //
  // PRE-submit: read the current body and require `findText` to match
  // EXACTLY ONCE. 0 matches or >1 matches → hard error, NO update call is
  // sent. This is the only way to fail safely: once the write lands, the
  // mangled body is already stored.
  //
  // POST-submit: read the body back and compare the changed region with the
  // submitted text. A mismatch is reported as an explicit warning plus a
  // `patchVerification` payload.
  //
  // Only editMode=patch is guarded — replace / append / prepend have no
  // anchor to verify and are untouched by this change.
  const isPatch = body.editMode === "patch";
  let patchBeforeBody: string | null = null;
  if (isPatch) {
    const findText = typeof args.findText === "string" ? args.findText : "";
    if (findText.length === 0) {
      // The server would answer `400 validation_error: findText is required
      // when using patch editMode` anyway; failing here with the same
      // wording keeps the error contract stable while saving a round-trip.
      return textResult({
        error:
          "outline_doc_update patch preflight failed: 400 validation_error: findText is required when using patch editMode — no update was sent.",
      });
    }
    const preflight = await runPatchPreflight(
      id.value,
      findText,
      (docId) => fetchDocText(cfg, docId),
    );
    if (!preflight.ok) {
      return textResult({ error: preflight.error });
    }
    patchBeforeBody = preflight.body;
  }

  // Track warnings for best-effort post-update side-effects (e.g. changelog
  // writing via revisions.update). Non-fatal — main update succeeds even if
  // these fail; we just collect the messages and surface them in the
  // response so the agent can decide whether to retry.
  const warnings: string[] = [];

  try {
    const data = await outlineFetch(cfg, "documents.update", body);
    const updated = data?.data ?? null;

    // ===== CP-3689: post-submit read-back verification =====
    //
    // The update already landed. Re-read the body and compare the region
    // the server actually stored with the text we submitted. A mismatch
    // (the server rewrote our markdown) is surfaced as an explicit warning
    // plus a `patchVerification` payload — the caller needs to know that the
    // anchor it holds is now stale.
    let patchVerification: PatchVerificationResult | undefined;
    if (isPatch && patchBeforeBody !== null && typeof body.text === "string") {
      patchVerification = await runPatchVerification(
        id.value,
        patchBeforeBody,
        body.text,
        (docId) => fetchDocText(cfg, docId),
      );
      if (!patchVerification.verified) {
        warnings.push(
          patchVerification.reason ??
            "patch verification failed: the stored text does not match the submitted replacement text.",
        );
      }
    }

    // Best-effort changelog: if the caller provided `changelog`, look up the
    // latest revision for this document and write the string into its `name`
    // field. Failures here are non-fatal — the main update has already
    // succeeded, so we log into `warnings` and continue.
    if (typeof args.changelog === "string" && args.changelog.length > 0) {
      const changelogResult = await writeChangelog(id.value, args.changelog, cfg);
      if ("warning" in changelogResult) {
        if (args.strictChangelog === true) {
          return textResult({
            error: `documents.update changelog write failed with strictChangelog=true: ${changelogResult.warning}`,
            method: "documents.update",
            // CP-2395: trim body on the strict-error path too — same
            // rationale as the ok path (don't round-trip the markdown body).
            request: trimUpdateRequest(body),
            // CP-2379: trim body on the strict-error path too — same
            // rationale as the ok path (don't round-trip the markdown body).
            document: updated ? trimDocBody(updated) : null,
          });
        }
        warnings.push(changelogResult.warning);
      }
    }

    return textResult({
      ok: true,
      method: "documents.update",
      // CP-2395: round-trip trim — `request` used to echo `body` (which
      // includes the full markdown body under `text`). Strip everything
      // except `{id, title}` (title only when the caller passed it in the
      // update — same shape as docCreate). The server-returned document
      // was already trimmed by CP-2379 via `trimDocBody(updated)` below.
      request: trimUpdateRequest(body),
      // CP-2379: round-trip trim — see docCreate for the rationale. The
      // agent just sent `text`/`title`; it does not need to receive the
      // post-update body back. `summary` carries the navigation fields.
      document: updated ? trimDocBody(updated) : null,
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
      // CP-3689: patch read-back result (only for editMode=patch).
      patchVerification: patchVerification ?? undefined,
    });
  } catch (err) {
    return textResult({ error: `documents.update failed: ${errorMessage(err)}` });
  }
}

async function docDelete(
  args: Record<string, unknown>,
  cfg: OutlineWikiConfig,
) {
  const guard = requireConfig(cfg);
  if (guard) return guard;
  // CP-3752: `id` accepts a string or an integer and is trimmed.
  const id = normalizeId(args.id, "id");
  if (!id.ok) {
    return textResult({
      error: `outline_doc_delete requires a non-empty \`id\` (string or integer) argument. ${id.error}`,
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
  const body: Record<string, unknown> = { id: id.value };
  if (permanent) body.permanent = true;

  try {
    const data = await outlineFetch(cfg, "documents.delete", body);
    return textResult({
      ok: true,
      method: "documents.delete",
      request: { id: id.value, permanent },
      result: data?.data ?? null,
      summary: {
        id: id.value,
        mode: permanent ? "permanent" : "trash",
      },
    });
  } catch (err) {
    return textResult({ error: `documents.delete failed: ${errorMessage(err)}` });
  }
}

async function docArchive(
  args: Record<string, unknown>,
  cfg: OutlineWikiConfig,
) {
  const guard = requireConfig(cfg);
  if (guard) return guard;
  // CP-3752: `id` accepts a string or an integer and is trimmed.
  const id = normalizeId(args.id, "id");
  if (!id.ok) {
    return textResult({
      error: `outline_doc_archive requires a non-empty \`id\` (string or integer) argument. ${id.error}`,
    });
  }
  try {
    const data = await outlineFetch(cfg, "documents.archive", { id: id.value });
    const archived = data?.data ?? null;
    return textResult({
      ok: true,
      method: "documents.archive",
      request: { id: id.value },
      document: archived,
      summary: {
        id: id.value,
        archivedAt: archived?.archivedAt ?? null,
      },
    });
  } catch (err) {
    return textResult({ error: `documents.archive failed: ${errorMessage(err)}` });
  }
}

async function docRestore(
  args: Record<string, unknown>,
  cfg: OutlineWikiConfig,
) {
  const guard = requireConfig(cfg);
  if (guard) return guard;
  // CP-3752: `id` accepts a string or an integer and is trimmed.
  const id = normalizeId(args.id, "id");
  if (!id.ok) {
    return textResult({
      error: `outline_doc_restore requires a non-empty \`id\` (string or integer) argument. ${id.error}`,
    });
  }
  try {
    const data = await outlineFetch(cfg, "documents.restore", { id: id.value });
    return textResult({
      ok: true,
      method: "documents.restore",
      request: { id: id.value },
      document: data?.data ?? null,
      summary: { id: id.value, restored: true },
    });
  } catch (err) {
    return textResult({ error: `documents.restore failed: ${errorMessage(err)}` });
  }
}

async function docMove(
  args: Record<string, unknown>,
  cfg: OutlineWikiConfig,
) {
  const guard = requireConfig(cfg);
  if (guard) return guard;
  // CP-3752: `id` accepts a string or an integer and is trimmed.
  const id = normalizeId(args.id, "id");
  if (!id.ok) {
    return textResult({
      error: `outline_doc_move requires a non-empty \`id\` (string or integer) argument. ${id.error}`,
    });
  }
  // doc.move has no `defaultCollectionId` fallback — moving is an
  // explicit user gesture, the destination must be named in the call.
  //
  // CP-3752: `collectionId` accepts a string or an integer and is trimmed.
  const collectionId = normalizeId(args.collectionId, "collectionId");
  if (!collectionId.ok) {
    return textResult({
      error:
        "outline_doc_move requires `collectionId` (string, UUID) — moving is an explicit gesture, no implicit default. " +
        collectionId.error,
    });
  }
  // CP-3752: `parentDocumentId` accepts a string or an integer and is trimmed.
  const parentDocumentId = normalizeOptionalId(
    args.parentDocumentId,
    "parentDocumentId",
  );
  if (!parentDocumentId.ok) {
    return textResult({ error: parentDocumentId.error });
  }
  // 0.4.0+: `parentDocumentId` is optional on outline_doc_move so a caller can
  // reparent a doc in the same operation (e.g. "move under the
  // <quality & testing> container"). Omitted → outline server defaults
  // the new doc to the collection root (existing behavior preserved).
  const body: Record<string, unknown> = {
    id: id.value,
    collectionId: collectionId.value,
  };
  if (parentDocumentId.value !== undefined) {
    body.parentDocumentId = parentDocumentId.value;
  }
  try {
    const data = await outlineFetch(cfg, "documents.move", body);
    return textResult({
      ok: true,
      method: "documents.move",
      request: body,
      document: data?.data ?? null,
      summary: {
        id: id.value,
        collectionId: collectionId.value,
        parentDocumentId: body.parentDocumentId ?? null,
      },
    });
  } catch (err) {
    return textResult({ error: `documents.move failed: ${errorMessage(err)}` });
  }
}

async function searchQuery(
  args: Record<string, unknown>,
  cfg: OutlineWikiConfig,
) {
  const guard = requireConfig(cfg);
  if (guard) return guard;
  if (typeof args.query !== "string" || args.query.trim().length === 0) {
    return textResult({
      error: "outline_search_query requires a non-empty `query` (string) argument.",
    });
  }
  // CP-2559: includeArchived defaults to false — Outline's `documents.search`
  // does NOT exclude archived docs by default (unlike `documents.list`), so
  // we must filter client-side. Pass includeArchived=true to keep archived
  // hits in the result.
  const includeArchived = pickBoolean(args.includeArchived, false);

  // CP-3752: pagination accepts a number or a numeric string; values
  // above the Outline API maximum are clamped (never rejected).
  const limit = normalizeLimit(args.limit, {
    label: "limit",
    fallback: 25,
    max: OUTLINE_MAX_LIMIT,
  });
  if (!limit.ok) return textResult({ error: limit.error });
  const offset = normalizeOffset(args.offset, {
    label: "offset",
    fallback: 0,
  });
  if (!offset.ok) return textResult({ error: offset.error });

  const body: Record<string, unknown> = {
    query: args.query,
    limit: limit.value,
    offset: offset.value,
  };
  // CP-3752: `collectionId` is an ID-like parameter — string or integer,
  // trimmed. Invalid types are rejected instead of being stringified.
  const collectionId = normalizeOptionalId(args.collectionId, "collectionId");
  if (!collectionId.ok) return textResult({ error: collectionId.error });
  if (collectionId.value !== undefined) body.collectionId = collectionId.value;
  // When the caller opts in, ask the server for archived hits too via the
  // statusFilter shorthand so the server doesn't drop them at the query
  // level. (Outline's `documents.search` honors `statusFilter` in addition
  // to the modern `filters` DSL.)
  if (includeArchived) {
    body.statusFilter = ["archived", "published", "draft"];
  }

  try {
    const data = await outlineFetch(cfg, "documents.search", body);
    let hits = Array.isArray(data?.data)
      ? data.data.map(trimSearchHit)
      : [];
    // CP-2559: defensive client-side archive filter — drop any hit whose
    // inner document has archivedAt set unless the caller opted in. The
    // server-side `documents.search` defaults to including archived hits,
    // so without this filter the planner sees archived docs mixed into the
    // search results (which is the bug that motivated this ticket).
    if (!includeArchived) {
      hits = hits.filter((h: Record<string, unknown> | null) => {
        const d = h?.document as
          | Record<string, unknown>
          | null
          | undefined;
        return d == null || d.archivedAt == null;
      });
    }
    return textResult({
      ok: true,
      method: "documents.search",
      request: body,
      // CP-2379: strip `document.text` (full markdown body) from each hit.
      // outline's `documents.search` returns `{ranking, context, document}`
      // where `document.text` is the full markdown — for a search hit that's
      // a huge token blast (43k→~1k chars per call in the planner workload).
      // We keep `ranking` + `context` (already a snippet, sibling of
      // `document`) + the inner-document navigation set (same set as
      // `outline_doc_list`: id / title / url / urlId / collectionId /
      // updatedAt / archivedAt). Callers that need the body must call
      // `outline_doc_get`.
      documents: hits,
      pagination: data?.pagination ?? null,
    });
  } catch (err) {
    return textResult({ error: `documents.search failed: ${errorMessage(err)}` });
  }
}

async function attachmentUpload(
  args: Record<string, unknown>,
  cfg: OutlineWikiConfig,
) {
  const guard = requireConfig(cfg);
  if (guard) return guard;
  if (typeof args.name !== "string" || args.name.length === 0) {
    return textResult({
      error: "outline_attachment_upload requires a non-empty `name` (string) argument.",
    });
  }
  if (typeof args.url !== "string" && typeof args.path !== "string") {
    return textResult({
      error:
        "outline_attachment_upload requires either `url` (string, outline fetches it) or `path` (string, plugin reads + uploads).",
    });
  }
  const presetRaw = typeof args.preset === "string" ? args.preset : "documentAttachment";
  if (!(ATTACHMENT_PRESETS as readonly string[]).includes(presetRaw)) {
    return textResult({
      error: `outline_attachment_upload preset must be one of: ${ATTACHMENT_PRESETS.join(", ")}.`,
    });
  }
  const preset = presetRaw as (typeof ATTACHMENT_PRESETS)[number];

  // Branch A: caller provides a URL. outline's `attachments.createFromUrl`
  // endpoint fetches the URL server-side, attaches the resulting file to
  // the given document, and returns the attachment record in one round-trip.
  // Only DocumentAttachment preset supports this path (the endpoint
  // schema enforces `preset === DocumentAttachment` and a non-empty
  // documentId).
  if (typeof args.url === "string") {
    if (preset !== "documentAttachment") {
      return textResult({
        error:
          "outline_attachment_upload with `url` only supports preset=documentAttachment; use `path` for avatar/emoji.",
      });
    }
    // CP-3752: `documentId` accepts a string or an integer and is trimmed.
    const documentId = normalizeId(args.documentId, "documentId");
    if (!documentId.ok) {
      return textResult({
        error:
          "outline_attachment_upload with `url` requires `documentId` (string, UUID) — outline's createFromUrl endpoint refuses document attachments without a target document. " +
          documentId.error,
      });
    }
    let attachmentData: any;
    try {
      const data = await outlineFetch(cfg, "attachments.createFromUrl", {
        name: args.name,
        url: args.url,
        documentId: documentId.value,
        preset,
      });
      attachmentData = data?.data ?? null;
    } catch (err) {
      return textResult({
        error: `attachments.createFromUrl failed: ${errorMessage(err)}`,
      });
    }

    const rawSize = attachmentData?.size;
    const sizeIsEmpty =
      rawSize === undefined ||
      rawSize === null ||
      rawSize === "" ||
      rawSize === "0" ||
      rawSize === 0;
    if (!attachmentData || !attachmentData.id || sizeIsEmpty) {
      return textResult({
        error: "源 URL 不可达或抓取失败,附件为空",
        method: "attachments.createFromUrl",
        request: { name: args.name, url: args.url, documentId: documentId.value, preset },
        attachment: attachmentData,
      });
    }

    const attachment = attachmentData;
    return textResult({
      ok: true,
      method: "attachments.createFromUrl",
      request: { name: args.name, url: args.url, documentId: documentId.value, preset },
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

  // Branch B: caller provides a local file path. The plugin reads the file,
  // calls `attachments.create` to mint an S3 presigned POST (one round-trip),
  // then PUTs the file to S3 with the presigned form fields (second
  // round-trip). This is the canonical S3-presigned-POST upload pattern;
  // we never hit the outline server with the file body, so it scales to
  // large attachments.
  const path = args.path as string;
  const contentType =
    typeof args.contentType === "string" && args.contentType.length > 0
      ? args.contentType
      : "application/octet-stream";
  // CP-3752: `documentId` accepts a string or an integer and is trimmed.
  const optionalDocumentId = normalizeOptionalId(
    args.documentId,
    "documentId",
  );
  if (!optionalDocumentId.ok) {
    return textResult({ error: optionalDocumentId.error });
  }
  const documentId = optionalDocumentId.value;

  let buffer: Buffer;
  try {
    buffer = await readFile(path);
  } catch (err) {
    return textResult({
      error: `outline_attachment_upload failed to read local file: ${errorMessage(err)}`,
    });
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
    return textResult({
      error: `attachments.create (step 1) failed: ${errorMessage(err)}`,
    });
  }

  const { uploadUrl, form, attachment } = step1?.data ?? {};
  if (typeof uploadUrl !== "string" || !form || typeof form !== "object") {
    return textResult({
      error:
        "attachments.create did not return uploadUrl/form — outline API contract changed?",
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
  // same order they were issued. Object.entries preserves insertion
  // order so the loop below emits them in the order outline returned.
  // S3 will 403 with `SignatureDoesNotMatch` if the policy hash fails,
  // and the error from `fetch` is bubbled verbatim in the catch below.
  try {
    const fd = new FormData();
    for (const [k, v] of Object.entries(form)) {
      if (typeof v === "string") fd.append(k, v);
    }
    // Wrap the Node Buffer in a Uint8Array so the TypeScript types align
    // with the DOM `BlobPart` (Buffer<ArrayBufferLike> vs Uint8Array<ArrayBuffer>).
    // Runtime is unaffected — both point to the same underlying bytes.
    fd.append(
      "file",
      new Blob([new Uint8Array(buffer)], { type: contentType }),
      args.name,
    );
    const res = await fetch(uploadUrl, { method: "POST", body: fd });
    if (!res.ok) {
      const text = await res.text();
      const snippet = text.length > 500 ? `${text.slice(0, 500)}…` : text;
      throw new Error(
        `S3 PUT failed: HTTP ${res.status} ${res.statusText}: ${snippet}`,
      );
    }
  } catch (err) {
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

function isLegacyFilesCreateUploadUrl(uploadUrl: string): boolean {
  if (uploadUrl.startsWith("/api/files.create")) return true;
  try {
    return new URL(uploadUrl).pathname === "/api/files.create";
  } catch {
    return false;
  }
}

async function collectionList(
  args: Record<string, unknown>,
  cfg: OutlineWikiConfig,
) {
  const guard = requireConfig(cfg);
  if (guard) return guard;

  // CP-3752: pagination accepts a number or a numeric string; values
  // above the Outline API maximum are clamped (never rejected).
  const limit = normalizeLimit(args.limit, {
    label: "limit",
    fallback: 25,
    max: OUTLINE_MAX_LIMIT,
  });
  if (!limit.ok) return textResult({ error: limit.error });
  const offset = normalizeOffset(args.offset, {
    label: "offset",
    fallback: 0,
  });
  if (!offset.ok) return textResult({ error: offset.error });

  const body: Record<string, unknown> = {
    limit: limit.value,
    offset: offset.value,
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
  } catch (err) {
    return textResult({ error: `collections.list failed: ${errorMessage(err)}` });
  }
}

async function collectionDocuments(
  args: Record<string, unknown>,
  cfg: OutlineWikiConfig,
) {
  const guard = requireConfig(cfg);
  if (guard) return guard;
  // CP-3752: `id` accepts a string or an integer and is trimmed.
  const id = normalizeId(args.id, "id");
  if (!id.ok) {
    return textResult({
      error:
        "outline_collection_documents requires a non-empty `id` (string or integer) argument (collection id, e.g. WTO = 2539c4a2-1fa8-4f0e-900f-9a5c7f1f72ba). " +
        id.error,
    });
  }

  // CP-2559: includeArchived defaults to false. The endpoint returns a
  // NavigationNode tree (server-side `Document.toNavigationNode` defaults
  // to `includeArchived: false`), and the response shape does NOT carry
  // `archivedAt` for us to filter on — so the server-side default already
  // handles exclusion. We accept the flag for API symmetry with
  // `outline_search_query` / `outline_doc_list`, but it currently has no
  // effect (documented in the tool description).
  const includeArchived = pickBoolean(args.includeArchived, false);

  // CP-3752: pagination accepts a number or a numeric string; values
  // above the Outline API maximum are clamped (never rejected).
  const limit = normalizeLimit(args.limit, {
    label: "limit",
    fallback: 25,
    max: OUTLINE_MAX_LIMIT,
  });
  if (!limit.ok) return textResult({ error: limit.error });
  const offset = normalizeOffset(args.offset, {
    label: "offset",
    fallback: 0,
  });
  if (!offset.ok) return textResult({ error: offset.error });

  const body: Record<string, unknown> = {
    id: id.value,
    limit: limit.value,
    offset: offset.value,
  };

  try {
    const data = await outlineFetch(cfg, "collections.documents", body);
    return textResult({
      ok: true,
      method: "collections.documents",
      request: { ...body, includeArchived },
      documents: data?.data ?? [],
      pagination: data?.pagination ?? null,
    });
  } catch (err) {
    return textResult({ error: `collections.documents failed: ${errorMessage(err)}` });
  }
}

async function collectionCreate(
  args: Record<string, unknown>,
  cfg: OutlineWikiConfig,
) {
  const guard = requireConfig(cfg);
  if (guard) return guard;
  if (typeof args.name !== "string" || args.name.length === 0) {
    return textResult({
      error:
        "outline_collection_create requires a non-empty `name` (string) argument.",
    });
  }

  // Build the request body. `permission` defaults to "read_write" rather than
  // letting outline's REST endpoint default to `null` (admin-only). The
  // TypeBox schema also declares `default: "read_write"` so OpenClaw-level
  // validation fills it in, but we re-default defensively here in case the
  // schema is bypassed (e.g. via the CLI).
  const body: Record<string, unknown> = { name: args.name };
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
  } else {
    body.permission = "read_write";
  }
  if (typeof args.sharing === "boolean") {
    body.sharing = args.sharing;
  } else {
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
  } catch (err) {
    return textResult({ error: `collections.create failed: ${errorMessage(err)}` });
  }
}

async function collectionUpdate(
  args: Record<string, unknown>,
  cfg: OutlineWikiConfig,
) {
  const guard = requireConfig(cfg);
  if (guard) return guard;
  // CP-3752: `id` accepts a string or an integer and is trimmed.
  const id = normalizeId(args.id, "id");
  if (!id.ok) {
    return textResult({
      error:
        "outline_collection_update requires a non-empty `id` (string or integer) argument (collection UUID). " +
        id.error,
    });
  }

  // At least one mutable field must be present; otherwise the call is a
  // no-op and we want to fail loudly.
  const mutable: Array<keyof typeof args> = [
    "name",
    "description",
    "icon",
    "color",
    "permission",
    "sharing",
  ];
  const hasAny = mutable.some(
    (k) => typeof (args as Record<string, unknown>)[k] !== "undefined",
  );
  if (!hasAny) {
    return textResult({
      error:
        "outline_collection_update requires at least one of `name`, `description`, `icon`, `color`, `permission`, `sharing`.",
    });
  }

  const body: Record<string, unknown> = { id: id.value };
  for (const k of mutable) {
    const v = (args as Record<string, unknown>)[k];
    if (typeof v !== "undefined") body[k] = v;
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
  } catch (err) {
    return textResult({ error: `collections.update failed: ${errorMessage(err)}` });
  }
}

async function revLog(
  args: Record<string, unknown>,
  cfg: OutlineWikiConfig,
) {
  const guard = requireConfig(cfg);
  if (guard) return guard;
  // CP-3752: `documentId` accepts a string or an integer and is trimmed.
  const documentId = normalizeId(args.documentId, "documentId");
  if (!documentId.ok) {
    return textResult({
      error:
        "outline_rev_log requires a non-empty `documentId` (string or integer) argument. " +
        documentId.error,
    });
  }
  // Clamp limit into [1, 20] with a default of 5. The TypeBox schema already
  // declares maximum: 20, so OpenClaw should refuse larger values before we
  // get here — but clamp defensively in case the schema is loosened later.
  //
  // CP-3752: `limit` also accepts a numeric string; values above 20 are
  // clamped to 20 (never rejected).
  const normalizedLimit = normalizeLimit(args.limit, {
    label: "limit",
    fallback: 5,
    max: REV_LOG_MAX_LIMIT,
  });
  if (!normalizedLimit.ok) return textResult({ error: normalizedLimit.error });
  const limit = normalizedLimit.value;

  const body: Record<string, unknown> = {
    documentId: documentId.value,
    limit,
  };

  try {
    const data = await outlineFetch(cfg, "revisions.list", body);
    const rawRevisions: unknown[] = Array.isArray(data?.data)
      ? data.data
      : [];
    // Strip heavy revision fields (`text`, `data`, `collaborators`, `color`,
    // `deletedAt`, etc.) and return only the metadata useful for a changelog
    // view: id, name (i.e. the human-readable changelog if any), createdAt,
    // and the author's display name. This keeps the response cheap to
    // serialize even on documents with hundreds of revisions.
    const revisions = rawRevisions.map((r) => {
      const rev = r as Record<string, unknown>;
      const createdBy = rev.createdBy as Record<string, unknown> | undefined;
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
  } catch (err) {
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
async function writeChangelog(
  documentId: string,
  changelog: string,
  cfg: OutlineWikiConfig,
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

/**
 * Read the current markdown body of a document (CP-3689).
 *
 * Used by the patch guardrail: before a patch we need the body the anchor
 * must match against, and after a patch we need it again to verify what the
 * server actually stored. Throws on any failure — the callers decide
 * whether to fail closed (preflight) or degrade to a warning (verification).
 */
async function fetchDocText(
  cfg: OutlineWikiConfig,
  id: string,
): Promise<string> {
  const info = await outlineFetch(cfg, "documents.info", { id });
  const text = info?.data?.text;
  if (typeof text !== "string") {
    throw new Error("documents.info returned no text for the document");
  }
  return text;
}

/**
 * POST a JSON envelope to the Outline REST API. Throws on non-2xx with the
 * response body included (truncated) so the agent sees a useful error.
 */
async function outlineFetch(
  cfg: OutlineWikiConfig,
  path: string,
  body: unknown,
): Promise<any> {
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
  } catch {
    throw new Error(
      `Response was not JSON (HTTP ${res.status}): ${text.slice(0, 200)}`,
    );
  }
}

function requireConfig(cfg: OutlineWikiConfig) {
  if (!cfg.apiToken || !cfg.endpoint) {
    return textResult({
      error:
        "Outline Wiki plugin is not configured. Set `apiToken` (Bearer) and `endpoint` (e.g. https://your-outline.example.com/api) under `plugins.entries.outline-wiki-openclaw-plugin.config` in openclaw.json.",
    });
  }
  return null;
}

function pickBoolean(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function textResult(data: unknown): {
  content: { type: "text"; text: string }[];
  details: unknown;
} {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return {
    content: [{ type: "text", text }],
    details: data,
  };
}

// ===== CP-2379 response-trim helpers =====
//
// outline's REST responses frequently include the full markdown body in a
// `text` field (`documents.list`, `documents.info`, `documents.search`,
// `documents.create`, `documents.update`). For search/list/create/update
// those bodies dominate the toolResult payload — at one planning workload,
// a single `outline_search_query` (limit=3) returned ~50k chars because
// every hit carried a 10k+ char body. We trim those bodies uniformly here
// so the MCP and CLI callers share the same shape. The agent must call
// `outline_doc_get` explicitly to fetch a body — that call is intentionally
// left untouched (single-shot metadata + body, no second `documents.export`
// round-trip) because fetching a body is the legitimate use case.
//
// Both helpers are pure / side-effect-free; tests can call them directly.

// Navigation metadata kept on a trimmed document. Conservative: id +
// title + url + urlId + collectionId + updatedAt + archivedAt cover
// every follow-up call the agent would want to make (`outline_doc_get
// {id}`, `outline_doc_update {id, ...}`, `outline_doc_move {id, ...}`,
// plus opening the wiki URL). `text` is the only thing stripped.
// `archivedAt` is included so callers can see archive state (null when
// live) — CP-2559 added this so `outline_doc_list` / `outline_search_query`
// responses surface the same archive signal the server holds.
const TRIMMED_DOC_FIELDS = [
  "id",
  "title",
  "url",
  "urlId",
  "collectionId",
  "updatedAt",
  "archivedAt",
] as const;

function trimDocBody(doc: unknown): Record<string, unknown> | null {
  if (!doc || typeof doc !== "object") return null;
  const out: Record<string, unknown> = {};
  for (const key of TRIMMED_DOC_FIELDS) {
    const v = (doc as Record<string, unknown>)[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

// ===== CP-2395 request-echo trim helpers =====
//
// CP-2379 trimmed the SERVER response (dropping `document.text`), but the
// response's `request` field was still echoing the agent's INPUT body —
// which contains the full markdown body the agent just sent via `text`.
// Round-tripping that defeats the whole point of CP-2379 (planner token
// burn from toolResult echoing the agent's own input back at it).
//
// These helpers strip `text` (and the rest of the heavy fields —
// `collectionId`, `parentDocumentId`, `publish`, `editMode`, `findText`,
// `lastRevision`, `done`, `editorVersion`, `templateId`, `fullWidth`,
// `preferences`, `insightsEnabled`, `deprecatedReason`, `append` legacy
// flag) so the response only carries the nav-level fields. Kept deliberately tiny:
// {title} for create (the agent already knows the title it sent), and
// {id, title} for update (id is required to address the doc, title only
// when the caller actually changed it). `summary` below already exposes
// the same nav metadata post-write, so `request` is just a debugging
// breadcrumb — keeping it tiny is fine.

function trimCreateRequest(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object") return {};
  const b = body as Record<string, unknown>;
  return {
    title: b.title,
  };
}

function trimUpdateRequest(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object") return {};
  const b = body as Record<string, unknown>;
  const out: Record<string, unknown> = { id: b.id };
  if (typeof b.title === "string") out.title = b.title;
  return out;
}

function trimSearchHit(hit: unknown): Record<string, unknown> | null {
  if (!hit || typeof hit !== "object") return null;
  const h = hit as Record<string, unknown>;
  // search hit shape: {ranking, context, document: {...full doc w/ text...}}
  // Keep `ranking` + `context` (snippet, sibling of `document`) and the
  // trimmed inner document (same nav set as doc_list). `text` and all
  // other heavy inner fields (`createdBy`, `updatedBy`, `tasks`,
  // `collaboratorIds`, etc.) are dropped — the agent can `outline_doc_get`
  // to fetch anything it needs beyond the nav fields.
  return {
    ranking: h.ranking,
    context: h.context,
    document: trimDocBody(h.document),
  };
}
