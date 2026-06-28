---
name: outline-wiki
description: OpenClaw outline-wiki 知识库原生插件. 提供两条调用路径:
  1) OpenClaw 原生 tools: 12 个独立 named tool (`outline_doc_*` / `outline_search_query` / `outline_collection_*` / `outline_attachment_upload`)
  2) 独立 CLI `outline-tool` (OpenCode / 任意 shell, 不依赖 OpenClaw, 走 category.method 字符串)
  12 个 method, 4 个 category: doc / search / collection / attachment. 当用户说"找 outline 上 XXX 文档"、"读一下 wiki 上的 XXX"、"在 outline 上写一篇 XXX"、"改一下 outline 上 XXX 文档"、"删一下 outline 上的 XXX"、"归档 XXX"、"在 outline 上传一张图片"时触发.
metadata:
  {
    "openclaw": { "emoji": "📚" },
  }
---

# Outline Wiki Plugin Skill

> 本插件提供两条 Outline 调用路径:
>
> - **OpenClaw 原生路径**: agent 调 12 个 named tool (`outline_doc_*` / `outline_search_query` / `outline_collection_*` / `outline_attachment_upload`), 通过 `@cereb/outline-wiki-openclaw-plugin` 暴露. 所有 5 个 agent 自动可见.
> - **CLI 工具路径**: 终端 / OpenCode 等子 agent 调 `outline-tool` 二进制 (不依赖 OpenClaw, 共享同一份 handler 代码).
>
> 两者功能完全相同, 走哪条取决于调用方上下文.

> **0.4.0 breaking change (2026-06-28)**: 旧版 `outline_wiki` 单一 dispatcher tool (走 `{category, method, args}` envelope) **已弃用**. 新版用 `defineToolPlugin` 暴露 12 个独立 named tool — 每个 tool 的参数直接是该 method 的 args (flat JSON object), 无 envelope. 旧调用形式在新版下**不可用** (tool 名 `outline_wiki` 已移除). 见末尾"迁移"段.

---

## 调用形态

### 1) OpenClaw 原生 named tools (agent 默认, 0.4.0+)

每个 method 是一个独立的 named tool, 参数直接是 method 的 args (flat object). 12 个 tool 列表见下表.

**例**:
```
outline_doc_list { limit: 5 }
outline_search_query { query: "redis sentinel", limit: 10 }
outline_doc_get { id: "<doc-uuid>" }
outline_doc_create { title: "...", text: "...", collectionId: "<uuid>", publish: true }
outline_doc_update { id: "<doc-uuid>", text: "...", editMode: "replace" }
outline_doc_move { id: "<doc-uuid>", collectionId: "<target-uuid>", parentDocumentId: "<parent-uuid>" }
outline_attachment_upload { name: "x.png", url: "<public-url>", documentId: "<doc-uuid>", preset: "documentAttachment" }
```

### 2) CLI 二进制 (OpenCode / 终端 / CI 使用, 不依赖 OpenClaw)

CLI 走 `category.method` 字符串 envelope (保留旧形态, 因为 CLI 不接 OpenClaw 工具系统):
```bash
outline-tool doc.list '{"limit":2}'
outline-tool doc.get '{"id":"..."}'
outline-tool search.query '{"query":"redis sentinel"}'
outline-tool collection.list '{}'
outline-tool attachment.upload '{"name":"x.png","url":"https://...","preset":"documentAttachment"}'
```
退出码: `0`=ok, `2`=JSON 解析错, `3`=dispatch 错, `4`=shape 错, `5`=业务错误.

---

## 12 个 named tool 速查

| Tool 名 | Outline method | 用途 | 必填参数 | 常用选填 |
|---|---|---|---|---|
| `outline_doc_list` | `documents.list` | 列文档 (含 text 字段) | — | `limit`, `offset`, `collectionId`, `query` |
| `outline_doc_get` | `documents.info` | 单文档 + metadata + markdown 正文 (单调用) | `id` | — |
| `outline_doc_create` | `documents.create` | 创建文档 (publish=true 默认) | `title`, `text`, `collectionId` (可走 cfg defaultCollectionId) | `publish`, **`parentDocumentId`** (0.3.0+, 挂到父文档下) |
| `outline_doc_update` | `documents.update` | 更新 text / title (editMode=replace 默认). **0.3.1 fail-fast (0.4.0 继承)**: 拒绝 `parentDocumentId` 入参 (server silent drop, use `outline_doc_move` to reparent) | `id` + (`text` / `title` 之一) | `editMode`, `publish` |
| `outline_doc_delete` | `documents.delete` | trash (default) / 硬删 (`permanent: true`) | `id` | `permanent` |
| `outline_doc_archive` | `documents.archive` | 归档 (admin 可读, 可 restore) | `id` | — |
| `outline_doc_restore` | `documents.restore` | 从 archive 恢复 | `id` | — |
| `outline_doc_move` | `documents.move` | 移到其他 collection (0.3.0+ 可同时 reparent) | `id`, `collectionId` | **`parentDocumentId`** (0.3.0+, 在 collection 内 reparent 到某个父文档) |
| `outline_search_query` | `documents.search` | 全文搜索文档 | `query` | `limit`, `offset`, `collectionId` |
| `outline_collection_list` | `collections.list` | 列所有 collection | — | `limit`, `offset` |
| `outline_collection_documents` | `collections.documents` | 列 collection 下文档 (含 children 结构) | `id` (collection id) | `limit`, `offset` |
| `outline_attachment_upload` | `attachments.create` / `attachments.createFromUrl` | dev wiki 走 `url` 模式 (`createFromUrl`, 推荐); `path` 模式走 `attachments.create` + PUT (dev wiki 是 legacy `files.create` 端点 cookie-only, plugin 端 fail-fast 推 `url` 模式) | `name` + (`url` 或 `path`) | `contentType`, `size`, `documentId`, `preset` |

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
5b. outline_doc_move {id: "<doc-id>", collectionId: "<target>",    # 0.3.0+: 跨/同 collection reparent
                            parentDocumentId: "<parent-uuid>"}
```

⚠️ **不要用 `outline_doc_update` 改 `parentDocumentId`** — 0.3.1 fail-fast 会返错指向 `outline_doc_move`. 详细根因见避坑清单 14.

### 场景 7: 上传附件 (截图 / 图片)

**🎯 dev wiki 推荐: URL 模式 (A)**. `path` 模式 (B) 在 dev wiki 上**不 work** (dev wiki 是 legacy `files.create` 端点 cookie-only, plugin 端 fail-fast 清晰错误推 URL 模式).

**A. URL 模式 (outline 自己 fetch, 一步走, dev wiki 走这条)**:
```
1. outline_attachment_upload {
     name: "screenshot.png",
     url: "<公开可访问的图片 URL>",
     documentId: "<doc-id>",
     preset: "documentAttachment"
   }
```
要求 URL 公开可访问 (dev wiki 内部能 fetch). 常用: 自己的 S3/OSS 公开 URL / 截图上传到 paste 服务后 URL / 公开图床.

**B. 本地文件模式 (plugin 读 fs + PUT, 现代 outline 走这条)**:
```
1. outline_attachment_upload {
     name: "screenshot.png",
     path: "/home/leoclaw/.openclaw/workspace-tester/screenshots/ac001.png",
     contentType: "image/png",
     documentId: "<doc-id>",
     preset: "documentAttachment"
   }
```
要求 outline 是现代版 (走 S3 预签 POST 模式). dev wiki 是 legacy 端点, **不 work** — 改用 URL 模式 (A) 或 outline Web UI 上传.

---

## ⚠️ 避坑清单 (pin 死, 别再犯)

1. **首行去标题**: 用 `outline_doc_get` 拿到文本后, 再 `outline_doc_update` 时**必须**去掉首行 `# 标题` (Outline 自动追加的). 不去会标题累积重复.

2. **collectionId 必须是 UUID**: 短字符串 (如 `"abc"`) 返 `validation_error: collectionId: Invalid UUID` 400. 标准格式 `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`. 常用 collectionId 见文末.

3. **`outline_doc_get` 已含完整正文**: `documents.info` 接口的 `data.text` 字段**已经**包含完整 markdown. **不要**再调 `documents.export` (那是冗余调用).

4. **`outline_doc_update` 必填 `text` 或 `title` 之一**: 两者都不传返 `requires at least one of text or title`. 不允许空 update (会 silently bump revision).

5. **`outline_doc_create` 必填 `collectionId`**: 优先级 `args.collectionId` > `cfg.defaultCollectionId`. 都没配返明确错误.

6. **publish 默认 true**: 创建/更新文档**立即可见**, 不需要二次 publish 操作.

7. **outline_doc_delete permanent 硬删两步走**: `documents.delete` 接受 `{id, permanent}` 参数, 但 outline 源码里 `cancan permanentDelete` action 要求 `!!document?.isDeleted` (即文档必须先在 trash 里). 所以想**真硬删**必须先 `outline_doc_delete {id}` (trash) 再 `outline_doc_delete {id, permanent: true}` (hard delete). 第一步之后 isDeleted=true 才满足 permanentDelete 的 cancan check.

8. **outline_doc_move 没有 defaultCollectionId fallback**: `outline_doc_create` 有 (走 `args.collectionId` > `cfg.defaultCollectionId`), `outline_doc_move` 没有 — 移动是显式用户姿态, 目标 collection 必须在 call 里明确.

9. **outline_attachment_upload S3 step 2 字段顺序** (仅现代 outline 走 S3 预签 POST 模式时): S3 presigned POST 期望 `attachments.create` 返的 `form` 字段**按 outline server 端 set 顺序**出现在 multipart body 里, **再**追加 `file` 字段. plugin 用 `Object.entries(form)` 顺序 append + 最后 append `file`, 跟 server 端 Object.entries 一致. 如果 S3 返 403 `SignatureDoesNotMatch`, 大概率是 field 顺序错乱 (少见, 因为 outline server 端 `form` 是同步 set, 顺序确定). **dev wiki 不会到这一步** (legacy 端点 fail-fast).

10. **outline_attachment_upload preset 值是 lowercase camelCase**: `documentAttachment` / `avatar` / `emoji` (跟 outline server 端 `AttachmentPreset` enum 完全一致, 见 outline repo `shared/types.ts:134`). **不要**写成 PascalCase (e.g. `DocumentAttachment`).

11. **`outline_search_query` query 必填且非空**: 跟 `outline_doc_create` 必填 `title` 一样, query 是非空 string (trim 后).

12. **dev wiki outline_attachment_upload path 模式 fail-fast (cookie-only 限制)**: dev wiki 用的是 legacy `files.create` 端点 (cookie-only auth, 不认 Bearer token). `attachments.create` Bearer call 成功后会返 `uploadUrl = "/api/files.create"` (相对路径, **不是** S3 presigned URL). plugin 端检测到这个**立即 fail-fast** + 推 URL 模式 (避免 caller 撞 cookie 401). 端到端验过的实际错误: `"dev wiki is using the legacy files.create endpoint which requires a browser session cookie. path mode is not supported on this outline instance; use \`url\` mode or upload via the outline web UI."` — 现代 outline (升级到 S3 预签) 不会撞这限制, 自动 work.

13. **`parentDocumentId` 0.3.0+ 透传 (YAGNI 例外放行, 0.4.0+ 仍生效)**: `outline_doc_create` / `outline_doc_move` 两 tool 都接受这个可选字段 (UUID), 直接挂到指定父文档下. **0.3.1 / 0.4.0**: `outline_doc_update` **不接受** `parentDocumentId` (0.3.0 接受但 server silent drop, 见避坑清单 14; TypeBox schema 直接不暴露这个字段, fail-fast 防御性保留). **用法区别**:
- `outline_doc_create {title, text, collectionId, parentDocumentId: "..."}` → 创建时直接嵌套到父文档下
- `outline_doc_move {id, collectionId, parentDocumentId: "..."}` → 跨/同 collection 移动, 同时在目标位置 reparent
- ~~`outline_doc_update {id, parentDocumentId: "..."}`~~ → **不要用**, server 端 silent drop; 0.3.1 fail-fast 直接返错, 0.4.0 TypeBox schema 也不接受
- **典型场景**: 「WTO - 质量与测试」是 collection 根下的容器文档, 它的子文档 (如「用户与权限 误判复盘 v1」) 通过 `parentDocumentId = 容器 uuid` 挂到容器下, 在 outline 文档树视图里出现在容器**内部**而不是 collection 根
- **YAGNI 仍保留** `templateId` / `icon` / `color` / `outline_doc_update` 的 `append` 模式 — 装饰性字段, 不影响信息架构
- 详细根因 + 验证矩阵见 README 踩坑清单 11/12

14. **🚨 `outline_doc_update` + `parentDocumentId` 0.3.1+ fail-fast (silent drop 根因)**: outline server 端 `documents.update` endpoint schema **不包含** `parentDocumentId` 字段 (curl 验证 2026-06-08: revision 2→3 步进, updatedAt 不变, document.parentDocumentId 仍为 null). **0.3.0 plugin 盲目透传**, caller 拿到 `ok: true` 但实际什么也没改. **0.3.1 plugin fail-fast**: 检测到 `parentDocumentId` 入参 → 立即返错指向 `outline_doc_move`, **跟 outline_attachment_upload path 模式 fail-fast 同模式** (避坑清单 12). **0.4.0**: TypeBox schema 直接不接受这个字段 (双重防御).
- **端到端触发场景**: tester 跑测误判复盘时, 第一次试调 `outline_doc_update` 挂载容器 — 静默 fail, revision 没变, container 文档下没出现子文档
- **workaround**: 一律走 `outline_doc_move {id, collectionId, parentDocumentId: "..."}` (同 collection 时 collectionId 重复填原 collection 即可)
- **为什么不 auto-forward 到 documents.move**: mask 掉 server 端行为后, 未来 outline server 修复 `documents.update` schema (把 parentDocumentId 加进去) 时反而察觉不到. fail-fast 错误消失就是修复信号
- **教训 (devclaw 0.3.0 path A 验证盲点)**: 0.3.0 验证矩阵只验 `documents.create` 真实改 parentDocumentId (✅), `outline_doc_update` / `outline_doc_move` 都只验 plugin 端 `ok: true`, **没验 server 端是否真的改**. 0.3.1 改 fail-fast 后, 验证 SOP 改: 不仅验 `ok: true`, 还要 documents.info 拉一遍确认 parentDocumentId 字段真的设了

15. **🔄 0.4.0 migration breaking change**: 旧版单一 dispatcher tool `outline_wiki` (走 `{category, method, args}` envelope, 命令形态如 `outline_wiki call doc.list {...}`) **已弃用**. 新版是 12 个独立 named tool. 旧调用形式在新版下**不可用** (tool 名 `outline_wiki` 已移除). 升级步骤:
- 把所有 `outline_wiki call doc.list {...}` → `outline_doc_list {...}` (args 直接是原 envelope 的 args, 不再嵌套)
- 把所有 `outline_wiki call {category, method, args}` 结构化 envelope → 直接调对应 tool, args 平铺
- CLI `outline-tool doc.list '{...}'` 形态**不变** (CLI 还在用 category.method envelope, 不受影响)
- TypeBox schema 现在直接验证每个 tool 的参数, 不再有 envelope 兜底

---

## 配置检查 (没配好时返的友好错误)

如果调用返:
```
"Outline Wiki plugin is not configured. Set `apiToken` (Bearer) and `endpoint` (e.g. https://wiki.dev.cereb.ai/api) under `plugins.entries.outline-wiki-openclaw-plugin.config` in openclaw.json."
```

说明 `~/.openclaw/openclaw.json` 的 `config` 段没配. 必填 2 个字段:
```json
{
  "apiToken": "ol_...",
  "endpoint": "https://wiki.dev.cereb.ai/api"
}
```

可选 2 个字段 (有默认值, 不配也能 work):
```json
{
  "mcpEndpoint": "https://wiki.dev.cereb.ai/mcp",        // 默认同 endpoint host
  "defaultCollectionId": "2539c4a2-1fa8-4f0e-900f-9a5c7f1f72ba"  // 常用 WTO
}
```

⚠️ **改 `config` 段必须** `systemctl --user restart openclaw-gateway.service` (OpenClaw 不会热加载 plugin entries.config).

---

## MVP 范围 (截至 2026-06-28 → 0.4.0, defineToolPlugin + 12 named tools)

✅ **已实现 (12 个 named tool, 4 个 category)**: 
- `doc`: `outline_doc_list`, `outline_doc_get`, `outline_doc_create`, `outline_doc_update`, `outline_doc_delete`, `outline_doc_archive`, `outline_doc_restore`, `outline_doc_move`
- `search`: `outline_search_query`
- `collection`: `outline_collection_list`, `outline_collection_documents`
- `attachment`: `outline_attachment_upload`

🆕 **0.4.0 (2026-06-28) architecture change**:
- **defineToolPlugin + 12 named tools**: 弃用旧 `definePluginEntry` + 单一 dispatcher `outline_wiki` 形态. 改用 `defineToolPlugin` (openclaw plugin-sdk/tool-plugin), 每个 method 一个独立 tool, 参数是 flat TypeBox object. 优点: (a) OpenClaw 冷启动 manifest 读取无需 load runtime code (`getToolPluginMetadata` 走 `toolPluginMetadataSymbol` 拿静态 metadata); (b) TypeBox schema 在调用前就验证参数 shape, envelope 解析开销消失; (c) tool 列表从 1 个巨型 envelope dispatcher → 12 个小 tool, agent 路由更直观.
- **breaking change**: 旧 `outline_wiki` tool 已删除, 所有调用形式需迁移 (见避坑清单 15).
- **CLI 不变**: `outline-tool <category>.<method> '<args-json>'` 形态保留, OpenCode/终端用户无感.
- **TypeBox schema 直接拒绝 parentDocumentId on outline_doc_update**: 0.3.1 fail-fast 防御性保留 (防止 schema 未来被无意放宽).

🆕 **0.3.0 (2026-06-08 11:00) 历史 (0.4.0 仍继承)**:
- `parentDocumentId` 透传支持 — `outline_doc_create` / `outline_doc_move` 接受这个可选字段 (UUID), 直接挂到父文档下
- **0.3.0 误设计**: `outline_doc_update` 也接受 `parentDocumentId`, 但 outline server `documents.update` endpoint schema 不含此字段, server silent drop, caller 拿到 `ok: true` 但实际什么也没改 (verification: revision 2→3 步进, updatedAt 不变, document.parentDocumentId 仍为 null)
- `outline_doc_move` 语义扩: 同 collection 时配合 `parentDocumentId` 可重新归位; 跨 collection 时不指定则归到目标 collection 根
- 根因: tester 误判复盘时新建文档需挂到「WTO - 质量与测试」容器下, **YAGNI 不该留到影响文档编排的地方** (Leo 拍板原话)

🔧 **0.3.1 (2026-06-08 11:30) 历史 (0.4.0 仍继承) bug fix**:
- `outline_doc_update` fail-fast: 检测到 `parentDocumentId` 入参 → 立即返错指向 `outline_doc_move`. **0.3.0 '三者至少一个' 守卫收回**, 恢复为 `text` / `title` 之一
- 设计选择: fail-fast 而非 auto-forward 到 documents.move. 原因: 保留 server 端行为可观测性, 未来 outline server 修 schema 时能立刻发现 (fail-fast 错误消失就是修复信号)
- 验证 SOP 改: 不仅验 `ok: true`, 还要 documents.info 拉一遍确认 parentDocumentId 字段真的设了

⏳ **未实现 (按 pilot 优先级排序)**:
- `user.list` — admin 场景低频 (~0.5h)
- `search.filter` / `search.advanced` — 高级搜索 (filter by author/date/collection) (~1h)
- `doc.publish` — outline 源码里没独立端点, create/update 传 `publish: true` 即可 (已实现, 无需补 method)
- `git init + commit` — 沉淀项目基线 (~0.5h)
- **改 SecretRef** — 正式部署前必做, dev 模式明文 token 是临时方案 (~1h)
- YAGNI 仍保留: `templateId` / `icon` / `color` / `outline_doc_update` 的 `append` 模式 — 装饰性字段, 不影响信息架构

---

## 常用 collectionId 速查

| 项目 | id |
|---|---|
| WTO | `2539c4a2-1fa8-4f0e-900f-9a5c7f1f72ba` |
| SSSS | `cad29122-ff32-4b03-88cb-f7a8a15c744d` |
| ISF | `9991482d-d6d6-401a-a64a-e167c21d5d4a` |
| EWLD | `f5f0102c-0bc4-4725-bf6e-73e3f5b52d42` |
| PTC HK | `b121a690-ed6a-44e3-abfa-d3128ea47634` |
| 架构设计 | `c6fe1b10-a61e-4c6c-85d8-3e4b7302f043` |
| 项目索引 | `3bf73717-9aee-4f7c-bbc5-8252b5d4e5c5` |
| 平台配置 | `e76d7490-a3fa-4439-9bc8-23e3071af186` |
| 团队规范 | `5f19dc6f-ba0e-4789-81b0-00af8a20fe49` |
| 待整理 | `b6bca85c-1611-4c72-86a5-23b7f6d8b255` |

---

## 相关链接

- **项目目录**: `~/dev/projects/outline-wiki-openclaw-plugin`
- **README (含开发循环 + 踩坑清单)**: `/home/leoclaw/dev/projects/outline-wiki-openclaw-plugin/README.md`
- **MEMORY.md (团队记忆)**: `~/.openclaw/workspace-devclaw/MEMORY.md` 的 "outline-wiki OpenClaw 原生插件" 段

---

## 贡献指南 (给自己 + 别人接手)

加新 method 时:
1. `src/index.ts` 里在 `defineToolPlugin({ tools: (tool) => [...] })` 数组里加一个新的 `tool({ name: "outline_<category>_<method>", ... })` 块
2. 对应的 handler 函数 (`async function <category><Method>`) 加上, 复用已有辅助函数 (`outlineFetch` / `textResult` / `pickNumber` / `errorMessage` / `requireConfig`)
3. 跑 `npm run typecheck && npm run build && npx openclaw plugins build --entry ./dist/index.js` (regen manifest + package.json metadata) `&& npx openclaw plugins validate --entry ./dist/index.js`
4. 打包安装: `npm pack && openclaw plugins install "npm-pack:./$(ls cereb-outline-wiki-openclaw-plugin-*.tgz | head -1)" --force && systemctl --user restart openclaw-gateway.service`
5. 验证: `node tools/quick-test.js outline_<category>_<method> '{...}'` + agent 链路
6. **更新本 SKILL.md** (新增 tool 行 + 避坑)
7. 重要决策写到 `MEMORY.md`

**YAGNI 原则的例外处理** (0.3.0 拍板): 当 caller 端有明确诉求 (如"文档编排需要 parentDocumentId") 而 YAGNI 会阻碍核心场景时, 可放行该字段. **例外放行**有完整流程: (a) 改 `src/index.ts` 透传 + 更新 YAGNI 注释说明哪些字段仍按 YAGNI 保留; (b) 更新 README 踩坑清单 + SKILL.md 速查表 + 避坑清单; (c) 跑 `quick-test` 验证 (path A) + 真实 agent 链路验证 (path B); (d) 同步 `package.json` 版本号. **不要**为"也许将来要用"预先放行.

**0.4.0 architecture decision (breaking change)**: `definePluginEntry` + 单一 dispatcher (旧 wecom 习惯) → `defineToolPlugin` + 独立 named tools. 原因: (a) 12 个 method 各自独立后, OpenClaw 冷启动 manifest 直接静态读 metadata 不 load runtime code, 启动开销下降; (b) TypeBox schema 直接验证每个 tool 参数, 弃用 `{category, method, args}` envelope 减少一层间接; (c) agent prompt 里 tool 列表从 1 个巨型 envelope → 12 个小 tool, 路由更直观. CLI 不变 (走 category.method envelope), OpenCode/终端用户无感. Agent 调用方需要做迁移 (避坑清单 15).