# Tasks 010: ImageGen Adapter 实现

按依赖顺序排列。每个任务独立可测、可回滚。

---

## T1: 建基础结构

- 新建 `lib/image-gen/` 目录
- `types.mjs` — JSDoc 类型定义（`GenerateInput` / `GenerateOutput` / `AdapterCapabilities`）
- `index.mjs` — 空 registry 骨架（`loadAdapters` / `getAdapter` / `listProviders`）
- `adapters/_base.mjs`（可选）— 共享辅助
- 不动现有 `lib/comfyui.mjs`，也不改 `server.mjs`

**验收**：`node --check` 全过，导入可用，但 `server.mjs` 完全不依赖

---

## T2: ComfyUIAdapter（包装现有代码）

- `lib/image-gen/adapters/comfyui.mjs`
- 内部 `import * as comfy from "../../comfyui.mjs"`
- 实现 `generate(input)`：把现有 /api/image/generate 里的"上传 ref → buildWorkflow → submit → poll → download"逻辑搬过来
- 实现 `ping()` / `cancel(jobId)`
- 定义 `capabilities`

**验收**：有 unit test（mock comfy.* 函数）验证 adapter 接口契约

---

## T3: Registry 实例化 + 配置自动升级

- `lib/config.mjs` 加 `migrateImagegen()`：检测旧格式 `{comfyUrl}` 自动转新格式 `{default, providers[]}`
- `server.mjs` 启动处 `loadAdapters(cfg.imagegen)`
- 注册 `comfyui` type

**验收**：
- 旧配置启动不报错（日志能看到 "loaded 1 imagegen adapter: default-comfyui"）
- 新配置（多 providers）也能加载

---

## T4: 路由切换到 adapter（带 feature flag）

- 加配置 `imagegen.useAdapters`（默认 false）
- `/api/image/generate`：if flag → `getAdapter(body.provider).generate(...)`；else → 保留老路径
- 业务层（鉴权 / ref 属主 / 速率 / 并发锁 / 翻译 / 消息入库 / 失败消息）完全保留
- 加能力校验：mode 不支持 / ref 不支持时返 400 + insertFailureMsg

**验收**：
- flag=false 时行为完全一致
- flag=true + 单 ComfyUI provider：`/image` 生图成功，DB 记录跟旧路径完全一样

---

## T5: Providers API 端点

- `GET /api/image/providers` → `listProviders()`
- 返回体：`{ default, providers: [{ id, type, capabilities }] }`

**验收**：curl 能看到正确返回；不需要 auth 绕过

---

## T6: 前端支持 @provider 语法

- `handleImageCommand()` regex 升级为 `/^\/+image(?:@(\S+))?(?::(\w+))?\s+(.+)/is`
- POST body 附 `provider` 字段
- 启动时 fetch `/api/image/providers` 缓存
- Autocomplete：输入 `/image@` 时下拉 providers

**验收**：
- 老语法 `/image <prompt>` 走 default 正常
- `/image@my-comfyui <prompt>` 显式走 comfyui
- Autocomplete 能选

---

## T7: 设置面板展示 providers

- 设置面板加"图像生成"区块
- 每个 provider 一张卡片：id、type、capabilities（只读）、是否默认
- 切换默认（调 `PATCH /api/config/imagegen-default` 或类似）—— 这个 API **可选**，第一版可以只读

**验收**：面板能看到当前配置，UI 不崩

---

## T8: OpenAIAdapter（DALL-E 3）

- `lib/image-gen/adapters/openai.mjs`
- 实现 `generate` / `ping` / `capabilities`
- 注册到 registry
- `_mapSize` 逻辑把宽高映射到 DALL-E 合法尺寸

**验收**：
- 配置加 `{ type: "openai", apiKey, model: "dall-e-3" }`
- `/image@dalle-3 一只坐在月球上的猫` 能出图
- ref image 场景返回明确 "DALL-E 不支持参考图" 错误

---

## T9: 端到端验证

- 同时配置 ComfyUI + DALL-E，多会话并行
- `/image <prompt>` → 走默认
- `/image@dalle-3 <prompt>` → DALL-E
- `/image@my-comfyui:faceid @xxx <prompt>` → ComfyUI 带参考图
- 所有失败路径都有明确错误 + DB 失败消息

**验收**：三种路径全跑通；DB 里 attachments.metadata 里有 provider 字段

---

## T10: 清理

- 删除 `imagegen.useAdapters` feature flag，默认走 adapter
- 更新 `CLAUDE.md` / `README` 的 imagegen 说明
- 保留 `lib/comfyui.mjs`（被 ComfyUIAdapter 依赖），但标注 "内部实现，不要直接从 server.mjs 调用"

**验收**：grep `comfyPing|comfySubmitPrompt|...` 在 `server.mjs` 无匹配

---

## 部署节奏

- T1-T3 一次 PR（纯重构，无行为变化）
- T4-T7 一次 PR（feature flag 保护，可灰度）
- T8-T9 一次 PR（新能力 + 验证）
- T10 一次 PR（清理）

每次推 + 等用户确认 + deploy。
