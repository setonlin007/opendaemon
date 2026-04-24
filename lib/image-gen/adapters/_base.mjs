/**
 * Adapter 共享辅助（retry / 分辨率映射）。
 * 不是强制基类——adapter 可以直接用普通 class，这些只是可复用工具。
 */

/**
 * 带退避重试的函数包装。
 *
 * @param {() => Promise<T>} fn
 * @param {Object} [opts]
 * @param {number} [opts.retries=2]         额外重试次数（总尝试 = retries + 1）
 * @param {number} [opts.delayMs=1000]      每次重试前等待
 * @param {(err: Error, attempt: number) => boolean} [opts.shouldRetry]  返回 false 立即抛出
 * @returns {Promise<T>}
 * @template T
 */
export async function withRetry(fn, opts = {}) {
  const retries = opts.retries ?? 2;
  const delayMs = opts.delayMs ?? 1000;
  const shouldRetry = opts.shouldRetry ?? (() => true);
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt >= retries || !shouldRetry(e, attempt)) throw e;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

/**
 * 标准分辨率预设表——adapter 可选择性引用。
 * adapter 声明 capabilities.resolutions 时只需给出这里的 key。
 */
export const RESOLUTION_PRESETS = {
  lite_portrait: { width: 768,  height: 1024 },
  lite_square:   { width: 768,  height: 768  },
  portrait:      { width: 896,  height: 1152 },
  square:        { width: 1024, height: 1024 },
  landscape:     { width: 1152, height: 896  },
};

export function resolvePreset(name, fallback = "lite_portrait") {
  return RESOLUTION_PRESETS[name] || RESOLUTION_PRESETS[fallback];
}
