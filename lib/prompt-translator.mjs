// 为 /image 斜杠命令提供中文→英文 prompt 翻译
// 复用 config.json 里第一个 openai 类型引擎的配置（通常是 kimi-k2 或 deepseek）
// 无配置或无中文时直接返回原文
import { loadConfig } from "./config.mjs";

const SYSTEM_PROMPT = `You are an expert prompt engineer for Stable Diffusion XL photorealistic image generation.
Translate the user's Chinese image description into an optimized English SDXL prompt.

Strict rules:
1. Output ONLY the translated prompt text (no explanation, no quotes)
2. Use comma-separated short phrases, not sentences
3. Describe the TARGET STATE of the image, not actions
4. Add photorealism keywords when appropriate: iPhone photo, 35mm film, kodak portra 400, detailed skin texture, visible skin pores, unretouched, candid
5. NEVER append AI-精修 triggers: masterpiece, best quality, highly detailed, 8k, perfect skin, flawless, professional photography
6. Preserve any English words already present
7. Do NOT add content filtering tags
8. Keep under 150 words`;

const CN_REGEX = /[一-龥]/;

/**
 * 若 text 含中文，调用 LLM 翻译成英文 SDXL prompt；否则返回原文。
 * @param {string} text
 * @returns {Promise<string>}
 */
export async function translateIfChinese(text) {
  if (!text || !CN_REGEX.test(text)) return text;

  const cfg = loadConfig();
  const engine = (cfg.engines || []).find(
    (e) => e.type === "openai" && e.provider?.apiKey && e.provider?.baseUrl
  );
  if (!engine) return text; // 没配可用的翻译引擎 → 原文发送

  const baseUrl = engine.provider.baseUrl.replace(/\/$/, "");
  const body = {
    model: engine.provider.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: text },
    ],
    temperature: 0.3,
    max_tokens: 500,
  };

  const r = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${engine.provider.apiKey}`,
      "HTTP-Referer": "http://127.0.0.1:3456",
      "X-Title": "OpenDaemon ImageGen",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    throw new Error(`Translation LLM failed: HTTP ${r.status}`);
  }
  const data = await r.json();
  const translated = data.choices?.[0]?.message?.content?.trim();
  if (!translated) return text;
  return translated;
}
