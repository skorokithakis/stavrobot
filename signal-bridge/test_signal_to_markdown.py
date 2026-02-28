"""Tests for signal_to_markdown.convert_signal_to_markdown."""

import sys
import os

# Allow importing from the signal-bridge directory without installing.
sys.path.insert(0, os.path.dirname(__file__))

# Stub out mistune so markdown_to_signal can be imported without the package.
import types

mistune_stub = types.ModuleType("mistune")
sys.modules.setdefault("mistune", mistune_stub)

from signal_to_markdown import convert_signal_to_markdown  # noqa: E402


def test_empty_formatting_returns_text_unchanged() -> None:
    """No formatting annotations leaves the text as-is."""
    assert convert_signal_to_markdown("hello", []) == "hello"


def test_bold() -> None:
    """BOLD annotation wraps the span in **...**."""
    result = convert_signal_to_markdown("hello world", [{"start": 0, "length": 5, "style": "BOLD"}])
    assert result == "**hello** world"


def test_italic() -> None:
    """ITALIC annotation wraps the span in _..._."""
    result = convert_signal_to_markdown("hello world", [{"start": 6, "length": 5, "style": "ITALIC"}])
    assert result == "hello _world_"


def test_strikethrough() -> None:
    """STRIKETHROUGH annotation wraps the span in ~~...~~."""
    result = convert_signal_to_markdown("delete me", [{"start": 0, "length": 9, "style": "STRIKETHROUGH"}])
    assert result == "~~delete me~~"


def test_monospace() -> None:
    """MONOSPACE annotation wraps the span in backticks."""
    result = convert_signal_to_markdown("run ls -la now", [{"start": 4, "length": 6, "style": "MONOSPACE"}])
    assert result == "run `ls -la` now"


def test_spoiler() -> None:
    """SPOILER annotation wraps the span in <spoiler>...</spoiler>."""
    result = convert_signal_to_markdown("secret text here", [{"start": 0, "length": 11, "style": "SPOILER"}])
    assert result == "<spoiler>secret text</spoiler> here"


def test_unknown_style_is_ignored() -> None:
    """An unrecognised style name is silently skipped."""
    result = convert_signal_to_markdown("hello", [{"start": 0, "length": 5, "style": "UNDERLINE"}])
    assert result == "hello"


def test_adjacent_annotations() -> None:
    """Two adjacent annotations produce separate markers without bleeding."""
    formatting = [
        {"start": 0, "length": 5, "style": "BOLD"},
        {"start": 5, "length": 5, "style": "ITALIC"},
    ]
    result = convert_signal_to_markdown("helloworld", formatting)
    assert result == "**hello**_world_"


def test_overlapping_annotations() -> None:
    """Overlapping annotations both insert their markers at the correct positions."""
    # "hello world": BOLD covers 0-7 ("hello w"), ITALIC covers 6-11 ("world")
    formatting = [
        {"start": 0, "length": 7, "style": "BOLD"},
        {"start": 6, "length": 5, "style": "ITALIC"},
    ]
    result = convert_signal_to_markdown("hello world", formatting)
    assert result == "**hello _w**orld_"


def test_multibyte_utf16_character() -> None:
    """Emoji (U+1F600) counts as 2 UTF-16 code units; offsets must be handled correctly."""
    # Text: "A😀B" — the emoji is at Python index 1 but UTF-16 offset 1..3.
    # Annotate the emoji only: start=1, length=2.
    text = "A\U0001f600B"
    formatting = [{"start": 1, "length": 2, "style": "BOLD"}]
    result = convert_signal_to_markdown(text, formatting)
    assert result == "A**\U0001f600**B"


def test_annotation_spanning_multibyte_characters() -> None:
    """Annotation that starts after a surrogate-pair character uses the right index."""
    # Text: "😀X" — emoji at UTF-16 offset 0 (length 2), X at UTF-16 offset 2.
    # Annotate X: start=2, length=1.
    text = "\U0001f600X"
    formatting = [{"start": 2, "length": 1, "style": "ITALIC"}]
    result = convert_signal_to_markdown(text, formatting)
    assert result == "\U0001f600_X_"


def test_whole_string_annotation() -> None:
    """An annotation covering the entire string wraps it completely."""
    text = "all bold"
    formatting = [{"start": 0, "length": 8, "style": "BOLD"}]
    result = convert_signal_to_markdown(text, formatting)
    assert result == "**all bold**"


def test_multiple_non_overlapping_annotations() -> None:
    """Multiple non-overlapping annotations are each applied independently."""
    text = "foo bar baz"
    formatting = [
        {"start": 0, "length": 3, "style": "BOLD"},
        {"start": 8, "length": 3, "style": "ITALIC"},
    ]
    result = convert_signal_to_markdown(text, formatting)
    assert result == "**foo** bar _baz_"


if __name__ == "__main__":
    import unittest

    # Run all test_ functions defined in this module.
    test_functions = [
        value
        for name, value in globals().items()
        if name.startswith("test_") and callable(value)
    ]
    failures = 0
    for test_function in test_functions:
        try:
            test_function()
            print(f"PASS: {test_function.__name__}")
        except AssertionError as error:
            print(f"FAIL: {test_function.__name__}: {error}")
            failures += 1
    if failures:
        sys.exit(1)
    print(f"\nAll {len(test_functions)} tests passed.")
