# Changelog

All notable changes to `@cereb/outline-wiki-openclaw-plugin` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Open-source release: added `LICENSE` (MIT), `CONTRIBUTING.md`, `CHANGELOG.md`. Updated `package.json` metadata (license, author, repository, bugs, homepage) and removed `private: true`. Replaced internal host placeholder (`wiki.dev.cereb.ai` → RFC 2606 example.com). Removed build artifacts from git tracking (`dist/` now gitignored; rebuilt on demand via `npm run build`).

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
- Initial implementation: read-only methods (`documents.list`, `documents.info`, `collections.list`) over the `mcporter` + Outline MCP channel.

[Unreleased]: https://github.com/Cereb-ai/openclaw-outline-wiki-plugin/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/Cereb-ai/openclaw-outline-wiki-plugin/releases/tag/v0.4.0