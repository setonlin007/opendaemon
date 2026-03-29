"""Channel base class — unified send interface for all messaging channels."""

import logging
from abc import ABC, abstractmethod

logger = logging.getLogger(__name__)


class Channel(ABC):
    """
    Abstract base class for messaging channels.

    P1 scope: send only (no receiving).
    Each channel implements send() and optionally health_check().
    """

    def __init__(self, name: str, config: dict):
        self.name = name
        self.config = config

    @abstractmethod
    def send(self, target: str, content: str) -> bool:
        """
        Send a text message.

        Args:
            target: Recipient identifier (contact name, chat ID, etc.)
            content: Message text

        Returns:
            True if sent successfully
        """
        ...

    def health_check(self) -> dict:
        """Return channel health status."""
        return {"channel": self.name, "status": "unknown"}
