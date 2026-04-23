#!/bin/bash
# Mac → Aliyun SSH 反向隧道管理脚本
# 把本地 ComfyUI :8188 通过 SSH 暴露给远端的 127.0.0.1:8188
# 远端 OpenDaemon 生图时可调本机 ComfyUI，且不暴露公网

set -e

LABEL="com.setonlin.comfyui-tunnel"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SSH_HOST="${SSH_HOST:-jarvis}"
LOCAL_PORT="${LOCAL_PORT:-8188}"
REMOTE_PORT="${REMOTE_PORT:-8188}"
ERR_LOG="/tmp/comfy-tunnel.err"
OUT_LOG="/tmp/comfy-tunnel.out"

# 彩色输出
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()    { echo -e "${CYAN}ℹ${NC} $*"; }
ok()      { echo -e "${GREEN}✓${NC} $*"; }
warn()    { echo -e "${YELLOW}⚠${NC} $*"; }
err()     { echo -e "${RED}✗${NC} $*"; }
section() { echo; echo -e "${CYAN}═════ $* ═════${NC}"; }

cmd_check() {
    section "前置检查"

    # 1. autossh
    if ! command -v autossh >/dev/null 2>&1; then
        err "autossh 未安装"
        info "请先: brew install autossh"
        return 1
    fi
    ok "autossh: $(command -v autossh)"

    # 2. SSH 免密到远端
    if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "$SSH_HOST" 'echo ok' 2>/dev/null | grep -q ok; then
        err "无法免密 SSH 到 $SSH_HOST"
        info "请确认 ~/.ssh/config 里有 $SSH_HOST 的 Host 条目，并已配好 key"
        info "测试: ssh $SSH_HOST"
        return 1
    fi
    ok "SSH $SSH_HOST: 免密可达"

    # 3. 远端 sshd 配置（验证 GatewayPorts=no，反向端口只绑 127.0.0.1）
    local gatewayports
    gatewayports=$(ssh "$SSH_HOST" "grep -iE '^\s*GatewayPorts' /etc/ssh/sshd_config 2>/dev/null" || echo "")
    if echo "$gatewayports" | grep -qi "yes"; then
        warn "远端 GatewayPorts=yes → 反向端口会绑 0.0.0.0 暴露公网！"
        warn "强烈建议改为 no 或不设置（默认 no）。当前行: $gatewayports"
    else
        ok "远端 GatewayPorts 默认/no → 反向端口只绑 127.0.0.1（安全）"
    fi

    # 4. ComfyUI 本机运行
    local local_code
    local_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$LOCAL_PORT/" || echo "000")
    if [ "$local_code" == "200" ]; then
        ok "ComfyUI 本机 :$LOCAL_PORT: HTTP 200"
    else
        warn "ComfyUI 本机 :$LOCAL_PORT 暂时不通 (HTTP $local_code) — 生图时再开就行，不影响隧道安装"
    fi

    # 5. 远端 REMOTE_PORT 是否已被占用
    local remote_listen
    remote_listen=$(ssh "$SSH_HOST" "lsof -iTCP:$REMOTE_PORT -sTCP:LISTEN -P -n 2>/dev/null | tail -n +2" || echo "")
    if [ -n "$remote_listen" ]; then
        warn "远端 :$REMOTE_PORT 已被进程占用："
        echo "$remote_listen" | head -3
        info "若是旧隧道残留，可用 './setup-tunnel.sh uninstall' 然后重装"
    else
        ok "远端 :$REMOTE_PORT 空闲"
    fi
}

cmd_install() {
    cmd_check || { err "前置检查失败，中止"; exit 1; }

    local autossh_bin
    autossh_bin=$(command -v autossh)

    # 如果已有 plist，先卸载旧的
    if [ -f "$PLIST" ]; then
        warn "已存在 plist，先卸载旧的"
        launchctl unload "$PLIST" 2>/dev/null || true
    fi

    section "写入 launchd plist"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTD/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$autossh_bin</string>
        <string>-M</string><string>0</string>
        <string>-N</string>
        <string>-R</string><string>$REMOTE_PORT:127.0.0.1:$LOCAL_PORT</string>
        <string>$SSH_HOST</string>
        <string>-o</string><string>ServerAliveInterval=30</string>
        <string>-o</string><string>ServerAliveCountMax=3</string>
        <string>-o</string><string>ExitOnForwardFailure=yes</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>AUTOSSH_GATETIME</key>
        <string>30</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ProcessType</key><string>Background</string>
    <key>StandardErrorPath</key><string>$ERR_LOG</string>
    <key>StandardOutPath</key><string>$OUT_LOG</string>
</dict>
</plist>
EOF
    ok "已写入 $PLIST"

    section "加载 launchd 服务"
    launchctl load -w "$PLIST"
    ok "已加载 $LABEL"

    info "等待隧道建立（5 秒）..."
    sleep 5

    cmd_status
}

cmd_status() {
    section "launchd 状态"
    local line
    line=$(launchctl list 2>/dev/null | grep "$LABEL" || echo "")
    if [ -z "$line" ]; then
        err "launchd 未加载 → 先跑 $0 install"
        return 1
    fi
    local pid exit_code label
    pid=$(echo "$line" | awk '{print $1}')
    exit_code=$(echo "$line" | awk '{print $2}')
    if [ "$pid" == "-" ]; then
        err "launchd 已加载但进程未启动（上次 exit code = $exit_code）"
        info "看日志: $0 logs"
    else
        ok "launchd PID: $pid  (上次 exit = $exit_code)"
    fi

    section "本机 ComfyUI :$LOCAL_PORT"
    local local_code
    local_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$LOCAL_PORT/" || echo "000")
    case "$local_code" in
        200) ok "HTTP 200" ;;
        000) warn "不通（ComfyUI 没跑）" ;;
        *)   warn "返回 $local_code" ;;
    esac

    section "远端 $SSH_HOST:$REMOTE_PORT 连通性"
    local remote_code
    remote_code=$(ssh -o ConnectTimeout=5 "$SSH_HOST" \
        "curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:$REMOTE_PORT/" 2>&1 || echo "ssh-failed")
    case "$remote_code" in
        200)
            ok "HTTP 200 → 隧道通，ComfyUI 响应正常"
            ;;
        000)
            err "隧道不通（ssh -R 可能没建立）或 ComfyUI 没跑"
            ;;
        ssh-failed)
            err "无法 SSH 到 $SSH_HOST 做测试"
            ;;
        *)
            warn "HTTP $remote_code（隧道可能通但 ComfyUI 异常）"
            ;;
    esac

    # 最近错误
    if [ -s "$ERR_LOG" ]; then
        local err_lines
        err_lines=$(wc -l < "$ERR_LOG" | tr -d ' ')
        if [ "$err_lines" -gt 0 ]; then
            section "最近错误 (tail 3 of $ERR_LOG)"
            tail -3 "$ERR_LOG"
        fi
    fi
}

cmd_logs() {
    section "错误日志 $ERR_LOG"
    [ -f "$ERR_LOG" ] && tail -50 "$ERR_LOG" || info "(无)"
    echo
    section "输出日志 $OUT_LOG"
    [ -f "$OUT_LOG" ] && tail -20 "$OUT_LOG" || info "(无)"
}

cmd_restart() {
    if [ ! -f "$PLIST" ]; then
        err "plist 不存在 → 先跑 $0 install"
        exit 1
    fi
    launchctl unload "$PLIST" 2>/dev/null && ok "已卸载"
    sleep 1
    launchctl load -w "$PLIST" && ok "已重新加载"
    sleep 3
    cmd_status
}

cmd_stop() {
    if [ ! -f "$PLIST" ]; then
        warn "plist 不存在，无事可做"
        exit 0
    fi
    launchctl unload "$PLIST" 2>/dev/null && ok "已停止（plist 保留，下次 boot 会自动启）"
}

cmd_uninstall() {
    if [ -f "$PLIST" ]; then
        launchctl unload "$PLIST" 2>/dev/null || true
        rm -f "$PLIST"
        ok "已卸载并删除 $PLIST"
    else
        info "plist 已不在"
    fi
}

cmd_test() {
    # 一次性前台运行（方便排错），Ctrl+C 停止
    section "前台运行隧道（Ctrl+C 停止）"
    info "命令: ssh -N -R $REMOTE_PORT:127.0.0.1:$LOCAL_PORT $SSH_HOST"
    info "如果一直挂住没报错就是成功了，开另一个终端跑: $0 status"
    exec ssh -N -R "$REMOTE_PORT:127.0.0.1:$LOCAL_PORT" "$SSH_HOST" \
        -o "ServerAliveInterval=30" \
        -o "ServerAliveCountMax=3" \
        -o "ExitOnForwardFailure=yes"
}

cmd_help() {
    cat <<HELP
用法: $0 <command>

命令:
  check        检查前置条件（autossh / SSH / 远端 sshd / ComfyUI / 远端端口）
  test         前台运行隧道（不用 launchd，Ctrl+C 停止，便于排错）
  install      写入 launchd plist 并启动（首次使用）
  status       查看隧道状态 + 远端连通性
  logs         查看最近日志
  restart      重启隧道
  stop         停止（保留 plist，下次开机仍会启）
  uninstall    完全卸载（停止 + 删除 plist）
  help         显示本帮助

环境变量（可选）:
  SSH_HOST      远端 SSH 别名（默认: jarvis，来自 ~/.ssh/config）
  LOCAL_PORT    本机 ComfyUI 端口（默认: 8188）
  REMOTE_PORT   远端映射端口（默认: 8188）

常用流程:
  1. 首次  :  $0 check  →  $0 test  →  Ctrl+C  →  $0 install
  2. 日常  :  $0 status  （验证是否在跑）
  3. 排错  :  $0 logs
  4. 删除  :  $0 uninstall

安全性:
  - 反向隧道端口只绑远端 127.0.0.1（GatewayPorts=no），不暴露公网
  - 任何能 SSH 到 $SSH_HOST 的人才能访问到你的 ComfyUI
  - ComfyUI 自己不带鉴权 → 必须保证 SSH 安全
HELP
}

case "${1:-help}" in
    check)      cmd_check ;;
    test)       cmd_test ;;
    install)    cmd_install ;;
    status)     cmd_status ;;
    logs)       cmd_logs ;;
    restart)    cmd_restart ;;
    stop)       cmd_stop ;;
    uninstall)  cmd_uninstall ;;
    help|-h|--help) cmd_help ;;
    *)
        err "未知命令: $1"
        cmd_help
        exit 1
        ;;
esac
