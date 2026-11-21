"""Tests for markdown_to_signal.convert_markdown.

These need the real mistune package, so the whole module is skipped when it is
unavailable (or when another test module has stubbed it out).
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))

mistune = pytest.importorskip("mistune")

if not hasattr(mistune, "create_markdown"):
    pytest.skip("real mistune is not installed", allow_module_level=True)

from markdown_to_signal import convert_markdown  # noqa: E402


def test_bracketed_email_is_plain_text() -> None:
    """A bracketed email survives verbatim instead of becoming a mailto link."""
    assert convert_markdown("<user@example.com>") == ("<user@example.com>", [])


def test_bracketed_email_after_text_is_plain_text() -> None:
    """A bracketed email keeps its surrounding text intact."""
    assert convert_markdown("Name <user@example.com>") == ("Name <user@example.com>", [])


def test_mailto_link_keeps_url() -> None:
    """Explicit mailto links are still rendered as text plus URL."""
    assert convert_markdown("[text](mailto:user@example.com)") == (
        "text (mailto:user@example.com)",
        [],
    )


def test_url_autolink_has_no_brackets() -> None:
    """Autolinked URLs lose their brackets and are not quoted twice."""
    assert convert_markdown("<https://example.com>") == ("https://example.com", [])


def test_inline_html_is_plain_text() -> None:
    """Unknown inline HTML tags are passed through verbatim."""
    assert convert_markdown("Name <foo>") == ("Name <foo>", [])


def test_inline_html_between_text_is_plain_text() -> None:
    """Inline HTML stays in place between the surrounding text."""
    assert convert_markdown("a <br> b") == ("a <br> b", [])


def test_block_html_is_plain_text() -> None:
    """Block HTML is passed through with paragraph-style blank line separation."""
    assert convert_markdown("<div>hi</div>\n\nnext") == ("<div>hi</div>\n\nnext", [])


def test_block_html_list_item_keeps_marker() -> None:
    """A list item starting with block HTML keeps its marker and surrounding layout."""
    assert convert_markdown("- <div>hi</div>\n- **next**") == (
        "- <div>hi</div>\n- next",
        ["18:4:BOLD"],
    )
