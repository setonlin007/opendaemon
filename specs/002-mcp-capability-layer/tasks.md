# Tasks 002: MCP Capability Layer

## Stage 1: MCP Server 骨架 + web_search

- [x] T1: 创建 `mcp/requirements.txt`（mcp, duckduckgo-search, requests, lark-oapi）
- [x] T2: 创建 `mcp/tools/web_search.py`（DuckDuckGo 搜索，从 Jarvis 迁移）
- [x] T3: 创建 `mcp/tools/__init__.py`（工具注册表）
- [x] T4: 创建 `mcp/server.py`（MCP Server 入口，stdio 传输，注册 web_search）
- [x] T5: 手动验证 MCP Server 启动 + tools/list + web_search 调用

## Stage 2: MCPManager + OpenAI tool-bridge 重写

- [x] T6: 创建 `lib/mcp-manager.mjs`（长进程 spawn、JSON-RPC 通信、listTools、callTool、自动重启）
  - depends: T4
- [x] T7: 重写 `server.mjs` — 用 MCPManager 替代 `buildMCPTools()` 的 execFileSync
  - depends: T6
- [x] T8: `server.mjs` 添加 MCP Server 进程生命周期管理（启动时 spawn，关闭时 kill）
  - depends: T6

## Stage 3: Channel 抽象 + Bark/Feishu/WeChat

- [x] T9: 创建 `mcp/channels/base.py`（Channel 抽象基类：send + health_check）
- [x] T10: 创建 `mcp/channels/bark.py`（Bark 推送，从 Jarvis 迁移精简）
  - depends: T9
- [x] T11: 创建 `mcp/channels/feishu.py`（飞书 REST API 发送，去掉 WebSocket 接收）
  - depends: T9
- [x] T12: 创建 `mcp/channels/wechat.py`（WeChat HTTP POST 发送，去掉轮询接收）
  - depends: T9
- [x] T13: 创建 `mcp/channels/__init__.py`（Channel 工厂：config dict → channel instances）
  - depends: T10, T11, T12
- [x] T14: `mcp/server.py` 集成 channels 初始化（从环境变量读取 config，创建 channel 实例）
  - depends: T4, T13

## Stage 4: send_message + notify

- [x] T15: 创建 `mcp/tools/send_message.py`（统一消息发送，channel 选择 + fallback）
  - depends: T14
- [x] T16: 创建 `mcp/tools/notify.py`（Bark 紧急推送）
  - depends: T14
- [x] T17: `mcp/tools/__init__.py` 注册 send_message + notify
  - depends: T15, T16

## Stage 5: reminder + cron_task

- [x] T18: 创建 `mcp/tools/reminder.py`（Timer + JSON 持久化 + 启动恢复 + channel 投递）
  - depends: T14
- [x] T19: 创建 `mcp/tools/cron_task.py`（Scheduler 线程 + 周期解析 + JSON 持久化 + channel 投递）
  - depends: T14
- [x] T20: `mcp/tools/__init__.py` 注册 reminder + cron_task
  - depends: T18, T19
- [x] T21: `mcp/server.py` 集成启动恢复逻辑（restore_reminders + restore_cron_tasks）
  - depends: T18, T19

## Stage 6: Config 验证 + 收尾

- [x] T22: 更新 `.gitignore`（添加 mcp/data/）
- [x] T23: 更新 `config.example.json`（完整 MCP + channels 配置模板）
- [x] T24: 更新 `lib/config.mjs`（MCP channels 配置验证）
  - depends: T7
- [x] T25: 更新 `CLAUDE.md`（MCP 架构文档、新增文件说明）
  - depends: all above
