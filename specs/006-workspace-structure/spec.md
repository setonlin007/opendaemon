# Spec 006: Workspace Structure

## Problem

OpenDaemon 当前的工作目录就是项目目录 (`/home/ubuntu/opendaemon`)。这导致：

1. **单项目锁定** — Daemon 只能在 opendaemon 项目中工作。用户如果有多个项目（如 jarvis-assistant），Daemon 缺乏统一的项目管理能力。
2. **产物混乱** — 用户让 Daemon 生成的非代码文件（Excel、报告、图片等）只能存到项目 `data/` 目录，与项目运行数据混在一起。
3. **散落的脚本** — home 目录下有大量一次性脚本，没有归属，难以管理。
4. **项目上下文不清** — 当用户说"改一下 xxx"，Daemon 无法判断是哪个项目，也没有机制确认。

## Goals

1. **Workspace 根目录** — 建立 `~/workspace` 作为 Daemon 的默认工作目录，包含所有项目和产物。
2. **多项目管理** — 每个项目是 workspace 下的独立目录，Daemon 能感知所有项目并在用户指定/确认后切换。
3. **产物目录** — 非代码产物（文档、数据文件、媒体等）有独立的存放位置和下载服务。
4. **零停机迁移** — 通过 symlink 保证现有路径、pm2、deploy 脚本全部不断。
5. **清理 home 目录** — 归档/删除不再需要的脚本。

## Non-Goals (this phase)

- 项目模板 / scaffolding 系统
- 跨项目依赖管理
- Git monorepo 整合
- 产物版本控制
- 多用户 workspace 隔离

## User Stories

### US-1: Workspace 感知

作为用户，当我给 Daemon 开发任务时，Daemon 应该知道我有哪些项目，并在不明确时询问我要在哪个项目中工作。

- Daemon 启动时加载 `.workspace.json` 了解所有项目
- 用户说"改一下搜索功能"→ Daemon 询问"你指的是哪个项目？当前有 opendaemon 和 jarvis-assistant"
- 用户说"在 jarvis 里加个功能"→ Daemon 直接定位到 jarvis-assistant 项目
- 用户说"对比两个项目的架构"→ Daemon 在 workspace 根目录工作，跨项目读取

### US-2: 产物管理

作为用户，当我让 Daemon 生成非代码文件时，文件应该存到统一的产物目录，并提供下载链接。

- 用户说"帮我做个 Excel 报表"→ 文件存到 `artifacts/data/report.xlsx`
- 用户说"帮我处理这张图"→ 文件存到 `artifacts/media/processed.png`
- 产物通过 `/api/workspace/files/{path}` 提供下载
- 产物目录按类型分子目录：documents / data / media / exports / temp

### US-3: 产物浏览器

作为用户，我可以通过可视化页面浏览、预览和下载 Daemon 生成的产物。

- 在侧边栏或独立页面提供产物入口
- 按目录树结构显示 artifacts/ 下的文件和文件夹
- 显示文件元数据：名称、大小、修改时间、类型图标
- 点击文件可直接下载，图片/文本类可内联预览
- 支持文件夹展开/折叠
- 空目录显示占位提示

### US-4: 项目注册

作为用户，我可以将新项目加入 workspace，也可以移除不再需要的项目。

- `workspace/projects/` 下的目录可注册为项目
- `.workspace.json` 记录项目元数据（路径、类型、描述、是否活跃）
- Daemon 可以通过对话创建新项目或注册已有目录

## Key Design Decisions

1. **Symlink 迁移** — `~/opendaemon` 变成 symlink 指向 `~/workspace/projects/opendaemon`，pm2、deploy.sh 等全部不用改路径。jarvis-assistant 同理。

2. **不设 default_project** — 每次不明确时询问用户。避免用户意外在错误的项目中执行操作。

3. **产物 serve 走 opendaemon server** — 在 server.mjs 中增加 `/api/workspace/files/*` 路由，复用现有认证和文件服务逻辑。

4. **Workspace 感知通过 System Prompt** — 在 CLAUDE.md 或注入的系统提示中包含 workspace 信息，让 LLM 知道项目列表和产物目录位置。

5. **Workspace 感知通过知识库按需注入** — 服务启动时读取 `.workspace.json`，生成一条 rules 类型的 knowledge 条目。后续由现有 injector.mjs 按标签匹配注入——开发类对话自动注入，闲聊时零开销。CLAUDE.md 同步更新供 Claude Code 参考。

6. **.workspace.json 是唯一元数据源** — 不入 DB，纯文件，人可读可编辑。
