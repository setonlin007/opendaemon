"""Knowledge Detail tool — retrieve full content of knowledge entries by ID.

Part of the progressive injection system (P0):
- Injector provides title index (Layer 1)
- LLM calls this tool to expand specific entries (Layer 2)
"""

import json
import logging
import os
import sqlite3

from mcp.types import Tool, TextContent

logger = logging.getLogger(__name__)

KNOWLEDGE_DETAIL_TOOL = Tool(
    name="knowledge_detail",
    description=(
        "Retrieve the full content of one or more knowledge entries by ID. "
        "Use this after seeing the knowledge index in context to get details "
        "about specific entries that are relevant to the current conversation."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "ids": {
                "type": "string",
                "description": "Comma-separated knowledge entry IDs (e.g. '12' or '12,15,23')",
            },
        },
        "required": ["ids"],
    },
)


def _get_db_path():
    """Resolve the OpenDaemon database path."""
    # Try common locations
    for candidate in [
        os.path.join(os.environ.get("OPENDAEMON_ROOT", ""), "data", "opendaemon.db"),
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "opendaemon.db"),
        os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "data", "opendaemon.db"),
    ]:
        if candidate and os.path.exists(candidate):
            return candidate
    return None


def _read_knowledge_content(db_path, entry_id):
    """Read knowledge content from Markdown file via index metadata."""
    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT id, category, title, tags, file_path, line_start, line_end, "
            "source_type, confidence, created_at, updated_at FROM knowledge_index WHERE id = ?",
            (entry_id,),
        ).fetchone()
        conn.close()

        if not row:
            return None

        # Resolve file path relative to project root
        project_root = os.path.dirname(os.path.dirname(db_path))  # data/opendaemon.db → project root
        file_path = os.path.join(project_root, row["file_path"])

        content = ""
        if os.path.exists(file_path):
            with open(file_path, "r", encoding="utf-8") as f:
                lines = f.readlines()
                content = "".join(lines[row["line_start"] - 1 : row["line_end"]])

        return {
            "id": row["id"],
            "category": row["category"],
            "title": row["title"],
            "tags": row["tags"],
            "confidence": row["confidence"],
            "source": row["source_type"],
            "updated_at": row["updated_at"],
            "content": content.strip(),
        }
    except Exception as e:
        logger.error(f"[knowledge_detail] failed to read entry {entry_id}: {e}")
        return None


async def handle_knowledge_detail(arguments: dict, **kwargs) -> list[TextContent]:
    ids_str = arguments.get("ids", "").strip()
    if not ids_str:
        return [TextContent(type="text", text="Error: ids parameter is required")]

    # Parse IDs
    try:
        ids = [int(x.strip()) for x in ids_str.split(",") if x.strip()]
    except ValueError:
        return [TextContent(type="text", text=f"Error: invalid IDs format '{ids_str}'. Use comma-separated numbers.")]

    if not ids:
        return [TextContent(type="text", text="Error: no valid IDs provided")]

    db_path = _get_db_path()
    if not db_path:
        return [TextContent(type="text", text="Error: OpenDaemon database not found")]

    logger.info(f"[knowledge_detail] fetching IDs: {ids}")

    results = []
    for entry_id in ids:
        entry = _read_knowledge_content(db_path, entry_id)
        if entry:
            block = (
                f"## [{entry['category']}] {entry['title']}\n"
                f"_ID: #{entry['id']} | Confidence: {entry['confidence']} | Source: {entry['source']}_\n\n"
                f"{entry['content']}"
            )
            results.append(block)
        else:
            results.append(f"## Entry #{entry_id}\n_Not found_")

    return [TextContent(type="text", text="\n\n---\n\n".join(results))]
