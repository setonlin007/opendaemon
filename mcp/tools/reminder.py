"""Reminder tool — one-time scheduled reminders with persistence."""

import json
import logging
import os
import threading
import time
from datetime import datetime

from mcp.types import Tool, TextContent

logger = logging.getLogger(__name__)

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
REMINDERS_FILE = os.path.join(DATA_DIR, "reminders.json")

_active_timers: dict[str, threading.Timer] = {}
_lock = threading.Lock()

REMINDER_TOOL = Tool(
    name="set_reminder",
    description="Set, list, or cancel one-time reminders. Reminders fire at the specified time and send a message through configured channels.",
    inputSchema={
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["set", "list", "cancel"],
                "description": "Action to perform",
                "default": "set",
            },
            "fire_time": {
                "type": "string",
                "description": "When to fire (YYYY-MM-DD HH:MM). Required for 'set'.",
            },
            "content": {
                "type": "string",
                "description": "Reminder message. Required for 'set'.",
            },
            "target": {
                "type": "string",
                "description": "Who to remind (channel target). Defaults to 'owner'.",
            },
            "channel": {
                "type": "string",
                "description": "Delivery channel. Auto-select if omitted.",
            },
            "reminder_id": {
                "type": "string",
                "description": "Reminder ID for 'cancel' action.",
            },
        },
        "required": ["action"],
    },
)


# ── Persistence ──

def _load_reminders() -> list[dict]:
    try:
        with open(REMINDERS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def _save_reminders(reminders: list[dict]):
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(REMINDERS_FILE, "w", encoding="utf-8") as f:
        json.dump(reminders, f, ensure_ascii=False, indent=2)


def _add_reminder(reminder: dict):
    with _lock:
        reminders = _load_reminders()
        reminders.append(reminder)
        _save_reminders(reminders)


def _remove_reminder(reminder_id: str):
    with _lock:
        reminders = _load_reminders()
        reminders = [r for r in reminders if r["id"] != reminder_id]
        _save_reminders(reminders)
        _active_timers.pop(reminder_id, None)


# ── Timer ──

def _schedule_timer(channels: dict, reminder: dict, delay: float):
    def _fire():
        _send_reminder(channels, reminder)

    timer = threading.Timer(delay, _fire)
    timer.daemon = True
    timer.start()
    _active_timers[reminder["id"]] = timer


def _send_reminder(channels: dict, reminder: dict):
    content = f"\u23f0 Reminder: {reminder['content']}"
    target = reminder.get("target", "owner")
    channel_name = reminder.get("channel", "")
    reminder_id = reminder["id"]

    sent = False
    if channel_name and channel_name in channels:
        sent = channels[channel_name].send(target, content)

    if not sent:
        for name, ch in channels.items():
            try:
                if ch.send(target, content):
                    sent = True
                    break
            except Exception:
                continue

    if sent:
        logger.info(f"[reminder] fired: {reminder['content'][:30]}")
    else:
        logger.error(f"[reminder] all channels failed: {reminder['content'][:30]}")

    _remove_reminder(reminder_id)


# ── Parse time ──

def _parse_fire_time(expr: str):
    expr = expr.strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y/%m/%d %H:%M", "%Y-%m-%dT%H:%M"):
        try:
            return datetime.strptime(expr, fmt)
        except ValueError:
            continue
    return None


# ── Restore on startup ──

def restore_reminders(channels: dict):
    reminders = _load_reminders()
    if not reminders:
        return

    now = datetime.now()
    restored = 0
    expired = 0

    for r in list(reminders):
        fire_time = datetime.strptime(r["fire_time"], "%Y-%m-%d %H:%M:%S")
        delay = (fire_time - now).total_seconds()

        if delay <= 0:
            if delay > -300:  # 5min grace
                _schedule_timer(channels, r, 1)
                restored += 1
            else:
                expired += 1
        else:
            _schedule_timer(channels, r, delay)
            restored += 1

    if expired:
        with _lock:
            remaining = [r for r in reminders
                         if (datetime.strptime(r["fire_time"], "%Y-%m-%d %H:%M:%S") - now).total_seconds() > -300]
            _save_reminders(remaining)

    if restored or expired:
        logger.info(f"[reminder] restored {restored}, expired {expired}")


# ── Handler ──

async def handle_reminder(arguments: dict, channels: dict = None, **kwargs) -> list[TextContent]:
    action = arguments.get("action", "set")
    channels = channels or {}

    if action == "list":
        return _handle_list()
    elif action == "cancel":
        return _handle_cancel(arguments.get("reminder_id", ""))
    else:
        return _handle_set(arguments, channels)


def _handle_set(arguments: dict, channels: dict) -> list[TextContent]:
    fire_time_str = arguments.get("fire_time", "")
    content = arguments.get("content", "")
    target = arguments.get("target", "owner")
    channel = arguments.get("channel", "")

    if not fire_time_str:
        return [TextContent(type="text", text="Error: fire_time is required (YYYY-MM-DD HH:MM)")]
    if not content:
        return [TextContent(type="text", text="Error: content is required")]

    parsed = _parse_fire_time(fire_time_str)
    if not parsed:
        return [TextContent(type="text", text=f"Error: invalid time format '{fire_time_str}'. Use YYYY-MM-DD HH:MM")]

    now = datetime.now()
    delay = (parsed - now).total_seconds()
    if delay <= 0:
        return [TextContent(type="text", text=f"Error: time {parsed.strftime('%Y-%m-%d %H:%M')} is in the past")]

    rid = f"r{int(now.timestamp())}"
    reminder = {
        "id": rid,
        "target": target,
        "content": content,
        "fire_time": parsed.strftime("%Y-%m-%d %H:%M:%S"),
        "created_at": now.strftime("%Y-%m-%d %H:%M:%S"),
        "channel": channel,
    }
    _add_reminder(reminder)
    _schedule_timer(channels, reminder, delay)

    display = parsed.strftime("%H:%M") if parsed.date() == now.date() else parsed.strftime("%Y-%m-%d %H:%M")
    logger.info(f"[reminder] set: {display} → {content[:30]}")
    return [TextContent(type="text", text=f"Reminder set: {display} — {content}")]


def _handle_list() -> list[TextContent]:
    reminders = _load_reminders()
    if not reminders:
        return [TextContent(type="text", text="No pending reminders.")]

    now = datetime.now()
    lines = [f"{len(reminders)} pending reminder(s):\n"]
    for r in sorted(reminders, key=lambda x: x["fire_time"]):
        fire_time = datetime.strptime(r["fire_time"], "%Y-%m-%d %H:%M:%S")
        remaining = (fire_time - now).total_seconds()
        if remaining > 3600:
            remain_str = f"{remaining/3600:.1f}h"
        elif remaining > 60:
            remain_str = f"{remaining/60:.0f}m"
        elif remaining > 0:
            remain_str = f"{remaining:.0f}s"
        else:
            remain_str = "imminent"
        lines.append(f"- [{r['id']}] {r['fire_time']} → {r['content']} (in {remain_str})")
    return [TextContent(type="text", text="\n".join(lines))]


def _handle_cancel(reminder_id: str) -> list[TextContent]:
    if not reminder_id:
        return [TextContent(type="text", text="Error: reminder_id is required (use action=list to see IDs)")]

    reminders = _load_reminders()
    found = next((r for r in reminders if r["id"] == reminder_id), None)
    if not found:
        return [TextContent(type="text", text=f"Error: reminder '{reminder_id}' not found")]

    _remove_reminder(reminder_id)
    timer = _active_timers.pop(reminder_id, None)
    if timer:
        timer.cancel()

    return [TextContent(type="text", text=f"Cancelled: {found['fire_time']} — {found['content']}")]
