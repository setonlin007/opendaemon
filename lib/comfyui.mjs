// ComfyUI REST client + SDXL workflow 构造器
// 5 种模式：txt2img / plus_face / faceid / faceid_plus / ipadapter
// 工作流节点设计与 ~/AI-ImageGen/webui/comfy.mjs 对齐（经过实测调优）

export const DEFAULT_COMFY_URL = "http://127.0.0.1:8188";

/**
 * 构造 ComfyUI API 格式的 workflow JSON
 * @param {string} mode - txt2img | plus_face | faceid | faceid_plus | ipadapter
 * @param {object} opts
 * @param {string} [opts.refImage] - 参考图 ComfyUI 文件名 (LoadImage 节点使用)
 * @param {string} opts.positive
 * @param {string} opts.negative
 * @param {number} [opts.width=896]
 * @param {number} [opts.height=1152]
 * @param {number} [opts.steps=25]
 * @param {number} [opts.seed] - 不传则随机
 * @param {number} [opts.cfg=5.5]
 * @param {number} [opts.weight=1.0]
 * @param {string} [opts.checkpoint='RealVisXL_V4.0.safetensors']
 * @param {boolean} [opts.useLightning=false] - 4-step Lightning LoRA (faceid 系不兼容)
 * @returns {{ workflow: object, seed: number }}
 */
export function buildWorkflow(mode, opts) {
  const {
    refImage,
    positive,
    negative,
    width = 896,
    height = 1152,
    steps = 25,
    seed,
    cfg = 5.5,
    weight = 1.0,
    checkpoint = "RealVisXL_V4.0.safetensors",
    useLightning = false,
  } = opts;

  const finalSeed = seed ?? Math.floor(Math.random() * 1e15);

  // Lightning 强制改采样参数：4 步 euler + sgm_uniform + 低 CFG
  const ltOn = useLightning && mode !== "faceid" && mode !== "faceid_plus";
  const finalSteps = ltOn ? 4 : steps;
  const finalCfg = ltOn ? 1.5 : cfg;
  const finalSampler = ltOn ? "euler" : "dpmpp_2m_sde";
  const finalScheduler = ltOn ? "sgm_uniform" : "karras";

  const w = {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: checkpoint },
    },
    "2": {
      class_type: "CLIPTextEncode",
      inputs: { text: positive, clip: ["1", 1] },
    },
    "3": {
      class_type: "CLIPTextEncode",
      inputs: { text: negative, clip: ["1", 1] },
    },
    "4": {
      class_type: "EmptyLatentImage",
      inputs: { width, height, batch_size: 1 },
    },
    "5": {
      class_type: "KSampler",
      inputs: {
        model: ["1", 0],
        positive: ["2", 0],
        negative: ["3", 0],
        latent_image: ["4", 0],
        seed: finalSeed,
        steps: finalSteps,
        cfg: finalCfg,
        sampler_name: finalSampler,
        scheduler: finalScheduler,
        denoise: 1.0,
      },
    },
    "6": {
      class_type: "VAEDecode",
      inputs: { samples: ["5", 0], vae: ["1", 2] },
    },
    "7": {
      class_type: "SaveImage",
      inputs: {
        images: ["6", 0],
        filename_prefix: `opendaemon_${mode}${ltOn ? "_lt" : ""}`,
      },
    },
  };

  // Lightning LoRA 注入（Plus-Face / ipadapter / txt2img 可用）
  let modelSrc = ["1", 0];
  if (ltOn) {
    w["14"] = {
      class_type: "LoraLoader",
      inputs: {
        model: ["1", 0],
        clip: ["1", 1],
        lora_name: "sdxl_lightning_4step_lora.safetensors",
        strength_model: 1.0,
        strength_clip: 1.0,
      },
    };
    modelSrc = ["14", 0];
    w["5"].inputs.model = modelSrc;
  }

  if (mode === "txt2img") {
    return { workflow: w, seed: finalSeed };
  }

  if (!refImage) {
    throw new Error(`Mode '${mode}' requires refImage`);
  }

  w["8"] = {
    class_type: "LoadImage",
    inputs: { image: refImage },
  };

  if (mode === "faceid" || mode === "faceid_plus") {
    w["9"] = {
      class_type: "IPAdapterUnifiedLoaderFaceID",
      inputs: {
        model: modelSrc,
        preset: "FACEID PLUS V2",
        lora_strength: 0.6,
        provider: "CPU",
      },
    };
    w["10"] = {
      class_type: "IPAdapterFaceID",
      inputs: {
        model: ["9", 0],
        ipadapter: ["9", 1],
        image: ["8", 0],
        weight,
        weight_faceidv2: 1.5,
        weight_type: "linear",
        combine_embeds: "concat",
        start_at: 0.0,
        end_at: 1.0,
        embeds_scaling: "V only",
      },
    };
    w["5"].inputs.model = ["10", 0];

    // faceid_plus 在 FaceID 之后再叠加 Plus-Face（权重固定 0.5）
    if (mode === "faceid_plus") {
      w["11"] = {
        class_type: "IPAdapterModelLoader",
        inputs: { ipadapter_file: "ip-adapter-plus-face_sdxl_vit-h.safetensors" },
      };
      w["12"] = {
        class_type: "CLIPVisionLoader",
        inputs: { clip_name: "CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors" },
      };
      w["13"] = {
        class_type: "IPAdapterAdvanced",
        inputs: {
          model: ["10", 0],
          ipadapter: ["11", 0],
          clip_vision: ["12", 0],
          image: ["8", 0],
          weight: 0.5,
          weight_type: "linear",
          combine_embeds: "concat",
          start_at: 0.0,
          end_at: 1.0,
          embeds_scaling: "V only",
        },
      };
      w["5"].inputs.model = ["13", 0];
    }
  } else if (mode === "plus_face" || mode === "ipadapter") {
    const ipaFile =
      mode === "plus_face"
        ? "ip-adapter-plus-face_sdxl_vit-h.safetensors"
        : "ip-adapter-plus_sdxl_vit-h.safetensors";
    w["11"] = {
      class_type: "IPAdapterModelLoader",
      inputs: { ipadapter_file: ipaFile },
    };
    w["12"] = {
      class_type: "CLIPVisionLoader",
      inputs: { clip_name: "CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors" },
    };
    w["13"] = {
      class_type: "IPAdapterAdvanced",
      inputs: {
        model: modelSrc,
        ipadapter: ["11", 0],
        clip_vision: ["12", 0],
        image: ["8", 0],
        weight,
        weight_type: "linear",
        combine_embeds: "concat",
        start_at: 0.0,
        end_at: 1.0,
        embeds_scaling: "V only",
      },
    };
    w["5"].inputs.model = ["13", 0];
  }

  return { workflow: w, seed: finalSeed };
}

/**
 * 上传图片字节到 ComfyUI（供 LoadImage 节点引用）
 * 用 ComfyUI 自己的 /upload/image 端点，不依赖文件系统共享。
 * @param {Buffer} buffer
 * @param {string} filename - 建议带唯一前缀防冲突
 * @param {string} comfyUrl
 * @returns {Promise<string>} - ComfyUI 返回的文件名（供 LoadImage 用）
 */
export async function uploadImageToComfy(buffer, filename, comfyUrl = DEFAULT_COMFY_URL) {
  // multipart/form-data 手工构造（避免引入 FormData polyfill 依赖）
  const boundary = "----comfy" + Math.random().toString(36).slice(2);
  const CRLF = "\r\n";
  const head = Buffer.from(
    `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="image"; filename="${filename}"${CRLF}` +
      `Content-Type: application/octet-stream${CRLF}${CRLF}`,
    "utf-8"
  );
  const tail = Buffer.from(`${CRLF}--${boundary}--${CRLF}`, "utf-8");
  const body = Buffer.concat([head, buffer, tail]);

  const r = await fetch(`${comfyUrl}/upload/image`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`ComfyUI 上传失败 ${r.status}: ${t.slice(0, 200)}`);
  }
  const data = await r.json();
  if (!data.name) throw new Error("ComfyUI 上传返回缺 name");
  return data.name;
}

/**
 * 提交 workflow 到 ComfyUI
 * @returns {Promise<string>} prompt_id
 */
export async function submitPrompt(workflow, comfyUrl = DEFAULT_COMFY_URL) {
  const r = await fetch(`${comfyUrl}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: workflow,
      client_id: "opendaemon-" + Date.now(),
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`ComfyUI /prompt 失败 ${r.status}: ${t.slice(0, 200)}`);
  }
  const data = await r.json();
  if (!data.prompt_id) throw new Error("ComfyUI /prompt 返回缺 prompt_id");
  return data.prompt_id;
}

/**
 * 轮询 /history 直到完成或超时。
 * @returns {Promise<{ filename: string, subfolder: string }>}
 */
export async function pollUntilComplete(
  promptId,
  comfyUrl = DEFAULT_COMFY_URL,
  timeoutMs = 900000,
  onProgress
) {
  const start = Date.now();
  const seen = new Set();
  while (Date.now() - start < timeoutMs) {
    const r = await fetch(`${comfyUrl}/history/${promptId}`);
    if (r.ok) {
      const hist = await r.json();
      const entry = hist[promptId];
      if (entry) {
        const status = entry.status || {};
        // Emit progress events
        if (onProgress) {
          for (const msg of status.messages || []) {
            if (!Array.isArray(msg)) continue;
            const key = JSON.stringify(msg).slice(0, 200);
            if (seen.has(key)) continue;
            seen.add(key);
            try { onProgress(msg[0], msg[1]); } catch {}
            if (msg[0] === "execution_error") {
              throw new Error(
                `节点 ${msg[1]?.node_id}(${msg[1]?.node_type}): ${msg[1]?.exception_message || "unknown"}`
              );
            }
          }
        }
        if (status.completed) {
          for (const out of Object.values(entry.outputs || {})) {
            if (out.images?.[0]) {
              return {
                filename: out.images[0].filename,
                subfolder: out.images[0].subfolder || "",
              };
            }
          }
          throw new Error("ComfyUI 完成但输出为空");
        }
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`轮询超时 ${timeoutMs}ms`);
}

/**
 * 从 ComfyUI 下载输出图片字节
 * @returns {Promise<Buffer>}
 */
export async function downloadOutput(
  filename,
  subfolder = "",
  comfyUrl = DEFAULT_COMFY_URL
) {
  const qs = new URLSearchParams({ filename, subfolder, type: "output" });
  const r = await fetch(`${comfyUrl}/view?${qs}`);
  if (!r.ok) throw new Error(`ComfyUI /view 失败 ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/**
 * 快速连通性探测
 */
export async function ping(comfyUrl = DEFAULT_COMFY_URL, timeoutMs = 3000) {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(`${comfyUrl}/`, { signal: ctrl.signal });
    return r.ok;
  } catch {
    return false;
  }
}
