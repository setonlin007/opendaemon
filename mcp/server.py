#!/usr/bin/env python3
"""
OpenDaemon MCP Server — exposes tools via stdio transport.

Launched by server.mjs as a long-running subprocess.
Channel config passed via OPENDAEMON_CHANNELS env var (JSON).
"""

import asyncio
import json
import logging
import os
import sys

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent

# Configure logging to stderr (stdout is for MCP JSON-RPC)
logging.basicConfig(
    level=logging.INFO,
    format="[mcp] %(levelname)s %(name)s: %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger("opendaemon-mcp")

# ── Globals ──

_channels = {}  # {name: Channel instance}
_server = Server("opendaemon")


def _init_channels():
    """Initialize channels from OPENDAEMON_CHANNELS env var."""
    global _channels
    raw = os.environ.get("OPENDAEMON_CHANNELS", "{}")
    try:
        config = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("Invalid OPENDAEMON_CHANNELS JSON, no channels configured")
        return

    if not config:
        logger.info("No channels configured")
        return

    from channels import create_channels
    _channels = create_channels(config)
    logger.info(f"Channels initialized: {list(_channels.keys())}")


def get_channels():
    """Get current channel instances (used by tools)."""
    return _channels


# ── MCP Handlers ──

@_server.list_tools()
async def list_tools():
    from tools import ALL_TOOLS
    return ALL_TOOLS


@_server.call_tool()
async def call_tool(name: str, arguments: dict):
    from tools import TOOL_HANDLERS
    handler = TOOL_HANDLERS.get(name)
    if not handler:
        return [TextContent(type="text", text=f"Error: unknown tool '{name}'")]

    try:
        result = await handler(arguments, channels=_channels)
        return result
    except Exception as e:
        logger.error(f"[{name}] error: {e}", exc_info=True)
        return [TextContent(type="text", text=f"Tool error: {e}")]


# ── Main ──

async def main():
    _init_channels()

    # Restore persistent state (reminders, cron tasks)
    from tools.reminder import restore_reminders
    from tools.cron_task import restore_cron_tasks
    restore_reminders(_channels)
    restore_cron_tasks(_channels)

    logger.info("OpenDaemon MCP Server starting (stdio)")
    async with stdio_server() as (read_stream, write_stream):
        await _server.run(read_stream, write_stream, _server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
