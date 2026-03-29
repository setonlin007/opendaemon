#!/bin/bash
# P6 Workspace Migration Script
# Executes T2 (migrate opendaemon) + T3 (migrate jarvis) + T4 (clean home)
# Run manually: bash ~/opendaemon/scripts/migrate-workspace.sh

set -e

echo "=== P6 Workspace Migration ==="
echo ""

# ── T2: Migrate opendaemon ──
echo "[T2] Migrating opendaemon..."
pm2 stop opendaemon
mv ~/opendaemon ~/workspace/projects/opendaemon
ln -s ~/workspace/projects/opendaemon ~/opendaemon
cd ~/opendaemon && pm2 start server.mjs --name opendaemon
pm2 save
echo "[T2] opendaemon migrated. Symlink: ~/opendaemon → ~/workspace/projects/opendaemon"
echo ""

# ── T3: Migrate jarvis-assistant ──
echo "[T3] Migrating jarvis-assistant..."
# Stop jarvis processes (they run via pm2 or direct python)
pm2 stop jarvis 2>/dev/null || true
pm2 stop jarvis-web 2>/dev/null || true
pm2 stop jarvis-admin 2>/dev/null || true
# Also try killing by pattern in case not managed by pm2
pkill -f "jarvis-assistant/main.py" 2>/dev/null || true
pkill -f "jarvis-assistant/web_chat.py" 2>/dev/null || true
pkill -f "jarvis-assistant/admin.py" 2>/dev/null || true
sleep 1

mv ~/jarvis-assistant ~/workspace/projects/jarvis-assistant
ln -s ~/workspace/projects/jarvis-assistant ~/jarvis-assistant

# Restart jarvis (adjust these commands based on actual startup method)
cd ~/jarvis-assistant
pm2 start jarvis 2>/dev/null || echo "[T3] Note: jarvis pm2 process not found, may need manual restart"
pm2 start jarvis-web 2>/dev/null || true
pm2 start jarvis-admin 2>/dev/null || true
pm2 save 2>/dev/null || true
echo "[T3] jarvis-assistant migrated. Symlink: ~/jarvis-assistant → ~/workspace/projects/jarvis-assistant"
echo ""

# ── T4: Clean home directory ──
echo "[T4] Cleaning home directory scripts..."
cd ~
rm -f check_chatroom.py check_key_usage.py check_session.py check_session_title.py
rm -f survey_old.py win_cleanup.py win_resources.py
rm -f deploy_new.py deploy_new2.py deploy_fix.py deploy_v3.py deploy_v4.py deploy_final.py deploy_upload.py
rm -f create_tasks.py setup_services.py start_services.py start_svc.py debug_svc.py switch_monitor.py
echo "[T4] Cleaned 20 scripts from home directory"
echo ""

# ── Verify ──
echo "=== Verification ==="
echo "Symlinks:"
ls -la ~/opendaemon | head -1
ls -la ~/jarvis-assistant | head -1
echo ""
echo "Workspace:"
ls ~/workspace/projects/
echo ""
echo "Home cleanup (remaining .py files):"
ls ~/*.py 2>/dev/null || echo "(none - clean!)"
echo ""
echo "PM2 status:"
pm2 list
echo ""
echo "=== Migration Complete ==="
echo "Refresh your browser to reconnect."
