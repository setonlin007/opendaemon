"""Generate image via local ComfyUI through OpenDaemon's HTTP endpoint.

This tool is a thin wrapper around OpenDaemon's /api/image/generate route.
Claude reads the mode descriptions below and picks the right one based on user intent.
"""

import logging
import os
import httpx

from mcp.types import Tool, TextContent

logger = logging.getLogger(__name__)

# OpenDaemon 自己的 HTTP 端口（本地）
_OPENDAEMON_URL = os.environ.get("OPENDAEMON_URL", "http://127.0.0.1:3000")

GENERATE_IMAGE_TOOL = Tool(
    name="generate_image",
    description=(
        "Generate an image using local ComfyUI (SDXL + FaceID / IP-Adapter). "
        "Pick the right mode based on user intent:\n\n"
        "• txt2img — No reference image, pure text-to-image.\n"
        "• plus_face — Has a face reference, daily iteration, FAST (2-3 min on CPU). "
        "Use when user wants 'same person, different scene' without strict identity lock.\n"
        "• faceid — Strongest face identity lock, ~5-8 min. "
        "Use when user says 'must look exactly like', '一眼认出', '锁脸'.\n"
        "• faceid_plus — FaceID + Plus-Face stacked, best identity + aesthetic. ~7-10 min. "
        "Use when user wants '定妆级', '写真级', 'the best possible likeness'.\n"
        "• ipadapter — Style/composition reference, does NOT lock face. "
        "Use when user says '参考风格', '借鉴构图', 'inspired by this vibe'.\n\n"
        "Always translate Chinese prompts to English before passing to `prompt`. "
        "Describe the TARGET state of the image, not actions."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "conv_id": {
                "type": "string",
                "description": "Conversation ID (will be injected by the agent)",
            },
            "prompt": {
                "type": "string",
                "description": "English SDXL-style prompt describing the target image. "
                               "Use comma-separated tags, describe the target state, "
                               "add realism keywords (iPhone photo, 35mm film, skin texture, unretouched). "
                               "NEVER include 'masterpiece/best quality/highly detailed' — those trigger AI-filter look.",
            },
            "negative_prompt": {
                "type": "string",
                "description": "Negative prompt. Recommended defaults: "
                               "'airbrushed, smooth skin, plastic, beauty filter, cgi, masterpiece, "
                               "bad anatomy, deformed'",
                "default": "",
            },
            "mode": {
                "type": "string",
                "enum": ["txt2img", "plus_face", "faceid", "faceid_plus", "ipadapter"],
                "description": "Generation mode — see main description for how to pick.",
            },
            "ref_attachment_id": {
                "type": "string",
                "description": "Reference image attachment ID (att_xxxxxxxx). "
                               "Required for all modes except txt2img. "
                               "Look in conversation history for the most recently uploaded image.",
            },
            "weight": {
                "type": "number",
                "description": "Reference image influence strength. "
                               "plus_face: 0.4-1.0 (default 0.85). "
                               "ipadapter: 0.3-1.0 (default 0.8). "
                               "faceid: 0.5-1.5 (default 1.1). "
                               "faceid_plus: 0.6-1.3 (default 1.0).",
            },
            "steps": {
                "type": "integer",
                "default": 25,
                "description": "Sampling steps. Lightning mode forces to 4.",
            },
            "resolution": {
                "type": "string",
                "enum": ["lite_portrait", "lite_square", "portrait", "square", "landscape"],
                "default": "lite_portrait",
                "description": "lite_* = 768 (Mac-friendly). Non-lite = 1024 (more detail, slower).",
            },
            "use_lightning": {
                "type": "boolean",
                "default": False,
                "description": "4-step Lightning LoRA acceleration. "
                               "Only works with plus_face/ipadapter/txt2img. "
                               "Auto-disabled for FaceID-family modes.",
            },
            "seed": {
                "type": "integer",
                "description": "Random seed for reproducibility. Omit for random.",
            },
        },
        "required": ["conv_id", "prompt", "mode"],
    },
)


async def handle_generate_image(arguments: dict, channels: dict = None, **kwargs) -> list[TextContent]:
    conv_id = arguments.get("conv_id")
    prompt = arguments.get("prompt")
    mode = arguments.get("mode")
    if not conv_id or not prompt or not mode:
        return [TextContent(type="text", text="Error: conv_id, prompt, mode are required")]

    payload = {
        "conv_id": conv_id,
        "prompt": prompt,
        "mode": mode,
        "negative_prompt": arguments.get("negative_prompt", ""),
        "ref_attachment_id": arguments.get("ref_attachment_id"),
        "weight": arguments.get("weight"),
        "steps": arguments.get("steps", 25),
        "resolution": arguments.get("resolution", "lite_portrait"),
        "use_lightning": arguments.get("use_lightning", False),
        "seed": arguments.get("seed"),
        "create_messages": True,  # 由后端自动入库消息 + 链接附件
    }
    # Strip None values so backend uses its defaults
    payload = {k: v for k, v in payload.items() if v is not None}

    try:
        async with httpx.AsyncClient(timeout=2000) as client:  # 30+ min timeout
            r = await client.post(
                f"{_OPENDAEMON_URL}/api/image/generate",
                json=payload,
            )
            if r.status_code != 200:
                body = r.text[:300]
                return [TextContent(type="text", text=f"Error: HTTP {r.status_code}: {body}")]
            data = r.json()
    except Exception as e:
        logger.exception("generate_image call failed")
        return [TextContent(type="text", text=f"Error calling OpenDaemon: {e}")]

    att_id = data.get("attachment_id")
    duration = data.get("duration_ms", 0) / 1000
    seed = data.get("seed")
    return [
        TextContent(
            type="text",
            text=(
                f"Generated image att_id={att_id} "
                f"(mode={mode}, {duration:.1f}s, seed={seed}). "
                f"The image has been posted to the conversation. "
                f"Reference it in your reply as ![](/api/uploads/{att_id})."
            ),
        )
    ]
