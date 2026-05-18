#!/bin/bash
# Claude Code 国内一键安装器 · Mac/Linux 版
# 双击此文件，会自动在 Terminal 打开运行

set -e

# 让 .command 双击启动后切换到本地目录
cd "$(dirname "$0")"

# 终端颜色
BOLD="\033[1m"
DIM="\033[2m"
CYAN="\033[36m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
ORANGE="\033[38;5;208m"
RESET="\033[0m"

clear
echo -e "${ORANGE}╔════════════════════════════════════════════╗${RESET}"
echo -e "${ORANGE}║                                            ║${RESET}"
echo -e "${ORANGE}║    ${BOLD}Claude Code · 国内一键安装${RESET}${ORANGE}              ║${RESET}"
echo -e "${ORANGE}║    ${DIM}for Mac · 适配国内网络与国内 AI${RESET}${ORANGE}        ║${RESET}"
echo -e "${ORANGE}║                                            ║${RESET}"
echo -e "${ORANGE}╚════════════════════════════════════════════╝${RESET}"
echo ""
echo -e "${DIM}// 这个脚本会做 5 件事：${RESET}"
echo -e "${DIM}//   1. 检查 Node.js${RESET}"
echo -e "${DIM}//   2. 用淘宝 npm 镜像装 Claude Code${RESET}"
echo -e "${DIM}//   3. 装 claude-code-router（让 CC 能接国内 AI）${RESET}"
echo -e "${DIM}//   4. 让你选一个国内 AI 后端 + 填 key${RESET}"
echo -e "${DIM}//   5. 写配置 · 提示用法${RESET}"
echo ""
read -p "$(echo -e ${CYAN}按回车开始 ▶${RESET}\ )" _

# ──── Step 1 · 检查 / 自动装 Node.js ────
echo ""
echo -e "${BOLD}[1/5] 检查 Node.js${RESET}"

NODE_VERSION_REQUIRED="v22.11.0"
NODE_PKG_URL="https://cdn.npmmirror.com/binaries/node/${NODE_VERSION_REQUIRED}/node-${NODE_VERSION_REQUIRED}.pkg"

if ! command -v node &> /dev/null; then
  echo -e "${YELLOW}! 没找到 Node.js · 即将自动下载安装${RESET}"
  echo ""
  echo -e "${DIM}// 从淘宝镜像下载 Node.js ${NODE_VERSION_REQUIRED} (~70MB)${RESET}"
  echo -e "${DIM}//   ${NODE_PKG_URL}${RESET}"
  echo ""

  TMP_PKG="/tmp/node-installer-$$.pkg"
  trap "rm -f $TMP_PKG" EXIT

  # 下载（带进度条）
  if curl -fL --progress-bar -o "$TMP_PKG" "$NODE_PKG_URL"; then
    echo -e "${GREEN}✓${RESET} 下载完成"
  else
    echo -e "${RED}✗ 下载失败${RESET}"
    echo -e "${YELLOW}请检查网络后重试，或手动去 https://nodejs.org/zh-cn/ 装 LTS${RESET}"
    read -p "$(echo -e ${DIM}按回车退出${RESET}\ )" _
    exit 1
  fi

  echo ""
  echo -e "${BOLD}安装 Node.js（需要管理员密码）${RESET}"
  echo -e "${DIM}// 输入开机密码即可（输入时不会显示，正常的）${RESET}"
  echo ""

  if sudo installer -pkg "$TMP_PKG" -target /; then
    echo -e "${GREEN}✓${RESET} Node.js 安装成功"
    # 刷新 PATH (确保当前 shell 找得到 node)
    export PATH="/usr/local/bin:$PATH"
  else
    echo -e "${RED}✗ 安装失败${RESET}"
    echo -e "${YELLOW}请手动去 https://nodejs.org/zh-cn/ 双击装 LTS 版本${RESET}"
    read -p "$(echo -e ${DIM}按回车退出${RESET}\ )" _
    exit 1
  fi
fi

# 二次验证
if ! command -v node &> /dev/null; then
  echo -e "${RED}✗ 装完仍找不到 node 命令${RESET}"
  echo -e "${YELLOW}请关闭这个 Terminal 窗口，重新双击本脚本运行${RESET}"
  read -p "$(echo -e ${DIM}按回车退出${RESET}\ )" _
  exit 1
fi

NODE_VERSION=$(node -v)
NPM_VERSION=$(npm -v)

# Node 版本检查 (需要 ≥ 18)
NODE_MAJOR=$(echo "$NODE_VERSION" | sed -E 's/v([0-9]+)\..*/\1/')
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  echo -e "${YELLOW}! Node.js $NODE_VERSION 版本太老 (Claude Code 需要 ≥ 18)${RESET}"
  read -p "$(echo -e ${CYAN}要自动下载新版 Node.js 覆盖安装吗？\(y/n\):${RESET}\ )" UPGRADE_NODE
  if [[ "$UPGRADE_NODE" == "y" || "$UPGRADE_NODE" == "Y" ]]; then
    TMP_PKG="/tmp/node-installer-$$.pkg"
    trap "rm -f $TMP_PKG" EXIT
    curl -fL --progress-bar -o "$TMP_PKG" "$NODE_PKG_URL"
    sudo installer -pkg "$TMP_PKG" -target /
    export PATH="/usr/local/bin:$PATH"
    NODE_VERSION=$(node -v)
    NPM_VERSION=$(npm -v)
  else
    echo -e "${RED}请手动升级 Node.js 到 18+，再重新双击本脚本${RESET}"
    read -p "$(echo -e ${DIM}按回车退出${RESET}\ )" _
    exit 1
  fi
fi
echo -e "${GREEN}✓${RESET} Node.js ${BOLD}$NODE_VERSION${RESET}  ·  npm ${BOLD}$NPM_VERSION${RESET}"

# ──── Step 2 · 配置 npm 国内镜像 ────
echo ""
echo -e "${BOLD}[2/5] 配置淘宝 npm 镜像${RESET}"
CURRENT_REGISTRY=$(npm config get registry)
if [[ "$CURRENT_REGISTRY" != *"npmmirror"* ]]; then
  echo -e "${DIM}当前 registry: ${CURRENT_REGISTRY}${RESET}"
  read -p "$(echo -e ${CYAN}切到淘宝镜像吗？\(y/n，默认 y\):${RESET}\ )" SWITCH_REG
  if [[ -z "$SWITCH_REG" || "$SWITCH_REG" == "y" || "$SWITCH_REG" == "Y" ]]; then
    npm config set registry https://registry.npmmirror.com
    echo -e "${GREEN}✓${RESET} 已切到 ${ORANGE}registry.npmmirror.com${RESET}"
  else
    echo -e "${YELLOW}保留你原来的 ${CURRENT_REGISTRY}（如果装得慢就再跑一次本脚本切换）${RESET}"
  fi
else
  echo -e "${GREEN}✓${RESET} 已经是国内镜像"
fi

# ──── Step 3 · 装 Claude Code ────
echo ""
echo -e "${BOLD}[3/5] 安装 Claude Code（可能 1-2 分钟）${RESET}"
if command -v claude &> /dev/null; then
  echo -e "${DIM}已检测到 Claude Code，跳过${RESET}"
else
  echo -e "${DIM}npm install -g @anthropic-ai/claude-code${RESET}"
  npm install -g @anthropic-ai/claude-code 2>&1 | grep -E "added|installed|warn|err" | head -5 || true
fi
if command -v claude &> /dev/null; then
  echo -e "${GREEN}✓${RESET} Claude Code 装好了"
else
  echo -e "${RED}✗ Claude Code 安装失败，请检查网络后重试${RESET}"
  read -p "$(echo -e ${DIM}按回车退出${RESET}\ )" _
  exit 1
fi

# ──── Step 4 · 装 claude-code-router ────
echo ""
echo -e "${BOLD}[4/5] 安装国内 AI 适配器 claude-code-router${RESET}"
if command -v ccr &> /dev/null; then
  echo -e "${DIM}已检测到 ccr，跳过${RESET}"
else
  echo -e "${DIM}npm install -g @musistudio/claude-code-router${RESET}"
  npm install -g @musistudio/claude-code-router 2>&1 | grep -E "added|installed|warn|err" | head -5 || true
fi
if command -v ccr &> /dev/null; then
  echo -e "${GREEN}✓${RESET} claude-code-router 装好了"
else
  echo -e "${RED}✗ claude-code-router 安装失败${RESET}"
  read -p "$(echo -e ${DIM}按回车退出${RESET}\ )" _
  exit 1
fi

# ──── Step 5 · 选 AI 后端 + 配置 ────
echo ""
echo -e "${BOLD}[5/5] 选个国内 AI 后端${RESET}"
echo ""
echo -e "  ${ORANGE}1${RESET}  DeepSeek      ${DIM}推理顶级 · 最便宜${RESET}"
echo -e "  ${ORANGE}2${RESET}  通义千问      ${DIM}阿里 · 速度最快${RESET}"
echo -e "  ${ORANGE}3${RESET}  GLM（智谱）   ${DIM}多模态 · 长文档${RESET}"
echo -e "  ${ORANGE}4${RESET}  MiniMax       ${DIM}语音 · 长上下文${RESET}"
echo ""
while true; do
  read -p "$(echo -e ${CYAN}选 1-4：${RESET}\ )" AI_CHOICE
  case $AI_CHOICE in
    1|2|3|4) break ;;
    *) echo -e "${YELLOW}请输入 1、2、3 或 4${RESET}" ;;
  esac
done

case $AI_CHOICE in
  1) PROVIDER_LABEL="DeepSeek"
     PROVIDER_NAME="deepseek"
     BASE_URL="https://api.deepseek.com/chat/completions"
     MODELS='["deepseek-chat","deepseek-reasoner"]'
     DEFAULT_MODEL="deepseek-chat"
     TRANSFORMER='"transformer":{"use":["deepseek"],"deepseek-chat":{"use":["tooluse"]}}'
     APIKEY_URL="https://platform.deepseek.com/api_keys"
     ;;
  2) PROVIDER_LABEL="通义千问"
     PROVIDER_NAME="qwen"
     BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
     MODELS='["qwen3-coder-plus"]'
     DEFAULT_MODEL="qwen3-coder-plus"
     TRANSFORMER='"transformer":{"use":[["maxtoken",{"max_tokens":65536}],"enhancetool"]}'
     APIKEY_URL="https://bailian.console.aliyun.com/?tab=model#/api-key"
     ;;
  3) PROVIDER_LABEL="GLM（智谱）"
     PROVIDER_NAME="zhipu"
     BASE_URL="https://open.bigmodel.cn/api/paas/v4/chat/completions"
     MODELS='["glm-4.5","glm-4-plus"]'
     DEFAULT_MODEL="glm-4.5"
     TRANSFORMER='"transformer":{"use":["Anthropic"]}'
     APIKEY_URL="https://open.bigmodel.cn/usercenter/apikeys"
     ;;
  4) PROVIDER_LABEL="MiniMax"
     PROVIDER_NAME="minimax"
     BASE_URL="https://api.minimaxi.com/v1/text/chatcompletion_v2"
     MODELS='["MiniMax-Text-01"]'
     DEFAULT_MODEL="MiniMax-Text-01"
     TRANSFORMER='"transformer":{"use":["Anthropic"]}'
     APIKEY_URL="https://platform.minimaxi.com/user-center/basic-information/interface-key"
     ;;
esac

echo ""
echo -e "${GREEN}你选了：${BOLD}$PROVIDER_LABEL${RESET}"
echo ""
echo -e "${DIM}如果还没有 API key，先打开下面链接申请：${RESET}"
echo -e "  ${CYAN}${APIKEY_URL}${RESET}"
echo ""
while true; do
  read -p "$(echo -e ${CYAN}粘贴你的 API key：${RESET}\ )" API_KEY
  if [[ -n "$API_KEY" && ${#API_KEY} -gt 8 ]]; then
    break
  else
    echo -e "${YELLOW}key 长度太短，再试一次（粘贴后按回车）${RESET}"
  fi
done

# 写配置
CONFIG_DIR="$HOME/.claude-code-router"
CONFIG_PATH="$CONFIG_DIR/config.json"
mkdir -p "$CONFIG_DIR"

# 配置文件已存在 → 给三个选择
if [[ -f "$CONFIG_PATH" ]]; then
  echo ""
  echo -e "${YELLOW}! 已检测到旧的 config.json:${RESET}"
  echo -e "${DIM}   $CONFIG_PATH${RESET}"
  echo ""
  echo -e "  ${ORANGE}1${RESET}  覆盖   ${DIM}用新选的 $PROVIDER_LABEL 替换全部（旧的会备份）${RESET}"
  echo -e "  ${ORANGE}2${RESET}  追加   ${DIM}把 $PROVIDER_LABEL 加到 Providers 数组里（保留其它）${RESET}"
  echo -e "  ${ORANGE}3${RESET}  跳过   ${DIM}不动 config，安装到此结束${RESET}"
  echo ""
  while true; do
    read -p "$(echo -e ${CYAN}选 1-3：${RESET}\ )" CONFIG_CHOICE
    case $CONFIG_CHOICE in
      1|2|3) break ;;
      *) echo -e "${YELLOW}请输入 1、2 或 3${RESET}" ;;
    esac
  done

  if [[ "$CONFIG_CHOICE" == "3" ]]; then
    echo -e "${DIM}// 跳过配置写入${RESET}"
    SKIP_WRITE=1
  else
    # 备份
    cp "$CONFIG_PATH" "$CONFIG_PATH.backup.$(date +%s)"
    echo -e "${DIM}// 已备份旧配置为 config.json.backup.$(date +%s)${RESET}"

    if [[ "$CONFIG_CHOICE" == "2" ]]; then
      # 追加模式：用 python 解析旧 json，加入新 provider
      python3 - "$CONFIG_PATH" "$PROVIDER_NAME" "$BASE_URL" "$API_KEY" "$MODELS" "$DEFAULT_MODEL" "$TRANSFORMER" <<'PYEOF'
import json, sys
path, name, base, key, models, default_model, transformer_raw = sys.argv[1:8]
with open(path) as f:
    cfg = json.load(f)
cfg.setdefault("Providers", [])
# 去重：如果已有同名 provider，覆盖它
cfg["Providers"] = [p for p in cfg["Providers"] if p.get("name") != name]
provider = {
    "name": name,
    "api_base_url": base,
    "api_key": key,
    "models": json.loads(models),
}
tf = json.loads("{" + transformer_raw.replace('"transformer":', '') + "}").get("transformer") if transformer_raw else None
# transformer_raw 格式是 '"transformer":{...}'，提出 {...} 部分
import re
m = re.search(r'"transformer"\s*:\s*(\{.*\})', transformer_raw)
if m:
    provider["transformer"] = json.loads(m.group(1))
cfg["Providers"].append(provider)
cfg.setdefault("Router", {})
# 把 default 路由切到新加的 provider
cfg["Router"]["default"] = f"{name},{default_model}"
with open(path, "w") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
print(f"✓ 已追加 {name} 到 Providers (default 路由也切换了)")
PYEOF
      SKIP_WRITE=1
    fi
  fi
fi

# 覆盖模式 或 全新写入
if [[ -z "$SKIP_WRITE" ]]; then
  cat > "$CONFIG_PATH" <<EOF
{
  "LOG": false,
  "Providers": [
    {
      "name": "$PROVIDER_NAME",
      "api_base_url": "$BASE_URL",
      "api_key": "$API_KEY",
      "models": $MODELS,
      $TRANSFORMER
    }
  ],
  "Router": {
    "default": "$PROVIDER_NAME,$DEFAULT_MODEL",
    "background": "$PROVIDER_NAME,$DEFAULT_MODEL",
    "think": "$PROVIDER_NAME,$DEFAULT_MODEL",
    "longContext": "$PROVIDER_NAME,$DEFAULT_MODEL"
  }
}
EOF
  echo -e "${GREEN}✓${RESET} 配置已写入 ${DIM}$CONFIG_PATH${RESET}"
fi

# ──── 完成 ────
echo ""
echo -e "${ORANGE}╔════════════════════════════════════════════╗${RESET}"
echo -e "${ORANGE}║   ${GREEN}✓ 全部完成！${RESET}${ORANGE}                            ║${RESET}"
echo -e "${ORANGE}╚════════════════════════════════════════════╝${RESET}"
echo ""
echo -e "${BOLD}下次怎么用：${RESET}"
echo ""
echo -e "  ${ORANGE}1${RESET}  打开终端 ${DIM}(Cmd + Space 搜 Terminal)${RESET}"
echo -e "  ${ORANGE}2${RESET}  ${BOLD}cd${RESET} 到你的项目文件夹"
echo -e "  ${ORANGE}3${RESET}  敲 ${BOLD}ccr code${RESET} ${DIM}// 启动 Claude Code（已自动接好国内 AI）${RESET}"
echo ""
echo -e "${DIM}小技巧：第一次进项目先输 ${BOLD}/init${RESET}${DIM}，让 AI 记住你的文件结构${RESET}"
echo ""
echo -e "${DIM}想换 AI 后端？重新双击本脚本即可（会备份旧配置）${RESET}"
echo ""
read -p "$(echo -e ${CYAN}按回车关闭窗口${RESET}\ )" _
