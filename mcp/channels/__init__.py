"""Channel factory — creates channel instances from config."""

import logging

from .base import Channel
from .bark import BarkChannel
from .feishu import FeishuChannel
from .wechat import WeChatChannel

logger = logging.getLogger(__name__)

CHANNEL_TYPES = {
    "bark": BarkChannel,
    "feishu": FeishuChannel,
    "wechat": WeChatChannel,
}


def create_channels(config: dict) -> dict[str, Channel]:
    """
    Create channel instances from config dict.

    Args:
        config: {channel_name: {type: "bark"|"feishu"|"wechat", ...}}

    Returns:
        {channel_name: Channel instance}
    """
    channels = {}
    for name, ch_config in config.items():
        ch_type = ch_config.get("type", name)
        cls = CHANNEL_TYPES.get(ch_type)
        if not cls:
            logger.warning(f"Unknown channel type: {ch_type}")
            continue
        try:
            channels[name] = cls(ch_config)
            logger.info(f"Channel created: {name} ({ch_type})")
        except Exception as e:
            logger.error(f"Failed to create channel {name}: {e}")
    return channels
