# Plan 010: ImageGen Adapter 实现

## Target Directory Layout

```
lib/
├── image-gen/
│   ├── index.mjs               # registry: loadAdapters / getAdapter / listProviders
│   ├── types.mjs               # JSDoc 类型定义（GenerateInput / GenerateOutput / Capabilities）
│   └── adapters/
│       ├── _base.mjs           # 可选：共享的 retry / AbortSignal 辅助
│       ├── comfyui.mjs         # 包装现有 lib/comfyui.mjs
│       └── openai.mjs          # 新增：DALL-E 3 实现
│
└── comfyui.mjs                 # 保留原文件，被 adapters/comfyui.mjs 复用（避免大改）
```

`server.mjs` 改动点：
- 启动时调 `loadAdapters(cfg.imagegen)`
- `/api/image/generate` handler 改走 adapter
- 新增 `GET /api/image/providers` 路由

## 配置迁移

**旧格式（兼容）：**
```json
{ "imagegen": { "comfyUrl": "http://127.0.0.1:8188", "maxConcurrent": 1, ... } }
```

**新格式：**
```json
{
  "imagegen": {
    "default": "my-comfyui",
    "providers": [
      { "id": "my-comfyui", "type": "comfyui", "url": "http://127.0.0.1:8188" },
      { "id": "dalle-3",    "type": "openai",  "apiKey": "sk-...", "model": "dall-e-3" }
    ],
    "limits": { "maxConcurrent": 1, "maxPerHour": 10, "maxPerDay": 50 }
  }
}
```

**自动升级逻辑**（`lib/config.mjs`）：
```js
function migrateImagegen(cfg) {
  const ig = cfg.imagegen || {};
  if (ig.providers) return;               // 已是新格式
  if (ig.comfyUrl) {
    cfg.imagegen = {
      default: "default-comfyui",
      providers: [{
        id: "default-comfyui",
        type: "comfyui",
        url: ig.comfyUrl,
      }],
      limits: {
        maxConcurrent: ig.maxConcurrent ?? 1,
        maxPerHour:    ig.maxPerHour    ?? 10,
        maxPerDay:     ig.maxPerDay     ?? 50,
      },
    };
  }
}
```

老配置启动后被自动补全为新格式（只在内存，不回写磁盘——用户按需自己迁移）。

## Adapter 契约

### 必选方法

```js
class Adapter {
  constructor(config) { /* id, type-specific fields */ }
  get capabilities() { /* 返回静态对象 */ }
  async generate(input: GenerateInput): GenerateOutput
}
```

### 可选方法

```js
async ping(): boolean         // 业务层预检
async cancel(jobId): void     // 取消
```

### Capabilities 对象

```js
{
  modes: string[],                    // adapter 接受的 mode 值
  resolutions: string[],              // 支持的分辨率 preset 名
  supportsRefImage: boolean,
  supportsNegativePrompt: boolean,
  maxSteps: number,                   // 0 表示不暴露
  defaultSteps: number,
  supportsCancel: boolean,
  estimatedSeconds: number,           // 提示 UI loading 时长
  rateHintsPerMinute?: number,        // provider 侧建议的速率上限
}
```

## 业务层改造（`/api/image/generate`）

```js
// 1. 选 adapter
const adapter = getAdapter(body.provider);   // undefined → default
const caps = adapter.capabilities;

// 2. 能力校验（每条失败都 insertFailureMsg + 明确错误）
if (mode !== "txt2img" && !caps.modes.includes(mode)) {
  return reject(400, `provider '${adapter.id}' 不支持 mode '${mode}'`);
}
if (ref_attachment_id && !caps.supportsRefImage) {
  return reject(400, `provider '${adapter.id}' 不支持参考图`);
}

// 3. Ping（adapter 自己决定 timeout/retry，业务层不管）
if (typeof adapter.ping === "function" && !(await adapter.ping())) {
  return reject(503, `provider '${adapter.id}' 不可达`);
}

// 4. 读 ref image bytes（如果需要）
let refBuf = null, refFilename = null;
if (ref_attachment_id) {
  refBuf = getAttachmentBuffer(ref_attachment_id);
  refFilename = getAttachment(ref_attachment_id).filename;
}

// 5. 翻译
const finalPositive = await translateIfChinese(prompt);

// 6. 标记并发锁
_markImageGenStart(conv_id, "pending");  // 用 "pending" 占位，拿到 jobId 后更新
try {
  const result = await adapter.generate({
    prompt: finalPositive,
    negative_prompt: finalNegative,
    mode, ref_image: refBuf, ref_image_name: refFilename,
    width: resSpec.width, height: resSpec.height,
    steps, seed, weight, use_lightning,
  });

  // 7. 保存 result.image → attachment
  const att = saveAttachment(conv_id, `output_${Date.now()}.png`, "image/png", result.image);
  updateAttachmentMetadata(att.id, JSON.stringify({
    ...result.metadata,
    provider: adapter.id,
    duration_ms: result.duration_ms,
  }));

  // 8. 插 assistant 消息
  ...
} finally {
  _markImageGenEnd(conv_id);
}
```

## 新 API 端点

### `GET /api/image/providers`

```json
{
  "default": "my-comfyui",
  "providers": [
    {
      "id": "my-comfyui",
      "type": "comfyui",
      "capabilities": {
        "modes": ["txt2img", "plus_face", "faceid", "faceid_plus", "ipadapter"],
        "resolutions": ["lite_portrait", "square", ...],
        "supportsRefImage": true,
        ...
      }
    },
    {
      "id": "dalle-3",
      "type": "openai",
      "capabilities": {
        "modes": ["txt2img"],
        "supportsRefImage": false,
        "estimatedSeconds": 15,
        ...
      }
    }
  ]
}
```

前端启动时 fetch 一次缓存，设置面板和 /image autocomplete 都复用。

### `POST /api/image/generate` 请求体新增

```js
{
  conv_id, prompt, mode, ref_attachment_id, weight, steps, seed, resolution,
  provider: "dalle-3"      // ← 新字段，可选
}
```

## 前端改动（`public/index.html`）

### `handleImageCommand()` 解析

支持 `@provider-id` 语法：
```js
const m = text.match(/^\/+image(?:@(\S+))?(?::(\w+))?\s+(.+)/is);
if (!m) return false;
const provider = m[1];   // 可能 undefined
const mode     = m[2];   // 可能 undefined → txt2img
const prompt   = m[3];
```

POST body 带上 `provider`。

### Autocomplete

键入 `/image@` 时，下拉列出 `providersCache.map(p => p.id)`。

### 设置面板

在"图像生成"区块展示 providers 列表 + 切换默认 + 每个 provider 的 capabilities 卡片（只读；编辑走 config.json）。

## ComfyUIAdapter 实现要点

```js
import * as comfy from "../../comfyui.mjs";   // 复用现有函数

export class ComfyUIAdapter {
  constructor(config) {
    this.id = config.id;
    this.url = config.url;
  }

  get capabilities() { /* 如 spec 定义 */ }

  async ping() {
    return comfy.ping(this.url);    // 已有 retry + 8s timeout
  }

  async generate(input) {
    // 1. 上传 ref image（如果有）
    let refName = null;
    if (input.ref_image) {
      const ext = (input.ref_image_name?.split(".").pop() || "png");
      refName = await comfy.uploadImageToComfy(
        input.ref_image, `od_ref_${Date.now()}.${ext}`, this.url
      );
    }
    // 2. buildWorkflow
    const { workflow, seed } = comfy.buildWorkflow(input.mode, {
      refImage: refName,
      positive: input.prompt, negative: input.negative_prompt,
      width: input.width, height: input.height,
      steps: input.steps, seed: input.seed, weight: input.weight,
      useLightning: input.use_lightning,
    });
    // 3. submit + poll + download
    const t0 = Date.now();
    const promptId = await comfy.submitPrompt(workflow, this.url);
    const output = await comfy.pollUntilComplete(promptId, this.url);
    const image = await comfy.downloadOutput(output.filename, output.subfolder, this.url);
    return {
      image,
      format: "png",
      metadata: { seed, mode: input.mode, model: "sdxl", comfy_prompt_id: promptId },
      duration_ms: Date.now() - t0,
      provider_job_id: promptId,
    };
  }

  async cancel(jobId) {
    await fetch(`${this.url}/interrupt`, { method: "POST" });
  }
}
```

## OpenAIAdapter 实现要点

```js
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
      resolutions: ["square", "portrait", "landscape"],
      supportsRefImage: false,
      supportsNegativePrompt: false,
      maxSteps: 0, defaultSteps: 0,
      supportsCancel: false,
      estimatedSeconds: 15,
      rateHintsPerMinute: 5,
    };
  }

  async ping() {
    // GET /models with short timeout
    try {
      const r = await fetch(`${this.baseUrl}/models`, {
        headers: { "Authorization": `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      return r.ok;
    } catch { return false; }
  }

  async generate(input) {
    if (input.ref_image) throw new Error("DALL-E 不支持参考图");
    const size = this._mapSize(input.width, input.height);  // → "1024x1024" 等
    const t0 = Date.now();
    const r = await fetch(`${this.baseUrl}/images/generations`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        prompt: input.prompt,
        n: 1,
        size,
        quality: "standard",
        response_format: "b64_json",   // 直接拿 base64，免得再 fetch URL
      }),
    });
    if (!r.ok) throw new Error(`DALL-E ${r.status}: ${await r.text()}`);
    const data = await r.json();
    const b64 = data.data[0].b64_json;
    return {
      image: Buffer.from(b64, "base64"),
      format: "png",
      metadata: { model: this.model, prompt: input.prompt, revised_prompt: data.data[0].revised_prompt },
      duration_ms: Date.now() - t0,
      provider_job_id: data.created?.toString() || "",
    };
  }

  _mapSize(w, h) {
    if (w === h) return "1024x1024";
    if (w > h)   return "1792x1024";
    return "1024x1792";
  }
}
```

## 测试策略

1. **单元** — mock adapter 返回固定 Buffer，验证业务层流程（消息入库、失败分支、速率限制）
2. **集成** — 真实连 ComfyUI（本地）验证迁移后行为一致
3. **兼容** — 用旧格式配置启动，确认自动升级生效、`/image <prompt>` 正常出图
4. **新 provider** — 配置里加 DALL-E，`/image@dalle-3 一只坐在月球上的猫` 出图

## Rollout 顺序

1. 建 `lib/image-gen/` 结构 + `types.mjs` + `index.mjs`（空 registry）
2. 实现 `ComfyUIAdapter`（包装现有代码，行为不变）
3. 改 `server.mjs` 路由走 adapter（feature flag：`imagegen.useAdapters = true`）
4. 升级 config migration
5. 新增 `GET /api/image/providers`
6. 前端解析 `@provider-id` + 设置面板 UI
7. 实现 `OpenAIAdapter`
8. 端到端验证
9. 删除 feature flag，全量走 adapter 路径

每一步独立可部署、可回滚。
