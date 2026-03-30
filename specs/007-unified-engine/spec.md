# Spec 007: 统一引擎接入

## Problem

OpenDaemon 当前的引擎接入存在以下问题：

1. **配置靠手动编辑** — 用户需要手动编辑 config.json 添加引擎，门槛高且容易出错。
2. **Claude SDK 配置死板** — 只支持 OAuth 模式，不支持配置 API Key、模型选择、云平台切换。
3. **Type B 引擎能力缺失** — 纯 API 引擎（Gemini、Kimi 等）没有文件操作、代码执行等基础 Agent 能力，只能靠 MCP 扩展工具。
4. **引擎分类不清晰** — 代码和 UI 上没有区分 Agentic 引擎和 API 引擎，用户无法感知能力差异。
5. **无连接验证** — 配置引擎后无法测试是否可用，出问题只能看报错。

## Goals

1. **前端引擎管理** — 用户在页面上完成引擎的添加、编辑、删除、测试，无需编辑 config.json。
2. **两类引擎分类** — 产品和 UI 上清晰区分 Agentic 引擎（自带 Agent 能力）和 API 引擎（OpenDaemon 提供 Agent 能力）。
3. **Claude SDK 可配置** — 支持 API Key、模型选择（Opus/Sonnet/Haiku）、云平台（Anthropic/Bedrock/Vertex）、预算控制。
4. **API 引擎内置工具** — 为 Type B 引擎内置文件读写、目录浏览、代码执行、HTTP 请求等基础能力。
5. **预设模板** — 提供常见引擎的预设配置，用户只需填 API Key 即可接入。
6. **连接测试** — 配置完成后一键验证引擎是否可用。

## Non-Goals (this phase)

- 引擎使用量统计 / 费用追踪
- 多引擎并行调用（同时请求多个引擎取最优结果）
- 引擎 fallback 自动降级
- 引擎权限控制（限制某些引擎的工具使用）

## Core Concept: 两类引擎

### Type A — Agentic 引擎

> 引擎自带 Agent 能力，OpenDaemon 作为编排层

- 引擎本身具备文件操作、代码执行、浏览器等能力
- MCP 工具是扩展能力（消息通道、定时任务等）
- 代表：Claude Agent SDK、OpenClaw
- 需要为每种引擎编写专属 adapter

### Type B — API 引擎

> 引擎只有对话能力，OpenDaemon 作为 Agent 框架

- 引擎通过 OpenAI 兼容接口提供 LLM 能力
- Agent 能力由 OpenDaemon 内置工具 + MCP 扩展提供
- 代表：OpenAI GPT-4o、Gemini、DeepSeek、Kimi、Ollama
- 配置 baseUrl + apiKey + model 即可接入

## User Stories

### US-1: 添加引擎

作为用户，我要在页面上添加新的 AI 引擎。

- 点击侧边栏"引擎管理"按钮，打开引擎管理面板
- 选择引擎类型：Agentic 引擎 或 API 引擎
- 可从预设模板中一键选择（GPT-4o、Gemini、DeepSeek 等），只需填 API Key
- 也可自定义配置任意 OpenAI 兼容接口
- 填完后点击"测试连接"验证可用性
- 保存后立即生效，无需重启

### US-2: 编辑和删除引擎

作为用户，我要管理已有的引擎配置。

- 引擎列表展示所有已配置的引擎，显示类型标签、状态
- 点击编辑进入表单，API Key 脱敏显示
- 编辑时不修改 API Key 字段则保持原值
- Engine ID 不可修改（已有对话引用）
- 删除时确认，且至少保留一个引擎

### US-3: 对话内切换引擎

作为用户，我要在对话中随时切换引擎。

- 对话头部显示当前引擎，点击可展开引擎选择器
- 选择新引擎后，后续消息使用新引擎回复
- 历史消息不受影响

### US-4: Type B 引擎的 Agent 能力

作为用户，我用 API 引擎（如 Gemini）也能执行文件操作等 Agent 任务。

- 对 Gemini 说"帮我生成一个 helloworld.txt 文件"→ 成功生成并提供下载链接
- 对 Kimi 说"读取 config.json 的内容"→ 成功返回文件内容
- 对 DeepSeek 说"列出 data 目录下的文件"→ 成功列出
- 工具调用体验与 Claude SDK 一致

## UI Design

### 引擎管理面板

```
┌─────────────────────────────────────────────────┐
│  ⚙️ 引擎管理                              ✕    │
├─────────────────────────────────────────────────┤
│                                                 │
│  ┌─ 🤖 Agentic 引擎 ────────────────────────┐  │
│  │                                           │  │
│  │  [C] Claude Opus          ✅  [编辑][删除]│  │
│  │      claude-opus-4-6 · Anthropic          │  │
│  │                                           │  │
│  └───────────────────────────────────────────┘  │
│                                                 │
│  ┌─ 🔌 API 引擎 ────────────────────────────┐  │
│  │                                           │  │
│  │  [K] Kimi K2              ✅  [编辑][删除]│  │
│  │      OpenRouter · moonshotai/kimi-k2      │  │
│  │                                           │  │
│  │  [G] Gemini 2.5 Pro       ✅  [编辑][删除]│  │
│  │      OpenRouter · google/gemini-2.5-pro   │  │
│  │                                           │  │
│  └───────────────────────────────────────────┘  │
│                                                 │
│  [+ 添加引擎]                                   │
│                                                 │
├─────────────────────────────────────────────────┤
│  添加引擎                                       │
│                                                 │
│  选择类型:                                      │
│  ┌──────────────┐  ┌──────────────────┐         │
│  │ 🤖 Agentic   │  │ 🔌 API 引擎      │         │
│  │ 自带Agent能力 │  │ OpenDaemon提供能力│         │
│  └──────────────┘  └──────────────────┘         │
│                                                 │
│  快速添加:                                      │
│  [GPT-4o] [Gemini] [DeepSeek] [Kimi] [Ollama]  │
│                                                 │
│  名称:     [ Gemini 2.5 Pro          ]          │
│  图标:     [ G ]                                │
│  Base URL: [ https://openrouter.ai/api/v1 ]     │
│  API Key:  [ sk-or-v1-***            ]          │
│  Model:    [ google/gemini-2.5-pro   ]          │
│                                                 │
│  [测试连接]  [保存]                              │
│                                                 │
└─────────────────────────────────────────────────┘
```

### 对话内引擎切换

```
┌─────────────────────────────────────────┐
│  [C] Claude Opus ▾                      │
│  ├─ 🤖 [C] Claude Opus      ✓          │
│  ├─ 🔌 [K] Kimi K2                     │
│  └─ 🔌 [G] Gemini 2.5 Pro              │
└─────────────────────────────────────────┘
```

引擎选择器中用 🤖/🔌 图标区分两类引擎。

## Technical Design

### 1. 配置层 (lib/config.mjs)

新增函数：
- `saveEngines(engines)` — 验证并写入 config.json，触发热更新
- `maskApiKey(key)` — 返回脱敏后的 key（`sk-***...abc`）
- `getEngineFullConfig(id)` — 返回完整配置（含脱敏 key）

### 2. API 层 (server.mjs)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/engines | 列表（已有，增加 category 字段） |
| GET | /api/engines/:id | 单个详情（脱敏） |
| POST | /api/engines | 添加 |
| PUT | /api/engines/:id | 编辑 |
| DELETE | /api/engines/:id | 删除 |
| POST | /api/engines/:id/test | 连接测试 |

### 3. Type B 内置工具 (lib/builtin-tools.mjs)

新建文件，为 API 引擎提供内置 Agent 工具：

```js
export const BUILTIN_TOOLS = [
  {
    name: "read_file",
    description: "Read the content of a file",
    parameters: { path: "string" }
  },
  {
    name: "write_file",
    description: "Write content to a file, creating it if needed",
    parameters: { path: "string", content: "string" }
  },
  {
    name: "list_directory",
    description: "List files and directories at the given path",
    parameters: { path: "string" }
  },
  {
    name: "run_code",
    description: "Execute JavaScript or Python code and return output",
    parameters: { language: "string", code: "string" }
  },
  {
    name: "http_request",
    description: "Make an HTTP request",
    parameters: { method: "string", url: "string", headers: "object", body: "string" }
  }
];
```

在 `engine-openai.mjs` 中合并内置工具和 MCP 工具，tool-use loop 里根据 name 分发执行。

### 4. Claude SDK 配置传入 (lib/engine-claude.mjs)

从 engine config 读取并传入 SDK options：

```js
const options = {
  model: engine.model,                    // 模型选择
  env: {
    ...process.env,
    ANTHROPIC_API_KEY: engine.provider?.apiKey,  // API Key
  },
  effort: engine.options?.effort || "high",
  maxBudgetUsd: engine.options?.maxBudgetUsd,
};
```

### 5. 前端 (public/index.html)

- CSS：引擎管理面板样式，引擎卡片、表单、预设模板
- HTML：引擎管理 overlay
- JS：CRUD 操作、动态表单、连接测试、引擎切换器
