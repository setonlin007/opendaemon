# Video Workbench Plugin

> OpenDaemon 上的视频生成工作台 · 把 `~/workspace/skills/video-factory/` skill 包成图形界面 · **完全可插拔**

## 设计

```
plugins/video-workbench/      ← 整个插件就一个目录
├── index.mjs                  # 入口 · 导出 init(opts) → { match, handle }
├── router.mjs                 # HTTP 路由
├── db.mjs                     # 独立 SQLite (data/vf.db)
├── keys.mjs                   # AES-256-GCM key 加密
├── manifest.mjs               # 项目 manifest.json 工具
├── skill-runner.mjs           # spawn skill 脚本 + SSE 日志转发
├── web/
│   └── video-factory.html     # 前端单页（hash routing）
├── install.sh
├── uninstall.sh
└── README.md
```

## 数据与文件位置

| 资产 | 位置 | 说明 |
|---|---|---|
| 插件代码 | `<daemon>/plugins/video-workbench/` | 整套插件文件，可整体 rm |
| SQLite | `<daemon>/data/vf.db` | 5 张 `vf_*` 表，独立于 `opendaemon.db` |
| 日志 | `<daemon>/data/vf-logs/<run_id>.log` | 每次 skill spawn 一份完整 stdout/stderr |
| 项目目录 | `~/workspace/projects/<slug>/` | 每个视频项目一个目录，含 `manifest.json` / `brief.json` / 产物 |
| Skill scripts | `~/workspace/skills/video-factory/scripts/` | 不归插件管，但靠它跑 |

## 访问

| URL | 用途 |
|---|---|
| `/video-factory.html` | 前端入口（直接访问 · **不在 daemon 主 UI 加链接**） |
| `/api/vf/health` | 健康检查 |
| `/api/vf/projects` | 项目 CRUD |
| `/api/vf/projects/:id/brief` | 简报 |
| `/api/vf/projects/:id/audio` | 配音合成（SSE） |
| `/api/vf/projects/:id/lint` | TTS 静态检查（SSE） |
| `/api/vf/projects/:id/sync-audit` | 音画同步审计（SSE） |
| `/api/vf/keys` | API key 管理（AES 加密） |
| `/api/vf/runs/:id/log` | 查看完整日志 |
| `/api/vf/runs/:id/kill` | 杀进程（递归 pkill -P） |

## 当前版本 v0.1（Iter 1）

实现的功能：

- ✅ Project CRUD（新建 / 列表 / 归档）
- ✅ 项目目录自动 bootstrap（创建 manifest.json / brief.json / scripts 软链）
- ✅ Brief 表单
- ✅ API key 加密存储（AES-256-GCM）
- ✅ Skill runner（spawn + SSE 日志 + 进度解析）
- ✅ TTS lint / sync-audit（透传 skill 脚本）
- ⚠️ Audio synth 已接通但前端 UI 占位
- ⏳ Playwright Recording (Iter 2)
- ⏳ Encode + 版本管理 UI (Iter 2)
- ⏳ Mac 录屏向导 (Iter 3)
- ⏳ 多平台发布 (Iter 3)

## 卸载（10 秒）

```bash
bash plugins/video-workbench/uninstall.sh --yes
```

脚本会：
1. 备份 `vf.db` 到 `~/vf-backup-<ts>.db`
2. 删除 `data/vf.db*` 和 `data/vf-logs/`
3. 提示 server.mjs 要删的 2 个代码块
4. 让你确认后删除 `plugins/video-workbench/` 目录

之后重启 daemon 即可完全恢复。

## 插件契约（不能违反，否则不可拆）

1. **零侵入主 server.mjs**：只允许 1 处 mount 代码块（`/* Plugin: Video Workbench */` 标记内）
2. **零侵入 lib/db.mjs**：用独立 `vf.db`，不动主库
3. **零侵入 public/index.html**：不在 daemon 主 UI 加任何 DOM
4. **零侵入 config.json**：API key 存 `vf.db` 加密表
5. **复用 auth 但不依赖内部**：只调 `auth.requireAuth(req, res)` 公开 API
6. **复用 skill 但不修改**：只 spawn `~/workspace/skills/video-factory/scripts/*.py`，不改 skill 一行
7. **依赖 npm 不增**：只用 daemon 已有的 `better-sqlite3`

违任一条 = 拆不干净，请回炉。

## 已知限制

- 单进程内存 mutex 防并发：daemon 重启时 running run 状态会变孤儿（在 DB 仍是 `running` 但 pid 已死）。计划在 init 时扫描并标记为 `killed`。
- 没有 csrf token：依赖 daemon 的 cookie session
- 不限速：高频请求需在 daemon 层用 rate limiter
