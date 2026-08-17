"""Plain text and markers, read off the reference parser's inline AST.

Nothing here recognises inline syntax. ``sdoc.js``'s ``parseInline`` does that —
escapes, code spans, maths, emphasis, links, autolinks, images, citations,
cross-references, colour swatches, copyable spans and all seven marker sigils —
and this module only walks the nodes it returns. That division is the point: a
hand-written Python re-implementation of the inline grammar is the same defect
as a hand-written block parser, one level down, and it fails the same way. The
one it replaced knew four of the six markers the specification lists and none of
the seventh the parser actually supports, so ``{^weak^}``, ``{=estimated=}`` and
``{~highlighted~}`` came back with their delimiters attached, reading as content.

Two reductions are offered, and they are reductions — the AST itself is the
lossless form, and :func:`sdoc.reference.parse_inline` returns it.

:func:`plain_text`
    Comparable prose. Delimiters go, content stays.

:func:`markers`
    Every ``{+…+}``-style marker as a ``(sigil, body)`` pair, for callers that
    read a status off a cell or a paragraph.
"""

from __future__ import annotations

from typing import Any

from sdoc.reference import parse_inline

__all__ = [
    "KNOWN_INLINE_TYPES",
    "MARKER_SIGILS",
    "markers",
    "markers_of",
    "plain_text",
    "plain_text_of",
]

#: Marker node type -> the sigil written in the source. The reference parser
#: names the marker kinds; this is the one place the names are turned back into
#: the characters an author typed, so a caller can ask "is this row
#: ``{?caution?}``" without matching on either. Seven, not the six the
#: specification lists: ``{~…~}`` is implemented and used, and a reader that
#: knows six of seven is the reader this replaced.
MARKER_SIGILS: dict[str, str] = {
    "mark_positive": "+",
    "mark_neutral": "=",
    "mark_note": "^",
    "mark_caution": "?",
    "mark_warning": "!",
    "mark_negative": "-",
    "mark_highlight": "~",
}

#: Inline nodes whose whole text is a ``value`` string, kept verbatim. A code
#: span's content is its text; so is a maths expression's, a copyable span's,
#: and a colour swatch's (``#1a73e8`` reads as itself).
_VALUE_NODES = frozenset(
    {"text", "code", "math_inline", "math_display", "copyable", "color_swatch"}
)

#: Inline nodes that are a wrapper around children. A link is here too: link
#: text survives, the target does not.
_CONTAINER_NODES = frozenset({"strong", "em", "strike", "link", *MARKER_SIGILS})

#: Every inline node type :func:`plain_text_of` reduces deliberately. A type
#: outside this set hits the fallback in :func:`_join`, which keeps the node's
#: text but knows nothing about it. ``test_binding.py`` asserts the reference
#: parser emits nothing outside this set, so that a new inline construct in
#: ``sdoc.js`` shows up as a failing test here rather than as prose that quietly
#: reads slightly wrong.
KNOWN_INLINE_TYPES = frozenset(
    _VALUE_NODES | _CONTAINER_NODES | {"image", "ref", "citation_ref"}
)


def plain_text_of(nodes: list[dict[str, Any]]) -> str:
    """Reduce an inline AST to comparable plain text.

    Delimiters are dropped and content is kept: marker bodies, emphasis,
    code-span and maths content, and link *text* survive; link targets do not.
    Escapes are already resolved by the parser, so ``\\@anchor`` arrives as
    ``@anchor``.

    Three node kinds are not pure content and are reduced deliberately:

    * an ``image`` becomes its alt text, which is what an image contributes to
      prose;
    * a ``ref`` becomes ``@id`` and a ``citation_ref`` becomes ``[@k1, @k2]`` —
      written back the way they were typed, because a cross-reference *is* its
      identifier and a caller that keys on one would lose it otherwise. This is
      serialising a node the parser already recognised, not recognising it.

    Whitespace is collapsed, so a cell written across a fold compares equal to
    the same cell written on one line.
    """
    out = _join(nodes)
    return " ".join(out.split())


def plain_text(text: str) -> str:
    """:func:`plain_text_of` over one raw string.

    Convenience for a single string. Reducing many is cheaper through
    :func:`sdoc.reference.parse_inline` plus :func:`plain_text_of`, which makes
    one round trip for the batch.
    """
    return plain_text_of(parse_inline([text])[0])


def markers_of(nodes: list[dict[str, Any]]) -> tuple[tuple[str, str], ...]:
    """Every marker in an inline AST as ``(sigil, body)``, in source order.

    Nested markers are reported as well as their enclosing one, outermost
    first; bodies are :func:`plain_text_of` of the marker's contents.
    """
    found: list[tuple[str, str]] = []

    def visit(items: list[dict[str, Any]]) -> None:
        for node in items or ():
            sigil = MARKER_SIGILS.get(node.get("type", ""))
            if sigil is not None:
                found.append((sigil, plain_text_of(node.get("children") or [])))
            if node.get("children"):
                visit(node["children"])

    visit(nodes)
    return tuple(found)


def markers(text: str) -> tuple[tuple[str, str], ...]:
    """:func:`markers_of` over one raw string."""
    return markers_of(parse_inline([text])[0])


def _join(nodes: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    for node in nodes or ():
        kind = node.get("type")
        if kind in _VALUE_NODES:
            parts.append(node.get("value") or "")
        elif kind in _CONTAINER_NODES:
            parts.append(_join(node.get("children") or []))
        elif kind == "image":
            parts.append(node.get("alt") or "")
        elif kind == "ref":
            parts.append("@" + (node.get("id") or ""))
        elif kind == "citation_ref":
            parts.append("[" + ", ".join("@" + k for k in node.get("keys") or ()) + "]")
        else:
            # An inline node type this binding has not been taught. Falling back
            # to `value`/`children` keeps its text rather than deleting it — a
            # silently emptied cell is the one outcome worse than an unstyled
            # one. `test_binding.py` asserts the reference emits no type that
            # lands here, so this is a cushion, not a design.
            parts.append(node.get("value") or _join(node.get("children") or []))
    return "".join(parts)
