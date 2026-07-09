# @cereb/outline-wiki-openclaw-plugin

OpenClaw native plugin that exposes the Outline Wiki knowledge base as a single
dispatcher tool `outline_wiki` — replacing the prior `mcporter + Outline MCP`
channel with a tool agents call directly. Reference: parallels
`@wecom/wecom-openclaw-plugin` (same `definePluginEntry` + single-dispatcher
pattern).

---

## 📍 位置 / 路径

| 项 | 值 |
|---|---|
| **项目目录** | `~/dev/projects/outline-wiki-openclaw-plugin` |
| **包名** | `@cereb/outline-wiki-openclaw-plugin` |
| **plugin id** | `outline-wiki-openclaw-plugin` |
| **tool 名** | 12 个独立 named tool（`outline_doc_*` / `outline_search_query` / `outline_collection_*` / `outline_attachment_upload`） |
| **plugin 装在哪里** | `~/.openclaw/npm/projects/cereb-outline-wiki-openclaw-plugin-<hash>/node_modules/...` |
| **config 段** | `~/.openclaw/openclaw.json` 的 `plugins.entries.outline-wiki-openclaw-plugin` |

---

## 🏗️ 架构范式（0.4.0+ — defineToolPlugin）

- **0.4.0 升级**：从 `definePluginEntry` + 单一 dispatcher tool `outline_wiki` (走 `{category, method, args}` envelope) 迁移到 `defineToolPlugin` (openclaw `plugin-sdk/tool-plugin`) + 12 个独立 named tool.
- 每个 method 是一个独立 tool，参数是 flat TypeBox object (e.g. `outline_doc_list {limit: 5}`)
- OpenClaw 冷启动 manifest 通过 `getToolPluginMetadata(entry)` 走 `toolPluginMetadataSymbol` 拿静态 metadata（不 load runtime code）
- TypeBox schema 在调用前就验证参数 shape，不需要 envelope 兜底
- CLI `outline-tool` 保留 `category.method` 字符串形态 (OpenCode/终端用户无感)
- 复用辅助函数：`outlineFetch` / `requireConfig` / `textResult` / `pickNumber` / `errorMessage`
- 旧 `outline_wiki` dispatcher tool 已删除 — 见下方"踩坑清单 13"迁移指南

---

## ✅ 已实现的 method（MVP 2.5 闭环 + 0.3.0 parentDocumentId 透传 + 0.3.1 silent-drop fix + **0.4.0 defineToolPlugin + 12 named tools**，截至 2026-06-28）

| Tool 名 (0.4.0+) | Outline method | 用途 | `parentDocumentId` | REST API |
|---|---|---|---|---|
| `outline_doc_list` | `documents.list` | 列文档（含 text 字段） | — | `documents.list` |
| `outline_doc_get` | `documents.info` | 单文档 + metadata + markdown 正文 | — | `documents.info`（**单调用**） |
| `outline_doc_create` | `documents.create` | 创建文档（publish=true 默认） | ✅ 可选（创建时直接挂到父文档下） | `documents.create` |
| `outline_doc_update` | `documents.update` | 更新 text / title（editMode=replace 默认）。**0.3.1 fail-fast / 0.4.0 schema 拒绝**：`parentDocumentId` 入参返错指向 `outline_doc_move` | ❌ 0.3.1+ fail-fast (server silent drop) | `documents.update` |
| `outline_doc_delete` | `documents.delete` | trash（default）/ hard delete（permanent=true） | — | `documents.delete` |
| `outline_doc_archive` | `documents.archive` | 归档（admin 可读，30 天内可恢复） | — | `documents.archive` |
| `outline_doc_restore` | `documents.restore` | 从 archive 恢复 | — | `documents.restore` |
| `outline_doc_move` | `documents.move` | 移到其他 collection（collectionId 必填） | ✅ 可选（在 collection 内 reparent） | `documents.move` |
| `outline_search_query` | `documents.search` | 全文搜索文档（query 必填） | — | `documents.search` |
| `outline_collection_list` | `collections.list` | 列所有 collection | — | `collections.list` |
| `outline_collection_documents` | `collections.documents` | 列 collection 下文档（含 children 结构） | — | `collections.documents` |
| `outline_attachment_upload` | `attachments.create` / `attachments.createFromUrl` | S3 预签 URL 两步走（`url` 走 `createFromUrl`，`path` 走 `attachments.create` + S3 PUT） | — | `attachments.create` / `attachments.createFromUrl` |

**0.4.0 关键变更（breaking change，2026-06-28）**：架构从 `definePluginEntry` + 单一 dispatcher tool `outline_wiki`（走 `{category, method, args}` envelope）迁移到 `defineToolPlugin` + 12 个独立 named tool. 旧 `outline_wiki` tool 已删除, agent 调用方需做迁移 (踩坑清单 13).

**0.3.0 关键变更**：YAGNI 例外放行 `parentDocumentId`——`outline_doc_create` / `outline_doc_move` 两 tool 透传这个字段到 outline server（**0.3.0 错误地把 `outline_doc_update` 也加进去**，server 端 `documents.update` schema 不含此字段导致 silent drop，0.3.1 fix）。

**0.3.1 关键变更（bug fix）**：`outline_doc_update` 检测到 `parentDocumentId` 入参 → fail-fast 返错指向 `outline_doc_move`（跟 outline_attachment_upload path 模式 fail-fast 同模式，保留 server 端行为可观测性）。完整理由见踩坑清单 11/12。

**pilot 推荐的 P0 + P1 全部端到端跑通**（12 个 named tool, 4 个 category）。Pilot 是最大主要使用者。

---

## 🔄 开发循环（重要！下次接着开发用这个）

> **记忆会丢，循环不会。** 把这 4 步记到手指上。

### Step 1: 写代码
- 改 `src/index.ts`（**单文件**，< 500 行）
- 复用已有辅助函数（`outlineFetch` / `textResult` / `pickNumber` / `errorMessage` / `requireConfig`）
- 新加 method：在 `defineToolPlugin({ tools: (tool) => [...] })` 数组里加一个 `tool({ name: "outline_<category>_<method>", ... })` 块, 加一个对应的 `async function <category><Method>` handler
- 新加 category 时：
  1. 在 `tools` 数组里加新 tool 块 (一个 category 一个 tool, 或按 method 拆)
  2. 加对应的 handler 函数
  3. TypeBox schema 必须显式声明每个 tool 的参数 (替代旧的 envelope TypeBox)

### Step 2: 编译 + 生成 manifest
```bash
cd ~/dev/projects/outline-wiki-openclaw-plugin
npm run typecheck
npm run build
npx openclaw plugins build --entry ./dist/index.js      # regen openclaw.plugin.json + package.json metadata
npx openclaw plugins validate --entry ./dist/index.js   # 验证 manifest 跟 entry 一致
```
**三者都必须过**。TS 报错 → 修 TypeBox schema；validate 报错 → 跑 `build` 重生成 manifest.

### Step 3: 打包 + 安装
```bash
cd ~/dev/projects/outline-wiki-openclaw-plugin
rm -f cereb-outline-wiki-openclaw-plugin-*.tgz
npm pack
openclaw plugins install "npm-pack:./$(ls cereb-outline-wiki-openclaw-plugin-*.tgz | head -1)" --force
```

### Step 4: 重启 gateway ⚠️ 必做

```bash
systemctl --user restart openclaw-gateway.service
```

**这是 plugin 加载新 dist 的唯一可靠方式**（见下方踩坑 2）。

### Step 5: 验证

两条路径都跑（双保险）：

**A. 绕过 gateway**（快，dev 改完立即验证）：
```bash
node tools/quick-test.js outline_doc_list '{"limit":2}'
node tools/quick-test.js outline_doc_get '{"id":"<uuid>"}'
node tools/quick-test.js outline_search_query '{"query":"redis sentinel"}'
```

**B. agent 链路**（最权威，模拟真实使用）：
作为 devclaw / tester / pilot 直接调对应 named tool (e.g. `outline_doc_list {...}`). 旧 `outline_wiki call ...` 形式**已不可用** (0.4.0 breaking).

---

## ⚠️ 踩坑清单（pin 死，下次不能再犯）

### 1. install 路径

❌ `openclaw plugins install <单文件>.js` —— 不带 manifest + 不装依赖 + 跟 `npm-pack:` install 撞 id 报 `duplicate plugin id`
✅ `openclaw plugins install "npm-pack:./<tgz>"` —— 跟 wecom 同款方式

### 2. plugin dist 重装需要 restart（**最重要**）

❌ "plugin dist 重装自动热加载" —— **错的**（之前误判）
✅ **OpenClaw 不会自动 reload plugin dist**
✅ `install` log 提示 "Restart the gateway to load plugins." 是**真的**，不是装饰
✅ 唯一可靠方式：`systemctl --user restart openclaw-gateway.service`（**不要**用 `openclaw gateway restart`，跟 systemd 锁冲突报 "lock timeout" 死循环）

### 3. `config patch` 不会热加载 plugin entries.config 段

✅ 改 `plugins.entries.<id>.config` 段 → 需 restart gateway（同上）
✅ 跟 plugin dist 重装是两回事，但都需 restart

### 4. `documents.info` 已含 `text` 字段（quickref 过时信息修正）

❌ quickref 老信息："fetch 只返 metadata" —— **过时**
✅ `documents.info` 的 `data.text` 字段**已经**包含完整 markdown 正文
✅ MVP 的 `doc.get` 只调 `info` 单接口就够，**不要**双调用 `info + export`（export 是冗余的，export 本身的 response 是 `{data: "<markdown字符串>"}`，data 是 string 不是 object）

### 5. parseCallString regex 必须支持 `cat.method` 形态

```js
^(\S+?)[.\s](\S+?)(?:\s+(\{[\s\S]*\}))?$
```
兼容 `doc.create`（点分）和 `doc create`（空格分）两种。`\S+?` 非贪婪避免点号被吞。

### 6. AgentToolResult 必须有 `details` 字段

❌ `{content: [{type: "text", text: "..."}]}` —— 编译 TS2322 不过
✅ 走 `textResult(data)` 辅助函数 → 自动加 `details: data`

### 7. `registerTool` 必须传 `name` + `label` + `description` + `parameters` + `execute`

❌ 漏 `label` → TS2345 不过
✅ 完整样板在 `src/index.ts` 的 `register(api)` 里

### 8. `optional: true` + `group:plugins` 兼容性

✅ `optional: true` **不会**被 `group:plugins` 展开拦下，agent 仍能看到 tool
✅ manifest 标 `optional: true` 是**推荐**姿势（plugin 工具不影响 core tool 列表，但 group:plugins 仍展开）

### 9. collectionId 必须是真 UUID

❌ 短字符串 `"abc"` → outline API 报 `validation_error: collectionId: Invalid UUID` 400
✅ 标准 UUID 格式 `2539c4a2-1fa8-4f0e-900f-9a5c7f1f72ba`

### 10. `defaultCollectionId` 走 plugin config

doc.create 不传 `collectionId` 时 fallback 到 `cfg.defaultCollectionId`（在 `openclaw.json` 的 `plugins.entries.outline-wiki-openclaw-plugin.config` 段配）。

### 11. YAGNI 例外放行：`parentDocumentId` (0.3.0, 2026-06-08 11:00)

✅ **0.3.0+ `doc.create` / `doc.move` 透传 `parentDocumentId` 到 outline server**。
- 之前 YAGNI 拒绝：MVP 阶段没 caller 需要，纯字段透传，延迟实现。
- 例外触发场景（2026-06-08）：tester 跑测误判复盘时新建「用户与权限 误判复盘 v1」需要挂到「WTO - 质量与测试」容器下，**YAGNI 不该留到影响文档编排的地方**（Leo 拍板原话）。
- **YAGNI 仍保留**：`templateId` / `icon` / `color` / `append`（`doc.update` append 模式）等 outline 字段仍按 YAGNI 暂不实现——它们是"美化/装饰"诉求，不影响信息架构。
- **`doc.move` 语义扩**：之前是"移到其他 collection"，0.3.0+ 是"在 collection 内移动到某个父文档下"（同 collection 时配合 `parentDocumentId` 可重新归位；跨 collection 时不指定 `parentDocumentId` 则归到目标 collection 根）。
- **验证路径**：
  - path A（quick-test，plugin 源码直跑）✅：`documents.create` 返 `document.parentDocumentId == 7cb11ad8-33ca-4e40-afba-70383e5763a0`；`doc.move` 验证：revision 步进 + `document.parentDocumentId` 真落库
  - path B（agent 链路，tester 端）：`doc.move` 仅传 `id` + `collectionId` + `parentDocumentId` 把「用户与权限 误判复盘 v1」挂到「WTO - 质量与测试」容器下

### 12. 🚨 `doc.update` + `parentDocumentId` silent drop 根因 + 0.3.1 fail-fast fix (2026-06-08 11:30)

❌ **0.3.0 误设计**：`doc.update` 也接受 `parentDocumentId` 入参并盲目透传到 `documents.update` endpoint。**Server silent drop**：revision 2→3 步进，updatedAt 不变，document.parentDocumentId 仍为 null。**Caller 拿到 `ok: true` 但实际什么也没改**。
- **curl 端到端验证**（2026-06-08 11:25）：
  ```
  POST /api/documents.update {id, parentDocumentId}
  → response: {ok:true, data:{id, parentDocumentId: null, revision: 3, updatedAt: <STEP 1 时间>}}
  POST /api/documents.info {id}
  → response: {ok:true, data:{id, parentDocumentId: null, ...}}
  ```
- **根因（outline server 端行为）**：`documents.update` endpoint schema 不包含 `parentDocumentId` 字段。可能的 server 端实现：zod/joi schema 用 `.strict()` 拒绝未知字段，但 outline 的实现是 silently strip unknown 字段——这是最差的设计选择（应选 `.strict()` 返 400 让 caller 知道）。

✅ **0.3.1 fail-fast 修复**：`doc.update` 检测到 `parentDocumentId` 入参 → 立即返错指向 `doc.move`：
```json
{
  "error": "doc.update does not accept `parentDocumentId` — the outline server silently drops it. To reparent a document, use `doc.move` with the same collection and the new `parentDocumentId`. Example: doc.move {id, collectionId, parentDocumentId: '<new-parent-uuid>'}.",
  "hint": "documents.update's schema does not include parentDocumentId — outline server silently drops it (silent drop verified 2026-06-08). To reparent, use `doc.move` with the new `collectionId` and `parentDocumentId`. See README 踩坑清单 12 and SKILL.md 避坑清单 15."
}
```

**为什么 fail-fast 而非 auto-forward 到 documents.move**：auto-forward 会 mask 掉 server 端行为，未来 outline server 修 schema（把 parentDocumentId 加进 documents.update）时反而察觉不到。fail-fast 错误消失就是修复信号（跟 attachment.upload path 模式 fail-fast 同模式，踩坑清单 13）。

**端到端触发场景**：tester 跑测误判复盘时第一次试调 `doc.update {id, parentDocumentId}` 挂载容器 — silent fail, 误判复盘 v1 没出现在「质量与测试」容器下。改用 `doc.move` 才生效（tester 端到端验过，参见 tester memory 2026-06-08.md）。

**devclaw 0.3.0 path A 验证盲点教训**：0.3.0 验证矩阵只验 `documents.create` 真实改 parentDocumentId（✅），`doc.update` / `doc.move` 都**只验 plugin 端 `ok: true`**，**没验 server 端是否真的改**。`doc.update` 这条没验出 server 端 silent drop。**0.3.1 改 fail-fast 后验证 SOP 改**：不仅验 `ok: true`，还要 `documents.info` 拉一遍确认 `parentDocumentId` 字段真设了。

### 13. 🚨 0.4.0 defineToolPlugin + 12 named tools breaking change (2026-06-28)

❌ **旧版**：单一 dispatcher tool `outline_wiki`，所有调用走 `{category, method, args}` envelope:
```
outline_wiki call doc.list {"limit":5}                          # 字符串
outline_wiki call {"category":"doc","method":"list","args":{...}}  # 结构化
outline_wiki call "doc.list {\"limit\":5}"                       # 点分字符串
```

✅ **0.4.0 新版**：12 个独立 named tool，每个 tool 参数直接是 method 的 args (flat JSON object, 无 envelope):
```
outline_doc_list {limit:5}
outline_doc_get {id: "<uuid>"}
outline_doc_create {title, text, collectionId, ...}
outline_doc_update {id, text, ...}
outline_doc_delete {id, permanent?}
outline_doc_archive {id}
outline_doc_restore {id}
outline_doc_move {id, collectionId, parentDocumentId?}
outline_search_query {query, ...}
outline_collection_list {}
outline_collection_documents {id, ...}
outline_attachment_upload {name, url|path, ...}
```

**为什么换**:
1. **冷启动开销下降**: OpenClaw 冷启动 manifest 通过 `getToolPluginMetadata(entry)` 走 `toolPluginMetadataSymbol` 拿静态 metadata (不 load runtime code), 12 个 tool 的 schema 在 manifest 阶段就 resolve 完
2. **TypeBox schema 直接验证参数**: 弃用 `{category, method, args}` envelope, 减少一层间接, 12 个 tool 各自有独立 TypeBox schema, 字段错误 (e.g. 漏 `id`) 在调用前就拒绝
3. **agent prompt 路由更直观**: tool 列表从 1 个巨型 dispatcher → 12 个语义清晰的小 tool, agent 选 tool 更准

**CLI 不变**: `outline-tool doc.list '{"limit":5}'` 形态保留 (CLI 不接 OpenClaw 工具系统, 走 category.method envelope 跟 OpenCode/终端习惯一致). OpenCode/终端用户**完全无感**.

**OpenClaw agent 用户**: 需要迁移 (踩坑清单 13 顶部). 步骤:
1. 把所有 `outline_wiki call <category>.<method> {args}` 替换成对应 named tool (args 平铺)
2. 把所有 `outline_wiki call {category, method, args}` 结构化 envelope 替换成对应 named tool
3. 重启 gateway 让 12 个新 tool 注册 (旧 `outline_wiki` 注册时已被覆盖)
4. **CLI 调用方完全不动** (`outline-tool` 形态没变)

**回滚**: 0.4.0 是 breaking change, 如要回滚到 0.3.x 需要 `npm install @cereb/outline-wiki-openclaw-plugin@0.3.2` + restart gateway. 0.3.x 的 `outline_wiki` dispatcher 形态保留可用.

---

## ⚙️ OpenClaw 配置

token 注入（**dev 模式临时，明文写**）：
```json
{
  "plugins": {
    "entries": {
      "outline-wiki-openclaw-plugin": {
        "enabled": true,
        "config": {
          "apiToken": "<Bearer token>",
          "endpoint": "https://your-outline.example.com/api",
          "mcpEndpoint": "https://your-outline.example.com/mcp",
          "defaultCollectionId": "2539c4a2-1fa8-4f0e-900f-9a5c7f1f72ba"
        }
      }
    }
  }
}
```

**正式部署应改 SecretRef**（`apiToken` 是敏感凭证）。改 `config` 段后必须 restart gateway（见踩坑 3）。

**token 来源**（dev 模式）：`~/.openclaw/workspace/config/mcporter.json` 的 `mcpServers.outline.headers.Authorization` 去掉 `Bearer ` 前缀。

---

## 📂 文件结构

```
~/dev/projects/outline-wiki-openclaw-plugin/
├── package.json              # @cereb/outline-wiki-openclaw-plugin, version 0.4.0
├── openclaw.plugin.json      # id=outline-wiki-openclaw-plugin, contracts.tools=[12 named tools]
├── tsconfig.json
├── README.md                 # 本文件
├── dist/                     # 编译产物（不要 git）
│   ├── index.js              # defineToolPlugin entry + 12 tool handlers
│   ├── index.d.ts
│   └── cli.js                # outline-tool 二进制（CLI 不变）
├── src/
│   ├── index.ts              # 全部 plugin 代码（~700 行, defineToolPlugin + 12 tool handlers）
│   └── cli.ts                # outline-tool CLI（保持 category.method envelope 形态）
├── tools/
│   └── quick-test.js         # 绕开 gateway 的 dev 验证脚本（接受 tool name + args JSON）
└── node_modules/             # 通过 npm install（不要 git）
```

**单文件 plugin 设计**（YAGNI）：MVP 阶段 12 个 tool + handler 在 1 个文件里仍然 < 700 行, 不拆 mcp/ 子目录. 等 method > 20 再考虑.

---

## 🎯 下一步候选（按 pilot 优先级）

按 pilot 推荐的优先级（pilot 是最大主要使用者）：

| 选项 | 范围 | 估时 | 备注 |
|---|---|---|---|
| **`user.list`** | 低优 | ~0.5h | admin 场景低频 |
| **`doc.publish`** | — | N/A | outline 源码里没这个独立端点，create/update 传 `publish: true` 即可（已实现）|
| **`search.filter` / `search.advanced`** | 低优 | ~1h | 高级搜索（filter by author/date/collection）|
| **git init + commit** | 收口 | 0.5h | 沉淀项目基线（目前未 init git） |
| **改 SecretRef** | 安全 | 1h | 正式部署前必做，dev 模式明文 token 是临时方案 |

**已完成 12 个 named tool 闭环**（4 个 category, 0.4.0+）：`outline_doc_{list,get,create,update,delete,archive,restore,move}` + `outline_search_query` + `outline_collection_{list,documents}` + `outline_attachment_upload`.

---

## 🔍 验证场景参考

- **example API**：`https://your-outline.example.com/api`
- **常用 collectionId**：
  - WTO: `2539c4a2-1fa8-4f0e-900f-9a5c7f1f72ba`
  - SSSS: `cad29122-ff32-4b03-88cb-f7a8a15c744d`
  - ISF: `9991482d-d6d6-401a-a64a-e167c21d5d4a`
  - EWLD: `f5f0102c-0bc4-4725-bf6e-73e3f5b52d42`
  - PTC HK: `b121a690-ed6a-44e3-abfa-d3128ea47634`
  - 架构设计: `c6fe1b10-a61e-4c6c-85d8-3e4b7302f043`
  - 项目索引: `3bf73717-9aee-4f7c-bbc5-8252b5d4e5c5`
  - 平台配置: `e76d7490-a3fa-4439-9bc8-23e3071af186`
  - 团队规范: `5f19dc6f-ba0e-4789-81b0-00af8a20fe49`

---

## 🤝 贡献指南（给自己 + 别人接手）

1. 改 `src/index.ts` → 跑 `npm run typecheck && npm run build && npx openclaw plugins build --entry ./dist/index.js && npx openclaw plugins validate --entry ./dist/index.js` → **四者必须过**
2. 跑 Step 3-4-5（pack + install + restart + 验证）
3. **必须** 双路径验证（quick-test + agent 链路）
4. 写新 tool：在 `defineToolPlugin({ tools: (tool) => [...] })` 数组里加 `tool({ name: "outline_<category>_<method>", ... })` 块 + 对应 handler 函数
5. 加新 category：在 `tools` 数组里加新 tool 块 + 对应 handler 函数 + TypeBox schema
6. 任何**新的踩坑**立刻更新本 README "踩坑清单" 段（防下次再犯）
7. 重大决策（如改命名、改包名、改架构、breaking change）写到 `~/.openclaw/workspace-devclaw/MEMORY.md`

---

## 📌 已知问题 / 后续清理

### Smoke test 文档清理
- `doc.delete` 已实现（0.1.1+）—— 两份 "(delete me)" 文档已用两步走流程清掉（trash + permanent）
- 详见 2026-06-08 调试日志（用真 token + 升级 scope 后端到端验证）

### token 明文写
`~/.openclaw/openclaw.json` 的 `apiToken` 是 dev 模式明文（从 mcporter.json 复制）。正式部署前必须改 SecretRef。

### 项目未 git init
待评估是否需要。MVP 阶段没必要（devclaw 工作流基本是单文件即改即用）。

### 无 SKILL.md
✅ **0.4.0 修复**: `skills/outline-wiki/SKILL.md` 已存在, 描述触发词 (找 outline 上 XXX 文档 / 读一下 wiki / 在 outline 上写一篇 / 改一下 / 删一下 / 归档 / 在 outline 上传一张图片) + 12 named tool 速查表 + 避坑清单 + collectionId 速查. devclaw / tester / pilot 通过 skill 自动发现 12 个 native tool 的能力.

### 0.4.0 升级注意 (breaking change)
升级到 0.4.0 后, 旧 `outline_wiki` tool 已删除, 需重启 gateway 让 12 个新 tool 注册. 升级后跑 `npx openclaw plugins inspect outline-wiki-openclaw-plugin --runtime` 确认新 tool 列表.

---

## 🔗 相关文档

- `~/.openclaw/workspace-devclaw/MEMORY.md` —— 命名拍板 + install 根因 + MVP 闭环沉淀
- `skills/outline-wiki/SKILL.md` —— 12 named tool 速查 + 避坑清单 + 场景化调用示例 + collectionId 速查
- `~/.openclaw/workspace/config/outline-mcp-quickref.md` —— mcporter 通道快速接入（被本 plugin 替代前为 mcporter 兜底用）
- wecom 范式参考（0.3.x 旧 dispatcher 形态）：`~/.openclaw/npm/node_modules/@wecom/wecom-openclaw-plugin/dist/src/mcp/tool.js`（`createWeComMcpTool` 模式）
- `defineToolPlugin` 参考：`node_modules/openclaw/docs/plugins/tool-plugins.md`
