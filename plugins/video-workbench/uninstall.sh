#!/bin/bash
# Video Workbench Plugin · 卸载脚本
#
# 干 5 件事：
#   1. 备份 vf.db 到 ~/vf-backup-<ts>.db（防误删）
#   2. 删除 data/vf.db
#   3. 删除 data/vf-logs/
#   4. 提示 server.mjs 要注释/删除的代码块
#   5. 提示 rm -rf plugins/video-workbench/
#
# 用法：
#   bash plugins/video-workbench/uninstall.sh         # dry-run
#   bash plugins/video-workbench/uninstall.sh --yes   # 实际执行

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DAEMON_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DATA_DIR="$DAEMON_ROOT/data"
DRY_RUN=true
[[ "$1" == "--yes" ]] && DRY_RUN=false

echo "════════════════════════════════════════════════════════"
echo "  Video Workbench Plugin · Uninstall"
echo "════════════════════════════════════════════════════════"
[[ "$DRY_RUN" == "true" ]] && echo "  ⚠️  DRY-RUN（加 --yes 实际执行）" && echo
echo "  daemon: $DAEMON_ROOT"
echo "  data:   $DATA_DIR"
echo

# 1. 备份 vf.db
if [[ -f "$DATA_DIR/vf.db" ]]; then
  TS=$(date +%Y%m%d-%H%M%S)
  BACKUP="$HOME/vf-backup-${TS}.db"
  echo "1. 备份 vf.db → $BACKUP"
  if [[ "$DRY_RUN" == "false" ]]; then
    cp "$DATA_DIR/vf.db" "$BACKUP"
    echo "   ✓ 已备份 ($(stat -c%s "$BACKUP") bytes)"
  fi
else
  echo "1. vf.db 不存在，跳过备份"
fi

# 2. 删 vf.db / vf.db-shm / vf.db-wal
echo
echo "2. 删除 SQLite 文件"
for f in vf.db vf.db-shm vf.db-wal; do
  if [[ -f "$DATA_DIR/$f" ]]; then
    echo "   rm $DATA_DIR/$f"
    [[ "$DRY_RUN" == "false" ]] && rm -f "$DATA_DIR/$f"
  fi
done

# 3. 删 vf-logs/
echo
echo "3. 删除日志目录"
if [[ -d "$DATA_DIR/vf-logs" ]]; then
  echo "   rm -rf $DATA_DIR/vf-logs/"
  [[ "$DRY_RUN" == "false" ]] && rm -rf "$DATA_DIR/vf-logs"
fi

# 4. 提示 server.mjs 改动
echo
echo "4. 提醒：从 server.mjs 删除以下代码块"
echo "──────────────────────────────────────────"
echo "   (a) 'Plugin: Video Workbench (可插拔)' 块（约 14 行，含 try/catch）"
echo "   (b) 'Plugin: Video Workbench (one-line dispatch)' 这一行"
echo "──────────────────────────────────────────"
grep -n "Plugin: Video Workbench\|__vf" "$DAEMON_ROOT/server.mjs" 2>/dev/null | head -8 || echo "   (server.mjs 已经没有相关代码，可跳过)"

# 5. 提示删插件目录
echo
echo "5. 删除插件目录"
echo "   rm -rf $SCRIPT_DIR"
if [[ "$DRY_RUN" == "false" ]]; then
  read -p "   立即删除？[y/N] " ans
  if [[ "$ans" =~ ^[Yy]$ ]]; then
    cd "$DAEMON_ROOT"
    rm -rf "$SCRIPT_DIR"
    echo "   ✓ 已删除"
  else
    echo "   ⊘ 跳过删除"
  fi
fi

echo
echo "════════════════════════════════════════════════════════"
echo "  完成。${DRY_RUN:+'（DRY-RUN，未实际改动磁盘）'}"
echo "  最后一步：bash scripts/deploy.sh 让 server.mjs 改动生效"
echo "════════════════════════════════════════════════════════"
