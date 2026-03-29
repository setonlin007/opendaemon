# Plan 006: Workspace Structure

## Target Directory Layout

```
~/workspace/                        # Daemon 默认工作目录
├── .workspace.json                 # Workspace 元数据（项目列表、配置）
│
├── projects/                       # 所有代码项目
│   ├── opendaemon/                 # git repo (从 ~/opendaemon 迁移)
│   └── jarvis-assistant/           # git repo (从 ~/jarvis-assistant 迁移)
│
├── artifacts/                      # Daemon 生成的非代码产物
│   ├── documents/                  # 文档、报告、分析
│   ├── data/                       # Excel、CSV、JSON 数据文件
│   ├── media/                      # 图片、音频、视频
│   ├── exports/                    # 用户要求导出的文件
│   └── temp/                       # 临时文件（可定期清理）
│
└── scripts/                        # 跨项目脚本/工具（可选）
```

迁移后的 symlink:
```
~/opendaemon → ~/workspace/projects/opendaemon
~/jarvis-assistant → ~/workspace/projects/jarvis-assistant
```

## .workspace.json Schema

```json
{
  "version": 1,
  "projects": {
    "opendaemon": {
      "path": "projects/opendaemon",
      "type": "node",
      "description": "自进化 AI Agent 平台",
      "repo": "github-opendaemon:setonlin007/opendaemon.git"
    },
    "jarvis-assistant": {
      "path": "projects/jarvis-assistant",
      "type": "python",
      "description": "个人 AI 助手 (微信/飞书)",
      "repo": "origin"
    }
  },
  "artifacts_path": "artifacts"
}
```

字段说明：
- `path`: 相对于 workspace 根目录的路径
- `type`: 项目语言/运行时 (node / python / go / ...)
- `description`: 简要描述，用于 Daemon 系统提示
- `repo`: git remote 名称或 URL

## 迁移步骤（零停机）

```
Phase 1: 创建结构
  mkdir -p ~/workspace/projects
  mkdir -p ~/workspace/artifacts/{documents,data,media,exports,temp}

Phase 2: 移动项目（逐个、先停后迁）
  # opendaemon（需短暂停机）
  pm2 stop opendaemon
  mv ~/opendaemon ~/workspace/projects/opendaemon
  ln -s ~/workspace/projects/opendaemon ~/opendaemon
  pm2 start opendaemon
  pm2 save

  # jarvis-assistant
  (停止 jarvis 进程)
  mv ~/jarvis-assistant ~/workspace/projects/jarvis-assistant
  ln -s ~/workspace/projects/jarvis-assistant ~/jarvis-assistant
  (重启 jarvis 进程)

Phase 3: 清理 home 目录散落脚本
  rm ~/check_*.py ~/deploy_*.py ~/create_tasks.py
  rm ~/setup_services.py ~/start_services.py ~/start_svc.py
  rm ~/debug_svc.py ~/survey_old.py ~/switch_monitor.py
  rm ~/win_cleanup.py ~/win_resources.py

Phase 4: 创建 .workspace.json

Phase 5: Workspace 知识同步
  syncWorkspaceKnowledge() 读取 .workspace.json → 写入 knowledge 条目
  服务启动时自动执行，按需通过 injector 标签匹配注入
```

## 产物服务 API

### 路由：`GET /api/workspace/files/{path}` — 文件下载

复用 opendaemon server 现有的认证和文件服务逻辑。

```
GET /api/workspace/files/documents/report.pdf
GET /api/workspace/files/data/analysis.xlsx
GET /api/workspace/files/media/screenshot.png
```

实现方式：
- server.mjs 中新增路由匹配 `/api/workspace/files/`
- 解析 `{path}`，拼接到 workspace artifacts 目录
- 安全校验：path 不能包含 `..`，不能超出 artifacts 目录
- 复用现有 `serveStaticFile()` 或 `Content-Disposition` 下载逻辑

### 路由：`GET /api/workspace/tree?path=` — 目录列表

返回指定路径下的文件和子目录列表，支持前端逐级展开。

```
GET /api/workspace/tree              → artifacts/ 根目录
GET /api/workspace/tree?path=data    → artifacts/data/ 下的内容
```

响应格式：
```json
{
  "path": "data",
  "items": [
    { "name": "report.xlsx", "type": "file", "size": 15360, "mtime": 1711728000000, "mime": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    { "name": "exports", "type": "dir", "children_count": 3, "mtime": 1711728000000 }
  ]
}
```

实现方式：
- `fs.readdirSync()` + `fs.statSync()` 读取目录
- 文件返回 name, type("file"), size, mtime, mime
- 目录返回 name, type("dir"), children_count, mtime
- 按类型排序（目录在前），同类型按名称排序
- 安全校验：同上，不允许路径穿越

## 产物浏览器 UI

### 入口

侧边栏 footer 新增 📁 按钮（与 🧠 Evolution 并列），点击打开产物浏览器 overlay。

### 交互设计

```
┌─────────────────────────────────────┐
│  📁 Artifacts              [×]      │
├─────────────────────────────────────┤
│  📂 documents/                      │
│  📂 data/                    ▼      │ ← 点击展开
│    📄 report.xlsx    15 KB  3/29    │
│    📄 users.csv       2 KB  3/28    │
│  📂 media/                          │
│    🖼 chart.png      48 KB  3/29    │ ← 图片可预览
│  📂 exports/                        │
│  📂 temp/                           │
│                                     │
│  (空目录显示"暂无文件"占位)          │
└─────────────────────────────────────┘
```

功能：
- **目录树**：默认显示一级目录，点击展开子级（lazy load，调 `/api/workspace/tree?path=`）
- **文件行**：显示类型图标 + 文件名 + 大小 + 修改时间 + 下载按钮
- **图片预览**：`.png/.jpg/.gif/.webp` 文件悬停或点击可内联预览（`<img>` 标签指向下载 URL）
- **文本预览**：`.txt/.md/.csv/.json` 文件点击可在 modal 中显示内容（fetch + 显示）
- **下载**：所有文件可点击下载按钮，调用 `/api/workspace/files/{path}`
- **空态**：目录为空时显示灰色占位文字

类型图标映射：
```
📂 目录
📄 默认文件
📊 .xlsx/.csv
📝 .md/.txt
🖼 .png/.jpg/.gif/.webp/.svg
📦 .zip/.tar/.gz
💾 .json/.xml
📋 .pdf
```

### Daemon 产物存储规则

| 产物类型 | 目录 | 示例 |
|---------|------|------|
| 文档报告 | `artifacts/documents/` | report.md, analysis.pdf |
| 数据文件 | `artifacts/data/` | users.xlsx, export.csv, config.json |
| 图片媒体 | `artifacts/media/` | chart.png, processed.jpg |
| 导出文件 | `artifacts/exports/` | backup.zip, dump.sql |
| 临时文件 | `artifacts/temp/` | scratch.txt（可定期清理）|

下载链接格式：`/api/workspace/files/{relative_path}`

## System Prompt 集成

在 Daemon 的系统提示中注入 workspace 上下文，使 LLM 感知多项目环境：

```
## Workspace
Working directory: ~/workspace
Projects:
- opendaemon (node) — 自进化 AI Agent 平台
  Path: projects/opendaemon
- jarvis-assistant (python) — 个人 AI 助手
  Path: projects/jarvis-assistant

Artifacts directory: artifacts/
  Save non-code files here. Provide download link: /api/workspace/files/{path}

When the user asks for development work:
- If the target project is clear from context, work in that project
- If unclear, ask: "你指的是哪个项目？"
- For cross-project tasks, work from workspace root
```

注入方式：**知识库按需注入**

不在每次对话中硬注入 workspace 上下文，而是利用现有的 Phase 2 知识注入机制：

1. 服务启动时读取 `~/workspace/.workspace.json`
2. 生成一条 rules 类型的 knowledge 条目，写入 `data/knowledge/rules.md`
3. 在 `knowledge_index` 中注册，设置宽泛 tags 覆盖开发类对话
4. 后续靠 injector.mjs 的标签匹配按需注入

**优势**：闲聊时不注入（零开销），只在涉及开发/文件/项目时自动匹配注入。

知识条目示例：
```markdown
## Workspace 结构
_Tags: workspace, project, file, code, develop, 项目, 开发, 文件, 创建, 修改 | Confidence: 1.0 | Source: system_

当前 workspace: ~/workspace
项目列表:
- opendaemon (projects/opendaemon) — Node.js, 自进化 AI Agent 平台
- jarvis-assistant (projects/jarvis-assistant) — Python, 个人 AI 助手

规则:
- 开发任务不确定项目时，询问用户："你指的是哪个项目？"
- 非代码产物（Excel、文档、图片等）存到 ~/workspace/artifacts/ 对应子目录
- 产物下载链接: /api/workspace/files/{path}
```

同步逻辑：
```javascript
// 伪代码 - syncWorkspaceKnowledge()
function syncWorkspaceKnowledge() {
  const wsPath = join(homedir(), 'workspace', '.workspace.json');
  if (!existsSync(wsPath)) return;
  const ws = JSON.parse(readFileSync(wsPath, 'utf-8'));

  // 生成知识内容
  let content = '## Workspace 结构\n\n当前 workspace: ~/workspace\n项目列表:\n';
  for (const [name, proj] of Object.entries(ws.projects)) {
    content += `- ${name} (${proj.path}) — ${proj.type}, ${proj.description}\n`;
  }
  content += '\n规则:\n';
  content += '- 开发任务不确定项目时，询问用户\n';
  content += '- 非代码产物存到 ~/workspace/artifacts/，下载链接: /api/workspace/files/{path}\n';

  // 写入 rules.md 并更新 knowledge_index
  upsertKnowledge('rules', 'Workspace 结构', tags, content, 1.0, 'system');
}
```

CLAUDE.md 同步更新（给 Claude Code 参考），但运行时感知完全依赖知识库注入。

## 现有 data/ 目录的关系

opendaemon 项目的 `data/` 目录保持不变：
- `data/opendaemon.db` — 项目运行时数据库
- `data/knowledge/` — 知识库文件
- `data/goals.md` — 用户目标
- `data/uploads/` — 用户上传的文件（聊天附件）

Workspace `artifacts/` 是独立的：
- 存放 Daemon 为用户生成的交付物
- 不属于任何项目
- 不进 git

原有的 `data/` 下载链接 `/api/files/{path}` 保持不变，新增 `/api/workspace/files/{path}` 路由。

## Risks

| 风险 | 缓解 |
|------|------|
| mv 期间 opendaemon 短暂停机 | pm2 stop → mv → ln → pm2 start，预计 < 5 秒 |
| jarvis-assistant 进程用绝对路径 | 检查 jarvis 的进程启动方式，必要时更新 |
| .workspace.json 格式错误 | loadWorkspaceContext() 做 try-catch，静默降级 |
| 旧路径残留引用 | symlink 覆盖，应用代码全部相对路径无风险 |
| artifacts 磁盘空间增长 | temp/ 定期清理；必要时加磁盘监控 |
