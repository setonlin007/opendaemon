/**
 * ImageGen Adapter 类型定义
 *
 * 所有 adapter 实现遵循这里的契约。业务层（server.mjs /api/image/generate）
 * 只依赖这些 shape，不感知具体 provider（ComfyUI / DALL-E / Replicate / ...）。
 */

/**
 * @typedef {Object} GenerateInput
 * @property {string} prompt                       最终送进 provider 的正向提示词（已翻译）
 * @property {string} [negative_prompt]
 * @property {string} [mode]                       adapter 声明支持的 mode 之一
 * @property {Buffer} [ref_image]                  参考图字节（空 → 纯文生图）
 * @property {string} [ref_image_name]             原始文件名，供 adapter 推断 MIME/扩展名
 * @property {number} [width]
 * @property {number} [height]
 * @property {number} [steps]
 * @property {number} [seed]
 * @property {number} [weight]                     ref image / IP-Adapter 强度
 * @property {boolean} [use_lightning]             ComfyUI 专有（4-step LoRA）；其他 adapter 忽略
 * @property {AbortSignal} [abortSignal]           传入后 adapter 应在可取消点检测并提前终止
 */

/**
 * @typedef {Object} GenerateOutput
 * @property {Buffer} image                        出图字节（PNG 为主）
 * @property {string} format                       "png" | "jpeg"
 * @property {Object} metadata                     写入 attachments.metadata 的生成参数记录
 * @property {number} duration_ms
 * @property {string} [provider_job_id]            用于 cancel（如 ComfyUI promptId）
 */

/**
 * @typedef {Object} AdapterCapabilities
 * @property {string[]} modes                      支持的 mode 值；业务层据此校验
 * @property {string[]} resolutions                支持的分辨率 preset 名
 * @property {boolean} supportsRefImage
 * @property {boolean} supportsNegativePrompt
 * @property {number} maxSteps                     0 表示不暴露给用户
 * @property {number} defaultSteps
 * @property {boolean} supportsCancel
 * @property {number} [estimatedSeconds]           UI loading 提示参考值
 * @property {number} [rateHintsPerMinute]         provider 建议的上限（业务层可选用）
 */

/**
 * @typedef {Object} ProviderInfo                  GET /api/image/providers 的 element
 * @property {string} id
 * @property {string} type                         "comfyui" | "openai" | ...
 * @property {AdapterCapabilities} capabilities
 */

/**
 * ImageGenAdapter 契约（鸭子类型，JS 无 interface）。
 *
 * 必须实现:
 *   new Adapter(config)          constructor 接收 provider config 对象
 *   get capabilities             返回 AdapterCapabilities
 *   async generate(input)        返回 GenerateOutput；出错抛异常
 *
 * 可选实现:
 *   async ping()                 预检可用性；未实现时业务层跳过预检
 *   async cancel(jobId)          取消；capabilities.supportsCancel=true 时应实现
 */

export {};
