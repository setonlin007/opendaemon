"""Send message tool — unified multi-channel message sending."""

import logging

from mcp.types import Tool, TextContent

logger = logging.getLogger(__name__)

SEND_MESSAGE_TOOL = Tool(
    name="send_message",
    description="Send a message through configured channels (WeChat, Feishu, Bark).",
    inputSchema={
        "type": "object",
        "properties": {
            "target": {"type": "string", "description": "Recipient name or chat name"},
            "content": {"type": "string", "description": "Message content"},
            "channel": {
                "type": "string",
                "description": "Channel name (bark/feishu/wechat). Auto-select if omitted.",
            },
        },
        "required": ["target", "content"],
    },
)


async def handle_send_message(arguments: dict, channels: dict = None, **kwargs) -> list[TextContent]:
    target = arguments.get("target", "")
    content = arguments.get("content", "")
    channel_name = arguments.get("channel", "")

    if not target:
        return [TextContent(type="text", text="Error: target is required")]
    if not content:
        return [TextContent(type="text", text="Error: content is required")]

    channels = channels or {}
    if not channels:
        return [TextContent(type="text", text="Error: no channels configured")]

    # If channel specified, use it directly
    if channel_name:
        ch = channels.get(channel_name)
        if not ch:
            available = list(channels.keys())
            return [TextContent(type="text", text=f"Error: channel '{channel_name}' not available (available: {available})")]
        ok = ch.send(target, content)
        if ok:
            return [TextContent(type="text", text=f"Sent via {channel_name} to {target}")]
        return [TextContent(type="text", text=f"Failed to send via {channel_name} to {target}")]

    # Auto-select: try each channel in order until one succeeds
    for name, ch in channels.items():
        try:
            ok = ch.send(target, content)
            if ok:
                return [TextContent(type="text", text=f"Sent via {name} to {target}")]
            logger.warning(f"[send_message] {name} failed, trying next...")
        except Exception as e:
            logger.warning(f"[send_message] {name} error: {e}, trying next...")

    return [TextContent(type="text", text=f"Failed to send to {target}: all channels failed")]
