# Changelog

All notable changes to `@cereb/outline-wiki-openclaw-plugin` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.1] - 2026-07-18

### Fixed
- `outline_doc_create` now treats `documents.create` responses without a non-empty `data.id` as an error instead of returning `ok:true`, and verifies the created document with `documents.info` before reporting success.

### Changed
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

[Unreleased]: https://github.com/Cereb-ai/openclaw-outline-wiki-plugin/compare/v0.5.1...HEAD
[0.5.1]: https://github.com/Cereb-ai/openclaw-outline-wiki-plugin/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Cereb-ai/openclaw-outline-wiki-plugin/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Cereb-ai/openclaw-outline-wiki-plugin/releases/tag/v0.4.0
