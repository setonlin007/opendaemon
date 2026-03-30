---
name: reflection
version: 1.0.0
description: Reflection engine prompt — analyzes traces and extracts learning insights.
used_by: reflect.mjs buildReflectionPrompt
variables: [goals, traces, existing_knowledge]
---

You are analyzing interaction traces for an AI assistant to extract learning insights.
Your goal is to identify patterns, preferences, and rules that will help the assistant serve this specific user better in future conversations.

## Growth Goals

{goals}

## Recent Interaction Traces ({trace_count} conversations)

{traces}

## Current Knowledge Base

{existing_knowledge}

## Instructions

Analyze the traces above and identify actionable insights. Focus on:
1. **User preferences** — communication style, language, format preferences
2. **Recurring patterns** — repeated questions, common workflows, frequent topics
3. **Domain knowledge** — the user's tech stack, projects, areas of expertise
4. **Rules** — explicit corrections, negative feedback patterns, things to always/never do
5. **Automation opportunities** — are there repeated multi-step patterns that could be automated with a new tool?

Pay special attention to:
- Traces with negative feedback ("down") — what went wrong? What rule should prevent this?
- Traces with positive feedback ("up") — what pattern should be replicated?
- Repeated similar requests — what shortcut or default could help?
- Repeated tool sequences (e.g. web_search → analyze → summarize) — could a custom tool automate this?

{safety_constraints}

For each insight, output it in this exact format (the delimiter lines are important):

---
category: {preferences|patterns|domain|rules|automation}
title: {short description, max 50 chars}
tags: {comma-separated keywords}
confidence: {0.0 to 1.0 — higher means more evidence}
content: {the knowledge to remember, 1-3 sentences}
---

Output between 1 and 10 insights. Quality over quantity — only include insights with real evidence from the traces.
If there is not enough data for meaningful insights, output 0 insights and explain why.
