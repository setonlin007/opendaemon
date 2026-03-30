# Spec 008: Agentic 引擎本地代理

## Problem

Claude Agent SDK 只能与 Anthropic Messages API 格式通信。用户如果想通过 OpenRouter、自定义网关等 OpenAI 兼容接口使用 Claude 的完整 Agent 能力（内置工具、MCP、extended thinking、session resume），无法直接配置，只能退化为 Type B API 引擎。

## Goals

1. **本地代理服务器** — 在 OpenDaemon 进程内启动本地 HTTP 代理，做 Anthropic ↔ OpenAI 协议翻译
2. **支持任意 API 端点** — 用户填 URL + Key 即可让 Agentic 引擎连接任意后端
3. **三种认证方式** — OAuth / API Key / 自定义接口（URL+Key），前端可选
4. **Anthropic 直通** — 如果目标是 Anthropic 兼容端点，直接转发不翻译
5. **向后兼容** — 现有 OAuth 和 API Key 模式不受影响

## Non-Goals (this phase)

- 支持非 Claude 模型通过 Agentic 引擎（如用 GPT-5 走 Agent SDK）
- 代理缓存 / 请求去重
- 多代理实例负载均衡
- WebSocket / gRPC 协议支持

## Architecture

```
用户配置: { baseUrl, apiKey, format }
               ↓
Claude Agent SDK
  env.ANTHROPIC_BASE_URL = http://127.0.0.1:{port}
  env.ANTHROPIC_API_KEY = base64({url, key, format, model})
               ↓
本地代理 (lib/anthropic-proxy.mjs)
  POST /v1/messages → 解码 → 路由
               ↓
  ┌─ format=anthropic → 直通转发（替换认证头）
  └─ format=openai → 协议翻译
       ├─ 请求: Anthropic Messages → OpenAI Chat Completions
       ├─ 响应: OpenAI SSE → Anthropic SSE
       └─ 工具调用: 格式互转
               ↓
实际 API (OpenRouter / Bedrock / DeepSeek / Ollama / 任意)
```

## User Stories

### US-1: 通过 OpenRouter 使用 Claude Agent

作为用户，我要通过 OpenRouter 使用 Claude 的完整 Agent 能力。

- 在引擎管理面板添加 Agentic 引擎
- 认证方式选"自定义接口"
- 填写 OpenRouter 的 URL + Key + Model
- 连接测试通过
- 对话时拥有完整的 Agent SDK 能力（MCP、内置工具、session resume）

### US-2: 通过 API Key 直连 Anthropic

作为用户，我有 Anthropic API Key，不想用 OAuth。

- 认证方式选"API Key"
- 填写 Key
- 直连 Anthropic API，不经过代理

### US-3: 保持 OAuth 模式

作为用户，我已经 `claude login` 过了，什么都不想配。

- 认证方式选"OAuth"
- 零配置，保持现有行为

## Technical Design

### 1. 本地代理 (lib/anthropic-proxy.mjs)

- Node.js native http 服务器
- 随机端口监听 `127.0.0.1`（仅本机可访问）
- 进程级单例：首次使用时启动，server 关闭时停止
- 端点：`POST /v1/messages`

请求处理流程：
1. 从 `x-api-key` Header 解码 base64 JSON → `{ url, key, format, model }`
2. format=anthropic → 直通转发
3. format=openai → 调用 converter 翻译请求 → 转发 → 翻译响应
4. 流式响应：逐 chunk 翻译并转发

### 2. 协议翻译 (lib/anthropic-openai-converter.mjs)

#### 请求转换

```
Anthropic Messages API          →    OpenAI Chat Completions API
─────────────────────────────────────────────────────────────────
system (string/array)           →    messages[0] role=system
messages[].role                 →    messages[].role (user/assistant)
messages[].content (blocks)     →    messages[].content (string/array)
  - text block                  →    text string
  - image block                 →    image_url content part
  - tool_use block              →    assistant message + tool_calls
  - tool_result block           →    role=tool message
tools[] (Anthropic schema)      →    tools[] (OpenAI function schema)
max_tokens                      →    max_tokens
stream                          →    stream
model                           →    model (from encoded config)
```

#### 流式响应转换

```
OpenAI SSE                      →    Anthropic SSE
─────────────────────────────────────────────────────────────────
(stream start)                  →    event: message_start
delta.content                   →    event: content_block_delta (text_delta)
delta.tool_calls[].id           →    event: content_block_start (tool_use)
delta.tool_calls[].arguments    →    event: content_block_delta (input_json_delta)
finish_reason=stop              →    event: message_delta (stop_reason=end_turn)
finish_reason=tool_calls        →    event: message_delta (stop_reason=tool_use)
usage                           →    event: message_delta (usage)
[DONE]                          →    event: message_stop
```

### 3. 编码/解码工具

```js
function encodeBackendConfig({ url, key, format, model }) {
  return Buffer.from(JSON.stringify({ url, key, format, model })).toString('base64');
}
function decodeBackendConfig(encoded) {
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8'));
}
```

### 4. 插件改造 (plugins/engine-claude-sdk/index.mjs)

handleChat 中增加代理逻辑：

```
if provider.baseUrl 存在:
  启动/获取代理端口
  编码 {url, key, format, model} → base64
  设置 ANTHROPIC_BASE_URL = http://127.0.0.1:{port}
  设置 ANTHROPIC_API_KEY = encoded
elif provider.apiKey 存在:
  设置 ANTHROPIC_API_KEY = apiKey
else:
  OAuth 模式，不设置 env
```

### 5. 前端表单

Agentic 引擎的认证方式选择：

```
○ OAuth（已登录 Claude，无需配置）
    → 只显示 Model + Effort

○ API Key
    → API Key 输入框
    → Model + Effort + Budget

○ 自定义接口（URL + Key）
    → Base URL 输入框
    → API Key 输入框
    → Model 输入框
    → Format 选择（OpenAI 兼容 / Anthropic 兼容）
    → Effort
```

## Config Format

```json
{
  "id": "claude-openrouter",
  "type": "claude-sdk",
  "label": "Claude via OpenRouter",
  "model": "anthropic/claude-sonnet-4",
  "provider": {
    "authMode": "custom",
    "baseUrl": "https://openrouter.ai/api/v1",
    "apiKey": "sk-or-...",
    "format": "openai"
  },
  "options": {
    "effort": "high"
  }
}
```

authMode 值: `"oauth"` | `"apikey"` | `"custom"`
