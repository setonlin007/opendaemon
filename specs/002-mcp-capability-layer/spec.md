# Spec 002: MCP Capability Layer

> Phase 1 — 通过 MCP Server 为 OpenDaemon 注入 LLM 原生不具备的能力

## Problem Statement

Phase 0 建立了多引擎对话平台，但 LLM 只能"对话"。用户真正需要的是一个能**搜索网络、发送消息、设置提醒、执行定时任务**的个人助手。这些能力 LLM 原生不具备，需要通过外部工具注入。

Jarvis 已经验证了这些能力的价值（web_search、send_message、set_reminder、cron_task），但它们耦合在 Jarvis 的 Python 运行时中，无法被 OpenDaemon 的多引擎架构复用。

MCP（Model Context Protocol）是标准化的能力注入协议。通过构建 MCP Server，这些能力可以同时服务于 Claude SDK 引擎（原生 MCP 支持）和 OpenAI 引擎（通过 server.mjs 的 tool-bridge 转换）。

## Goals

1. 一个 Python MCP Server（`mcp/server.py`），遵循 MCP 标准协议，通过 stdio 通信
2. **Web Search** — 互联网搜索能力（DuckDuckGo，免费无需 API key）
3. **Send Message** — 统一消息发送（支持多通道：WeChat、Feishu、Bark）
4. **Notification** — 紧急通知推送（Bark push notification）
5. **Reminder** — 一次性定时提醒（持久化，服务重启恢复）
6. **Cron Task** — 周期性定时任务（daily/weekly/interval/cron 表达式）
7. 两个引擎都能使用这些工具（Claude SDK 原生 MCP；OpenAI 通过 tool-bridge）
8. `config.json` 驱动 MCP Server 配置，零代码启用/禁用

## Non-Goals (for this spec)

- 文件系统操作工具（Claude SDK 已原生支持；OpenAI 引擎暂不需要）
- 自我进化循环（Phase 2）
- 技能市场 / 动态安装技能（Future）
- MCP Server 的 HTTP/SSE 传输模式（stdio 足够，单用户场景）
- 消息接收 / IM 机器人被动回复（需要 webhook server，scope 太大）

## Architecture Overview

```
OpenDaemon Server (Node.js)
    │
    ├── Claude SDK Engine ── MCP Protocol (stdio) ──┐
    │                                                │
    └── OpenAI Engine ── tool-bridge (JSON-RPC) ─────┤
                                                     │
                                              MCP Server (Python)
                                                     │
                                    ┌────────┬───────┼────────┬──────────┐
                                    ▼        ▼       ▼        ▼          ▼
                               web_search  send_msg  notify  reminder  cron_task
                                    │        │       │        │          │
                                    ▼        ▼       ▼        ▼          ▼
                                DuckDuckGo  WeChat  Bark   JSON file   JSON file
                                            Feishu         + Timer     + Scheduler
```

## User Stories

### US-1: Web Search

**As a** user chatting with any engine,
**I want to** ask the daemon to search the internet,
**So that** it can answer questions about current events, look up documentation, or find information not in its training data.

**Acceptance Criteria:**
- [ ] MCP tool `web_search` accepts `query` (string) and optional `max_results` (int, default 5)
- [ ] Uses DuckDuckGo (free, no API key)
- [ ] Returns formatted results: title, snippet, URL
- [ ] Works with both Claude SDK and OpenAI engines
- [ ] Graceful error handling (timeout, no results, library missing)

**Example:**
```
User: 帮我搜一下 MCP 协议的最新规范
Daemon: [calls web_search("MCP protocol specification latest")]
        搜索到以下结果：
        1. Model Context Protocol — Official Spec ...
```

### US-2: Send Message

**As the** owner,
**I want to** ask the daemon to send messages through my IM channels (WeChat, Feishu),
**So that** it can act as my communication proxy — reply to people, forward information, etc.

**Acceptance Criteria:**
- [ ] MCP tool `send_message` accepts `target` (string), `content` (string), optional `channel` (string)
- [ ] Supports multiple channels: WeChat (via itchat/wechaty bridge), Feishu (via bot API), Bark (push)
- [ ] Channel configuration in `config.json` under `mcp.opendaemon.channels`
- [ ] Only owner role can send to arbitrary targets (security constraint from Jarvis)
- [ ] Returns confirmation or error message
- [ ] If channel not specified, uses first available channel

**Channel Config Example:**
```json
{
  "mcp": {
    "opendaemon": {
      "command": "python",
      "args": ["mcp/server.py"],
      "env": {},
      "channels": {
        "bark": {
          "type": "bark",
          "server_url": "https://api.day.app/YOUR_KEY"
        },
        "feishu": {
          "type": "feishu",
          "app_id": "cli_xxx",
          "app_secret": "xxx",
          "target_map": { "张三": "ou_xxx" }
        }
      }
    }
  }
}
```

### US-3: Push Notification

**As the** owner,
**I want to** receive push notifications on my phone when something important happens,
**So that** I don't miss critical information even when I'm not looking at the chat.

**Acceptance Criteria:**
- [ ] MCP tool `notify` accepts `title` (string) and `content` (string)
- [ ] Sends via Bark (iOS push notification service, self-hosted friendly)
- [ ] Bark server URL configurable in channel config
- [ ] Returns success/failure status

### US-4: Set Reminder

**As a** user,
**I want to** ask the daemon to remind me about something at a specific time,
**So that** I don't forget important tasks and meetings.

**Acceptance Criteria:**
- [ ] MCP tool `set_reminder` accepts `action` (set/list/cancel), `fire_time` (YYYY-MM-DD HH:MM), `content`, optional `target`, `channel`
- [ ] Persisted to `data/reminders.json` (survives MCP Server restart)
- [ ] On restart, restores pending reminders; fires overdue ones within 5min grace
- [ ] When triggered, sends message through configured channel (fallback chain)
- [ ] AI handles natural language → absolute time conversion (不在 MCP Server 内做)
- [ ] Returns confirmation with human-readable time

**Example:**
```
User: 明天下午3点提醒我开会
Daemon: [calls set_reminder(action="set", fire_time="2026-03-30 15:00", content="开会")]
        已设置提醒：明天 15:00 提醒你开会
```

### US-5: Cron Task

**As a** user,
**I want to** set up recurring tasks (daily standup reminder, weekly report prompt),
**So that** the daemon proactively reaches out at scheduled times.

**Acceptance Criteria:**
- [ ] MCP tool `cron_task` accepts `action` (create/list/delete/pause/resume), `schedule`, `content`, optional `target`, `channel`
- [ ] Schedule formats: `daily HH:MM`, `weekly N HH:MM`, `every Nh/Nm`, `cron M H D M W`
- [ ] Persisted to `data/cron_tasks.json`
- [ ] Background scheduler thread checks every 30s
- [ ] Auto-starts scheduler on first tool call or MCP Server startup
- [ ] Pause/resume individual tasks without deletion

**Example:**
```
User: 每天早上9点给我发一条天气摘要
Daemon: [calls cron_task(action="create", schedule="daily 09:00", content="请查询今天天气并发送摘要", target="owner")]
        已创建定时任务：每天 09:00 → 发送天气摘要
```

### US-6: Unified Tool Access Across Engines

**As a** user switching between Claude and OpenAI engines,
**I want** the same MCP tools available in every engine,
**So that** I don't lose capabilities when I switch models.

**Acceptance Criteria:**
- [ ] Claude SDK engine: MCP tools injected via SDK's native MCP server config (already supported in P0)
- [ ] OpenAI engine: MCP tools converted to OpenAI function-calling format via `buildMCPTools()` in server.mjs
- [ ] Tool schemas (name, description, parameters) defined in MCP Server's `tools/list` response
- [ ] OpenAI tool-bridge: `server.mjs` spawns MCP Server subprocess, sends JSON-RPC `tools/call`, parses response
- [ ] Unified behavior: same tool, same parameters, same result format regardless of engine

## Technical Constraints

1. **MCP Server in Python** — Jarvis skills are Python, minimize rewrite effort. Use `mcp` Python SDK.
2. **stdio transport** — Single user, local deployment. No need for HTTP/SSE transport.
3. **Stateful process** — Reminder timers and cron scheduler live in the MCP Server process. The server must be long-running (not spawn-per-call for these tools).
4. **Channel abstraction** — Channels (WeChat/Feishu/Bark) are pluggable. Each channel implements `send(target, content) -> bool`. Missing channels degrade gracefully.
5. **Data persistence** — `data/reminders.json` and `data/cron_tasks.json` for durability. JSON format, human-readable.
6. **Security** — No shell execution tools. No file write tools. Message sending restricted by config. MCP Server has no network-facing ports.

## Migration from Jarvis

| Jarvis Skill | MCP Tool | Migration Notes |
|-------------|----------|-----------------|
| `web_search` | `web_search` | Direct port, remove context/request_context coupling |
| `send_message` | `send_message` | Simplify: remove role-based access (single-user), keep channel abstraction |
| `send_notification` | `notify` | Direct port, Bark only |
| `set_reminder` | `set_reminder` | Port timer logic + persistence, replace channel refs with config-driven channels |
| `cron_task` | `cron_task` | Port scheduler + persistence, same channel replacement |

**Not migrated in P1:**
- `glob_files`, `read_file`, `grep_files`, `list_files` — Claude SDK has native equivalents; OpenAI engine can add later if needed
- `self_update`, `self_reflect` — Phase 2 (self-evolution)
- `deep_research` — Can be done with web_search + LLM reasoning
- `fitness_coach`, `query_contacts`, `read_profile` — Domain-specific, user can add later

## Resolved Decisions

1. **WeChat channel**: WeChat + Feishu + Bark 全部在 P1 实现。WeChat 稳定性问题通过 channel 降级机制处理（发送失败 fallback 到下一个 channel）。
2. **长进程 MCP Server**: OpenAI tool-bridge 从 spawn-per-call 改为长进程模式。server.mjs 启动时 spawn MCP Server 子进程并保持 stdin/stdout 通信。这样 reminder/cron 的内存定时器不会丢失。Claude SDK 引擎本身就是长进程 MCP，两个引擎统一。
3. **Cron 触发动作**: P1 只做静态消息发送（触发时直接发送预设内容）。P2 支持 LLM 参与生成（cron 触发 → 调 LLM → 发送生成内容）。
4. **MCP Server 进程管理**: server.mjs 自动管理。启动时 spawn，退出时 kill，异常时自动重启。

## Success Metrics

- 用户可以通过任意引擎让 daemon 搜索网络并返回结果
- 用户可以通过 daemon 发送消息到 Bark/Feishu
- 设置的提醒在指定时间准确触发（误差 < 1 分钟）
- 周期性任务稳定运行，重启后自动恢复
- 新增一个 channel type 只需实现一个 Python class（< 50 行）
