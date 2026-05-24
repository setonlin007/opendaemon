#!/bin/bash
# Video Workbench Plugin · 安装提示脚本
# 实际安装就是 git pull（这个目录存在就行）+ server.mjs 加 mount 代码

cat <<'EOF'
════════════════════════════════════════════════════════
  Video Workbench Plugin · Install
════════════════════════════════════════════════════════

  插件已就位（你正在它的目录里）。

  最后一步：确保 server.mjs 里有这两段 mount 代码：

  ─── 1) 初始化（紧贴 await loadPlugins() 后） ───
  let __vf = null;
  try {
    const { videoWorkbench } = await import("./plugins/video-workbench/index.mjs");
    __vf = await videoWorkbench.init({
      requireAuth: auth.requireAuth,
      dataDir: join(__dirname, "data"),
      authSecret: config.auth.password,
      projectsRoot: join(homedir(), "workspace", "projects"),
    });
  } catch (err) {
    console.warn("[plugin] video-workbench load failed:", err.message);
  }

  ─── 2) 请求分发（紧贴 auth.requireAuth 后） ───
  if (__vf && __vf.match(method, path)) return __vf.handle(req, res);

  ─── 3) 部署生效 ───
  bash scripts/deploy.sh

  ─── 4) 访问 ───
  https://<your-daemon>/video-factory.html

EOF
