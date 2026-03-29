"""Feishu channel — Bot REST API (send only, no WebSocket receive)."""

import json
import logging
import threading
import time

import requests

from .base import Channel

logger = logging.getLogger(__name__)


class FeishuChannel(Channel):
    """
    Feishu Bot channel (send only).

    Config:
        app_id: Feishu app ID (cli_xxx)
        app_secret: Feishu app secret
        target_map: Optional {display_name: open_id/chat_id} mapping
    """

    def __init__(self, config: dict):
        super().__init__("feishu", config)
        self.app_id = config.get("app_id", "")
        self.app_secret = config.get("app_secret", "")
        self._target_map = config.get("target_map", {})

        self._token = ""
        self._token_expire = 0
        self._token_lock = threading.Lock()
        self._session = requests.Session()

    def send(self, target: str, content: str) -> bool:
        token = self._get_token()
        if not token:
            return False

        receive_id, id_type = self._resolve_target(target)
        url = f"https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type={id_type}"
        payload = {
            "receive_id": receive_id,
            "msg_type": "text",
            "content": json.dumps({"text": content}),
        }
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

        try:
            resp = self._session.post(url, json=payload, headers=headers, timeout=10)
            data = resp.json()
            if data.get("code") == 0:
                logger.info(f"[feishu] sent: {target[:20]} → {content[:30]}")
                return True
            logger.error(f"[feishu] send failed: {data}")
            return False
        except Exception as e:
            logger.error(f"[feishu] send error: {e}")
            return False

    def _resolve_target(self, target: str) -> tuple[str, str]:
        """Resolve target to (receive_id, receive_id_type)."""
        # Check target_map first
        if target in self._target_map:
            target = self._target_map[target]

        if target.startswith("oc_"):
            return target, "chat_id"
        elif target.startswith("ou_"):
            return target, "open_id"
        return target, "chat_id"

    def _get_token(self) -> str:
        with self._token_lock:
            if self._token and time.time() < self._token_expire - 60:
                return self._token

            url = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal"
            payload = {"app_id": self.app_id, "app_secret": self.app_secret}
            try:
                resp = self._session.post(url, json=payload, timeout=10)
                data = resp.json()
                if data.get("code") == 0:
                    self._token = data["tenant_access_token"]
                    self._token_expire = time.time() + data.get("expire", 7200)
                    logger.info("[feishu] token refreshed")
                    return self._token
                logger.error(f"[feishu] token failed: {data}")
                return ""
            except Exception as e:
                logger.error(f"[feishu] token error: {e}")
                return ""

    def health_check(self) -> dict:
        token = self._get_token()
        if token:
            return {"channel": "feishu", "status": "healthy"}
        return {"channel": "feishu", "status": "down", "error": "cannot get token"}
