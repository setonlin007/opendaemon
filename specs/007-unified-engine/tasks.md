# Tasks 007: 统一引擎接入

## Dependency Graph

```
T1 (config.mjs 写入) → T2 (API 端点) → T5 (前端 UI)
                     → T3 (内置工具)  → T5
T4 (Claude SDK 配置) → T5
                     → T6 (验证测试)
```

## Stage 1: 后端基础

### T1: 配置持久化 (lib/config.mjs)
**Depends on:** nothing

- [ ] 新增 `saveEngines(engines)` — 读取 config.json → 替换 engines → 写回 → 热更新
- [ ] 新增 `maskApiKey(key)` — 脱敏处理（保留前3后4位）
- [ ] 新增 `getEngineFullConfig(id)` — 返回完整配置（API Key 脱敏）
- [ ] 写入前复用现有 validation 逻辑
- [ ] 写入使用 writeFileSync（单用户场景足够）

### T2: API 端点 (server.mjs)
**Depends on:** T1

- [ ] `GET /api/engines/:id` — 返回单个引擎完整配置（脱敏）
- [ ] `POST /api/engines` — 添加引擎，验证 id 不重复
- [ ] `PUT /api/engines/:id` — 编辑引擎，API Key 为 `***` 时保留原值，id 不可改
- [ ] `DELETE /api/engines/:id` — 删除引擎，至少保留一个
- [ ] `POST /api/engines/:id/test` — 连接测试
  - openai 类型：发送简单请求到 baseUrl/chat/completions，返回 ok + latency
  - claude-sdk 类型：验证 API Key 有效性
- [ ] 更新 `GET /api/engines` 返回 category 字段（agentic/api）

### T3: Type B 内置工具 (lib/builtin-tools.mjs)
**Depends on:** nothing

- [ ] 新建 `lib/builtin-tools.mjs`
- [ ] 实现 `read_file` — 读取文件内容，限制在项目目录和 data/ 目录
- [ ] 实现 `write_file` — 写入文件，限制在 data/ 目录
- [ ] 实现 `list_directory` — 列出目录内容
- [ ] 实现 `run_code` — 执行 JS/Python 代码，subprocess + timeout
- [ ] 实现 `http_request` — 通用 HTTP 请求，支持 GET/POST/PUT/DELETE
- [ ] 导出 OpenAI function calling 格式的工具定义
- [ ] 导出 `executeBuiltinTool(name, args)` 执行函数
- [ ] 在 `engine-openai.mjs` 中合并内置工具和 MCP 工具
- [ ] tool-use loop 根据 tool name 分发（内置 vs MCP）

### T4: Claude SDK 可配置 (lib/engine-claude.mjs)
**Depends on:** nothing

- [ ] 从 engine config 读取 `model` 字段，传入 SDK options.model
- [ ] 从 engine config 读取 `provider.apiKey`，传入 options.env.ANTHROPIC_API_KEY
- [ ] 从 engine config 读取 `provider.platform`，设置对应 env vars
  - bedrock: CLAUDE_CODE_USE_BEDROCK=1
  - vertex: CLAUDE_CODE_USE_VERTEX=1
  - foundry: CLAUDE_CODE_USE_FOUNDRY=1
- [ ] 从 engine config 读取 `options.effort`，传入 SDK options
- [ ] 从 engine config 读取 `options.maxBudgetUsd`，传入 SDK options
- [ ] 无配置时保持现有行为（向后兼容）

## Stage 2: 前端

### T5: 引擎管理 UI (public/index.html)
**Depends on:** T2, T3, T4

**CSS:**
- [ ] 引擎管理面板样式（.engines-overlay, .engines-panel）
- [ ] 引擎卡片样式（分 Agentic / API 两组展示）
- [ ] 表单样式（类型选择、动态字段、预设模板卡片）
- [ ] 连接测试状态样式（loading / success / error）

**HTML:**
- [ ] 侧边栏添加"引擎管理"入口按钮
- [ ] 引擎管理 overlay 骨架

**JS — 引擎列表:**
- [ ] `openEnginesPanel()` — 获取引擎列表并渲染
- [ ] `renderEnginesList(engines)` — 按 Agentic / API 分组渲染引擎卡片
- [ ] `deleteEngine(id)` — 确认后删除
- [ ] `testEngine(id)` — 调用测试接口，显示结果

**JS — 添加/编辑表单:**
- [ ] `showEngineForm(engine?)` — 渲染表单，有 engine 时为编辑模式
- [ ] 类型选择器：Agentic / API，切换显示不同字段
- [ ] Type A 表单：label, icon, model(下拉), apiKey, platform(下拉), effort(下拉), maxBudgetUsd
- [ ] Type B 表单：label, icon, baseUrl, apiKey, model(文本)
- [ ] `saveEngine()` — 调用 POST/PUT，成功后刷新列表

**JS — 预设模板:**
- [ ] 预设数据：GPT-4o, Gemini 2.5 Pro, DeepSeek V3, Kimi K2, Claude Opus, Claude Sonnet, Ollama
- [ ] 点击预设 → 自动填充表单，用户只需补 API Key

**JS — 对话内引擎切换:**
- [ ] 对话头部引擎名可点击
- [ ] 展开引擎下拉（带 🤖/🔌 分类标识）
- [ ] 选择后 PATCH conversation engine_id
- [ ] 更新本地状态和 UI

## Stage 3: 验证

### T6: 端到端验证
**Depends on:** T5

- [ ] 通过 UI 添加一个 API 引擎（如 DeepSeek），验证连接测试通过
- [ ] 用新添加的引擎发起对话，验证正常回复
- [ ] 用 Type B 引擎测试内置工具（生成文件、读取文件、列目录）
- [ ] 编辑引擎配置（改 model），验证立即生效
- [ ] 删除引擎，验证至少保留一个
- [ ] 验证 Claude SDK 引擎配置 API Key + model 后正常工作
- [ ] 验证对话内切换引擎功能
- [ ] 验证 config.json 持久化正确（重启后配置仍在）
