"""Convert Signal textFormatting annotations to Markdown."""

from markdown_to_signal import utf16_length


_STYLE_MARKERS: dict[str, tuple[str, str]] = {
    "BOLD": ("**", "**"),
    "ITALIC": ("_", "_"),
    "STRIKETHROUGH": ("~~", "~~"),
    "MONOSPACE": ("`", "`"),
    "SPOILER": ("<spoiler>", "</spoiler>"),
}


def convert_signal_to_markdown(text: str, formatting: list[dict]) -> str:
    """Apply Signal textFormatting annotations to plain text and return Markdown.

    Each entry in `formatting` must have:
      - start: int  (UTF-16 code unit offset)
      - length: int (UTF-16 code unit count)
      - style: str  (one of BOLD, ITALIC, STRIKETHROUGH, MONOSPACE, SPOILER)

    Annotations may overlap or nest. The function inserts open/close markers at
    the appropriate character boundaries and returns the resulting string.
    If `formatting` is empty, the text is returned unchanged.
    """
    if not formatting:
        return text

    # Collect (utf16_position, is_close, marker_string) tuples.
    # We use is_close as a sort key so that close markers sort before open
    # markers at the same position, which keeps adjacent spans from merging.
    events: list[tuple[int, bool, str]] = []
    for annotation in formatting:
        style = annotation.get("style", "")
        markers = _STYLE_MARKERS.get(style)
        if markers is None:
            continue
        open_marker, close_marker = markers
        start: int = annotation["start"]
        length: int = annotation["length"]
        end = start + length
        events.append((start, False, open_marker))
        events.append((end, True, close_marker))

    # Sort by position; at the same position, close markers (True) come before
    # open markers (False) so that adjacent annotations do not bleed into each other.
    events.sort(key=lambda event: (event[0], not event[1]))

    total_utf16 = utf16_length(text)
    result_parts: list[str] = []
    prev_python_index = 0
    prev_utf16_offset = 0

    for utf16_position, _is_close, marker in events:
        # Clamp to valid range.
        utf16_position = max(0, min(utf16_position, total_utf16))

        # Advance from the previous UTF-16 offset to the current one.
        # We walk forward from prev_python_index rather than from 0 each time
        # to keep the overall complexity linear.
        delta = utf16_position - prev_utf16_offset
        python_index = prev_python_index
        units_walked = 0
        while units_walked < delta and python_index < len(text):
            units_walked += 2 if ord(text[python_index]) >= 0x10000 else 1
            python_index += 1

        result_parts.append(text[prev_python_index:python_index])
        result_parts.append(marker)
        prev_python_index = python_index
        prev_utf16_offset = utf16_position

    # Append any remaining text after the last event.
    result_parts.append(text[prev_python_index:])
    return "".join(result_parts)
