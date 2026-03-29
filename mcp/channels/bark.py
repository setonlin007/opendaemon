"""Bark channel — iOS push notifications (send only)."""

import json
import logging
import urllib.parse
import urllib.request

from .base import Channel

logger = logging.getLogger(__name__)


class BarkChannel(Channel):
    """
    Bark push notification channel.

    Config:
        key: Bark device key
        server: Bark server URL (default: https://api.day.app)
    """

    def __init__(self, config: dict):
        super().__init__("bark", config)
        self.key = config.get("key", "")
        self.server = config.get("server", "https://api.day.app").rstrip("/")

    def send(self, target: str, content: str) -> bool:
        if not self.key:
            logger.error("[bark] no key configured")
            return False

        title = target or "OpenDaemon"
        url = (
            f"{self.server}/{urllib.parse.quote(self.key)}"
            f"/{urllib.parse.quote(title)}"
            f"/{urllib.parse.quote(content)}"
        )
        params = {"group": "opendaemon", "isArchive": "1"}
        url += "?" + urllib.parse.urlencode(params)

        try:
            req = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read())
                if data.get("code") == 200:
                    logger.info(f"[bark] sent: {title}")
                    return True
                logger.error(f"[bark] failed: {data}")
                return False
        except Exception as e:
            logger.error(f"[bark] error: {e}")
            return False

    def health_check(self) -> dict:
        if not self.key:
            return {"channel": "bark", "status": "down", "error": "no key"}
        try:
            url = f"{self.server}/ping"
            req = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(req, timeout=5) as resp:
                if resp.status == 200:
                    return {"channel": "bark", "status": "healthy"}
        except Exception as e:
            return {"channel": "bark", "status": "degraded", "error": str(e)}
        return {"channel": "bark", "status": "degraded"}
