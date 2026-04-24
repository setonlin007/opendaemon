/**
 * ComfyUI Adapter
 *
 * 包装 lib/comfyui.mjs。行为完全等价于旧的 server.mjs 里直接调用 comfy.* 的实现，
 * 只是把"上传 ref → buildWorkflow → submit → poll → download"这组流程收敛到
 * 一个统一的 generate(input) 入口。
 */

import * as comfy from "../../comfyui.mjs";
import { registerAdapterType, _resetForTests as _ } from "../index.mjs";  // eslint-disable-line

const MODE_WEIGHT_DEFAULT = {
  plus_face: 0.85,
  faceid: 1.1,
  faceid_plus: 1.0,
  ipadapter: 0.8,
  txt2img: 1.0,
};

export class ComfyUIAdapter {
  constructor(config) {
    if (!config?.id) throw new Error("ComfyUIAdapter: config.id required");
    this.id = config.id;
    this.url = config.url || comfy.DEFAULT_COMFY_URL;
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
      estimatedSeconds: 150,
    };
  }

  async ping() {
    return comfy.ping(this.url);  // 已内置 8s timeout + 2 次 retry
  }

  /**
   * @param {import("../types.mjs").GenerateInput} input
   * @returns {Promise<import("../types.mjs").GenerateOutput>}
   */
  async generate(input) {
    const t0 = Date.now();
    const mode = input.mode || "txt2img";
    const weight = input.weight ?? MODE_WEIGHT_DEFAULT[mode] ?? 1.0;

    // 1. 上传参考图（如果有）
    let refImageName = null;
    if (input.ref_image) {
      const ext = (input.ref_image_name?.split(".").pop() || "png").toLowerCase();
      const comfyFn = `od_ref_${Date.now()}_${Math.floor(Math.random() * 10000)}.${ext}`;
      try {
        refImageName = await comfy.uploadImageToComfy(input.ref_image, comfyFn, this.url);
      } catch (e) {
        throw new Error(`ComfyUI 上传参考图失败: ${e.message}`);
      }
    } else if (mode !== "txt2img") {
      throw new Error(`mode '${mode}' 需要参考图`);
    }

    // 2. 构造工作流
    const { workflow, seed: finalSeed } = comfy.buildWorkflow(mode, {
      refImage: refImageName,
      positive: input.prompt,
      negative: input.negative_prompt || "",
      width: input.width ?? 768,
      height: input.height ?? 1024,
      steps: input.steps ?? 25,
      seed: input.seed,
      weight,
      useLightning: input.use_lightning ?? false,
    });

    // 3. 提交并轮询
    const promptId = await comfy.submitPrompt(workflow, this.url);
    const output = await comfy.pollUntilComplete(promptId, this.url, 1800000 /* 30 min */);

    // 4. 下载结果
    const image = await comfy.downloadOutput(output.filename, output.subfolder, this.url);

    return {
      image,
      format: "png",
      metadata: {
        model: "sdxl",
        mode,
        seed: finalSeed,
        weight,
        steps: input.steps ?? 25,
        ref_image_name: refImageName,
        comfy_prompt_id: promptId,
        comfy_output_filename: output.filename,
      },
      duration_ms: Date.now() - t0,
      provider_job_id: promptId,
    };
  }

  async cancel(_jobId) {
    // ComfyUI 的 /interrupt 是全局的（不区分 promptId），会中断当前正在跑的任何任务。
    // jobId 参数在此忽略，只作为契约字段保留。
    try {
      await fetch(`${this.url}/interrupt`, { method: "POST" });
    } catch (e) {
      throw new Error(`ComfyUI /interrupt 失败: ${e.message}`);
    }
  }
}

// 自注册
registerAdapterType("comfyui", (cfg) => new ComfyUIAdapter(cfg));
