# Plan 002: MCP Capability Layer

> Implementation blueprint for Phase 1 — Python MCP Server + tool-bridge rewrite + channel abstraction

## Overview

将 Jarvis 的核心能力（web_search、send_message、notify、reminder、cron_task）迁移为标准 MCP Server，同时重写 server.mjs 的 OpenAI tool-bridge 为长进程模式，实现两个引擎统一的工具调用体验。

## File Plan

### New Files

```
mcp/
├── server.py              # MCP Server 入口，注册所有 tools
├── requirements.txt       # Python 依赖
├── channels/
│   ├── __init__.py        # Channel 工厂：from config → channel instances
│   ├── base.py            # Channel 抽象基类（send + health_check）
│   ├── bark.py            # Bark 推送通道
│   ├── feishu.py          # 飞书 Bot API 通道
│   └── wechat.py          # WeChat HTTP bridge 通道
├── tools/
│   ├── __init__.py        # 统一注册入口
│   ├── web_search.py      # DuckDuckGo 搜索
│   ├── send_message.py    # 统一消息发送
│   ├── notify.py          # Bark 紧急推送
│   ├── reminder.py        # 一次性定时提醒
│   └── cron_task.py       # 周期性定时任务
└── data/                  # 运行时数据（gitignored）
    ├── reminders.json
    └── cron_tasks.json
```

### Modified Files

```
server.mjs                 # 重写 buildMCPTools() → 长进程 MCP bridge
                           # 新增 MCP Server 进程管理（spawn/kill/restart）
lib/config.mjs             # 新增 MCP channels 配置验证
config.example.json        # 新增 MCP + channels 配置示例
.gitignore                 # 新增 mcp/data/
```

## Architecture Detail

### 1. MCP Server (Python)

使用 `mcp` Python SDK（`pip install mcp`），stdio 传输模式。

```python
# mcp/server.py 核心结构
from mcp.server import Server
from mcp.server.stdio import stdio_server

server = Server("opendaemon")

# 注册 tools
@server.list_tools()
async def list_tools():
    return [web_search_tool, send_message_tool, notify_tool, reminder_tool, cron_task_tool]

@server.call_tool()
async def call_tool(name, arguments):
    return dispatch(name, arguments)

# 启动
async def main():
    channels = init_channels(config)     # 从 stdin 初始化消息读取 config
    restore_reminders(channels)           # 恢复持久化的定时器
    restore_cron_tasks(channels)          # 启动 cron 调度器
    async with stdio_server() as (read, write):
        await server.run(read, write, server.create_initialization_options())
```

**Config 传递**: server.mjs spawn 时通过环境变量 `OPENDAEMON_CONFIG` 传入 JSON 序列化的 channel 配置。MCP Server 启动时解析并初始化 channels。

### 2. Channel 抽象层

从 Jarvis 精简迁移，只保留发送能力（P1 不做消息接收）。

```python
# mcp/channels/base.py
class Channel(ABC):
    name: str
    config: dict

    @abstractmethod
    def send(self, target: str, content: str) -> bool: ...

    def health_check(self) -> dict: ...
```

**Channel 实现对比（Jarvis → OpenDaemon）：**

| | Jarvis | OpenDaemon P1 |
|---|---|---|
| **Bark** | send only, urllib | send only, urllib（直接迁移） |
| **Feishu** | WebSocket 收 + REST 发 | REST 发 only（去掉 WebSocket 接收） |
| **WeChat** | 轮询收 + HTTP POST 发 | HTTP POST 发 only（去掉轮询接收） |
| **基类** | 收/发/健康检查/去重 | 发/健康检查 only |

### 3. Tool-Bridge 重写（server.mjs）

当前 `buildMCPTools()` 使用 `execFileSync` 每次 spawn 子进程。需要改为：

```
server.mjs 启动
    │
    ├── spawn("python", ["mcp/server.py"]) → 长驻子进程
    │     stdin/stdout ← JSON-RPC over stdio
    │
    ├── 初始化时发送 initialize → 获取 tool list
    │
    ├── Claude SDK engine: 直接使用 config.mcp（已有功能，无需修改）
    │
    └── OpenAI engine: buildMCPTools() 改为：
          - 从 initialize 响应读取 tool schemas
          - onToolCall() 通过 stdin 发送 JSON-RPC tools/call
          - 解析 stdout 中的 JSON-RPC response
```

**MCP Process Manager** — 新增 `lib/mcp-manager.mjs`：

```javascript
// lib/mcp-manager.mjs
export class MCPManager {
  constructor(config) { ... }

  // spawn MCP Server 子进程，保持 stdin/stdout 通信
  async start() { ... }

  // 发送 JSON-RPC 请求，返回 response
  async request(method, params) { ... }

  // 获取 tool list（缓存）
  async listTools() { ... }

  // 调用 tool
  async callTool(name, arguments) { ... }

  // 关闭子进程
  async stop() { ... }

  // 异常重启
  async restart() { ... }
}
```

**JSON-RPC 通信协议**（MCP 标准）：

```
→ stdin:  {"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
← stdout: {"jsonrpc":"2.0","id":1,"result":{"capabilities":{"tools":{}},...}}

→ stdin:  {"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
← stdout: {"jsonrpc":"2.0","id":2,"result":{"tools":[...]}}

→ stdin:  {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"web_search","arguments":{"query":"hello"}}}
← stdout: {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"..."}]}}
```

### 4. Config Structure

```json
{
  "auth": { "password": "..." },
  "engines": [ ... ],
  "mcp": {
    "opendaemon": {
      "command": "python",
      "args": ["mcp/server.py"],
      "env": {},
      "channels": {
        "bark": {
          "type": "bark",
          "key": "YOUR_BARK_KEY",
          "server": "https://api.day.app"
        },
        "feishu": {
          "type": "feishu",
          "app_id": "cli_xxx",
          "app_secret": "xxx"
        },
        "wechat": {
          "type": "wechat",
          "sender_url": "http://WINDOWS_IP:5679"
        }
      }
    }
  }
}
```

`channels` 配置嵌套在 MCP server config 中，通过环境变量传给 Python 进程。这样：
- Claude SDK 引擎直接使用 `config.mcp.opendaemon` 作为 MCP server config
- OpenAI 引擎通过 MCPManager 使用同一个长进程
- Channel 配置集中管理，不分散

## Tool Schemas

### web_search

```json
{
  "name": "web_search",
  "description": "Search the internet using DuckDuckGo. Returns titles, snippets, and URLs.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "Search query" },
      "max_results": { "type": "integer", "description": "Max results (default 5)", "default": 5 }
    },
    "required": ["query"]
  }
}
```

### send_message

```json
{
  "name": "send_message",
  "description": "Send a message through configured channels (WeChat, Feishu, Bark).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "target": { "type": "string", "description": "Recipient name or chat name" },
      "content": { "type": "string", "description": "Message content" },
      "channel": { "type": "string", "description": "Channel name (bark/feishu/wechat). Auto-select if omitted." }
    },
    "required": ["target", "content"]
  }
}
```

### notify

```json
{
  "name": "notify",
  "description": "Send a push notification to the owner's phone via Bark.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "title": { "type": "string", "description": "Notification title" },
      "content": { "type": "string", "description": "Notification body" }
    },
    "required": ["title", "content"]
  }
}
```

### set_reminder

```json
{
  "name": "set_reminder",
  "description": "Set, list, or cancel one-time reminders. Reminders fire at the specified time and send a message through configured channels.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "action": { "type": "string", "enum": ["set", "list", "cancel"], "description": "Action to perform", "default": "set" },
      "fire_time": { "type": "string", "description": "When to fire (YYYY-MM-DD HH:MM). Required for 'set'." },
      "content": { "type": "string", "description": "Reminder message. Required for 'set'." },
      "target": { "type": "string", "description": "Who to remind (channel target). Defaults to owner." },
      "channel": { "type": "string", "description": "Delivery channel. Auto-select if omitted." },
      "reminder_id": { "type": "string", "description": "Reminder ID for 'cancel' action." }
    },
    "required": ["action"]
  }
}
```

### cron_task

```json
{
  "name": "cron_task",
  "description": "Create, list, delete, pause, or resume periodic tasks. Tasks fire on schedule and send messages through configured channels.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "action": { "type": "string", "enum": ["create", "list", "delete", "pause", "resume"], "description": "Action to perform", "default": "list" },
      "schedule": { "type": "string", "description": "Schedule expression: 'daily HH:MM', 'weekly N HH:MM', 'every Nh/Nm', 'cron M H D M W'. Required for 'create'." },
      "content": { "type": "string", "description": "Task content/message. Required for 'create'." },
      "target": { "type": "string", "description": "Delivery target. Defaults to owner." },
      "channel": { "type": "string", "description": "Delivery channel. Auto-select if omitted." },
      "task_id": { "type": "string", "description": "Task ID for delete/pause/resume." }
    },
    "required": ["action"]
  }
}
```

## Data Flow

### Tool Call via Claude SDK Engine

```
User → server.mjs → streamClaude()
         │
         └── Claude SDK ─── MCP stdio ──→ mcp/server.py
                                               │
                                          call_tool()
                                               │
                                          return result
                                               │
         ┌── Claude SDK ←── MCP stdio ───────────┘
         │
    (SDK handles tool result internally, continues conversation)
```

Claude SDK 的 MCP 集成已在 P0 建立，无需修改。只需 config.mcp 中有正确配置即可。

### Tool Call via OpenAI Engine

```
User → server.mjs → streamOpenAI()
         │
         ├── messages + tools → OpenAI API
         │
         ← tool_calls in response
         │
         ├── MCPManager.callTool(name, args)
         │       │
         │       └── stdin → mcp/server.py → stdout
         │                        │
         │                   call_tool()
         │                        │
         │       ┌── stdout ←─────┘
         │       │
         ├── tool result → messages.push({role: "tool", ...})
         │
         └── loop → OpenAI API (with tool results)
```

### Reminder/Cron Fire Flow

```
Timer/Scheduler fires (inside mcp/server.py process)
    │
    └── channels[channel_name].send(target, message)
           │
           ├── Bark: HTTP GET → api.day.app
           ├── Feishu: HTTP POST → open.feishu.cn/api
           └── WeChat: HTTP POST → sender_url/send
```

定时器和 cron 调度器运行在 MCP Server 进程内部，不经过 server.mjs。它们触发时直接调用 channel 发送，无需 LLM 参与（P1 限制）。

## Implementation Order

按依赖关系分为 5 个阶段：

### Stage 1: MCP Server 骨架 + web_search

最小可验证单元。不依赖 channels，可独立测试。

1. 创建 `mcp/requirements.txt`
2. 创建 `mcp/server.py` — MCP Server 骨架（initialize + tools/list + tools/call）
3. 创建 `mcp/tools/web_search.py` — DuckDuckGo 搜索
4. 更新 `config.example.json` — MCP 配置示例
5. 手动测试：`echo '{"jsonrpc":"2.0","id":1,"method":"tools/call",...}' | python mcp/server.py`

### Stage 2: MCPManager + OpenAI tool-bridge 重写

让 OpenAI 引擎能通过长进程 MCP 调用 tools。

6. 创建 `lib/mcp-manager.mjs` — 长进程 MCP 通信管理器
7. 重写 `server.mjs` 中 `buildMCPTools()` — 使用 MCPManager 替代 execFileSync
8. 在 `server.mjs` 中添加 MCP Server 进程生命周期管理（启动/关闭/重启）
9. 端到端测试：OpenAI 引擎 → web_search → 返回结果

### Stage 3: Channel 抽象 + Bark/Feishu/WeChat

消息通道基础设施。

10. 创建 `mcp/channels/base.py` — Channel 抽象基类
11. 创建 `mcp/channels/bark.py` — Bark 推送（从 Jarvis 迁移）
12. 创建 `mcp/channels/feishu.py` — 飞书发送（从 Jarvis 精简迁移，去掉 WebSocket 接收）
13. 创建 `mcp/channels/wechat.py` — WeChat HTTP 发送（从 Jarvis 精简迁移，去掉轮询）
14. 创建 `mcp/channels/__init__.py` — Channel 工厂（config → instances）
15. `mcp/server.py` 集成 channels 初始化

### Stage 4: send_message + notify

依赖 channels，构建消息发送工具。

16. 创建 `mcp/tools/send_message.py` — 统一消息发送
17. 创建 `mcp/tools/notify.py` — Bark 紧急推送
18. 端到端测试：通过 chat 发消息 → Bark 推送到手机

### Stage 5: reminder + cron_task

依赖 channels，构建定时任务工具。

19. 创建 `mcp/tools/reminder.py` — 一次性提醒（Timer + 持久化 + 恢复）
20. 创建 `mcp/tools/cron_task.py` — 周期性任务（Scheduler + 持久化 + 恢复）
21. `mcp/server.py` 集成启动恢复逻辑
22. 更新 `.gitignore` — 添加 `mcp/data/`
23. 端到端测试：设置提醒 → 等待触发 → 收到 Bark 推送

### Stage 6: Config 验证 + 收尾

24. 更新 `lib/config.mjs` — MCP channels 配置验证
25. 更新 `config.example.json` — 完整配置模板
26. 更新 `CLAUDE.md` — 新增 MCP 相关架构文档

## Risk & Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| MCP Python SDK API 不兼容 | 高 | 先做 Stage 1 验证，确认 SDK 行为后再继续 |
| WeChat sender 服务不可用 | 低 | Channel 降级机制，WeChat 失败自动 fallback 到 Bark |
| MCP Server 进程意外退出 | 中 | MCPManager 实现自动重启（最多 3 次，间隔递增） |
| JSON-RPC 通信解析错误 | 中 | 严格的 line-buffered parsing，每条 JSON 以 newline 分隔 |
| 定时器精度漂移 | 低 | 30s 检查间隔可接受，误差 < 1min |
