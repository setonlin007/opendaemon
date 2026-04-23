"""MCP Tools registry — all tools register here."""

from mcp.types import Tool

from .web_search import WEB_SEARCH_TOOL, handle_web_search
from .send_message import SEND_MESSAGE_TOOL, handle_send_message
from .notify import NOTIFY_TOOL, handle_notify
from .reminder import REMINDER_TOOL, handle_reminder
from .cron_notify_task import CRON_NOTIFY_TASK_TOOL, handle_cron_notify_task
from .cron_agent_task import CRON_AGENT_TASK_TOOL, handle_cron_agent_task
from .tech_buzz import TECH_BUZZ_TOOL, handle_tech_buzz
from .knowledge_detail import KNOWLEDGE_DETAIL_TOOL, handle_knowledge_detail
from .generate_image import GENERATE_IMAGE_TOOL, handle_generate_image

ALL_TOOLS: list[Tool] = [
    WEB_SEARCH_TOOL,
    SEND_MESSAGE_TOOL,
    NOTIFY_TOOL,
    REMINDER_TOOL,
    CRON_NOTIFY_TASK_TOOL,
    CRON_AGENT_TASK_TOOL,
    TECH_BUZZ_TOOL,
    KNOWLEDGE_DETAIL_TOOL,
    GENERATE_IMAGE_TOOL,
]

TOOL_HANDLERS = {
    "web_search": handle_web_search,
    "send_message": handle_send_message,
    "notify": handle_notify,
    "set_reminder": handle_reminder,
    "cron_notify_task": handle_cron_notify_task,
    "cron_agent_task": handle_cron_agent_task,
    "tech_buzz": handle_tech_buzz,
    "knowledge_detail": handle_knowledge_detail,
    "generate_image": handle_generate_image,
}
