"""Cron task tool — periodic scheduled tasks with persistence."""

import json
import logging
import os
import re
import threading
import time as time_mod
from datetime import datetime

from mcp.types import Tool, TextContent

logger = logging.getLogger(__name__)

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
TASKS_FILE = os.path.join(DATA_DIR, "cron_tasks.json")

_scheduler_started = False
_scheduler_lock = threading.Lock()

CRON_TASK_TOOL = Tool(
    name="cron_task",
    description="Create, list, delete, pause, or resume periodic tasks. Tasks fire on schedule and send messages through configured channels.",
    inputSchema={
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["create", "list", "delete", "pause", "resume"],
                "description": "Action to perform",
                "default": "list",
            },
            "schedule": {
                "type": "string",
                "description": "Schedule: 'daily HH:MM', 'weekly N HH:MM', 'every Nh/Nm', 'cron M H D M W'. Required for 'create'.",
            },
            "content": {
                "type": "string",
                "description": "Task content/message. Required for 'create'.",
            },
            "target": {
                "type": "string",
                "description": "Delivery target. Defaults to 'owner'.",
            },
            "channel": {
                "type": "string",
                "description": "Delivery channel. Auto-select if omitted.",
            },
            "task_id": {
                "type": "string",
                "description": "Task ID for delete/pause/resume.",
            },
        },
        "required": ["action"],
    },
)


# ── Persistence ──

def _load_tasks() -> list[dict]:
    try:
        with open(TASKS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def _save_tasks(tasks: list[dict]):
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(TASKS_FILE, "w", encoding="utf-8") as f:
        json.dump(tasks, f, ensure_ascii=False, indent=2)


# ── Schedule parsing ──

def _parse_schedule(expr: str) -> dict | None:
    expr = expr.strip()

    # daily HH:MM
    m = re.match(r"daily\s+(\d{1,2}):(\d{2})$", expr, re.IGNORECASE)
    if m:
        return {"type": "daily", "hour": int(m.group(1)), "minute": int(m.group(2))}

    # weekly N HH:MM
    m = re.match(r"weekly\s+([1-7])\s+(\d{1,2}):(\d{2})$", expr, re.IGNORECASE)
    if m:
        return {"type": "weekly", "weekday": int(m.group(1)),
                "hour": int(m.group(2)), "minute": int(m.group(3))}

    # every Nh / every Nm
    m = re.match(r"every\s+(\d+)\s*([hm])$", expr, re.IGNORECASE)
    if m:
        value = int(m.group(1))
        unit = m.group(2).lower()
        if value <= 0:
            return None
        seconds = value * 3600 if unit == "h" else value * 60
        display = f"every {value}{'h' if unit == 'h' else 'm'}"
        return {"type": "interval", "seconds": seconds, "display": display}

    # cron M H D M W
    m = re.match(r"cron\s+(.+)$", expr, re.IGNORECASE)
    if m:
        parts = m.group(1).strip().split()
        if len(parts) == 5:
            return {"type": "cron", "expr": parts, "display": f"cron {' '.join(parts)}"}

    return None


def _schedule_display(sched: dict) -> str:
    t = sched["type"]
    if t == "daily":
        return f"daily {sched['hour']:02d}:{sched['minute']:02d}"
    if t == "weekly":
        days = {1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat", 7: "Sun"}
        return f"weekly {days.get(sched['weekday'], '?')} {sched['hour']:02d}:{sched['minute']:02d}"
    if t == "interval":
        return sched.get("display", f"every {sched['seconds']}s")
    if t == "cron":
        return sched.get("display", "cron")
    return str(sched)


def _should_fire(sched: dict, last_fire_ts: float | None) -> bool:
    now = datetime.now()
    t = sched["type"]

    if t == "daily":
        target = now.replace(hour=sched["hour"], minute=sched["minute"], second=0, microsecond=0)
        if now >= target:
            if last_fire_ts:
                last = datetime.fromtimestamp(last_fire_ts)
                if last.date() == now.date():
                    return False
            return True
        return False

    if t == "weekly":
        if now.isoweekday() != sched["weekday"]:
            return False
        target = now.replace(hour=sched["hour"], minute=sched["minute"], second=0, microsecond=0)
        if now >= target:
            if last_fire_ts:
                last = datetime.fromtimestamp(last_fire_ts)
                if last.date() == now.date():
                    return False
            return True
        return False

    if t == "interval":
        if not last_fire_ts:
            return True
        return time_mod.time() - last_fire_ts >= sched["seconds"]

    if t == "cron":
        return _cron_match(sched["expr"], now, last_fire_ts)

    return False


def _cron_match(expr: list, now: datetime, last_fire_ts: float | None) -> bool:
    minute, hour, day, month, weekday = expr

    def _match(field, value):
        if field == "*":
            return True
        for part in field.split(","):
            if "-" in part:
                lo, hi = part.split("-", 1)
                if int(lo) <= value <= int(hi):
                    return True
            elif part.startswith("*/"):
                step = int(part[2:])
                if step > 0 and value % step == 0:
                    return True
            elif int(part) == value:
                return True
        return False

    if not (_match(minute, now.minute) and _match(hour, now.hour)
            and _match(day, now.day) and _match(month, now.month)
            and _match(weekday, now.isoweekday())):
        return False

    # Prevent double-fire in same minute
    if last_fire_ts:
        last = datetime.fromtimestamp(last_fire_ts)
        if (last.year == now.year and last.month == now.month
                and last.day == now.day and last.hour == now.hour
                and last.minute == now.minute):
            return False
    return True


# ── Scheduler ──

def _start_scheduler(channels: dict):
    global _scheduler_started
    with _scheduler_lock:
        if _scheduler_started:
            return
        _scheduler_started = True

    def _loop():
        while True:
            try:
                _tick(channels)
            except Exception as e:
                logger.error(f"[cron] scheduler error: {e}")
            time_mod.sleep(30)

    t = threading.Thread(target=_loop, daemon=True, name="cron-scheduler")
    t.start()
    logger.info("[cron] scheduler started")


def _tick(channels: dict):
    tasks = _load_tasks()
    changed = False

    for task in tasks:
        if task.get("paused"):
            continue
        sched = task.get("schedule_parsed")
        if not sched:
            continue
        if _should_fire(sched, task.get("last_fire")):
            _fire_task(channels, task)
            task["last_fire"] = time_mod.time()
            task["fire_count"] = task.get("fire_count", 0) + 1
            changed = True

    if changed:
        _save_tasks(tasks)


def _fire_task(channels: dict, task: dict):
    content = f"\u23f0 [{task.get('name', 'cron')}] {task['content']}"
    target = task.get("target", "owner")
    channel_name = task.get("channel", "")

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
        logger.info(f"[cron] fired: {task['content'][:30]}")
    else:
        logger.error(f"[cron] all channels failed: {task['content'][:30]}")


# ── Restore on startup ──

def restore_cron_tasks(channels: dict):
    tasks = _load_tasks()
    _start_scheduler(channels)
    active = sum(1 for t in tasks if not t.get("paused"))
    if tasks:
        logger.info(f"[cron] restored {len(tasks)} tasks ({active} active)")


# ── Handler ──

async def handle_cron_task(arguments: dict, channels: dict = None, **kwargs) -> list[TextContent]:
    action = arguments.get("action", "list")
    channels = channels or {}

    # Ensure scheduler is running
    _start_scheduler(channels)

    if action == "create":
        return _handle_create(arguments, channels)
    elif action == "list":
        return _handle_list()
    elif action == "delete":
        return _handle_delete(arguments.get("task_id", ""))
    elif action == "pause":
        return _handle_toggle(arguments.get("task_id", ""), paused=True)
    elif action == "resume":
        return _handle_toggle(arguments.get("task_id", ""), paused=False)
    return [TextContent(type="text", text=f"Error: unknown action '{action}'")]


def _handle_create(arguments: dict, channels: dict) -> list[TextContent]:
    schedule = arguments.get("schedule", "")
    content = arguments.get("content", "")
    target = arguments.get("target", "owner")
    channel = arguments.get("channel", "")

    if not schedule:
        return [TextContent(type="text", text="Error: schedule is required (e.g. 'daily 09:00', 'every 2h', 'weekly 5 17:00')")]
    if not content:
        return [TextContent(type="text", text="Error: content is required")]

    sched = _parse_schedule(schedule)
    if not sched:
        return [TextContent(type="text", text=f"Error: invalid schedule '{schedule}'\nFormats: daily HH:MM | weekly N HH:MM | every Nh/Nm | cron M H D M W")]

    now = datetime.now()
    tid = f"cron_{int(now.timestamp())}"
    name = content[:20].replace("\n", " ")

    task = {
        "id": tid,
        "name": name,
        "content": content,
        "target": target,
        "schedule": schedule,
        "schedule_parsed": sched,
        "channel": channel,
        "paused": False,
        "fire_count": 0,
        "last_fire": None,
        "created_at": now.strftime("%Y-%m-%d %H:%M:%S"),
    }

    tasks = _load_tasks()
    tasks.append(task)
    _save_tasks(tasks)

    display = _schedule_display(sched)
    logger.info(f"[cron] created: {tid} | {display} | {content[:30]}")
    return [TextContent(type="text", text=f"Cron task created: {display} → {content}\nID: {tid}")]


def _handle_list() -> list[TextContent]:
    tasks = _load_tasks()
    if not tasks:
        return [TextContent(type="text", text="No cron tasks.")]

    lines = [f"{len(tasks)} cron task(s):\n"]
    for t in tasks:
        sched = t.get("schedule_parsed", {})
        display = _schedule_display(sched) if sched else t.get("schedule", "?")
        status = "paused" if t.get("paused") else "active"
        count = t.get("fire_count", 0)
        lines.append(f"- [{t['id']}] {status} | {display} | {t['content'][:30]} (fired {count}x)")
    return [TextContent(type="text", text="\n".join(lines))]


def _handle_delete(task_id: str) -> list[TextContent]:
    if not task_id:
        return [TextContent(type="text", text="Error: task_id is required (use action=list to see IDs)")]
    tasks = _load_tasks()
    found = next((t for t in tasks if t["id"] == task_id), None)
    if not found:
        return [TextContent(type="text", text=f"Error: task '{task_id}' not found")]
    tasks = [t for t in tasks if t["id"] != task_id]
    _save_tasks(tasks)
    return [TextContent(type="text", text=f"Deleted: {found['content'][:30]}")]


def _handle_toggle(task_id: str, paused: bool) -> list[TextContent]:
    if not task_id:
        return [TextContent(type="text", text="Error: task_id is required")]
    tasks = _load_tasks()
    for t in tasks:
        if t["id"] == task_id:
            t["paused"] = paused
            _save_tasks(tasks)
            status = "paused" if paused else "resumed"
            return [TextContent(type="text", text=f"Task {status}: {t['content'][:30]}")]
    return [TextContent(type="text", text=f"Error: task '{task_id}' not found")]
