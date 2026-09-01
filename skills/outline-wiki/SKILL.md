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
| `outline_doc_list` | `documents.list` | 列文档 (返回**裁剪版**, 仅 metadata, 不含 markdown 正文 — 见下文「返回格式裁剪」) | — | `limit`, `offset`, `collectionId`, `query` |
| `outline_doc_get` | `documents.info` | 单文档 + metadata + markdown 正文 (单调用) | `id` | — |
| `outline_doc_create` | `documents.create` | 创建文档 (publish=true 默认). **返回裁剪** (CP-2379 + CP-2395): 不回 `document.text` 全文, 只回 nav metadata + summary; `request` 字段也裁剪为 `{title}` (不回 input body 全文) | `title`, `text`, `collectionId` (可走 cfg `defaultCollectionId`) | `publish`, `parentDocumentId` (挂到父文档下) |
| `outline_doc_update` | `documents.update` | 更新 text / title (`editMode=replace` 默认). **拒绝** `parentDocumentId` 入参 (server silent drop, use `outline_doc_move` to reparent). **返回裁剪** (CP-2379 + CP-2395): 不回 `document.text` 全文, 只回 nav metadata + summary; `request` 字段也裁剪为 `{id[, title]}` (不回 input body 全文, 含严格错误路径) | `id` + (`text` / `title` 之一) | `editMode`, `publish`, `changelog` |
| `outline_doc_delete` | `documents.delete` | trash (default) / 硬删 (`permanent: true`) | `id` | `permanent` |
| `outline_doc_archive` | `documents.archive` | 归档 (admin 可读, 可 restore) | `id` | — |
| `outline_doc_restore` | `documents.restore` | 从 archive 恢复 | `id` | — |
| `outline_doc_move` | `documents.move` | 移到其他 collection (可同时 reparent) | `id`, `collectionId` | `parentDocumentId` (在 collection 内 reparent 到某个父文档) |
| `outline_search_query` | `documents.search` | 全文搜索文档. **返回裁剪**: 每条 hit 的 `document.text` 已剥离, 仅保留 ranking + context + nav metadata (id/title/url/urlId/collectionId/updatedAt) | `query` | `limit`, `offset`, `collectionId` |
| `outline_collection_list` | `collections.list` | 列所有 collection | — | `limit`, `offset` |
| `outline_collection_documents` | `collections.documents` | 列 collection 下文档 (含 children 结构) | `id` (collection id) | `limit`, `offset` |
| `outline_collection_create` | `collections.create` | 新建 collection (permission 默认 `read_write`, sharing 默认 true) | `name` | `description`, `icon`, `color`, `permission`, `sharing` |
| `outline_collection_update` | `collections.update` | 改 collection 字段 | `id` + (name/description/icon/color/permission/sharing 至少一项) | — |
| `outline_attachment_upload` | `attachments.create` / `attachments.createFromUrl` | URL 模式 (server-side fetch) / 本地文件模式 (S3 预签 POST) | `name` + (`url` 或 `path`) | `contentType`, `size`, `documentId`, `preset` |
| `outline_rev_log` | `revisions.list` | 文档修改记录 (name / timestamp / author, 不含正文) | `documentId` | `limit` (default 5, max 20) |

---

## 返回格式裁剪 (CP-2379 + CP-2395)

> **从 master @ 6ca0328 之后生效**: 4 个高频 handler (`outline_search_query` / `outline_doc_list` / `outline_doc_create` / `outline_doc_update`) 不再在响应里回显 markdown 正文 (`text` 字段). 这是 planner token 优化 (toolResult 占单任务 token 消耗的 77-86% — 详见 CP-2378).
>
> **CP-2395 补充**: `outline_doc_create` / `outline_doc_update` 的 `request` 字段也从「回显 input args 全文」裁剪为 nav 级别 (`{title}` / `{id, title}`) — 与 CP-2383 jira 插件回声裁剪保持一致, agent 刚把 body 发进来, 不需要再回.

**裁剪范围**:
- `outline_search_query` 返回的每条 hit: `document.text` 剥离, **保留** `ranking` / `context` (已是 snippet) + 内部 `document` 裁剪为 nav 元数据 (`id` / `title` / `url` / `urlId` / `collectionId` / `updatedAt`)
- `outline_doc_list` 返回的每篇 doc: `text` 剥离, 仅保留 nav 元数据 (`id` / `title` / `url` / `urlId` / `collectionId` / `updatedAt`)
- `outline_doc_create` 返回:
  - `request`: 裁剪为 `{title}` (仅 nav 级别 breadcrumb, 不回显 `text` / `collectionId` / `publish` / `parentDocumentId`)
  - `document`: 裁剪为 nav 元数据 (`id` / `title` / `url` / `urlId` / `collectionId` / `updatedAt`) — agent 刚把 body 发进来, 不需要再回
  - `summary`: 完整保留 (`id` / `title` / `url` / `urlId` / `revision` / `publishedAt`) — 用于导航
- `outline_doc_update` 返回:
  - `request`: 裁剪为 `{id}` / `{id, title}` (按调用方实际传入的字段; 不回显 `text` / `editMode` / `publish` / `changelog` / `strictChangelog`)
  - `document`: 裁剪为 nav 元数据 (同上)
  - `summary`: 完整保留 (`id` / `title` / `url` / `urlId` / `revision` / `updatedAt`) — 用于导航
  - 严格错误路径 (`strictChangelog=true` + changelog 写失败): 同样裁剪 `request` / `document`, 不回显 markdown body

**为什么裁剪**:
- 实测单次 `outline_search_query limit=3` 命中 3 篇 doc, 每篇 text 10k+ 字符, toolResult **~50k 字符**. 裁剪后 ~1k 字符量级.
- `outline_doc_create` / `outline_doc_update` 的「input body 全文回显」是同样量级的 token 黑洞 — agent 刚发出去的 markdown 又被原样打回来, 等于把整篇 body 在 toolResult 里再贴一遍. 裁掉 `request.text` 直接干掉这部分冗余.
- `outline_doc_get` 全文读取**不受影响** — 仍是 metadata + markdown 正文 (单调用 `documents.info`), 这是「读正文」的合法路径.
- CLI (`outline-tool`) 共享同一份 trim helper (`src/cli.ts` 的 `trimDocBody` / `trimSearchHit` / `trimCreateRequest` / `trimUpdateRequest`), 两条路径响应 byte-for-byte 一致 (CP-2060 parity).

**调用方影响**:
- 拿到 hit id 后, 想读正文就调 `outline_doc_get {id}` (一次往返拿 metadata + body).
- 不需要正文就别调 (列表/搜索就够了 — nav 元数据足够做 find + open).
- `outline_doc_create` / `outline_doc_update` 后想确认调用本身, 用 `summary` (`id` / `revision`) 就够了, 不依赖 `request` 字段回显.

**反断言 (回归保护)**:
- `tests/response-trim.test.ts`: 19 条 case 断言裁剪后 **任何** 路径下都不带 `text` (含 `request` / `document`), MCP ↔ CLI byte-for-byte 一致; `outline_doc_get` 不变 (仍带 text).
- `tests/doc-create.test.ts` / `tests/doc-update.test.ts`: 断言 `request` 仅含 `{title}` / `{id, title}`, 不含 `text` (含严格错误路径).
- `tests/cli-vs-mcp-parity.test.ts`: CP-2060 parity contract 覆盖 `request` 字段.

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

## CLI ↔ MCP 行为对照 (知情性说明)

本节面向**调用方** (agent / 终端用户), 用于了解 CLI 与 OpenClaw 原生 named tools 的实际行为一致性, 不是开发约束.

- **路径 A** (OpenClaw 原生): 15 个 named tool (`outline_doc_*` / `outline_search_query` / `outline_collection_*` / `outline_attachment_upload` / `outline_rev_log`)
- **路径 B** (CLI 二进制): `outline-tool <method>` (MCP 名 `outline_*` 或短 `category.method` 均接受)

两条路径下, **方法名、参数/必填项、默认值、fallback、verify 行为** 是一致的 — 你用同一份 args 调任一路径, 期望产出同一份 wire 请求体 (例如 `POST /api/documents.create` body) 和同一份响应.

具体行为对照 (供调用方知情, 不是契约):

| 维度 | 路径 A (OpenClaw 原生 tool) | 路径 B (`outline-tool` CLI) |
|---|---|---|
| `outline_doc_create.collectionId` 解析 | `args.collectionId` > `cfg.defaultCollectionId`; 两者皆缺 → 返回明确错误 (无静默丢弃) | 同左 |
| `outline_doc_create` 成功后 verify | 调 `documents.info` 确认 `data.id` 非空; 失败 → 返回 error | 同左 |
| `outline_doc_update.editMode` | 接受 `editMode`, 默认 `"replace"` | 同左 |
| `outline_doc_update.publish` | 接受 `publish` (boolean, 可选) | 同左 |
| `outline_doc_update.changelog` | 接受 `changelog` (可选 string), best-effort 写入最新 revision `name` | 同左 |
| `outline_doc_update.strictChangelog` | 接受 `strictChangelog` (bool, 默认 false); `true` 时 changelog 写失败 → 返回硬失败 | 同左 |
| `outline_search_query.limit` 默认值 | `pickNumber(args.limit, 25)` — 即默认 **25** | 同左 |

**调用方关注点**:

- 同一份 args 在两条路径下应当产生同一份 wire 请求体; 切换路径不需要改业务调用.
- 若发现两条路径的实际行为与上表不符, 请走 issue 反馈给仓库维护方 (开发侧会在 `tests/cli-vs-mcp-parity.test.ts` 加固并修复).
- 行为差异的实际保障由仓库内的 parity 测试承担; 调用方无需 (也不应) 在调用层做兼容性分支.