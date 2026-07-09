---
name: outline-wiki
description: OpenClaw outline-wiki 知识库原生插件. 提供两条调用路径:
  1) OpenClaw 原生 tools: 13 个独立 named tool (`outline_doc_*` / `outline_search_query` / `outline_collection_*` / `outline_attachment_upload` / `outline_rev_log`)
  2) 独立 CLI `outline-tool` (OpenCode / 任意 shell, 不依赖 OpenClaw, 走 category.method 字符串)
  13 个 method, 5 个 category: doc / search / collection / attachment / revision. 当用户说"找 outline 上 XXX 文档"、"读一下 wiki 上的 XXX"、"在 outline 上写一篇 XXX"、"改一下 outline 上 XXX 文档"、"删一下 outline 上的 XXX"、"归档 XXX"、"在 outline 上传一张图片"、"看 outline 文档的修改记录"时触发.
metadata:
  {
    "openclaw": { "emoji": "📚" },
  }
---

# Outline Wiki Plugin Skill

> 本插件提供两条 Outline 调用路径:
>
> - **OpenClaw 原生路径**: agent 调 13 个 named tool, 通过 `@cereb/outline-wiki-openclaw-plugin` 暴露.
> - **CLI 工具路径**: 终端 / OpenCode 等子 agent 调 `outline-tool` 二进制 (不依赖 OpenClaw, 共享同一份 handler 代码).
>
> 两者功能完全相同, 走哪条取决于调用方上下文.

---

## 调用形态

### 1) OpenClaw 原生 named tools (agent 默认)

每个 method 是一个独立的 named tool, 参数直接是 method 的 args (flat object). 13 个 tool 列表见下表.

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

### 2) CLI 二进制 (OpenCode / 终端 / CI 使用, 不依赖 OpenClaw)

CLI 走 `category.method` 字符串 envelope (保留旧形态, 因为 CLI 不接 OpenClaw 工具系统):
```bash
outline-tool doc.list '{"limit":2}'
outline-tool doc.get '{"id":"..."}'
outline-tool search.query '{"query":"redis sentinel"}'
outline-tool collection.list '{}'
outline-tool attachment.upload '{"name":"x.png","url":"https://...","preset":"documentAttachment"}'
outline-tool rev.log '{"documentId":"..."}'
```
退出码: `0`=ok, `2`=JSON 解析错, `3`=dispatch 错, `4`=shape 错, `5`=业务错误.

---

## 13 个 named tool 速查

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