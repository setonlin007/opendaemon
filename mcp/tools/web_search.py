"""Web search tool — DuckDuckGo (free, no API key)."""

import logging

from mcp.types import Tool, TextContent

logger = logging.getLogger(__name__)

WEB_SEARCH_TOOL = Tool(
    name="web_search",
    description="Search the internet using DuckDuckGo. Returns titles, snippets, and URLs.",
    inputSchema={
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Search query"},
            "max_results": {
                "type": "integer",
                "description": "Max results (default 5)",
                "default": 5,
            },
        },
        "required": ["query"],
    },
)


async def handle_web_search(arguments: dict, **kwargs) -> list[TextContent]:
    query = arguments.get("query", "")
    max_results = arguments.get("max_results", 5)

    if not query:
        return [TextContent(type="text", text="Error: query is required")]

    try:
        from ddgs import DDGS
    except ImportError:
        try:
            from duckduckgo_search import DDGS
        except ImportError:
            return [TextContent(type="text", text="Error: search library not installed (pip install ddgs)")]

    logger.info(f"[web_search] query={query} max_results={max_results}")
    try:
        # Support proxy via HTTPS_PROXY env var
        proxy = None
        import os
        proxy_url = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
        if proxy_url:
            proxy = proxy_url
        results = DDGS(proxy=proxy).text(query, max_results=max_results)
        if not results:
            return [TextContent(type="text", text=f"No results found for '{query}'")]

        lines = []
        for i, r in enumerate(results, 1):
            title = r.get("title", "")
            body = r.get("body", "")
            href = r.get("href", "")
            lines.append(f"{i}. {title}\n   {body}\n   {href}")

        return [TextContent(type="text", text="\n\n".join(lines))]
    except Exception as e:
        logger.error(f"[web_search] failed: {e}")
        return [TextContent(type="text", text=f"Search failed: {e}")]
