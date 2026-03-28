# Spec 001: Platform Foundation

> Phase 0 — The skeleton of OpenDaemon: multi-engine harness + web UI + session management

## Problem Statement

There is no lightweight, self-evolving agent harness that lets users plug any LLM engine, inject custom capabilities via MCP, and have the system improve over time in a user-defined direction. Existing solutions are either locked to one model (Claude Code), too heavy (DeerFlow), or static (OpenClaw).

## Goals

1. A working multi-engine web platform where users can chat with any configured LLM
2. Claude SDK engine for Claude models (full agent capabilities with tools)
3. OpenAI-compatible engine for any other model (with function calling support)
4. Session/conversation management with persistence
5. Password-based authentication
6. MCP capability injection foundation (config-driven, engines can use MCP tools)

## Non-Goals (for this spec)

- Self-evolution loop (Phase 2)
- IM channel integration (Phase 1)
- Admin UI for Jarvis (deferred)
- Docker/sandbox execution
- Sub-agent orchestration

## User Stories

### US-1: Multi-Engine Chat
**As a** developer,
**I want to** configure multiple LLM engines (Claude Opus, Kimi K2, DeepSeek) and switch between them,
**So that** I can use the best model for each task without changing tools.

**Acceptance Criteria:**
- [ ] config.json defines engines with id, type, label, provider settings
- [ ] Web UI shows engine selector
- [ ] New conversation binds to selected engine
- [ ] Existing conversations retain their engine
- [ ] Claude SDK engine: full streaming with tool use, thinking blocks
- [ ] OpenAI engine: streaming chat with function calling support

### US-2: Conversation Management
**As a** user,
**I want to** have multiple conversations with history, organized in a sidebar,
**So that** I can maintain context across sessions and find past conversations.

**Acceptance Criteria:**
- [ ] SQLite stores conversations (id, title, engine_id, timestamps)
- [ ] SQLite stores messages (role, content, metadata)
- [ ] Sidebar lists conversations sorted by last updated
- [ ] Auto-title from first message
- [ ] Create / delete conversations
- [ ] Switching conversations loads message history
- [ ] Claude SDK conversations can resume via session_id

### US-3: Authentication
**As a** user deploying on a server,
**I want to** protect my instance with a password,
**So that** unauthorized users cannot access my LLM engines.

**Acceptance Criteria:**
- [ ] config.json contains auth.password
- [ ] Login page at /login.html
- [ ] Cookie-based session (30 days)
- [ ] All API routes require authentication except login
- [ ] Timing-safe password comparison

### US-4: MCP Capability Foundation
**As a** developer,
**I want to** configure MCP servers in config.json that get injected into engines,
**So that** my LLM can call custom tools (send messages, query contacts, etc.)

**Acceptance Criteria:**
- [ ] config.json defines MCP servers with command, args, tools
- [ ] Claude SDK engine: passes mcpServers to query() options
- [ ] OpenAI engine: converts MCP tool definitions to OpenAI function format
- [ ] MCP tools appear in the model's available tools
- [ ] Tool execution results display in the web UI

### US-5: Slash Command Autocomplete
**As a** user of the Claude SDK engine,
**I want to** type "/" and see available commands,
**So that** I can use Claude Code's built-in capabilities.

**Acceptance Criteria:**
- [ ] Typing "/" shows autocomplete dropdown
- [ ] Arrow keys / Tab to select
- [ ] Only shown when current engine is claude-sdk type

## Technical Constraints

- Node.js (ES modules)
- No frontend build tools (single HTML files)
- SQLite via better-sqlite3 (synchronous API)
- Native HTTP server (no Express)
- Claude Agent SDK for Claude engine
- Standard fetch for OpenAI-compatible engine

## Edge Cases

- Engine configured but API key invalid → show clear error, don't crash
- Claude SDK rate limited → show rate limit banner with reset time
- OpenAI streaming interrupted → show partial response + error
- Resume Claude session that expired → start new session transparently
- MCP server process crashes → log error, continue without tools
- Concurrent conversations (multiple browser tabs) → must work correctly

## Open Questions

- [RESOLVED] Claude SDK works with Max subscription OAuth — verified
- [RESOLVED] Claude SDK license: proprietary, cannot offer OAuth login to third parties
- Should OpenAI engine tool-use loop run server-side or client-side? → Server-side (unified SSE format)
