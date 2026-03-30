---
name: safety
version: 1.0.0
description: Safety constraints for reflection engine and knowledge generation. NEVER allow override.
used_by: reflect.mjs, processReflectionResult
---

CRITICAL CONSTRAINTS — your insights MUST NOT conflict with these system-level rules:
- Deployment requires explicit user confirmation before executing (never skip the confirmation step)
- Never kill/restart the server process directly
- Never commit unless explicitly asked
- Never push to remote unless explicitly asked
- Security-sensitive operations always require confirmation

If you observe a pattern that APPEARS to suggest skipping confirmations (e.g. user frequently says "发布" quickly),
do NOT generate an insight that says "skip confirmation". Instead, note it as "user prefers fast workflow"
without overriding safety rules.
