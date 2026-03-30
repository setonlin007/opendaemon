"""Tech Buzz tool — aggregate trending tech discussions from multiple sources.

Zero external dependencies beyond ddgs (already installed for web_search).
Uses stdlib urllib for HTTP, asyncio.run_in_executor for concurrency.
"""

import asyncio
import json
import logging
import os
import re
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta

from mcp.types import Tool, TextContent

logger = logging.getLogger(__name__)

TECH_BUZZ_TOOL = Tool(
    name="tech_buzz",
    description=(
        "Aggregate trending tech discussions from Hacker News (API with real scores), "
        "GitHub Trending (real stars), Reddit, X, and HuggingFace. "
        "Returns structured results with real hotness metrics. "
        "Use this to get the latest tech buzz and hot discussions."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "topic": {
                "type": "string",
                "description": "Topic to focus on (default: 'AI agent LLM')",
                "default": "AI agent LLM",
            },
            "sources": {
                "type": "string",
                "description": "Comma-separated sources to query: hn,github,reddit,x,huggingface,media. Default: all",
                "default": "all",
            },
        },
        "required": [],
    },
)


# ── HTTP Helpers (stdlib only) ──

def _http_get(url, timeout=15):
    """Synchronous HTTP GET using urllib. Returns bytes or None."""
    try:
        proxy_url = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
        if proxy_url:
            proxy_handler = urllib.request.ProxyHandler({"https": proxy_url, "http": proxy_url})
            opener = urllib.request.build_opener(proxy_handler)
        else:
            opener = urllib.request.build_opener()

        req = urllib.request.Request(url, headers={"User-Agent": "OpenDaemon-TechBuzz/1.0"})
        with opener.open(req, timeout=timeout) as resp:
            return resp.read()
    except Exception as e:
        logger.warning(f"[tech_buzz] HTTP GET failed: {url} — {e}")
        return None


def _http_get_json(url, timeout=15):
    """Synchronous HTTP GET, returns parsed JSON or None."""
    data = _http_get(url, timeout)
    if data:
        try:
            return json.loads(data)
        except json.JSONDecodeError as e:
            logger.warning(f"[tech_buzz] JSON decode failed: {url} — {e}")
    return None


def _http_get_text(url, timeout=15):
    """Synchronous HTTP GET, returns text or None."""
    data = _http_get(url, timeout)
    if data:
        try:
            return data.decode("utf-8", errors="replace")
        except Exception:
            return None
    return None


def _ddg_search(query, max_results=8):
    """Synchronous DuckDuckGo search."""
    try:
        from ddgs import DDGS
    except ImportError:
        try:
            from duckduckgo_search import DDGS
        except ImportError:
            return []
    try:
        proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
        results = DDGS(proxy=proxy).text(query, max_results=max_results)
        return results or []
    except Exception as e:
        logger.warning(f"[tech_buzz] ddg search failed: {query} — {e}")
        return []


# ── Source Fetchers (all synchronous, run via executor) ──

def _fetch_hn(topic, limit=15):
    """Fetch Hacker News top stories with real scores."""
    items = []
    try:
        ids_data = _http_get_json("https://hacker-news.firebaseio.com/v0/topstories.json")
        if not ids_data:
            return items

        for sid in ids_data[:limit]:
            story = _http_get_json(f"https://hacker-news.firebaseio.com/v0/item/{sid}.json")
            if not story:
                continue
            title = story.get("title", "")
            score = story.get("score", 0)
            comments = story.get("descendants", 0)
            url = story.get("url", "")
            story_id = story.get("id", "")
            hn_url = f"https://news.ycombinator.com/item?id={story_id}"

            if score >= 30:
                items.append({
                    "source": "HN",
                    "title": title,
                    "url": url or hn_url,
                    "hotness": score,
                    "hotness_label": f"⬆{score} 💬{comments}",
                    "hn_url": hn_url,
                })
    except Exception as e:
        logger.error(f"[tech_buzz] HN fetch error: {e}")
    return items


def _fetch_github_trending(topic):
    """Fetch GitHub trending repos by parsing the trending page."""
    items = []
    try:
        html = _http_get_text("https://github.com/trending?since=daily")
        if not html:
            return items

        repo_pattern = re.compile(r'<h2[^>]*>\s*<a[^>]*href="(/[^"]+)"', re.DOTALL)
        star_pattern = re.compile(r'(\d[\d,]*)\s*stars?\s*today', re.IGNORECASE)
        desc_pattern = re.compile(r'<p[^>]*class="[^"]*col-9[^"]*"[^>]*>\s*(.*?)\s*</p>', re.DOTALL)

        articles = re.split(r'<article', html)[1:]

        for article in articles[:20]:
            repo_match = repo_pattern.search(article)
            if not repo_match:
                continue

            repo_path = repo_match.group(1).strip()
            repo_name = repo_path.lstrip("/")

            desc_match = desc_pattern.search(article)
            description = desc_match.group(1).strip() if desc_match else ""
            description = re.sub(r'<[^>]+>', '', description).strip()

            star_match = star_pattern.search(article)
            stars_today = 0
            if star_match:
                stars_today = int(star_match.group(1).replace(",", ""))

            items.append({
                "source": "GitHub",
                "title": repo_name,
                "description": description,
                "url": f"https://github.com{repo_path}",
                "hotness": stars_today,
                "hotness_label": f"⭐{stars_today} today",
            })
    except Exception as e:
        logger.error(f"[tech_buzz] GitHub trending error: {e}")
    return items


def _fetch_ddg_source(topic, source_name, query_template):
    """Fetch from a search-based source via DuckDuckGo."""
    query = query_template.format(topic=topic, year=datetime.now().year)
    results = _ddg_search(query, 8)
    items = []
    for r in results:
        items.append({
            "source": source_name,
            "title": r.get("title", ""),
            "description": r.get("body", ""),
            "url": r.get("href", ""),
            "hotness": 0,
            "hotness_label": "via search",
        })
    return items


# ── Main Handler ──

async def handle_tech_buzz(arguments: dict, **kwargs) -> list[TextContent]:
    topic = arguments.get("topic", "AI agent LLM").strip()
    sources_str = arguments.get("sources", "all").strip().lower()

    if sources_str == "all":
        enabled = {"hn", "github", "reddit", "x", "huggingface", "media"}
    else:
        enabled = set(s.strip() for s in sources_str.split(","))

    logger.info(f"[tech_buzz] topic={topic} sources={enabled}")

    loop = asyncio.get_event_loop()
    all_items = []
    source_status = {}

    try:
        tasks = []
        task_names = []

        # --- API-based sources (real hotness data) ---
        if "hn" in enabled:
            tasks.append(loop.run_in_executor(None, _fetch_hn, topic))
            task_names.append("hn")

        if "github" in enabled:
            tasks.append(loop.run_in_executor(None, _fetch_github_trending, topic))
            task_names.append("github")

        # --- Search-based sources ---
        if "reddit" in enabled:
            tasks.append(loop.run_in_executor(None, _fetch_ddg_source,
                topic, "Reddit", "reddit MachineLearning LocalLLaMA {topic} {year}"))
            task_names.append("reddit")

        if "x" in enabled:
            tasks.append(loop.run_in_executor(None, _fetch_ddg_source,
                topic, "X", "site:x.com {topic} {year}"))
            task_names.append("x")

        if "huggingface" in enabled:
            tasks.append(loop.run_in_executor(None, _fetch_ddg_source,
                topic, "HuggingFace", "site:huggingface.co {topic} {year}"))
            task_names.append("huggingface")

        if "media" in enabled:
            tasks.append(loop.run_in_executor(None, _fetch_ddg_source,
                topic, "Media", "{topic} latest news {year} release breakthrough"))
            task_names.append("media")

        results = await asyncio.gather(*tasks, return_exceptions=True)

        for name, result in zip(task_names, results):
            if isinstance(result, Exception):
                logger.error(f"[tech_buzz] {name} failed: {result}")
                source_status[name] = "❌"
            elif not result:
                source_status[name] = "⚠️ 0条"
            else:
                source_status[name] = f"✅ {len(result)}条"
                all_items.extend(result)

    except Exception as e:
        logger.error(f"[tech_buzz] critical error: {e}")
        return [TextContent(type="text", text=f"Tech buzz fetch failed: {e}")]

    # --- Sort: items with real hotness first, then by hotness desc ---
    all_items.sort(key=lambda x: x.get("hotness", 0), reverse=True)

    # --- Deduplicate by URL ---
    seen_urls = set()
    deduped = []
    for item in all_items:
        url_key = item.get("url", "").split("?")[0].rstrip("/")
        if url_key and url_key not in seen_urls:
            seen_urls.add(url_key)
            deduped.append(item)

    # --- Format output ---
    now = datetime.now(timezone(timedelta(hours=8)))
    lines = [
        f"# Tech Buzz — {now.strftime('%Y-%m-%d %H:%M')} CST",
        f"> Topic: {topic}",
        f"> Sources: {' | '.join(f'{k}: {v}' for k, v in source_status.items())}",
        "",
    ]

    for i, item in enumerate(deduped[:30], 1):
        hotness = item.get("hotness_label", "")
        title = item.get("title", "Untitled")
        desc = item.get("description", "")
        url = item.get("url", "")
        source = item.get("source", "")
        hn_url = item.get("hn_url", "")

        line = f"{i}. **[{source}]** {title}"
        if hotness:
            line += f" `{hotness}`"
        if desc:
            line += f"\n   {desc[:150]}"
        if url:
            line += f"\n   {url}"
        if hn_url and hn_url != url:
            line += f"\n   HN: {hn_url}"
        lines.append(line)
        lines.append("")

    lines.append(f"---\nTotal: {len(deduped)} items (before dedup: {len(all_items)})")

    return [TextContent(type="text", text="\n".join(lines))]
