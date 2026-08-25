---
name: outline-wiki
description: OpenClaw outline-wiki 知识库原生插件. 提供两条调用路径:
  1) OpenClaw 原生 tools: 15 个独立 named tool (`outline_doc_*` / `outline_search_query` / `outline_collection_*` / `outline_attachment_upload` / `outline_rev_log`)
  2) 独立 CLI `outline-tool` (非 OpenClaw 原生 agent 如 codex / 任意 shell, 不依赖 OpenClaw, 方法名与 MCP 100% 对齐: `outline_*` 全名或短 category.method 均可用)
  15 个 method, 4 个 category: doc / search / collection / attachment. 当用户说"找 outline 上 XXX 文档"、"读一下 wiki 上的 XXX"、"在 outline 上写一篇 XXX"、"改一下 outline 上 XXX 文档"、"删一下 outline 上的 XXX"、"归档 XXX"、"在 outline 上传一张图片"、"看 outline 文档的修改记录"时触发.
metadata:
  {
    "openclaw": { "emoji": "📚" },
  }
---

# Outline Wiki Plugin Skill

> 本插件提供两条 Outline 调用路径:
>
> - **OpenClaw 原生路径 (路径 A)**: OpenClaw 原生 agent 调 15 个 named tool, 通过 `@cereb/outline-wiki-openclaw-plugin` 暴露.
> - **CLI 工具路径 (路径 B)**: 非 OpenClaw 原生 agent (codex 等, 无 MCP 工具暴露) / 终端 / CI 调 `outline-tool` 二进制 (不依赖 OpenClaw, 共享同一份 handler 代码).
>
> 两者功能完全相同, 走哪条取决于调用方上下文. 方法名 100% 对齐.

---

## 调用形态

### 1) OpenClaw 原生 named tools (路径 A, agent 默认)

每个 method 是一个独立的 named tool, 参数直接是 method 的 args (flat object). 15 个 tool 列表见下表.

**例**:
```
outline_doc_list { limit: 5 }
outline_search_query { query: "redis sentinel", limit: 10 }
outline_doc_get { id: "<doc-uuid>" }
outline_doc_create { title: "...", text: "...", collectionId: "<uuid>", publish: true }
outline_doc_update { id: "<doc-uuid>", text: "...", editMode: "replace" }
outline_doc_move { id: "<doc-uuid>", collectionId: "<target-uuid>", parentDocumentId: "<parent-uuid>" }
outline_attachment_upload { name: "x.png", url: "<public-url>", documentId: "<doc-uuid>", preset: "documentAttachment" }
outline_rev_log { documentId: "<doc-uuid>", limit: 5 }
```

### 2) CLI 二进制 (路径 B — 非 OpenClaw 原生 agent 如 codex / 终端 / CI)

**方法名与 MCP 100% 对齐**: `outline_*` 全名 (MCP 名) 或短 `category.method` 都接受, 参数与 MCP 工具完全一致:
```bash
outline-tool outline_doc_list '{"limit":2}'
outline-tool outline_doc_get '{"id":"..."}'
outline-tool outline_search_query '{"query":"redis sentinel"}'
outline-tool outline_rev_log '{"documentId":"...","limit":5}'
outline-tool outline_attachment_upload '{"name":"x.png","url":"https://...","preset":"documentAttachment"}'
# 短名同样可用 (向后兼容):
outline-tool doc.list '{"limit":2}'
outline-tool doc.get '{"id":"..."}'
outline-tool search.query '{"query":"redis sentinel"}'
outline-tool doc.rev_log '{"documentId":"...","limit":5}'
outline-tool attachment.upload '{"name":"x.png","url":"https://...","preset":"documentAttachment"}'
# --help 打印方法列表
outline-tool --help
```
退出码: `0`=ok, `2`=JSON 解析错, `3`=dispatch 错, `4`=shape 错, `5`=业务错误.

> ⚠️ 方法名必须用 MCP 名 (`outline_*`) 或短名 (`category.method`), 两者都能直接调用. CLI 只有 15 个方法, 与 MCP 工具一一对应.

---

## 15 个 named tool 速查

| Tool 名 | Outline method | 用途 | 必填参数 | 常用选填 |
|---|---|---|---|---|
| `outline_doc_list` | `documents.list` | 列文档 (含 text 字段) | — | `limit`, `offset`, `collectionId`, `query` |
| `outline_doc_get` | `documents.info` | 单文档 + metadata + markdown 正文 (单调用) | `id` | — |
| `outline_doc_create` | `documents.create` | 创建文档 (publish=true 默认) | `title`, `text`, `collectionId` (可走 cfg `defaultCollectionId`) | `publish`, `parentDocumentId` (挂到父文档下) |
| `outline_doc_update` | `documents.update` | 更新 text / title (`editMode=replace` 默认). **拒绝** `parentDocumentId` 入参 (server silent drop, use `outline_doc_move` to reparent) | `id` + (`text` / `title` 之一) | `editMode`, `publish`, `changelog` |
| `outline_doc_delete` | `documents.delete` | trash (default) / 硬删 (`permanent: true`) | `id` | `permanent` |
| `outline_doc_archive` | `documents.archive` | 归档 (admin 可读, 可 restore) | `id` | — |
| `outline_doc_restore` | `documents.restore` | 从 archive 恢复 | `id` | — |
| `outline_doc_move` | `documents.move` | 移到其他 collection (可同时 reparent) | `id`, `collectionId` | `parentDocumentId` (在 collection 内 reparent 到某个父文档) |
| `outline_search_query` | `documents.search` | 全文搜索文档 | `query` | `limit`, `offset`, `collectionId` |
| `outline_collection_list` | `collections.list` | 列所有 collection | — | `limit`, `offset` |
| `outline_collection_documents` | `collections.documents` | 列 collection 下文档 (含 children 结构) | `id` (collection id) | `limit`, `offset` |
| `outline_collection_create` | `collections.create` | 新建 collection (permission 默认 `read_write`, sharing 默认 true) | `name` | `description`, `icon`, `color`, `permission`, `sharing` |
| `outline_collection_update` | `collections.update` | 改 collection 字段 | `id` + (name/description/icon/color/permission/sharing 至少一项) | — |
| `outline_attachment_upload` | `attachments.create` / `attachments.createFromUrl` | URL 模式 (server-side fetch) / 本地文件模式 (S3 预签 POST) | `name` + (`url` 或 `path`) | `contentType`, `size`, `documentId`, `preset` |
| `outline_rev_log` | `revisions.list` | 文档修改记录 (name / timestamp / author, 不含正文) | `documentId` | `limit` (default 5, max 20) |

---

## 常见场景

### 场景 1: 找 + 读文档

```
1. outline_collection_list {limit:30}               # 先看有哪些 collection
2. outline_doc_list {collectionId: "...", query: "..."}  # 在指定 collection 搜
3. outline_doc_get {id: "..."}                       # 拿到完整 markdown 正文
```

### 场景 2: 写新文档

```
1. outline_collection_list {}                       # 找目标 collection 的 id
2. outline_doc_create {
     title: "...",
     text: "# ..." (注意: 正文从 ## 开始, 不写 # 标题行),
     collectionId: "...",
     publish: true                                  # 默认 true, 可省略
   }
```

### 场景 3: 修改已有文档

```
1. outline_doc_get {id: "..."}                      # 拿当前内容
2. (基于 text 改, ⚠️ 去掉首行 # 标题 - 见避坑 1)
3. outline_doc_update {
     id: "...",
     text: "...",
     editMode: "replace"                            # 默认值, 可省略
   }
```

### 场景 4: 批量浏览一个 collection 的文档树

```
1. outline_collection_list {limit:30}                          # 找 collection id
2. outline_collection_documents {id: "<collection-id>"}        # 列出该 collection 下所有文档
3. 拿到目标文档的 id 后, outline_doc_get 读正文
```

### 场景 5: 全文搜索文档

```
1. outline_search_query {query: "redis sentinel", limit: 10}  # 全文搜
2. 拿到 doc id 后 outline_doc_get 读正文
```

### 场景 6: 文档管理 (delete / archive / move)

```
1. outline_doc_delete {id: "<doc-id>"}                              # 软删 -> 30 天可恢复
2. outline_doc_delete {id: "<doc-id>", permanent: true}            # 硬删 (前提: 文档已在 trash)
3. outline_doc_archive {id: "<doc-id>"}                            # 归档 (admin 可读)
4. outline_doc_restore {id: "<doc-id>"}                            # 恢复
5. outline_doc_move {id: "<doc-id>", collectionId: "<target>"}     # 移到其他 collection
5b. outline_doc_move {id: "<doc-id>", collectionId: "<target>",    # 跨/同 collection reparent
                            parentDocumentId: "<parent-uuid>"}
```

⚠️ **不要用 `outline_doc_update` 改 `parentDocumentId`** — 0.3.1 fail-fast 会返错指向 `outline_doc_move`.

### 场景 7: 上传附件 (截图 / 图片)

**URL 模式 (推荐, 一行搞定)**: 适合公开可访问的图片.
```
outline_attachment_upload {
  name: "screenshot.png",
  url: "<公开可访问的图片 URL>",
  documentId: "<doc-id>",
  preset: "documentAttachment"
}
```

**本地文件模式 (S3 预签 POST)**: 适合本地文件, 需要 outline 是现代版 (走 S3 预签 POST).
```
outline_attachment_upload {
  name: "screenshot.png",
  path: "/abs/path/to/screenshot.png",
  contentType: "image/png",
  documentId: "<doc-id>",
  preset: "documentAttachment"
}
```

部分老版 outline 用的是 legacy `files.create` 端点 (cookie-only auth, 不认 Bearer token), 此时本地文件模式 fail-fast, plugin 会清晰提示改用 URL 模式或 outline Web UI 上传.

### 场景 8: 看文档的修改记录

```
outline_rev_log { documentId: "<doc-uuid>", limit: 10 }
# 返 [{id, name, createdAt, createdByName}, ...] — 不含正文, 适合频繁调用做变更追踪
```

---

## ⚠️ 避坑清单 (pin 死, 别再犯)

1. **首行去标题**: 用 `outline_doc_get` 拿到文本后, 再 `outline_doc_update` 时**必须**去掉首行 `# 标题` (Outline 自动追加的). 不去会标题累积重复.

2. **`collectionId` 必须是 UUID**: 短字符串 (如 `"abc"`) 返 `validation_error: collectionId: Invalid UUID` 400. 标准格式 `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`.

3. **`outline_doc_update` 拒绝 `parentDocumentId`**: outline server 端 `documents.update` endpoint schema 不包含 `parentDocumentId` 字段, 静默 drop 不会有任何提示. 改用 `outline_doc_move {id, collectionId, parentDocumentId}` 走同一 collection 也行.

4. **publish 默认 true**: 创建/更新文档**立即可见**, 不需要二次 publish 操作.

---

## 配置检查 (没配好时返的友好错误)

如果调用返:
```
"Outline Wiki plugin is not configured. Set `apiToken` (Bearer) and `endpoint` (e.g. https://your-outline.example.com/api) under `plugins.entries.outline-wiki-openclaw-plugin.config` in openclaw.json."
```

说明 `~/.openclaw/openclaw.json` 的 `config` 段没配. 必填 2 个字段:
```json
{
  "apiToken": "ol_...",
  "endpoint": "https://your-outline.example.com/api"
}
```

可选 2 个字段 (有默认值, 不配也能 work):
```json
{
  "mcpEndpoint": "https://your-outline.example.com/mcp",        // 默认同 endpoint host
  "defaultCollectionId": "<UUID>"                              // outline_doc_create 缺省 collectionId 时走这个
}
```

⚠️ **改 `config` 段必须** `systemctl --user restart openclaw-gateway.service` (OpenClaw 不会热加载 plugin entries.config).

---

## 硬性一致性契约 (CP-2062)

> 本节是 CP-2062 写入的硬性契约, 与下方 `tests/cli-vs-tools-parity.test.ts` 一一对应. 任何违反本节的改动视为 bug, 必须在合并前修复.

**契约**: CLI (`outline-tool <category>.<method>`) 每个 method 的 **参数解析顺序 / 默认值 / fallback / 后续副作用 (如 documents.info verify / changelog 写 revision)** 必须与 OpenClaw 原生 named tool (`outline_<category>_<method>`) **完全一致** —— 同一份 args, 两条路径必须产出**等价**的 outline REST 请求 body (以及同样的副作用). 两条路径有任何不一致 → 测试红 (`tests/cli-vs-tools-parity.test.ts`) → 视为 bug.

**具体已对齐的差异点 (CP-2062 修复)**:

1. **`doc.create` collectionId 解析顺序**: `args.collectionId` > `cfg.defaultCollectionId`. 两者都缺时, CLI **必须**返回明确错误 (`doc.create requires collectionId ... — pass it as an arg, or set defaultCollectionId in the plugin config`), 不允许静默 `collectionId: undefined` 透传给 outline.
2. **`doc.create` 成功后 verify**: 调用 `documents.info { id }` 二次确认 `data.id` 非空. verify 失败 → 返 `documents.create verify failed for id "..."` 错误 (非静默成功).
3. **`doc.update` 四参数**: `editMode` (默认 `"replace"`, 仅在 text 设了时附加), `publish` (bool, 不设则不传), `changelog` (成功后 best-effort 写最新 revision 的 `name`), `strictChangelog` (默认 false; true 时 changelog 写失败硬失败). 任一字段与 OpenClaw tool 侧行为不一致 → 测试红.
4. **`search.query` 默认 limit**: 25 (OpenClaw tool 也是 `pickNumber(args.limit, 25)`). 不允许保留旧的 10.

**强制守护**:
- 改 `src/cli.ts` 任一 method 的参数/fallback/verify 逻辑时, 必须同步改 `src/index.ts` 中对应的 OpenClaw tool handler (或反之). 不允许只改一边.
- `npm test` 必须全绿 (`tests/cli-vs-tools-parity.test.ts` 是兜底). 任何 parity 测试红 = 必须修复, 不允许 skip / `.todo` / `.skip`.
- 详见 [`CONTRIBUTING.md`](../../CONTRIBUTING.md) 与 PR 模板.