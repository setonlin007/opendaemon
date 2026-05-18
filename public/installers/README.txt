╔══════════════════════════════════════════════════╗
║  Claude Code 一键安装包 · 国内适配                ║
║  作者：[你的视频频道名]                            ║
╚══════════════════════════════════════════════════╝

【这是什么】

帮你 30 秒装好 Claude Code 的脚本，已经针对国内网络环境优化：
  · 走淘宝 npm 镜像（不卡）
  · 没装 Node.js？自动从淘宝镜像下载装好（约 30-70MB）
  · 自动配 claude-code-router（接国内 AI）
  · 4 家国内 AI 可选（DeepSeek / 通义千问 / GLM / MiniMax）

【两个文件，选适合你电脑的】

  📂 Mac 用户：
     双击 → claude-code-installer.command

     ⚠️ 如果弹"Apple 无法验证 / 未打开"且只能选「完成 / 移到废纸篓」：
        这是 macOS 13+ 的 Gatekeeper 拦截。三种解决办法选一个：

        ▸ 最快（终端 1 行）：
          xattr -d com.apple.quarantine ~/Downloads/claude-code-installer.command
          然后回 Finder 双击就行了

        ▸ 不下载文件直接跑（推荐）：
          bash <(curl -fsSL https://github.com/setonlin007/opendaemon/raw/main/public/installers/claude-code-installer.command)

        ▸ 系统设置点开（图形界面）：
          1. 关掉警告（按"完成"，别按移到废纸篓）
          2. 系统设置 → 隐私与安全性 → 滚到最底
          3. 找到被拦截的提示 → 点"仍要打开"
          4. 回 Finder 双击文件 → 这次会有"打开"按钮

     · 装 Node.js 时会要管理员密码（开机密码）

  📂 Windows 用户：
     双击 → claude-code-installer.bat
     · SmartScreen 警告时：点"更多信息" → "仍要运行"
     · 装 Node.js 时会弹"用户账户控制"，点【是】

【你只需要】

  ✓ 一个国内 AI 的 API key
    （脚本里会给你申请链接，免费注册，新人都送额度）

  其它东西脚本都会自动装好。

【运行步骤】

  1. 双击对应的安装器
  2. 跟着提示按回车 / 输数字选项
  3. 没装 Node.js 的话：输入开机密码 / 点 UAC 同意，自动装
  4. 选 AI 后端 + 粘贴 API key
  5. 等 1-2 分钟自动跑完

【装完怎么用】

  打开终端（Mac：Cmd+Space 搜 Terminal · Win：Win+R 输 powershell）
    cd 你的项目文件夹
    ccr code

  第一次进新项目先输 /init，让 AI 扫描你的文件夹结构

【遇到问题】

  · Windows 装完 Node 后说"找不到 node" → 关掉 cmd，重新双击脚本
  · npm 装得很慢 → 脚本已自动切淘宝镜像，重新跑会跳过已装步骤
  · API key 错了 → 重新双击脚本，旧配置会自动备份

  其它问题去视频评论区反馈，我看到就改。

══════════════════════════════════════════════════
