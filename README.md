# @cereb/outline-wiki-openclaw-plugin

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.4.0-blue.svg)](package.json)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-%3E%3D2026.5.17-purple.svg)](https://docs.openclaw.ai)

OpenClaw native plugin for Outline Wiki knowledge bases — exposes 13 named tools (one per Outline REST method), each invocable directly from an OpenClaw agent or the bundled `outline-tool` CLI. Replaces the legacy `mcporter + Outline MCP` channel with a single dispatcher-friendly tool surface.

## Features

- **13 named tools** covering documents, search, collections, attachments, and revision history.
- **Two invocation paths** — call as an OpenClaw named tool, or use the bundled `outline-tool` CLI from OpenCode, a terminal, or CI.
- **Document hierarchy** — `outline_doc_create` and `outline_doc_move` accept an optional `parentDocumentId` to nest a document under a parent in the same call.
- **Fail-fast on missing config** — clear error messages, never silent fallback.
- **Single round-trip** — `outline_doc_get` already returns the full markdown body in `data.text`; no second `documents.export` call needed.

## Tools

| tool | purpose | required args |
|---|---|---|
| `outline_doc_list` | list documents (returns text in payload) | — |
| `outline_doc_get` | single document + full markdown body | `id` |
| `outline_doc_create` | create document (publish=true default; accepts `parentDocumentId`) | `title`, `text`, `collectionId` (or `defaultCollectionId` config) |
| `outline_doc_update` | update text / title; rejects `parentDocumentId` (use `outline_doc_move` to reparent) | `id` + (`text` or `title`) |
| `outline_doc_delete` | trash (default) or hard-delete (`permanent: true`, requires already-trashed) | `id` |
| `outline_doc_archive` | move to archive (admin-readable, recoverable) | `id` |
| `outline_doc_restore` | restore from archive | `id` |
| `outline_doc_move` | move to a different collection (accepts `parentDocumentId` to reparent in the same call) | `id`, `collectionId` |
| `outline_search_query` | full-text search | `query` |
| `outline_collection_list` | list all collections | — |
| `outline_collection_documents` | list documents in a collection (includes children structure) | `id` (collection id) |
| `outline_attachment_upload` | upload via S3 presigned POST (`url` or `path` mode) | `name` + (`url` or `path`) |
| `outline_rev_log` | revision metadata (name / timestamp / author) for a document | `documentId` |

Per-tool argument schemas, the OpenClaw agent skill, and the 避坑清单 live in [`skills/outline-wiki/SKILL.md`](skills/outline-wiki/SKILL.md).

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

```bash
outline-tool doc.list '{"limit":2}'
outline-tool doc.get '{"id":"..."}'
outline-tool search.query '{"query":"redis sentinel"}'
outline-tool collection.list '{}'
outline-tool attachment.upload '{"name":"x.png","url":"https://...","preset":"documentAttachment"}'
```

Exit codes: `0` = success, `2` = JSON parse error, `3` = dispatch error, `4` = shape error, `5` = business error.

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

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, testing, and PR workflow.

## License

[MIT](LICENSE) © 2026 Leo Wang / Cereb

## Links

- **Repository**: https://github.com/Cereb-ai/openclaw-outline-wiki-plugin
- **Issues**: https://github.com/Cereb-ai/openclaw-outline-wiki-plugin/issues
- **OpenClaw docs**: https://docs.openclaw.ai