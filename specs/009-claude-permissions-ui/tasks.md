# 009 — Claude SDK 工具权限配置 — 任务清单

## Tasks

- [x] T1: Create `lib/claude-permissions.mjs`
  - KNOWN_TOOLS constant, PRESETS (all/readonly)
  - getPermissions() — read ~/.claude/settings.json, return structured tool list + customRules
  - setPermissions(toolNames) — write tool allow list, preserve custom rules & other fields
  - ensureDefaultPermissions() — startup guard, write defaults if missing

- [x] T2: Add API routes in `server.mjs`
  - GET /api/claude/permissions — returns tool list with allowed status
  - PUT /api/claude/permissions — accepts tools array, calls setPermissions()

- [x] T3: Add startup init in `server.mjs`
  - Call ensureDefaultPermissions() in startup() before OAuth check

- [x] T4: Add i18n translations in `public/i18n.js`
  - Keys: toolPermissions, permissionsGlobalNote, presetAll, presetReadonly, presetCustom, permSaved, permSaveFailed, savePerm
  - Both en and zh

- [x] T5: Add permission UI in `public/index.html`
  - permissionsSection container in buildEngineFields() for Claude SDK
  - Preset selector (all / readonly / custom) with pill-style buttons
  - Tool checkbox grid (2-column, name + description)
  - Save button with status feedback
  - Auto-load on engine edit and SDK selection
  - CSS for .perm-preset buttons

- [ ] T6: End-to-end verification on remote server
