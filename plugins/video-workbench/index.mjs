/**
 * Video Workbench Plugin · 入口
 *
 * 唯一公开 API：videoWorkbench.init({ requireAuth, dataDir, authSecret })
 *   → 返回 { match(method, path), handle(req, res) }
 *
 * 卸载流程：
 *   1. server.mjs 删 import + 删 mount 两行
 *   2. rm -rf plugins/video-workbench/
 *   3. rm data/vf.db data/vf-logs/
 *   bash uninstall.sh 可一键完成。
 */
import { join } from "path";
import { initVfDb } from "./db.mjs";
import { createRouter } from "./router.mjs";

export const videoWorkbench = {
  /**
   * @param {Object} opts
   * @param {Function} opts.requireAuth     - daemon 的 auth.requireAuth(req, res) → boolean
   * @param {string}   opts.dataDir         - daemon 的 data/ 目录
   * @param {string}   opts.authSecret      - daemon auth.password（用于 key 加密派生）
   * @param {string}   opts.projectsRoot    - 可选，默认 ~/workspace/projects
   */
  async init({ requireAuth, dataDir, authSecret, projectsRoot }) {
    if (!requireAuth) throw new Error("[vf] init: requireAuth callback required");
    if (!dataDir) throw new Error("[vf] init: dataDir required");
    if (!authSecret) throw new Error("[vf] init: authSecret required (for AES key derivation)");

    // 初始化独立 SQLite
    initVfDb(dataDir);

    // 创建日志目录
    const logsDir = join(dataDir, "vf-logs");

    // 创建路由分发器
    const router = createRouter({
      daemonAuthSecret: authSecret,
      projectsRoot,
      logsDir,
    });

    console.log("[plugin] video-workbench mounted · UI: /video-factory.html · API: /api/vf/*");

    return {
      /** 返回 true = 这个请求归插件管 */
      match(method, path) {
        return router.match(method, path);
      },

      /** 处理一个请求 · 由 server.mjs 在 auth 已过的前提下调用 */
      async handle(req, res) {
        // 这里 server.mjs 已经跑过 requireAuth；安全
        await router.handle(req, res);
      },
    };
  },
};
