# OpenDaemon Constitution

> This document defines the soul of OpenDaemon. All design decisions, feature priorities, and code reviews must align with these principles.

## What is OpenDaemon?

**The self-evolving agent harness that grows with you.**

OpenDaemon is not another chatbot, not another agent framework, not another AI platform. It is a lightweight harness that sits on top of any LLM engine, injects your custom capabilities, and — most importantly — **gets smarter in the direction YOU define, every single day**.

## Core Principles

### 1. Grow With You, Not For You

Every OpenDaemon instance is unique. It learns from YOUR interactions, YOUR feedback, YOUR domain. After three months, two people's daemons are completely different — like two employees who started the same job but specialized in different directions.

The user defines growth goals. The daemon pursues them through reflection, pattern extraction, and memory consolidation. Growth is directed, not random.

### 2. Harness, Not Engine

We do NOT build LLM engines. Claude, GPT, Kimi, DeepSeek — they are the engines. We build the harness that makes any engine useful in YOUR context.

- Plug any LLM engine (Claude SDK, OpenAI-compatible, future engines)
- Inject any capability via MCP (messaging, data, APIs, tools)
- The harness adapts; the engine computes

### 3. Self-Evolution is the Core Feature

This is not a nice-to-have. This IS the product.

- Every interaction produces a trace
- Periodic reflection extracts patterns and rules
- Learned knowledge injects into future context
- Success patterns become reusable templates
- The daemon verifies improvements before adopting them
- Eventually: the daemon writes new capabilities for itself

### 4. Lightweight by Design

Single-process deployment. No Docker required. No Kubernetes. No PostgreSQL. SQLite is enough. One HTML file for the frontend. If a junior developer can't set it up in 10 minutes, we've failed.

DeerFlow needs 4 Docker containers. OpenClaw needs 8-16GB RAM. OpenDaemon needs `node server.mjs`.

### 5. Open and Extensible

- MIT license for all original code
- Any LLM provider via standard protocols (OpenAI-compatible API)
- Any capability via MCP (Model Context Protocol)
- No vendor lock-in. No telemetry. No phone-home
- Claude SDK is optional (for users with Claude subscriptions)

## Architecture Invariants

These are non-negotiable architectural constraints:

1. **Engine layer uses existing harnesses** — Claude Agent SDK, OpenAI API. We do NOT write our own tool-use loop for Claude, our own context management for GPT, etc.

2. **Capabilities are MCP** — All custom capabilities (messaging, contacts, reminders, data access) are exposed as MCP servers. This is the universal protocol.

3. **Memory is file-based and human-readable** — Learned patterns, rules, goals are stored as Markdown files. A user can read, edit, or delete any learned behavior. No opaque vector databases as the primary store.

4. **Every interaction is traceable** — Full trace logs for every conversation. This is the raw material for self-evolution. Without traces, no learning.

5. **Growth direction is user-defined** — The user writes `goals.md`. The reflection loop is guided by these goals. The daemon does not decide its own direction.

## What We Do NOT Build

- A chat UI that competes with ChatGPT/Claude.ai (theirs is better)
- A coding agent that competes with Claude Code/Cursor (theirs is better)
- A multi-agent framework that competes with CrewAI/AutoGen (theirs is better)
- A full platform that competes with OpenClaw/DeerFlow (theirs is bigger)

We build the ONE thing none of them do: **an agent that gets better at being YOUR agent, every day**.

## Target Users

**Developers who want an AI assistant that specializes over time, without building an agent from scratch.**

- Independent developers and tech enthusiasts
- AI agent developers who want to focus on capabilities, not infrastructure
- Teams needing an AI assistant integrated with internal systems
- Anyone who wants an AI that remembers, learns, and improves

## Success Metric

If a user has been using OpenDaemon for 3 months and it's NOT noticeably better at their specific tasks than it was on day 1, we have failed.
