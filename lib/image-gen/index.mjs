/**
 * ImageGen Adapter Registry
 *
 * 启动时调用 loadAdapters(config.imagegen)，此后业务层通过 getAdapter(id) 取用。
 * 未知的 type 在启动期抛错，避免运行时才暴露配置错误。
 */

const _state = {
  adapters: null,     // Map<id, adapter>
  defaultId: null,    // string
  types: new Map(),   // type name → factory(config) → adapter
};

/**
 * 注册一个 adapter type。由各 adapter 模块在被导入时自行注册，
 * 也可由 loadAdapters 前显式调用（测试场景）。
 *
 * @param {string} type       如 "comfyui" | "openai"
 * @param {(config: object) => object} factory
 */
export function registerAdapterType(type, factory) {
  _state.types.set(type, factory);
}

/**
 * 按配置初始化所有 provider。重复调用会重置 registry。
 *
 * @param {{ default?: string, providers?: Array<{id:string,type:string}> }} imagegenConfig
 */
export function loadAdapters(imagegenConfig = {}) {
  _state.adapters = new Map();
  _state.defaultId = imagegenConfig.default || null;

  const providers = imagegenConfig.providers || [];
  for (const cfg of providers) {
    if (!cfg.id || !cfg.type) {
      throw new Error(`imagegen provider 缺少 id 或 type: ${JSON.stringify(cfg)}`);
    }
    const factory = _state.types.get(cfg.type);
    if (!factory) {
      throw new Error(`imagegen provider '${cfg.id}' 的 type '${cfg.type}' 未注册`);
    }
    if (_state.adapters.has(cfg.id)) {
      throw new Error(`imagegen provider id '${cfg.id}' 重复`);
    }
    _state.adapters.set(cfg.id, factory(cfg));
  }

  // 如果没显式指定 default 但有 providers，取第一个
  if (!_state.defaultId && _state.adapters.size > 0) {
    _state.defaultId = _state.adapters.keys().next().value;
  }

  return { count: _state.adapters.size, defaultId: _state.defaultId };
}

/**
 * 取出 adapter 实例。
 * @param {string} [id]   不传或为假值时用 default
 * @returns adapter 实例
 */
export function getAdapter(id) {
  if (!_state.adapters) {
    throw new Error("imagegen registry 未初始化，请先调用 loadAdapters()");
  }
  const target = id || _state.defaultId;
  if (!target) {
    throw new Error("imagegen 没有配置任何 provider");
  }
  const adapter = _state.adapters.get(target);
  if (!adapter) {
    throw new Error(`imagegen provider '${target}' 不存在`);
  }
  return adapter;
}

/**
 * 列出所有 provider 的公开信息（供 /api/image/providers 用）。
 * @returns {{ default: string|null, providers: Array<{id,type,capabilities}> }}
 */
export function listProviders() {
  if (!_state.adapters) return { default: null, providers: [] };
  return {
    default: _state.defaultId,
    providers: Array.from(_state.adapters.entries()).map(([id, adapter]) => ({
      id,
      type: _typeOf(adapter),
      capabilities: adapter.capabilities,
    })),
  };
}

function _typeOf(adapter) {
  // 反查注册表：哪个 factory 产出了这个实例
  for (const [type, factory] of _state.types.entries()) {
    if (adapter instanceof (factory.prototype?.constructor || class {})) return type;
  }
  // 兜底：从类名推断
  return (adapter.constructor?.name || "").replace(/Adapter$/i, "").toLowerCase();
}

/**
 * 仅供测试使用：重置所有状态。
 */
export function _resetForTests() {
  _state.adapters = null;
  _state.defaultId = null;
  _state.types.clear();
}
