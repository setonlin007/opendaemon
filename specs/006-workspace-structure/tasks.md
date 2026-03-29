# Tasks 006: Workspace Structure

## Dependency Graph

```
T1 (create dirs) → T2 (migrate opendaemon) → T3 (migrate jarvis) → T4 (clean home)
                 → T5 (.workspace.json) → T8 (知识库 workspace 感知)
                 → T6a (artifacts API) → T6b (artifacts 浏览器 UI)
                 → T7 (update CLAUDE.md)
                 → T9 (verify)
```

## Stage 1: 基础结构

### T1: 创建 Workspace 目录结构
**Depends on:** nothing

- [ ] 创建 `~/workspace/projects/`
- [ ] 创建 `~/workspace/artifacts/{documents,data,media,exports,temp}`
- [ ] 创建 `~/workspace/scripts/`（可选，跨项目脚本）
- [ ] 验证目录权限和所有权

## Stage 2: 项目迁移

### T2: 迁移 opendaemon
**Depends on:** T1

- [ ] `pm2 stop opendaemon`
- [ ] `mv ~/opendaemon ~/workspace/projects/opendaemon`
- [ ] `ln -s ~/workspace/projects/opendaemon ~/opendaemon`
- [ ] `cd ~/opendaemon && pm2 start server.mjs --name opendaemon`
- [ ] `pm2 save`
- [ ] 验证 opendaemon 服务正常运行（curl health check）
- [ ] 验证 symlink 正确（`ls -la ~/opendaemon`）

### T3: 迁移 jarvis-assistant
**Depends on:** T1

- [ ] 查明 jarvis-assistant 的进程启动方式（pm2 / 手动 / systemd）
- [ ] 停止 jarvis-assistant 所有进程
- [ ] `mv ~/jarvis-assistant ~/workspace/projects/jarvis-assistant`
- [ ] `ln -s ~/workspace/projects/jarvis-assistant ~/jarvis-assistant`
- [ ] 重启 jarvis-assistant 进程
- [ ] 验证 jarvis 所有进程正常

### T4: 清理 Home 目录
**Depends on:** T2, T3

- [ ] 删除一次性调试脚本：`check_chatroom.py`, `check_key_usage.py`, `check_session.py`, `check_session_title.py`, `survey_old.py`, `win_cleanup.py`, `win_resources.py`
- [ ] 删除一次性部署脚本：`deploy_new.py`, `deploy_new2.py`, `deploy_fix.py`, `deploy_v3.py`, `deploy_v4.py`, `deploy_final.py`, `deploy_upload.py`
- [ ] 删除一次性配置脚本：`create_tasks.py`, `setup_services.py`, `start_services.py`, `start_svc.py`, `debug_svc.py`, `switch_monitor.py`
- [ ] 验证 home 目录干净（只剩 dotfiles + workspace symlinks + claude-bridge）

## Stage 3: 元数据和服务

### T5: 创建 .workspace.json
**Depends on:** T2, T3

- [ ] 在 `~/workspace/` 下创建 `.workspace.json`
- [ ] 填充 opendaemon 项目元数据（path, type, description, repo）
- [ ] 填充 jarvis-assistant 项目元数据
- [ ] 填充 artifacts_path

### T6a: 产物文件服务 API
**File:** `server.mjs`
**Depends on:** T1

- [ ] 新增路由 `GET /api/workspace/files/{path}` — 文件下载
- [ ] 解析 path，拼接到 workspace artifacts 绝对路径
- [ ] 安全校验：禁止 `..` 路径穿越，限制在 artifacts 目录内
- [ ] 复用现有文件下载逻辑（Content-Type 检测 + Content-Disposition）
- [ ] 新增路由 `GET /api/workspace/tree?path=` — 目录列表
- [ ] 返回 items 数组：文件含 name/type/size/mtime/mime，目录含 name/type/children_count/mtime
- [ ] 按类型排序（目录在前），同类型按名称排序
- [ ] 认证保护（复用现有 auth middleware）

### T6b: 产物浏览器 UI
**File:** `public/index.html`
**Depends on:** T6a

- [ ] 侧边栏 footer 新增 📁 按钮，点击打开产物浏览器 overlay
- [ ] Overlay 结构：header + 目录树区域（复用 evo-overlay 样式模式）
- [ ] 目录树：默认显示一级目录，点击展开子级（lazy load 调 `/api/workspace/tree?path=`）
- [ ] 文件行：类型图标 + 文件名 + 大小(格式化) + 修改时间 + 下载按钮
- [ ] 类型图标映射：📂目录 📊xlsx/csv 📝md/txt 🖼图片 📦压缩包 💾json/xml 📋pdf 📄默认
- [ ] 图片预览：.png/.jpg/.gif/.webp 文件点击可在 modal 中内联预览
- [ ] 文本预览：.txt/.md/.csv/.json 文件点击可在 modal 中显示内容
- [ ] 空目录显示灰色占位文字"暂无文件"

### T7: 更新 CLAUDE.md
**File:** `CLAUDE.md`
**Depends on:** T5

- [ ] 新增 Workspace 章节：目录结构、项目列表
- [ ] 更新文件生成指引：产物存到 artifacts/，下载链接改为 `/api/workspace/files/`
- [ ] 新增多项目工作规则：不明确时询问用户
- [ ] 更新 Directory Structure 图

### T8: Workspace 感知（知识库注入）
**Files:** `lib/knowledge.mjs` (或启动脚本), `data/knowledge/rules.md`, `lib/db.mjs`
**Depends on:** T5

- [ ] 新增 `syncWorkspaceKnowledge()` 函数：读取 `~/workspace/.workspace.json`，生成 workspace 知识条目
- [ ] 将 workspace 信息写入 `data/knowledge/rules.md` 的专属段落（带标记，便于后续更新）
- [ ] 在 `knowledge_index` 表中创建/更新对应条目，tags 设为 `workspace, project, file, code, develop, 项目, 开发, 文件, 创建, 修改`
- [ ] 服务启动时（`server.mjs` startup）调用一次 `syncWorkspaceKnowledge()`，确保知识条目与 .workspace.json 同步
- [ ] 容错：`.workspace.json` 不存在时静默跳过，不影响启动
- [ ] 项目增减后重启服务或手动触发即可更新知识条目（无需额外 API）

## Stage 4: 验证

### T9: 端到端验证
**Depends on:** all above

- [ ] opendaemon 服务正常：访问 web UI、发送消息、Evolution 面板
- [ ] jarvis-assistant 进程正常：wechat/web_chat/admin 三个进程运行
- [ ] symlinks 工作：`~/opendaemon/server.mjs` 和 `~/jarvis-assistant/main.py` 可访问
- [ ] 产物 API：在 artifacts/temp/ 放测试文件，通过 `/api/workspace/files/temp/test.txt` 下载
- [ ] deploy.sh 正常：`cd ~/opendaemon && bash scripts/deploy.sh` 仍可执行
- [ ] git 操作正常：在两个项目目录中 git status / git pull 无误
- [ ] home 目录整洁：`ls ~` 只有 dotfiles + workspace + symlinks + claude-bridge

## Implementation Order

1. **T1** (创建目录) — 无风险
2. **T6a** (artifacts API) + **T6b** (浏览器 UI) — 可先写代码，不依赖迁移
3. **T2** (迁移 opendaemon) — 需短暂停机
4. **T3** (迁移 jarvis) — 独立操作
5. **T4** (清理 home)
6. **T5** (.workspace.json) — 依赖项目就位
7. **T8** (知识库 workspace 感知) — 依赖 .workspace.json
8. **T7** (更新 CLAUDE.md)
9. **T9** (验证)

**预计：1-2 小时**（大部分是文件移动和验证）
