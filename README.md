# @cereb/outline-wiki-openclaw-plugin

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.5.1-blue.svg)](package.json)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-%3E%3D2026.5.17-purple.svg)](https://docs.openclaw.ai)

OpenClaw native plugin for Outline Wiki knowledge bases — exposes **15 named tools** (one per Outline REST method), each invocable directly from an OpenClaw agent or the bundled `outline-tool` CLI. Replaces the legacy single-dispatcher pattern with one named tool per Outline REST method.

## Features

- **15 named tools** covering documents, search, collections, attachments, and revision history.
- **Two invocation paths** — call as an OpenClaw named tool, or use the bundled `outline-tool` CLI from OpenCode, a terminal, or CI.
- **CLI ↔ MCP aligned behavior** — every method's parameters, defaults, fallbacks, and verify behavior are consistent between the OpenClaw tool and the CLI (e.g. `outline_search_query.limit` defaults to `25`, `outline_doc_create.collectionId` falls back to `defaultCollectionId` config, post-create verify via `documents.info`). See `skills/outline-wiki/SKILL.md` for the behavior table.
- **Document hierarchy** — `outline_doc_create` and `outline_doc_move` accept an optional `parentDocumentId` to nest a document under a parent in the same call.
- **Fail-fast on missing config** — clear error messages, never silent fallback.
- **Single round-trip** — `outline_doc_get` already returns the full markdown body in `data.text`; no second `documents.export` call needed.

## Tools

| tool | purpose | required args |
|---|---|---|
| `outline_doc_list` | list documents (metadata only — `text` stripped, see Response-trim contract below) | — |
| `outline_doc_get` | single document + full markdown body | `id` |
| `outline_doc_create` | create document (publish=true default; accepts `parentDocumentId`); `collectionId` falls back to `defaultCollectionId` config; verifies result via `documents.info`; **response trims `document.text`** (CP-2379 — round-trip trim) | `title`, `text`, `collectionId` (or `defaultCollectionId` config) |
| `outline_doc_update` | update text / title (`editMode="replace"` default); supports `publish`, `changelog` (best-effort revision-name write), `strictChangelog`; **rejects `parentDocumentId`** (use `outline_doc_move` to reparent); **response trims `document.text`** (CP-2379 — round-trip trim) | `id` + (`text` or `title`) |
| `outline_doc_delete` | trash (default) or hard-delete (`permanent: true`, requires already-trashed) | `id` |
| `outline_doc_archive` | move to archive (admin-readable, recoverable) | `id` |
| `outline_doc_restore` | restore from archive | `id` |
| `outline_doc_move` | move to a different collection (accepts `parentDocumentId` to reparent in the same call) | `id`, `collectionId` |
| `outline_search_query` | full-text search (limit default `25`, not `10`); **per-hit `document.text` stripped** (CP-2379) — keep ranking/context + nav metadata | `query` |
| `outline_collection_list` | list all collections | — |
| `outline_collection_documents` | list documents in a collection (includes children structure) | `id` (collection id) |
| `outline_collection_create` | create collection (default `permission="read_write"`, `sharing=true`) | `name` |
| `outline_collection_update` | update collection fields | `id` + (`name` / `description` / `icon` / `color` / `permission` / `sharing` 至少一项) |
| `outline_attachment_upload` | upload via S3 presigned POST (`url` or `path` mode) | `name` + (`url` or `path`) |
| `outline_rev_log` | revision metadata (name / timestamp / author) for a document | `documentId` |

Per-tool argument schemas, the OpenClaw agent skill, and the 避坑清单 live in [`skills/outline-wiki/SKILL.md`](skills/outline-wiki/SKILL.md).

## Response-trim contract (CP-2379)

Four high-frequency handlers strip the full markdown body (`text`) from their toolResult payload to keep the planner token spend in check (toolResult accounts for 77-86% of per-task token cost on cereb-pilot — see CP-2378):

- `outline_search_query` — per-hit `document.text` is stripped; keep `ranking` + `context` (already a snippet) + inner-document nav metadata (`id` / `title` / `url` / `urlId` / `collectionId` / `updatedAt`).
- `outline_doc_list` — `text` is stripped from every doc; nav metadata preserved.
- `outline_doc_create` / `outline_doc_update` — round-trip trim: the agent just sent the body via `text`, so it does NOT come back in `document.text`. Trimmed `document` (nav metadata) + the convenience `summary` (`id` / `title` / `url` / `urlId` / `revision` / `publishedAt` or `updatedAt`) are returned instead.
- `outline_doc_get` is intentionally NOT trimmed — that's the canonical "fetch the body" call.

The CLI (`outline-tool`) shares the same trim helpers (`trimDocBody` / `trimSearchHit` in `src/cli.ts`), so MCP and CLI byte-for-byte parity on response shape is preserved (`tests/cli-vs-mcp-parity.test.ts` + `tests/response-trim.test.ts` enforce this).

Regression tests: `tests/response-trim.test.ts` — 14 cases asserting no `text` round-trips, MCP ↔ CLI parity on every trimmed handler.

## Installation

### From local source (development)

```bash
git clone https://github.com/Cereb-ai/openclaw-outline-wiki-plugin.git
cd openclaw-outline-wiki-plugin
npm install
npm run build
npm pack
openclaw plugins install "npm-pack:./$(ls cereb-outline-wiki-openclaw-plugin-*.tgz | head -1)" --force
systemctl --user restart openclaw-gateway.service   # required to load the new plugin
```

### From npm (once published)

```bash
npm install -g @cereb/outline-wiki-openclaw-plugin
openclaw plugins install "@cereb/outline-wiki-openclaw-plugin"
systemctl --user restart openclaw-gateway.service
```

## Configuration

The plugin reads config in this order (highest priority first):

1. `plugins.entries.outline-wiki-openclaw-plugin.config` in `~/.openclaw/openclaw.json`
2. Environment variables (`OUTLINE_API_TOKEN` / `OUTLINE_TOKEN`, `OUTLINE_ENDPOINT`, `OUTLINE_MCP_ENDPOINT`)

### `~/.openclaw/openclaw.json`

```json
{
  "plugins": {
    "entries": {
      "outline-wiki-openclaw-plugin": {
        "enabled": true,
        "config": {
          "apiToken": "<Outline API bearer token>",
          "endpoint": "https://your-outline.example.com/api",
          "mcpEndpoint": "https://your-outline.example.com/mcp",
          "defaultCollectionId": "<optional UUID, used when outline_doc_create omits collectionId>"
        }
      }
    }
  }
}
```

### Environment variables

| variable | required | default | description |
|---|---|---|---|
| `OUTLINE_API_TOKEN` (or `OUTLINE_TOKEN`) | ✅ | — | Outline API bearer token |
| `OUTLINE_ENDPOINT` | ✅ | — | Outline API base URL, e.g. `https://your-outline.example.com/api` |
| `OUTLINE_MCP_ENDPOINT` | ❌ | same host as `OUTLINE_ENDPOINT` | MCP endpoint for S3 pre-signed attachment uploads |

Any missing required variable → fail-fast at startup with an actionable error pointing at the missing field.

## Usage

**OpenClaw native tool** (default for agents):

```json
outline_doc_list { limit: 5 }
outline_search_query { query: "redis sentinel", limit: 10 }
outline_doc_get { id: "<doc-uuid>" }
outline_doc_create { title: "...", text: "...", collectionId: "<uuid>", publish: true }
outline_doc_update { id: "<doc-uuid>", text: "...", editMode: "replace" }
outline_doc_move { id: "<doc-uuid>", collectionId: "<target-uuid>", parentDocumentId: "<parent-uuid>" }
outline_attachment_upload { name: "x.png", url: "<public-url>", documentId: "<doc-uuid>", preset: "documentAttachment" }
```

**Standalone CLI** `outline-tool` (for OpenCode, terminal, CI):

The CLI accepts the same method names as the MCP tools (`outline_*` long names or short `category.method`), the same parameters, the same defaults, the same fallbacks, and the same verify behavior. **Same args, same wire body, same response** — see "CLI ↔ MCP behavior" below.

```bash
# MCP names (preferred — match OpenClaw tool names verbatim)
outline-tool outline_doc_list '{"limit":2}'
outline-tool outline_doc_get '{"id":"..."}'
outline-tool outline_search_query '{"query":"redis sentinel"}'
outline-tool outline_doc_create '{"title":"...","text":"...","collectionId":"..."}'
outline-tool outline_doc_update '{"id":"...","text":"...","editMode":"replace","changelog":"..."}'
outline-tool outline_collection_create '{"name":"..."}'
outline-tool outline_collection_update '{"id":"...","permission":"read_write"}'
outline-tool outline_rev_log '{"documentId":"...","limit":5}'
outline-tool outline_attachment_upload '{"name":"x.png","url":"https://...","documentId":"...","preset":"documentAttachment"}'

# Short names (backward compat) — same args
outline-tool doc.list '{"limit":2}'
outline-tool doc.get '{"id":"..."}'
outline-tool search.query '{"query":"redis sentinel"}'
outline-tool attachment.upload '{"name":"x.png","url":"https://...","documentId":"...","preset":"documentAttachment"}'
```

Exit codes: `0` = success, `2` = JSON parse error, `3` = dispatch error, `4` = shape error, `5` = business error.

### CLI ↔ MCP behavior

For your awareness as a caller: the OpenClaw named tool and the `outline-tool` CLI share the same handler code, so the following behaviors are aligned between the two paths:

- `outline_doc_create.collectionId` resolves as `args.collectionId > cfg.defaultCollectionId`; both missing → explicit error (no silent drop).
- `outline_doc_create` verifies the result via `documents.info` (`data.id` non-empty); verify failure → error.
- `outline_doc_update` accepts `editMode` (default `"replace"`), `publish`, `changelog` (best-effort revision-name write), `strictChangelog` (when `true`, changelog write failure hard-fails the response).
- `outline_search_query.limit` defaults to **25** (not 10) via `pickNumber(args.limit, 25)`.

If you notice drift between the two paths in practice, please file an issue — the development side will harden `tests/cli-vs-mcp-parity.test.ts` and fix the drift. See `skills/outline-wiki/SKILL.md` for the full behavior table.

## Development

```bash
npm install
npm run typecheck        # tsc --noEmit
npm run build            # tsc -p tsconfig.json
npm test                 # vitest run
```

Validate the plugin manifest after `src/index.ts` changes:

```bash
npx openclaw plugins build --entry ./dist/index.js
npx openclaw plugins validate --entry ./dist/index.js
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for code structure, how to add a new tool, and PR guidelines.

## Build artifacts contract

`dist/` is a **local build artifact**, not source — it must never be committed.

- **`dist/` is gitignored** — see `.gitignore` line `dist/`. Commits since `70b9a9e` (open-source release prep) do not track it; PRs should not reintroduce it.
- **`src/` is the single source of truth** — every change that affects runtime behavior starts in `src/*.ts`. The compiler (`tsc -p tsconfig.json`) produces `dist/` deterministically from `src/`.
- **PRs and commits contain `src/` only** — never `dist/`. If `git status` shows `dist/` entries after `npm run build`, something is wrong with `.gitignore` (do not `git add` them).
- **Release flow** — every release that ships to a running gateway must:
  1. `npm run build` — produce `dist/` from the merged `src/`.
  2. Sync the artifact copy to `/opt/openclaw-plugins` (deployment-side operation; see ops ticket — *not* part of this repo).
  3. `systemctl --user restart openclaw-gateway.service` — the gateway only picks up new code after restart.

If you need to reset your local `dist/`, run `npm run clean` (alias for `rm -rf dist`); the next `npm run build` will regenerate it.

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, testing, and PR workflow.

## License

[MIT](LICENSE) © 2026 Leo Wang / Cereb

## Links

- **Repository**: https://github.com/Cereb-ai/openclaw-outline-wiki-plugin
- **Issues**: https://github.com/Cereb-ai/openclaw-outline-wiki-plugin/issues
- **OpenClaw docs**: https://docs.openclaw.ai