# Spec 010: ImageGen Adapter 抽象

## Problem

当前 `/api/image/generate` 路由直接调用 `lib/comfyui.mjs` 的 ComfyUI REST API 函数（`comfyPing` / `comfySubmitPrompt` / `comfyPollUntilComplete` / `comfyDownloadOutput`）。

三层耦合：

1. **路由层 ↔ 具体 provider** — 业务逻辑（鉴权、速率限制、翻译、并发锁）和 ComfyUI 协议细节混在同一个 handler 里
2. **API 参数 ↔ ComfyUI 概念** — `mode=plus_face/faceid/faceid_plus/ipadapter/txt2img` 是 ComfyUI 工作流的特有术语，作为 API 公开参数和 UI 选项暴露出去
3. **配置结构只支持单一 provider** — `imagegen.comfyUrl` 只能配一个 ComfyUI 实例，没法同时接 DALL-E、Replicate、Stability AI 等

结果：想切换到其他多模态生图服务要动大量代码；想在不同场景用不同 provider（本地 ComfyUI 无审查 / 云端 DALL-E 快速出图）做不到。

## Goals

1. **统一 `ImageGenAdapter` 接口** — 定义 provider 无关的 `generate()` 契约，业务层只依赖接口
2. **ComfyUI 迁移为 adapter** — 现有 `lib/comfyui.mjs` 包装成 `adapters/comfyui.mjs`，业务行为不变
3. **多 provider 配置 + 运行时切换** — 配置改成 `providers[]` 列表 + `default` 字段，API 可指定 provider
4. **能力声明（capabilities）** — 每个 adapter 声明支持哪些 mode / 分辨率 / 是否支持 ref image，UI 根据 capabilities 决定显示选项
5. **至少 1 个云托管 adapter 验证** — 实现 OpenAI DALL-E 3 adapter 证明抽象可扩展

## Non-Goals (this phase)

- 多 provider 并行生成（同一 prompt 发给多个 provider 对比）
- 跨 provider 的 mode 自动映射（ComfyUI 的 `faceid` 在 DALL-E 里没有对应物，只能降级或拒绝）
- 用户层的 provider 计费聚合
- 图片后处理插件（upscale / 背景去除）
- 视频生成、语音生成（下个 spec）

## Architecture

```
POST /api/image/generate
  │
  ├─ 业务层（server.mjs handler，不碰具体 provider）
  │    • 鉴权 + ref 属主校验 + 并发锁 + 速率限制
  │    • prompt 翻译（中→英）
  │    • user 消息早落库 + 失败消息入库
  │    • 选 provider：body.provider ?? config.imagegen.default
  │
  ├─ Adapter registry（lib/image-gen/index.mjs）
  │    • loadAdapters(config) → Map<providerId, adapter>
  │    • getAdapter(id) → adapter
  │    • 按 adapter.capabilities 校验 mode/分辨率是否支持
  │
  └─ 调用 adapter.generate({ prompt, mode, ref_image, ... })
        │
        ├─ ComfyUIAdapter         → 现有 SSH 隧道 + workflow 构造
        ├─ OpenAIAdapter          → /v1/images/generations (DALL-E 3)
        ├─ ReplicateAdapter       → 未来扩展
        └─ StabilityAdapter       → 未来扩展
```

## User Stories

### US-1: 配置多 provider 并指定默认

作为用户，我想同时配置本地 ComfyUI 和云端 DALL-E，默认用 ComfyUI，特定场景切 DALL-E。

- 在 `config.json` 填两个 provider
- 默认 `/image <prompt>` 走 ComfyUI
- `/image@dalle-3 <prompt>` 指定走 DALL-E

### US-2: 不同 provider 的能力差异可见

作为用户，我在 UI 里选 mode 时，只看到当前 provider 支持的选项。

- 选 ComfyUI 时能看到 `faceid/plus_face/ipadapter` 等
- 选 DALL-E 时只看到 `txt2img`（DALL-E 不支持 ref image）
- 选了 DALL-E 但传 ref image 时返回明确错误

### US-3: 切换 provider 零代码改动

作为开发者，我想加一个新 provider（比如 Replicate）不动业务层代码。

- 新建 `lib/image-gen/adapters/replicate.mjs` 实现接口
- 在 registry 里注册类型
- 配置里加一条 `{ id, type: "replicate", ... }` 即可用

### US-4: 现有 /image 命令继续工作

作为用户，我现有的 `/image 马头人身`、`/image:faceid @xxx <prompt>` 继续工作，不用改用法。

- 路由保持向后兼容：body 不传 `provider` 时走 default
- 不传 provider 的用户感知不到任何变化

## Technical Design

### 1. Adapter 接口定义（`lib/image-gen/types.mjs`）

```js
/**
 * @typedef {Object} GenerateInput
 * @property {string} prompt
 * @property {string} [negative_prompt]
 * @property {string} [mode]              - adapter 内部映射（txt2img / faceid / ...）
 * @property {Buffer} [ref_image]         - 参考图字节
 * @property {string} [ref_image_name]    - 参考图原始文件名（供 adapter 决定 MIME）
 * @property {number} [width]
 * @property {number} [height]
 * @property {number} [steps]
 * @property {number} [seed]
 * @property {number} [weight]
 * @property {boolean} [use_lightning]
 * @property {AbortSignal} [abortSignal]
 */

/**
 * @typedef {Object} GenerateOutput
 * @property {Buffer} image                - PNG bytes
 * @property {string} format               - "png" | "jpeg"
 * @property {Object} metadata             - { prompt, seed, mode, model, ... }
 * @property {number} duration_ms
 * @property {string} provider_job_id      - 用于取消（如 ComfyUI promptId）
 */

/**
 * @typedef {Object} AdapterCapabilities
 * @property {string[]} modes              - ["txt2img", "faceid", ...]
 * @property {string[]} resolutions        - ["lite_portrait", "square", ...]
 * @property {boolean} supportsRefImage
 * @property {boolean} supportsNegativePrompt
 * @property {number} maxSteps
 * @property {number} defaultSteps
 * @property {boolean} supportsCancel
 */
```

### 2. Adapter 接口（每个 adapter 实现）

```js
// lib/image-gen/adapters/comfyui.mjs
export class ComfyUIAdapter {
  constructor(config) {
    this.id = config.id;                   // "my-comfyui-mac"
    this.url = config.url;                 // "http://127.0.0.1:8188"
  }

  get capabilities() {
    return {
      modes: ["txt2img", "plus_face", "faceid", "faceid_plus", "ipadapter"],
      resolutions: ["lite_portrait", "lite_square", "portrait", "square", "landscape"],
      supportsRefImage: true,
      supportsNegativePrompt: true,
      maxSteps: 50,
      defaultSteps: 25,
      supportsCancel: true,
    };
  }

  async ping() { /* ... */ }
  async generate(input) { /* 现有 ComfyUI 逻辑 */ }
  async cancel(jobId) { /* 调 /interrupt */ }
}
```

```js
// lib/image-gen/adapters/openai.mjs
export class OpenAIAdapter {
  constructor(config) {
    this.id = config.id;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || "https://api.openai.com/v1";
    this.model = config.model || "dall-e-3";
  }

  get capabilities() {
    return {
      modes: ["txt2img"],
      resolutions: ["square", "portrait", "landscape"],  // DALL-E 3 支持
      supportsRefImage: false,
      supportsNegativePrompt: false,
      maxSteps: 0,                         // DALL-E 不暴露 steps
      defaultSteps: 0,
      supportsCancel: false,
    };
  }

  async ping() {
    // 轻量 GET models 接口
  }

  async generate(input) {
    if (input.ref_image) throw new Error("DALL-E 不支持参考图");
    // POST /v1/images/generations
    // 返回 URL → fetch → Buffer
  }
}
```

### 3. Registry（`lib/image-gen/index.mjs`）

```js
const ADAPTER_TYPES = {
  comfyui: (cfg) => new ComfyUIAdapter(cfg),
  openai:  (cfg) => new OpenAIAdapter(cfg),
  // replicate: ..., stability: ...
};

let _adapters = null;  // Map<id, adapter>
let _defaultId = null;

export function loadAdapters(imagegenConfig) {
  _adapters = new Map();
  _defaultId = imagegenConfig.default;
  for (const cfg of imagegenConfig.providers || []) {
    const factory = ADAPTER_TYPES[cfg.type];
    if (!factory) throw new Error(`unknown adapter type: ${cfg.type}`);
    _adapters.set(cfg.id, factory(cfg));
  }
}

export function getAdapter(id) {
  const target = id || _defaultId;
  if (!_adapters?.has(target)) {
    throw new Error(`adapter not found: ${target}`);
  }
  return _adapters.get(target);
}

export function listProviders() {
  return Array.from(_adapters.values()).map(a => ({
    id: a.id,
    type: a.constructor.name.replace("Adapter", "").toLowerCase(),
    capabilities: a.capabilities,
  }));
}
```

### 4. 配置 schema

```json
{
  "imagegen": {
    "default": "my-comfyui",
    "providers": [
      {
        "id": "my-comfyui",
        "type": "comfyui",
        "url": "http://127.0.0.1:8188"
      },
      {
        "id": "dalle-3",
        "type": "openai",
        "apiKey": "sk-...",
        "model": "dall-e-3",
        "baseUrl": "https://api.openai.com/v1"
      }
    ],
    "limits": {
      "maxConcurrent": 1,
      "maxPerHour": 10,
      "maxPerDay": 50
    }
  }
}
```

### 5. `/api/image/generate` 改造

业务层保持原有逻辑（鉴权 / ref 校验 / 速率 / 翻译 / 消息入库），但**生成动作统一走 adapter**：

```js
const adapter = getAdapter(body.provider);  // undefined → default

// 能力校验
const caps = adapter.capabilities;
if (mode && !caps.modes.includes(mode)) {
  // 返回 400 + insertFailureMsg: "provider X 不支持 mode Y"
}
if (ref_attachment_id && !caps.supportsRefImage) {
  // 返回 400
}

// 统一调用
const result = await adapter.generate({
  prompt: finalPositive,
  negative_prompt: finalNegative,
  mode, ref_image: refBuf, ref_image_name: refAtt?.filename,
  width, height, steps, seed, weight, use_lightning,
});

// 保存 result.image，写入 DB
```

### 6. 新 API 端点

- **`GET /api/image/providers`** — 返回 `listProviders()`，前端初始化时拉取
- **`POST /api/image/generate`** body 新增可选字段 `provider: string`
- **斜杠命令**：`/image@<provider-id>[:<mode>] <prompt>` — frontend 解析后塞进 body.provider

### 7. 前端改动

- 设置面板新增 "图像生成" 区块：列出所有 providers + 默认切换
- `/image` 命令 autocomplete 加 `@provider-id` 提示
- Mode 下拉根据当前 provider 的 `capabilities.modes` 动态生成

## Backwards Compatibility

- 不传 `provider` 字段时自动走 `default`
- 旧配置 `imagegen.comfyUrl` 在启动时自动升级为 `providers: [{ id: "default-comfyui", type: "comfyui", url: ... }]` + `default: "default-comfyui"`
- 现有 `/image <prompt>` 和 `/image:mode <prompt>` 语法不变
- DB schema 不动（`attachments.metadata` 已经是 JSON，可以存 provider 信息）

## Security / Boundaries

明确责任划分：

| 层 | 职责 |
|----|------|
| **业务层** | 会话鉴权、ref 属主、速率、并发锁、用户可见文案 |
| **Adapter 层** | 和 provider 通信、格式转换、retry、错误翻译 |
| **Provider** | 生成图片、内容审核（DALL-E 内置）、API key 权限、计费 |

Adapter 不负责业务策略；业务层不感知 provider 协议细节。ComfyUI 的"无审查"、DALL-E 的"内容过滤"都是 provider 自己的事。

## Risks

1. **mode 语义不一致** — ComfyUI 的 `faceid` 和 DALL-E 的 `txt2img` 无法自动等价。通过 capabilities 显式拒绝不支持的 mode，而非静默降级。
2. **响应时间差异大** — ComfyUI 2-3 分钟、DALL-E 10-20 秒。UI 的 loading 提示需按 provider 调整（进一步的 capability 字段 `estimatedSeconds`）。
3. **价格/限流风险** — 切换到云 provider 后，高频 /image 可能烧钱。默认 `limits` 仍在业务层，但 adapter 可额外声明 `rateHintsPerMinute` 让业务层更谨慎。

## Success Criteria

- [ ] 现有 ComfyUI 生图在迁移后行为完全一致（UI/DB/日志不变）
- [ ] 配置文件里加一个 `type: openai` provider，`/image@dalle-3 <prompt>` 能出图
- [ ] `GET /api/image/providers` 返回所有 providers + capabilities
- [ ] 能力不匹配时返回明确错误（不是静默失败）
- [ ] 单 provider 的 config（老格式）启动时自动升级，无破坏
