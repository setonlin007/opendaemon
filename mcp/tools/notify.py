"""Notify tool — push notification via Bark."""

import logging

from mcp.types import Tool, TextContent

logger = logging.getLogger(__name__)

NOTIFY_TOOL = Tool(
    name="notify",
    description="Send a push notification to the owner's phone via Bark.",
    inputSchema={
        "type": "object",
        "properties": {
            "title": {"type": "string", "description": "Notification title"},
            "content": {"type": "string", "description": "Notification body"},
        },
        "required": ["title", "content"],
    },
)


async def handle_notify(arguments: dict, channels: dict = None, **kwargs) -> list[TextContent]:
    title = arguments.get("title", "")
    content = arguments.get("content", "")

    if not title:
        return [TextContent(type="text", text="Error: title is required")]
    if not content:
        return [TextContent(type="text", text="Error: content is required")]

    channels = channels or {}
    bark = channels.get("bark")
    if not bark:
        return [TextContent(type="text", text="Error: Bark channel not configured")]

    ok = bark.send(title, content)
    if ok:
        return [TextContent(type="text", text=f"Notification sent: {title}")]
    return [TextContent(type="text", text=f"Notification failed: {title}")]
