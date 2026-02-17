"""Convert markdown text to Signal plain text with textStyle annotations."""

import mistune


def utf16_length(text: str) -> int:
    """Return the number of UTF-16 code units in a Python string.

    Characters with code point >= 0x10000 (emoji, etc.) require a surrogate
    pair in UTF-16 and thus count as 2 code units instead of 1.
    """
    return sum(2 if ord(character) >= 0x10000 else 1 for character in text)


def convert_markdown(text: str) -> tuple[str, list[str]]:
    """Convert markdown text to plain text and Signal textStyle annotations.

    Returns a tuple of (plain_text, text_styles) where text_styles is a list
    of dicts with keys: start (int), length (int), style (str).
    Offsets are in UTF-16 code units.
    """
    md = mistune.create_markdown(renderer="ast", plugins=["strikethrough"])
    ast = md(text)
    converter = _Converter()
    converter.walk_nodes(ast)
    plain_text = converter.text.rstrip("\n")
    return plain_text, converter.styles


class _Converter:
    """Stateful walker that builds plain text and style annotations from a mistune AST."""

    def __init__(self) -> None:
        self.text = ""
        self.styles: list[str] = []

    def _utf16_offset(self) -> int:
        """Return the current UTF-16 offset into self.text."""
        return utf16_length(self.text)

    def _append(self, fragment: str) -> None:
        self.text += fragment

    def _apply_style(self, style: str, start_offset: int) -> None:
        """Record a style annotation from start_offset to the current position."""
        length = utf16_length(self.text) - start_offset
        if length > 0:
            self.styles.append(f"{start_offset}:{length}:{style}")

    def walk_nodes(self, nodes: list[dict]) -> None:
        """Walk a list of AST nodes."""
        for node in nodes:
            self._walk_node(node)

    def _walk_node(self, node: dict) -> None:
        node_type = node["type"]

        if node_type == "paragraph":
            self._handle_paragraph(node)
        elif node_type == "heading":
            self._handle_heading(node)
        elif node_type == "strong":
            self._handle_styled_inline(node, "BOLD")
        elif node_type == "emphasis":
            self._handle_styled_inline(node, "ITALIC")
        elif node_type == "strikethrough":
            self._handle_styled_inline(node, "STRIKETHROUGH")
        elif node_type == "codespan":
            self._handle_codespan(node)
        elif node_type == "block_code":
            self._handle_block_code(node)
        elif node_type == "text":
            self._append(node["raw"])
        elif node_type == "softbreak":
            self._append("\n")
        elif node_type == "linebreak":
            self._append("\n")
        elif node_type == "link":
            self._handle_link(node)
        elif node_type == "image":
            self._handle_image(node)
        elif node_type == "list":
            self._handle_list(node)
        elif node_type == "block_quote":
            self._handle_block_quote(node)
        elif node_type == "thematic_break":
            self._handle_thematic_break()
        elif node_type == "blank_line":
            pass
        else:
            # Fall back to walking children for unknown block types.
            children = node.get("children")
            if children:
                self.walk_nodes(children)

    def _handle_paragraph(self, node: dict) -> None:
        # Ensure paragraphs are separated by a blank line from prior content.
        if self.text and not self.text.endswith("\n\n"):
            if self.text.endswith("\n"):
                self._append("\n")
            else:
                self._append("\n\n")
        self.walk_nodes(node["children"])
        self._append("\n\n")

    def _handle_heading(self, node: dict) -> None:
        if self.text and not self.text.endswith("\n\n"):
            if self.text.endswith("\n"):
                self._append("\n")
            else:
                self._append("\n\n")
        start = self._utf16_offset()
        self.walk_nodes(node["children"])
        self._apply_style("BOLD", start)
        self._append("\n\n")

    def _handle_styled_inline(self, node: dict, style: str) -> None:
        start = self._utf16_offset()
        self.walk_nodes(node["children"])
        self._apply_style(style, start)

    def _handle_codespan(self, node: dict) -> None:
        start = self._utf16_offset()
        self._append(node["raw"])
        self._apply_style("MONOSPACE", start)

    def _handle_block_code(self, node: dict) -> None:
        if self.text and not self.text.endswith("\n\n"):
            if self.text.endswith("\n"):
                self._append("\n")
            else:
                self._append("\n\n")
        start = self._utf16_offset()
        # Strip trailing newline that mistune appends to block code raw content.
        self._append(node["raw"].rstrip("\n"))
        self._apply_style("MONOSPACE", start)
        self._append("\n\n")

    def _handle_link(self, node: dict) -> None:
        url = node["attrs"]["url"]
        # Collect the link text by temporarily diverting output.
        saved_text = self.text
        saved_styles = self.styles
        self.text = ""
        self.styles = []
        self.walk_nodes(node["children"])
        link_text = self.text
        self.text = saved_text
        self.styles = saved_styles

        if not link_text or link_text == url:
            self._append(url)
        else:
            self._append(f"{link_text} ({url})")

    def _handle_image(self, node: dict) -> None:
        self._append(node["attrs"]["src"])

    def _handle_list(self, node: dict) -> None:
        if self.text and not self.text.endswith("\n\n"):
            if self.text.endswith("\n"):
                self._append("\n")
            else:
                self._append("\n\n")
        ordered = node["attrs"]["ordered"]
        start_index = node["attrs"].get("start", 1) or 1
        for index, item in enumerate(node["children"]):
            if ordered:
                prefix = f"{start_index + index}. "
            else:
                prefix = "- "
            self._append(prefix)
            self._walk_list_item(item)
        self._append("\n")

    def _walk_list_item(self, node: dict) -> None:
        """Walk a list_item node, flattening its content onto one line."""
        children = node.get("children", [])
        for child in children:
            if child["type"] == "paragraph":
                # Inline the paragraph content without the surrounding newlines.
                self.walk_nodes(child["children"])
            elif child["type"] == "list":
                # Nested list: start on a new line with indentation.
                self._append("\n")
                self._handle_nested_list(child)
            else:
                self._walk_node(child)
        self._append("\n")

    def _handle_nested_list(self, node: dict) -> None:
        """Handle a nested list with two-space indentation."""
        ordered = node["attrs"]["ordered"]
        start_index = node["attrs"].get("start", 1) or 1
        for index, item in enumerate(node["children"]):
            if ordered:
                prefix = f"  {start_index + index}. "
            else:
                prefix = "  - "
            self._append(prefix)
            self._walk_list_item(item)

    def _handle_block_quote(self, node: dict) -> None:
        if self.text and not self.text.endswith("\n\n"):
            if self.text.endswith("\n"):
                self._append("\n")
            else:
                self._append("\n\n")
        self.walk_nodes(node["children"])
        if not self.text.endswith("\n\n"):
            if self.text.endswith("\n"):
                self._append("\n")
            else:
                self._append("\n\n")

    def _handle_thematic_break(self) -> None:
        if self.text and not self.text.endswith("\n"):
            self._append("\n")
        self._append("---\n\n")
