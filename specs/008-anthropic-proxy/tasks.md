# Tasks 008: Agentic 引擎本地代理

## Dependency Graph

```
T1 (编码工具) → T2 (协议翻译) → T3 (代理服务器) → T4 (插件改造) → T5 (前端) → T6 (验证)
```

## Stage 1: 核心代理

### T1: 编码/解码工具
**Depends on:** nothing
**Effort:** 0.5h

- [ ] 在 lib/anthropic-proxy.mjs 中实现 `encodeBackendConfig()` / `decodeBackendConfig()`
- [ ] base64 编码 `{ url, key, format, model }` JSON

### T2: 协议翻译模块 (lib/anthropic-openai-converter.mjs)
**Depends on:** nothing
**Effort:** 4-6h（最复杂的部分）

**请求转换:**
- [ ] `convertRequest(anthropicReq)` → OpenAI Chat Completions 请求体
- [ ] system prompt 转换（string/array → messages[0]）
- [ ] messages 转换（content blocks → text/image/tool）
- [ ] tool_use content block → assistant message + tool_calls
- [ ] tool_result content block → role=tool message
- [ ] tools schema 转换（Anthropic → OpenAI function calling）
- [ ] max_tokens / model / stream 直传

**流式响应转换:**
- [ ] `createStreamConverter()` — 返回 Transform stream
- [ ] 生成 Anthropic 格式的 message_start 事件
- [ ] delta.content → content_block_delta (type=text_delta)
- [ ] delta.tool_calls 开始 → content_block_start (type=tool_use)
- [ ] delta.tool_calls arguments → content_block_delta (type=input_json_delta)
- [ ] delta.tool_calls 结束 → content_block_stop
- [ ] finish_reason=stop → message_delta (stop_reason=end_turn)
- [ ] finish_reason=tool_calls → message_delta (stop_reason=tool_use)
- [ ] usage → message_delta 中的 usage 字段
- [ ] [DONE] → message_stop 事件
- [ ] 跟踪 content block index（文本和工具调用交替出现）

**错误处理:**
- [ ] 上游错误转换为 Anthropic error 格式 `{ type: "error", error: { type, message } }`
- [ ] 超时处理

### T3: 代理服务器 (lib/anthropic-proxy.mjs)
**Depends on:** T1, T2
**Effort:** 2-3h

- [ ] `startProxy()` → `{ port, stop }` — 启动本地 HTTP 服务器
- [ ] 监听 `127.0.0.1` 随机端口
- [ ] 处理 `POST /v1/messages` 路由
- [ ] 从 `x-api-key` Header 解码后端配置
- [ ] format=anthropic → 直通转发（替换认证头，保持 SSE 流）
- [ ] format=openai → 翻译请求 → fetch 到目标 → 翻译响应流
- [ ] 非流式请求支持（整体翻译返回）
- [ ] 进程级单例（`ensureProxy()` 只启动一次）
- [ ] graceful shutdown（server 停止时关闭代理）

### T4: 插件改造 (plugins/engine-claude-sdk/index.mjs)
**Depends on:** T3
**Effort:** 1-2h

- [ ] handleChat 中检测 `engine.provider.baseUrl`
- [ ] 有 baseUrl → 启动代理 → 编码配置 → 设置 env
- [ ] 有 apiKey 无 baseUrl → 直接设置 ANTHROPIC_API_KEY
- [ ] 都没有 → OAuth 模式
- [ ] test() 函数适配：自定义接口时通过代理测试
- [ ] streamSimple() 适配（反射也走代理）

## Stage 2: 前端

### T5: 前端认证方式选择
**Depends on:** T4
**Effort:** 2-3h

- [ ] Agentic 引擎表单增加 authMode 单选：OAuth / API Key / Custom URL
- [ ] OAuth 模式：只显示 Model + Effort
- [ ] API Key 模式：显示 Key + Model + Effort + Budget
- [ ] Custom 模式：显示 URL + Key + Model + Format(openai/anthropic) + Effort
- [ ] 新引擎面板的 Agentic 类型选择后展示 authMode 选择
- [ ] 编辑引擎时根据现有配置回填 authMode
- [ ] 连接测试按钮对三种模式都生效

## Stage 3: 验证

### T6: 端到端验证
**Depends on:** T5
**Effort:** 1h

- [ ] 验证 OAuth 模式：无配置，正常对话 + 工具调用
- [ ] 验证 API Key 模式：填 Anthropic Key，正常对话 + 工具调用
- [ ] 验证 Custom + OpenAI 格式：配 OpenRouter URL + Key，对话 + 工具调用
- [ ] 验证 Custom + Anthropic 格式：配 Anthropic 兼容网关，对话
- [ ] 验证流式输出正确性（文本 + 工具调用交替）
- [ ] 验证 session resume 在代理模式下工作
- [ ] 验证错误情况：URL 不可达、Key 无效、模型不存在
- [ ] 验证代理不影响 Type B (API) 引擎
