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


@pytest.mark.parametrize(
    "markdown, expected",
    [
        ("<user@example.com>", ("<user@example.com>", [])),
        ("Name <user@example.com>", ("Name <user@example.com>", [])),
    ],
    ids=["bare", "after-text"],
)
def test_bracketed_email_is_plain_text(markdown: str, expected: tuple[str, list[str]]) -> None:
    """A bracketed email survives verbatim instead of becoming a mailto link."""
    assert convert_markdown(markdown) == expected


def test_mailto_link_keeps_url() -> None:
    """Explicit mailto links are still rendered as text plus URL."""
    assert convert_markdown("[text](mailto:user@example.com)") == (
        "text (mailto:user@example.com)",
        [],
    )


def test_url_autolink_has_no_brackets() -> None:
    """Autolinked URLs lose their brackets and are not quoted twice."""
    assert convert_markdown("<https://example.com>") == ("https://example.com", [])


@pytest.mark.parametrize(
    "markdown, expected",
    [
        ("Name <foo>", ("Name <foo>", [])),
        ("a <br> b", ("a <br> b", [])),
    ],
    ids=["bare", "between-text"],
)
def test_inline_html_is_plain_text(markdown: str, expected: tuple[str, list[str]]) -> None:
    """Unknown inline HTML tags are passed through verbatim."""
    assert convert_markdown(markdown) == expected


@pytest.mark.parametrize(
    "markdown, expected",
    [
        ("<div>hi</div>\n\nnext", ("<div>hi</div>\n\nnext", [])),
        ("- <div>hi</div>\n- **next**", ("- <div>hi</div>\n- next", ["18:4:BOLD"])),
    ],
    ids=["block", "list-item"],
)
def test_block_html_is_plain_text(markdown: str, expected: tuple[str, list[str]]) -> None:
    """Block HTML is passed through with paragraph-style blank line separation."""
    assert convert_markdown(markdown) == expected
