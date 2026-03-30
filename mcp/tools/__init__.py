"""MCP Tools registry — all tools register here."""

from mcp.types import Tool

from .web_search import WEB_SEARCH_TOOL, handle_web_search
from .send_message import SEND_MESSAGE_TOOL, handle_send_message
from .notify import NOTIFY_TOOL, handle_notify
from .reminder import REMINDER_TOOL, handle_reminder
from .cron_task import CRON_TASK_TOOL, handle_cron_task
from .tech_buzz import TECH_BUZZ_TOOL, handle_tech_buzz

ALL_TOOLS: list[Tool] = [
    WEB_SEARCH_TOOL,
    SEND_MESSAGE_TOOL,
    NOTIFY_TOOL,
    REMINDER_TOOL,
    CRON_TASK_TOOL,
    TECH_BUZZ_TOOL,
]

TOOL_HANDLERS = {
    "web_search": handle_web_search,
    "send_message": handle_send_message,
    "notify": handle_notify,
    "set_reminder": handle_reminder,
    "cron_task": handle_cron_task,
    "tech_buzz": handle_tech_buzz,
}
