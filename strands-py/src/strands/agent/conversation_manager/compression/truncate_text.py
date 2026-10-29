"""Last-resort text truncation for when summarization cannot reduce the context."""

import json
import re
from collections.abc import Iterator
from typing import Any

from ....types.content import ContentBlock, Message, Messages
from ....types.tools import ToolResultContent
from .pin_message import is_pinned

_TRUNCATION_MARKER = re.compile(r"\.\.\. \[truncated: \d+ chars removed\] \.\.\.")
_PRESERVE_CHARS = 2_000


def _text_blocks(message: Message) -> Iterator[ContentBlock | ToolResultContent]:
    """Yield every truncatable text or JSON block, including items inside tool results."""
    for content in message.get("content", []):
        if not isinstance(content, dict):
            continue  # type: ignore[unreachable]
        if "text" in content or "json" in content:
            yield content
        for item in content.get("toolResult", {}).get("content", []):
            if isinstance(item, dict) and ("text" in item or "json" in item):
                yield item


def _truncate_block(block: Any, preserve_chars: int, minimum_removed_chars: int = 0) -> bool:
    """Replace one oversized text or JSON block with a head-and-tail text preview."""
    if "text" in block:
        text = block["text"]
        was_truncated = bool(_TRUNCATION_MARKER.search(text))
    elif "json" in block:
        text = json.dumps(block["json"], ensure_ascii=False)
        was_truncated = False
    else:
        return False

    removed = len(text) - 2 * preserve_chars
    if removed <= minimum_removed_chars or was_truncated:
        return False

    marker = f"...\n\n... [truncated: {removed} chars removed] ...\n\n..."
    block.clear()
    block["text"] = f"{text[:preserve_chars]}{marker}{text[-preserve_chars:]}"
    return True


def _truncate_oversized_text_blocks(messages: Messages, preserve_chars: int = _PRESERVE_CHARS) -> bool:
    """Replace every oversized, untruncated text or JSON block in non-pinned messages with a head+tail preview.

    A block qualifies when truncating it saves more than ``preserve_chars`` characters, so each call
    either shrinks the history by a meaningful amount or reports that nothing is left to truncate.

    Args:
        messages: The conversation history, modified in place.
        preserve_chars: Characters kept at each end of a truncated block.

    Returns:
        True if at least one block was truncated.
    """
    if preserve_chars <= 0:
        return False

    truncated = False
    for index, message in enumerate(messages):
        if is_pinned(messages, index):
            continue
        for block in _text_blocks(message):
            if _truncate_block(block, preserve_chars, minimum_removed_chars=preserve_chars):
                truncated = True
    return truncated
