"""WeChat channel — HTTP bridge to wechat_sender (send only)."""

import logging
import time

import requests

from .base import Channel

logger = logging.getLogger(__name__)


class WeChatChannel(Channel):
    """
    WeChat channel via remote sender HTTP API.

    Config:
        sender_url: URL of wechat_sender service (e.g. http://WINDOWS_IP:5679)
    """

    def __init__(self, config: dict):
        super().__init__("wechat", config)
        self.sender_url = config.get("sender_url", "").rstrip("/")
        self._session = requests.Session()
        self._session.trust_env = False

    def send(self, target: str, content: str) -> bool:
        if not self.sender_url:
            logger.error("[wechat] no sender_url configured")
            return False

        # Split long messages to avoid truncation
        parts = self._split_message(content)
        for i, part in enumerate(parts):
            ok = self._send_one(target, part)
            if not ok:
                return False
            if i < len(parts) - 1:
                time.sleep(0.5)
        return True

    def _send_one(self, target: str, content: str) -> bool:
        payload = {"target": target, "message": content}
        url = f"{self.sender_url}/api/send"
        try:
            resp = self._session.post(url, json=payload, timeout=15)
            data = resp.json()
            if resp.status_code == 200 and data.get("ok"):
                logger.info(f"[wechat] sent: [{target}] {content[:40]}")
                return True
            logger.error(f"[wechat] send failed: {data.get('error', resp.text[:100])}")
            return False
        except requests.ConnectionError:
            logger.error(f"[wechat] connection failed: {url}")
            return False
        except requests.Timeout:
            logger.error("[wechat] send timeout")
            return False
        except Exception as e:
            logger.error(f"[wechat] send error: {e}")
            return False

    @staticmethod
    def _split_message(content: str, max_len: int = 500) -> list[str]:
        """Split long messages into chunks for WeChat's paste limitation."""
        content = content.strip()
        if not content:
            return []
        if "\n" not in content and len(content) <= max_len:
            return [content]

        paragraphs = content.split("\n\n")
        parts = []
        current = ""

        for para in paragraphs:
            para = para.strip()
            if not para:
                continue
            test = f"{current}\n\n{para}" if current else para
            if len(test) <= max_len:
                current = test
            else:
                if current:
                    parts.append(current)
                    current = ""
                if len(para) > max_len:
                    lines = para.split("\n")
                    for line in lines:
                        line = line.strip()
                        if not line:
                            continue
                        test = f"{current}\n{line}" if current else line
                        if len(test) <= max_len:
                            current = test
                        else:
                            if current:
                                parts.append(current)
                            while len(line) > max_len:
                                parts.append(line[:max_len])
                                line = line[max_len:]
                            current = line
                else:
                    current = para

        if current:
            parts.append(current)
        return parts if parts else [content[:max_len]]

    def health_check(self) -> dict:
        if not self.sender_url:
            return {"channel": "wechat", "status": "down", "error": "no sender_url"}
        try:
            resp = self._session.get(f"{self.sender_url}/api/health", timeout=10)
            if resp.status_code == 200:
                return {"channel": "wechat", "status": "healthy"}
            return {"channel": "wechat", "status": "degraded"}
        except Exception as e:
            return {"channel": "wechat", "status": "down", "error": str(e)}
