# Contributing

Thanks for your interest in contributing to `@cereb/outline-wiki-openclaw-plugin`!

## Prerequisites

- **Node.js** ≥ 18 (uses native `fetch`, `FormData`, and ESM)
- **OpenClaw** runtime installed (`openclaw` CLI available, gateway running under systemd)
- **Outline Wiki** instance with an API token (for live testing)

## Development setup

```bash
# 1. Clone
git clone https://github.com/Cereb-ai/openclaw-outline-wiki-plugin.git
cd openclaw-outline-wiki-plugin

# 2. Install dependencies (peer dep `openclaw` is dev-installed automatically)
npm install

# 3. Typecheck and build
npm run typecheck
npm run build

# 4. Run tests
npm test
```

## Build artifacts contract

`dist/` is a **local build artifact**, not source. Keep it out of every commit and PR.

- **`dist/` is gitignored** — see `.gitignore` (`dist/` line). It has not been tracked since commit `70b9a9e` (open-source release prep).
- **`src/` is the single source of truth** — change `src/*.ts`; the compiler produces `dist/` deterministically.
- **Commits and PRs contain `src/` only** — never `dist/`. If `git status` shows `dist/` entries after a build, do **not** `git add` them; fix `.gitignore` instead.
- **Clean a stale `dist/`** with `npm run clean` (`rm -rf dist`); the next `npm run build` regenerates it.
- **Release flow** — every release that ships to a running gateway must:
  1. `npm run build` — produce `dist/` from the merged `src/`.
  2. Sync the artifact copy to `/opt/openclaw-plugins` (deployment-side operation handled by ops, not this repo).
  3. `systemctl --user restart openclaw-gateway.service` — gateway picks up new code on reload.

If `git status` ever shows `dist/` entries, treat it as a contract violation: investigate, fix `.gitignore`, and do not commit the artifacts.

## Code structure

- `src/index.ts` — plugin manifest + tool definitions (`defineToolPlugin`) + all handlers in one file
- `src/cli.ts` — standalone `outline-tool` CLI binary
- `skills/outline-wiki/SKILL.md` — OpenClaw agent skill (YAML frontmatter + markdown); loaded automatically when the plugin is installed
- `openclaw.plugin.json` — plugin manifest read by OpenClaw at startup
- `tools/quick-test.js` — historical smoke-test CLI for individual tool calls

## Adding a new tool

1. Add a tool definition in `src/index.ts`:
   ```ts
   tool({
     name: "outline_<category>_<method>",
     label: "Outline <Category> <Method>",
     description: "...",
     parameters: Type.Object({...}),
     async execute(args, cfg) {
       return await <category><Method>(args, cfg as OutlineWikiConfig);
     },
   }),
   ```
2. Add the corresponding handler:
   ```ts
   async function <category><Method>(args, cfg) {
     const guard = requireConfig(cfg);
     if (guard) return guard;
     // ...
   }
   ```
3. Add `"outline_<category>_<method>"` to `contracts.tools` in `openclaw.plugin.json`.
4. Regenerate the manifest:
   ```bash
   npm run build
   npx openclaw plugins build --entry ./dist/index.js
   npx openclaw plugins validate --entry ./dist/index.js
   ```
5. Add a vitest test (where applicable).
6. Document the tool in `skills/outline-wiki/SKILL.md` (description + 必填参数 + 常用选填 + any 避坑 entry).

## Testing

- **Unit tests** — `npm test` (vitest, runs all `*.test.ts` files)
- **Smoke tests** — invoke a single tool from `node tools/quick-test.js outline_<category>_<method> '<args-json>'`
- **Live e2e** — call the tool from an agent harness against your Outline instance

## Code style

- **TypeScript strict mode** (already enabled in `tsconfig.json`).
- **TypeBox schemas** for tool parameters (declared inline in the tool block).
- **No silent fallbacks** — missing config must `throw` or return a clear `error` text result.
- **Fail-fast with actionable error messages** — point the caller at the missing field and how to set it (env var or `openclaw.json` override).
- **Mask tokens in logs / errors** — never print raw `apiToken` values to chat, logs, or commit messages.

## Submitting a pull request

1. Fork and create a feature branch: `git checkout -b feat/<short-description>`
2. Make focused commits with descriptive messages. **Do not commit `dist/`** — see "Build artifacts contract" above.
3. Ensure `npm run typecheck`, `npm run build`, and `npm test` all pass.
4. Push and open a PR against `master` on the upstream repo.
5. Describe the change in the PR body: what, why, how to test.

## Reporting issues

Open an issue at https://github.com/Cereb-ai/openclaw-outline-wiki-plugin/issues with:

- OpenClaw version (`openclaw --version`)
- Plugin version (`cat package.json | grep version`)
- Minimal reproduction (the tool call + the error response)
- Relevant logs (mask any tokens!)

## Security

For vulnerabilities, please **do not** open a public issue. Email `wanglingsong@gmail.com` with subject `SECURITY: outline-wiki-openclaw-plugin` instead.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).