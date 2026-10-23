# Changelog

All notable changes to `@cereb/outline-wiki-openclaw-plugin` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.3] - 2026-10-23

### Added
- `outline_doc_update` gained a **patch guardrail** for `editMode=patch` (CP-3689). The plugin now reads the current document body before the update and requires `findText` to match **exactly once** (literal, non-fuzzy match). 0 matches or >1 matches fail with an explicit error and **no `documents.update` request is sent**. After a successful update the plugin reads the body back and compares the replaced region with the submitted text; a mismatch is reported in `warnings[]` plus a new `patchVerification` payload (`verified` / `exact` / `normalized` / `skipped` / `storedRegion`).
- New shared module `src/patch-guard.ts` — the guardrail logic, used by both the OpenClaw tool (`src/index.ts`) and the CLI (`src/cli.ts`) so the two paths cannot drift.

### Fixed
- A patch whose anchor occurs more than once no longer silently edits the **first** occurrence (the Outline server replaces only the first match) — the call now fails before any write happens.
- A patch whose replacement text the Outline server rewrites (e.g. a code span nested inside bold: submitted `` **`code`** `` is stored as `` `**code**` ``) no longer returns a bare `ok: true`. The write still succeeds server-side, but the response now carries an explicit warning and `patchVerification.verified: false` with the region the server actually stored, so the caller knows the anchor is stale and that the change can no longer be undone with another patch.

### Changed
- `skills/outline-wiki/SKILL.md` — new pitfall entries: “patch 避免粗体与 code span 混排” (with a copy-paste-safe replacement form and a table of the markdown constructs the server rewrites) and “`editMode=patch` 护栏 (v0.5.3+)” (preflight three-state + read-back semantics). The CLI ↔ MCP behaviour table gained two rows for the guardrail.
- `outline_doc_update` tool description documents the guardrail and the markdown-rewrite hazard.
- The guardrail applies to `editMode=patch` only. `replace` / `append` / `prepend` semantics are unchanged, and a patch now costs two extra reads (`documents.info` before and after the write).

### Notes
- Root cause is **server-side**, not plugin-side: the Outline server round-trips the submitted markdown through its own serializer (not the identity for some constructs) and replaces only the first `findText` match. Verified against the dev wiki on 2026-10-23 — `documents.create`, `documents.update` (`replace`) and `documents.update` (`patch`) all corrupt the same input the same way. The plugin cannot fix the stored bytes; it can only refuse to write when the anchor is unsafe and to report when the server changed the submitted text.

## [0.5.2] - 2026-09-19

### Added
- `outline_doc_update` now supports `editMode=patch` and passes `findText` through to `documents.update` as the anchor text. When `findText` is supplied, the plugin no longer appends it to `text` and returns the matched occurrences in the response, so callers can scope in-place edits without re-sending the whole document body.

### Changed
- Tool description, `skills/outline-wiki/SKILL.md`, and `README.md` now document all four `editMode` values (`replace` / `append` / `prepend` / `patch`) including when to use `findText` as the patch anchor.

## [0.5.1] - 2026-07-18

### Fixed
- `outline_doc_create` now treats `documents.create` responses without a non-empty `data.id` as an error instead of returning `ok:true`, and verifies the created document with `documents.info` before reporting success.
- `outline_doc_update` now rejects any provided `parentDocumentId` at the handler before calling `documents.update`; use `outline_doc_move` for reparent.
- `outline_attachment_upload` path mode now aborts on legacy `files.create` upload URLs before any S3 upload attempt and points callers to `url` mode.

### Changed
- `outline_doc_update` now accepts optional `strictChangelog`; default/false preserves best-effort changelog warnings, while true hard-fails the response if the changelog write fails.
- A3 investigation: source confirms `outline_doc_get` calls `documents.info`. On 2026-07-18, a temporary 8,279-byte long document returned equal text via plugin path and raw REST `documents.info` (8,159 bytes each), so no `documents.export.md` fallback was added.
- Open-source release: added `LICENSE` (MIT), `CONTRIBUTING.md`, `CHANGELOG.md`. Updated `package.json` metadata (license, author, repository, bugs, homepage) and removed `private: true`. Replaced internal host placeholder (`wiki.dev.cereb.ai` → RFC 2606 example.com). Removed build artifacts from git tracking (`dist/` now gitignored; rebuilt on demand via `npm run build`).

## [0.5.0] - 2026-07-13

### Added
- New tool `outline_collection_create` (`collections.create` REST). Required: `name`. Optional: `description`, `icon`, `color`, `sharing` (bool, default `true`). New tool `outline_collection_update` (`collections.update` REST). Required: `id`. Optional: `name`, `description`, `icon`, `color`, `permission`, `sharing`. Both tools are also exposed via the standalone CLI as `outline-tool collection.create` / `outline-tool collection.update`.

### Changed
- `outline_collection_create` defaults `permission` to `"read_write"` (not `null`). Outline's REST endpoint returns `permission: null` when the field is omitted, which makes the resulting collection admin-only and is the root cause of "I created a collection but nobody can see it" incidents. The TypeBox schema declares `default: "read_write"` and the handler re-defaults defensively for the CLI path.

## [0.4.0] - 2026-06-28

### Changed
- **Breaking**: rewrote from `definePluginEntry` + single dispatcher tool `outline_wiki` (using `{category, method, args}` envelope) to `defineToolPlugin` + 12 independent named tools. Each tool's parameters are a flat TypeBox object of the method's args. OpenClaw's tool-discovery manifest reads static metadata without loading runtime code.
- `outline_doc_update` now rejects `parentDocumentId` at the schema layer (was fail-fast runtime check in 0.3.1; defense-in-depth in 0.4.0).

### Added
- `parentDocumentId` support on `outline_doc_create` and `outline_doc_move` — nest a document under a parent in the same call.
- `outline_doc_update` accepts an optional `changelog` string; after a successful update the plugin best-effort writes it into the latest revision's `name` field.

## [0.3.x] - 2026-06

### Changed
- `parentDocumentId` field added to `outline_doc_create` and `outline_doc_move`.

### Fixed
- 0.3.0 regression: `outline_doc_update` silently dropped `parentDocumentId` (outline server's `documents.update` schema does not include this field). 0.3.1 replaced the silent drop with a fail-fast error pointing at `outline_doc_move`.

## [0.2.x] - 2026-06

### Added
- Initial `definePluginEntry` + single-dispatcher tool shape (`outline_wiki call <category>.<method> '<args-json>'`).

## [0.1.0] - 2026-06

### Added
- Initial implementation: read-only methods (`documents.list`, `documents.info`, `collections.list`) over the legacy single-dispatcher shape.

[Unreleased]: https://github.com/Cereb-ai/openclaw-outline-wiki-plugin/compare/v0.5.2...HEAD
[0.5.2]: https://github.com/Cereb-ai/openclaw-outline-wiki-plugin/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/Cereb-ai/openclaw-outline-wiki-plugin/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Cereb-ai/openclaw-outline-wiki-plugin/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Cereb-ai/openclaw-outline-wiki-plugin/releases/tag/v0.4.0
