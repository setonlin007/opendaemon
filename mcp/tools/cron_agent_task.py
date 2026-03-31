"""Cron agent task — schedule local agent execution with persistence.

Triggers the local OpenDaemon chat API to execute agent tasks on a schedule.
Supports one-shot and recurring schedules with execution logging.
"""

import json
import logging
import os
import re
import threading
import time as time_mod
from datetime import datetime
from urllib.request import Request, urlopen
from urllib.error import URLError

from mcp.types import Tool, TextContent

logger = logging.getLogger(__name__)

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
TASKS_FILE = os.path.join(DATA_DIR, "cron_agent_tasks.json")
LOGS_FILE = os.path.join(DATA_DIR, "cron_agent_logs.json")

_scheduler_started = False
_scheduler_lock = threading.Lock()

# Server base URL — MCP server runs on the same host as OpenDaemon
_BASE_URL = os.environ.get("OPENDAEMON_BASE_URL", "http://127.0.0.1:3456")
_AUTH_TOKEN = os.environ.get("OPENDAEMON_AUTH_TOKEN", "")

CRON_AGENT_TASK_TOOL = Tool(
    name="cron_agent_task",
    description=(
        "Schedule and execute local agent tasks. Use this when user wants to do something later — "
        "implement code, run checks, make file changes, deploy, or any task requiring local file/repo access. "
        "Supports one-shot ('do this at 5pm') and recurring schedules. "
        "NOT for sending notifications — use cron_notify_task for that."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["create", "list", "delete", "pause", "resume", "logs"],
                "description": "Action to perform",
                "default": "list",
            },
            "schedule": {
                "type": "string",
                "description": "Schedule: 'daily HH:MM', 'weekly N HH:MM', 'every Nh/Nm', 'cron M H D M W'. Required for 'create'.",
            },
            "prompt": {
                "type": "string",
                "description": "The prompt/instruction for the agent to execute. Required for 'create'.",
            },
            "engine_id": {
                "type": "string",
                "description": "Engine to use. If omitted, uses the first available engine.",
            },
            "once": {
                "type": "boolean",
                "description": "If true, task auto-deletes after first execution. Use for one-shot tasks like 'do this at 5pm'.",
                "default": False,
            },
            "notify_on_complete": {
                "type": "boolean",
                "description": "Send a notification when task completes. Default true.",
                "default": True,
            },
            "task_id": {
                "type": "string",
                "description": "Task ID for delete/pause/resume/logs.",
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
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(TASKS_FILE, "w", encoding="utf-8") as f:
            json.dump(tasks, f, ensure_ascii=False, indent=2)
    except Exception as e:
        logger.error(f"[cron-agent] save tasks error: {e}")


def _load_logs() -> list[dict]:
    try:
        with open(LOGS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def _save_logs(logs: list[dict]):
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(LOGS_FILE, "w", encoding="utf-8") as f:
            json.dump(logs, f, ensure_ascii=False, indent=2)
    except Exception as e:
        logger.error(f"[cron-agent] save logs error: {e}")


def _add_log(task_id: str, task_name: str, conv_id: str, status: str,
             duration_ms: int, summary: str):
    """Append an execution log entry."""
    try:
        logs = _load_logs()
        logs.append({
            "task_id": task_id,
            "task_name": task_name,
            "conv_id": conv_id,
            "status": status,
            "duration_ms": duration_ms,
            "summary": summary,
            "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        })
        # Keep last 200 log entries
        if len(logs) > 200:
            logs = logs[-200:]
        _save_logs(logs)
    except Exception as e:
        logger.error(f"[cron-agent] add log error: {e}")


# ── Schedule parsing (shared logic with cron_notify_task) ──

def _parse_schedule(expr: str) -> dict | None:
    expr = expr.strip()

    m = re.match(r"daily\s+(\d{1,2}):(\d{2})$", expr, re.IGNORECASE)
    if m:
        return {"type": "daily", "hour": int(m.group(1)), "minute": int(m.group(2))}

    m = re.match(r"weekly\s+([1-7])\s+(\d{1,2}):(\d{2})$", expr, re.IGNORECASE)
    if m:
        return {"type": "weekly", "weekday": int(m.group(1)),
                "hour": int(m.group(2)), "minute": int(m.group(3))}

    m = re.match(r"every\s+(\d+)\s*([hm])$", expr, re.IGNORECASE)
    if m:
        value = int(m.group(1))
        unit = m.group(2).lower()
        if value <= 0:
            return None
        seconds = value * 3600 if unit == "h" else value * 60
        display = f"every {value}{'h' if unit == 'h' else 'm'}"
        return {"type": "interval", "seconds": seconds, "display": display}

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

    if last_fire_ts:
        last = datetime.fromtimestamp(last_fire_ts)
        if (last.year == now.year and last.month == now.month
                and last.day == now.day and last.hour == now.hour
                and last.minute == now.minute):
            return False
    return True


# ── Agent Execution ──

def _execute_agent(task: dict, channels: dict):
    """Execute an agent task by calling the local OpenDaemon chat API."""
    start_time = time_mod.time()
    conv_id = None
    status = "error"
    summary = ""

    try:
        # 1. Resolve engine_id (fetch default if not specified)
        engine_id = task.get("engine_id", "")
        if not engine_id:
            try:
                init_req = Request(f"{_BASE_URL}/api/engines", method="GET")
                if _AUTH_TOKEN:
                    init_req.add_header("Cookie", f"od_session={_AUTH_TOKEN}")
                with urlopen(init_req, timeout=10) as resp:
                    engines_data = json.loads(resp.read().decode())
                    engines = engines_data.get("engines", [])
                    if engines:
                        engine_id = engines[0].get("id", "")
            except Exception as e:
                logger.warning(f"[cron-agent] failed to fetch engines: {e}")

        if not engine_id:
            raise ValueError("No engine_id specified and could not resolve default engine")

        # 2. Create a new conversation
        create_url = f"{_BASE_URL}/api/conversations"
        create_body = json.dumps({"engine_id": engine_id}).encode()
        req = Request(create_url, data=create_body, method="POST",
                      headers={"Content-Type": "application/json"})
        if _AUTH_TOKEN:
            req.add_header("Cookie", f"od_session={_AUTH_TOKEN}")

        with urlopen(req, timeout=30) as resp:
            conv_data = json.loads(resp.read().decode())
            conv_id = conv_data.get("id")

        if not conv_id:
            raise ValueError("Failed to create conversation: no id returned")

        logger.info(f"[cron-agent] created conv {conv_id} for task {task['id']}")

        # 2. Send prompt via chat API (SSE stream — read until done)
        chat_url = f"{_BASE_URL}/api/chat"
        chat_body = json.dumps({
            "conversation_id": conv_id,
            "prompt": task["prompt"],
        }).encode()
        chat_req = Request(chat_url, data=chat_body, method="POST",
                           headers={"Content-Type": "application/json"})
        if _AUTH_TOKEN:
            chat_req.add_header("Cookie", f"od_session={_AUTH_TOKEN}")

        # Read SSE stream to completion
        result_text = ""
        with urlopen(chat_req, timeout=600) as resp:
            for line in resp:
                try:
                    decoded = line.decode("utf-8").strip()
                    if decoded.startswith("data: "):
                        data = json.loads(decoded[6:])
                        event_type = data.get("type", "")
                        if event_type == "result":
                            result_text = data.get("text", "")[:500]
                        elif event_type == "error":
                            raise RuntimeError(data.get("message", "Unknown error"))
                except (json.JSONDecodeError, UnicodeDecodeError):
                    continue

        status = "success"
        summary = result_text[:200] if result_text else "Completed (no result text)"
        logger.info(f"[cron-agent] task {task['id']} completed in {int(time_mod.time() - start_time)}s")

    except Exception as e:
        status = "error"
        summary = str(e)[:200]
        logger.error(f"[cron-agent] task {task['id']} failed: {e}")

    finally:
        duration_ms = int((time_mod.time() - start_time) * 1000)
        _add_log(task["id"], task.get("name", ""), conv_id or "", status, duration_ms, summary)

        # Send notification if configured
        if task.get("notify_on_complete", True) and channels:
            status_icon = "\u2705" if status == "success" else "\u274c"
            notify_msg = f"{status_icon} Agent task [{task.get('name', task['id'])}] {status}\nDuration: {duration_ms // 1000}s"
            if conv_id:
                notify_msg += f"\nConversation: {conv_id}"
            if summary:
                notify_msg += f"\n{summary[:100]}"
            _send_notification(channels, notify_msg)


def _send_notification(channels: dict, message: str):
    """Send notification through available channels."""
    try:
        for name, ch in channels.items():
            try:
                if ch.send("owner", message):
                    return
            except Exception:
                continue
        logger.warning("[cron-agent] no channel could deliver notification")
    except Exception as e:
        logger.error(f"[cron-agent] notification error: {e}")


# ── Scheduler ──

def _start_agent_scheduler(channels: dict):
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
                logger.error(f"[cron-agent] scheduler error: {e}")
            time_mod.sleep(30)

    t = threading.Thread(target=_loop, daemon=True, name="cron-agent-scheduler")
    t.start()
    logger.info("[cron-agent] scheduler started")


def _tick(channels: dict):
    tasks = _load_tasks()
    changed = False
    to_remove = []

    for task in tasks:
        if task.get("paused"):
            continue
        if task.get("running"):
            continue
        sched = task.get("schedule_parsed")
        if not sched:
            continue
        if _should_fire(sched, task.get("last_fire")):
            task["running"] = True
            _save_tasks(tasks)

            # Execute in a separate thread to avoid blocking scheduler
            def _run(t=task):
                try:
                    _execute_agent(t, channels)
                finally:
                    # Update task state after execution
                    try:
                        current_tasks = _load_tasks()
                        for ct in current_tasks:
                            if ct["id"] == t["id"]:
                                ct["last_fire"] = time_mod.time()
                                ct["fire_count"] = ct.get("fire_count", 0) + 1
                                ct["running"] = False
                                if t.get("once"):
                                    current_tasks = [x for x in current_tasks if x["id"] != t["id"]]
                                    logger.info(f"[cron-agent] one-shot task {t['id']} auto-deleted")
                                break
                        _save_tasks(current_tasks)
                    except Exception as e:
                        logger.error(f"[cron-agent] post-run update error: {e}")

            runner = threading.Thread(target=_run, daemon=True,
                                     name=f"cron-agent-{task['id']}")
            runner.start()
            changed = True

    if changed:
        _save_tasks(tasks)


# ── Restore on startup ──

def restore_cron_agent_tasks(channels: dict):
    """Restore agent tasks and start scheduler on MCP server startup."""
    try:
        tasks = _load_tasks()
        # Clear any stale running flags from unclean shutdown
        changed = False
        for t in tasks:
            if t.get("running"):
                t["running"] = False
                changed = True
        if changed:
            _save_tasks(tasks)

        _start_agent_scheduler(channels)
        active = sum(1 for t in tasks if not t.get("paused"))
        if tasks:
            logger.info(f"[cron-agent] restored {len(tasks)} tasks ({active} active)")
    except Exception as e:
        logger.error(f"[cron-agent] restore error: {e}")


# ── Handler ──

async def handle_cron_agent_task(arguments: dict, channels: dict = None, **kwargs) -> list[TextContent]:
    action = arguments.get("action", "list")
    channels = channels or {}

    _start_agent_scheduler(channels)

    try:
        if action == "create":
            return _handle_create(arguments)
        elif action == "list":
            return _handle_list()
        elif action == "delete":
            return _handle_delete(arguments.get("task_id", ""))
        elif action == "pause":
            return _handle_toggle(arguments.get("task_id", ""), paused=True)
        elif action == "resume":
            return _handle_toggle(arguments.get("task_id", ""), paused=False)
        elif action == "logs":
            return _handle_logs(arguments.get("task_id", ""))
        return [TextContent(type="text", text=f"Error: unknown action '{action}'")]
    except Exception as e:
        logger.error(f"[cron-agent] handler error: {e}")
        return [TextContent(type="text", text=f"Error: {e}")]


def _handle_create(arguments: dict) -> list[TextContent]:
    schedule = arguments.get("schedule", "")
    prompt = arguments.get("prompt", "")
    engine_id = arguments.get("engine_id", "")
    once = arguments.get("once", False)
    notify = arguments.get("notify_on_complete", True)

    if not schedule:
        return [TextContent(type="text", text="Error: schedule is required (e.g. 'daily 09:00', 'every 2h', 'cron 0 17 * * *')")]
    if not prompt:
        return [TextContent(type="text", text="Error: prompt is required")]

    sched = _parse_schedule(schedule)
    if not sched:
        return [TextContent(type="text", text=f"Error: invalid schedule '{schedule}'\nFormats: daily HH:MM | weekly N HH:MM | every Nh/Nm | cron M H D M W")]

    now = datetime.now()
    tid = f"agent_{int(now.timestamp())}"
    name = prompt[:30].replace("\n", " ")

    task = {
        "id": tid,
        "name": name,
        "prompt": prompt,
        "engine_id": engine_id,
        "schedule": schedule,
        "schedule_parsed": sched,
        "once": once,
        "notify_on_complete": notify,
        "paused": False,
        "running": False,
        "fire_count": 0,
        "last_fire": None,
        "created_at": now.strftime("%Y-%m-%d %H:%M:%S"),
    }

    tasks = _load_tasks()
    tasks.append(task)
    _save_tasks(tasks)

    display = _schedule_display(sched)
    mode = " (one-shot)" if once else ""
    logger.info(f"[cron-agent] created: {tid} | {display}{mode} | {prompt[:30]}")
    return [TextContent(type="text", text=f"Agent task created: {display}{mode}\nPrompt: {prompt[:80]}...\nID: {tid}")]


def _handle_list() -> list[TextContent]:
    tasks = _load_tasks()
    if not tasks:
        return [TextContent(type="text", text="No agent tasks scheduled.")]

    lines = [f"{len(tasks)} agent task(s):\n"]
    for t in tasks:
        sched = t.get("schedule_parsed", {})
        display = _schedule_display(sched) if sched else t.get("schedule", "?")
        status = "running" if t.get("running") else ("paused" if t.get("paused") else "active")
        count = t.get("fire_count", 0)
        mode = " [once]" if t.get("once") else ""
        lines.append(f"- [{t['id']}] {status}{mode} | {display} | {t.get('name', '?')[:30]} (ran {count}x)")
    return [TextContent(type="text", text="\n".join(lines))]


def _handle_delete(task_id: str) -> list[TextContent]:
    if not task_id:
        return [TextContent(type="text", text="Error: task_id is required (use action=list to see IDs)")]
    tasks = _load_tasks()
    found = next((t for t in tasks if t["id"] == task_id), None)
    if not found:
        return [TextContent(type="text", text=f"Error: task '{task_id}' not found")]
    if found.get("running"):
        return [TextContent(type="text", text=f"Error: task '{task_id}' is currently running, cannot delete")]
    tasks = [t for t in tasks if t["id"] != task_id]
    _save_tasks(tasks)
    return [TextContent(type="text", text=f"Deleted agent task: {found.get('name', task_id)[:30]}")]


def _handle_toggle(task_id: str, paused: bool) -> list[TextContent]:
    if not task_id:
        return [TextContent(type="text", text="Error: task_id is required")]
    tasks = _load_tasks()
    for t in tasks:
        if t["id"] == task_id:
            if t.get("running"):
                return [TextContent(type="text", text=f"Error: task '{task_id}' is currently running")]
            t["paused"] = paused
            _save_tasks(tasks)
            status = "paused" if paused else "resumed"
            return [TextContent(type="text", text=f"Agent task {status}: {t.get('name', task_id)[:30]}")]
    return [TextContent(type="text", text=f"Error: task '{task_id}' not found")]


def _handle_logs(task_id: str) -> list[TextContent]:
    logs = _load_logs()
    if task_id:
        logs = [l for l in logs if l.get("task_id") == task_id]

    if not logs:
        msg = f"No execution logs for task '{task_id}'." if task_id else "No execution logs."
        return [TextContent(type="text", text=msg)]

    # Show last 10 entries
    recent = logs[-10:]
    lines = [f"Execution logs ({len(logs)} total, showing last {len(recent)}):\n"]
    for l in recent:
        status_icon = "\u2705" if l.get("status") == "success" else "\u274c"
        duration = l.get("duration_ms", 0)
        dur_str = f"{duration // 1000}s" if duration >= 1000 else f"{duration}ms"
        lines.append(
            f"- {status_icon} [{l.get('task_name', '?')[:20]}] {l.get('timestamp', '?')} "
            f"| {dur_str} | conv:{l.get('conv_id', '?')[:8]}"
        )
        if l.get("summary"):
            lines.append(f"  {l['summary'][:80]}")
    return [TextContent(type="text", text="\n".join(lines))]
