"""A typed Python view of a document, over the reference parser's AST.

Everything about the *grammar* — what a scope is, where a table ends, how a row
splits into cells, what an inline marker is — comes from ``sdoc.js`` by way of
:mod:`sdoc.reference` and :mod:`sdoc.inline`. This module contains no scanning
and no line-shape regexes. What it does is project the reference AST onto the
three things a document reader usually addresses:

``sections``
    Scopes that have a heading *and* an anchor, because a section is addressed
    by anchor and an unanchored one has no address.

``headings``
    Every scope with a heading, anchored or not, flat and in source order. A
    table's nearest preceding heading is how a caller tells a ``Modifiable
    Parameters`` table from an ``Alternative Rule`` table nested inside it — see
    :meth:`SdocDocument.heading_before`.

``tables``
    Flat, in source order, each tagged with the nearest *anchored* enclosing
    section, and each cell kept twice: ``raw`` exactly as the reference emitted
    it, and ``text`` reduced to comparable prose by the reference's own inline
    parser.

The projection is deliberately partial. Anything it does not surface is still
reachable through :func:`sdoc.reference.parse_documents`, which hands back the
reference parser's own nodes — otherwise the next thing a consumer needs from
the format becomes a reason to write a parser again.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from sdoc.inline import plain_text
from sdoc.reference import parse_documents, parse_inline

__all__ = [
    "SdocCell",
    "SdocDiagnostic",
    "SdocDocument",
    "SdocHeading",
    "SdocParseError",
    "SdocSection",
    "SdocTable",
    "parse_sdoc",
    "parse_sdoc_documents",
]


class SdocParseError(ValueError):
    """The document does not have the structure this reader requires.

    Raised rather than tolerated. A file that stops parsing must be loud:
    silently yielding a shorter table is the failure mode this whole area exists
    to rule out.
    """


@dataclass(frozen=True)
class SdocCell:
    """One table cell, kept both as written and as plain text."""

    raw: str
    text: str

    @classmethod
    def of(cls, raw: str) -> SdocCell:
        return cls(raw=raw, text=plain_text(raw))

    def __str__(self) -> str:
        return self.text


@dataclass(frozen=True)
class SdocDiagnostic:
    """A recoverable complaint the reference parser made about a document.

    The reference parser recovers and carries on. This model does not swallow
    that: diagnostics are attached to the document so a caller can refuse a
    document that has any. A recovered parse is where a table quietly goes
    missing.
    """

    message: str
    line: int | None


@dataclass(frozen=True)
class SdocSection:
    """A scope with a heading and an anchor."""

    title: str
    anchor: str
    #: Anchors from the outermost enclosing anchored section inwards, ending in
    #: `anchor`. Unanchored intermediate scopes are not in the path — they have
    #: no address to name.
    path: tuple[str, ...]
    line: int
    line_end: int
    #: Prose belonging directly to this section: source lines that are not
    #: inside a table, a code block or a nested *anchored* section. Kept raw;
    #: use `sdoc.inline.plain_text` or `sdoc.inline.markers`.
    prose: str

    @property
    def parent_anchor(self) -> str | None:
        return self.path[-2] if len(self.path) > 1 else None


@dataclass(frozen=True)
class SdocHeading:
    """Any scope carrying a heading, anchored or not, in source order."""

    title: str
    anchor: str | None
    line: int
    line_end: int


@dataclass(frozen=True)
class SdocTable:
    """A table block, with its position in the section tree."""

    header: tuple[str, ...]
    header_raw: tuple[str, ...]
    rows: tuple[tuple[SdocCell, ...], ...]
    #: 1-based source line of each row in `rows`, same length and order.
    row_lines: tuple[int, ...]
    #: True for a `{[table headerless]`, whose first line is data. `header` is
    #: then empty, and every schema lookup keyed on it will miss — loudly.
    headerless: bool
    line: int
    line_end: int
    section_anchor: str
    section_title: str
    section_path: tuple[str, ...]
    source: str

    def column(self, name: str) -> int:
        """Index of the header cell equal to ``name``.

        Raises rather than returning -1: a caller that asks for a column by name
        and gets a wrong index writes the wrong field into every row.
        """
        try:
            return self.header.index(name)
        except ValueError:
            raise SdocParseError(
                f"{self.source}:{self.line}: table has no column {name!r}; "
                f"header is {list(self.header)}"
            ) from None


@dataclass(frozen=True)
class SdocDocument:
    path: Path
    name: str
    sections: tuple[SdocSection, ...]
    tables: tuple[SdocTable, ...]
    sections_by_anchor: dict[str, SdocSection] = field(default_factory=dict)
    #: Every heading in source order, anchored or not.
    headings: tuple[SdocHeading, ...] = ()
    #: What the reference parser complained about while recovering.
    diagnostics: tuple[SdocDiagnostic, ...] = ()

    def heading_before(self, line: int) -> SdocHeading | None:
        """The nearest heading opening at or before ``line``, or None.

        "Nearest" and not "nearest enclosing": a table whose immediately
        preceding heading is a *sibling* subsection is not inside the earlier
        one, which is exactly the discrimination a caller wants. Asking for the
        nearest enclosing heading instead would report the outer section for
        every table in the file.
        """
        found: SdocHeading | None = None
        for heading in self.headings:
            if heading.line <= line:
                found = heading
            else:
                break
        return found

    def section(self, anchor: str) -> SdocSection:
        section = self.sections_by_anchor.get(anchor)
        if section is None:
            raise SdocParseError(f"{self.name}: no section @{anchor}")
        return section

    def tables_in(self, anchor: str) -> tuple[SdocTable, ...]:
        """Tables whose nearest anchored enclosing section is ``anchor``.

        Tables in a *nested anchored* section belong to that section, not this
        one. Tables in an unanchored subsection belong here, because an
        unanchored scope is not an address.
        """
        return tuple(t for t in self.tables if t.section_anchor == anchor)


# --------------------------------------------------------------------------
# Projection from the reference AST
# --------------------------------------------------------------------------

#: Node types whose source lines are not prose. Nested anchored sections are
#: excluded separately, because whether a scope counts depends on its anchor.
_NOT_PROSE = frozenset({"table", "code"})


def parse_sdoc(path: Path | str) -> SdocDocument:
    """Parse one sdoc file with the reference parser."""
    resolved = Path(path)
    return parse_sdoc_documents([resolved])[resolved]


def parse_sdoc_documents(paths: list[Path]) -> dict[Path, SdocDocument]:
    """Parse several files in one batch.

    Keyed by the paths as given, so a caller can look results up with the same
    object it passed in.
    """
    raw = parse_documents(list(paths))
    # Inline-parse every cell in the batch in one round trip, so the per-cell
    # `plain_text` calls below are cache hits. Without this a document with a
    # thousand cells is a thousand round trips, and the honest implementation
    # loses to the hand-written one on speed alone — which is how repositories
    # end up with hand-written ones.
    parse_inline(sorted({text for payload in raw.values() for text in _cell_texts(payload)}))
    return {
        given: _build(path=Path(given), payload=raw[Path(given).resolve()])
        for given in paths
    }


def _cell_texts(payload: dict[str, Any]) -> set[str]:
    """Every table header and cell string in a parsed document."""
    found: set[str] = set()

    def visit(nodes: list[dict[str, Any]]) -> None:
        for node in nodes or ():
            if node.get("type") == "table":
                found.update(node.get("headers") or ())
                for row in node.get("rows") or ():
                    found.update(row)
            for key in ("children", "items"):
                if node.get(key):
                    visit(node[key])

    visit(payload.get("nodes") or [])
    return found


def _build(*, path: Path, payload: dict[str, Any]) -> SdocDocument:
    if "error" in payload:
        raise SdocParseError(f"{path.name}: {payload['error']}")

    lines = path.read_text(encoding="utf-8").split("\n")
    name = path.name

    sections: list[SdocSection] = []
    headings: list[SdocHeading] = []
    tables: list[SdocTable] = []

    def visit(nodes: list[dict[str, Any]], anchors: tuple[str, ...], title: str) -> None:
        for node in nodes or ():
            kind = node.get("type")
            if kind == "table":
                tables.append(
                    _table(
                        node=node,
                        source=name,
                        anchors=anchors,
                        section_title=title,
                    )
                )
                continue
            if kind != "scope":
                # Lists, blockquotes and callouts can hold tables; scopes inside
                # them are list ITEMS, not headings, so recursion continues but
                # `items` is never treated as a heading tree.
                for key in ("children", "items"):
                    if node.get(key):
                        visit(node[key], anchors, title)
                continue

            anchor = node.get("id") or ""
            if node.get("hasHeading"):
                headings.append(
                    SdocHeading(
                        title=node.get("title", ""),
                        anchor=anchor or None,
                        line=node["lineStart"],
                        line_end=node["lineEnd"],
                    )
                )
            if node.get("hasHeading") and anchor:
                sections.append(
                    SdocSection(
                        title=node.get("title", ""),
                        anchor=anchor,
                        path=anchors + (anchor,),
                        line=node["lineStart"],
                        line_end=node["lineEnd"],
                        prose=_prose(lines=lines, node=node),
                    )
                )
                visit(node.get("children"), anchors + (anchor,), node.get("title", ""))
            else:
                # An unanchored scope — `# Scope {`, a `{= … =}` callout, the
                # `@meta` block — is transparent: what it contains still belongs
                # to the nearest anchored section.
                visit(node.get("children"), anchors, title)

    visit(payload.get("nodes") or [], (), "")

    sections.sort(key=lambda s: s.line)
    headings.sort(key=lambda h: h.line)
    tables.sort(key=lambda t: t.line)

    by_anchor: dict[str, SdocSection] = {}
    for section in sections:
        if section.anchor in by_anchor:
            raise SdocParseError(
                f"{name}:{section.line}: duplicate section anchor @{section.anchor} "
                f"(first at line {by_anchor[section.anchor].line})"
            )
        by_anchor[section.anchor] = section

    return SdocDocument(
        path=path,
        name=name,
        sections=tuple(sections),
        tables=tuple(tables),
        sections_by_anchor=by_anchor,
        headings=tuple(headings),
        diagnostics=tuple(
            SdocDiagnostic(message=str(d.get("message", d)), line=d.get("line"))
            for d in payload.get("errors") or ()
        ),
    )


def _table(
    *,
    node: dict[str, Any],
    source: str,
    anchors: tuple[str, ...],
    section_title: str,
) -> SdocTable:
    header_raw = tuple(node.get("headers") or ())
    rows = tuple(tuple(SdocCell.of(cell) for cell in row) for row in node.get("rows") or ())
    row_lines = tuple(node.get("rowLines") or ())
    if len(row_lines) != len(rows):
        # A cushion, not a gate: the worker refuses to guess, so it never
        # returns a short list. Kept because if it ever did, a `zip` downstream
        # would drop rows silently, and a short table is the one failure this
        # whole area exists to rule out.
        raise SdocParseError(
            f"{source}:{node['lineStart']}: the reference bridge returned "
            f"{len(row_lines)} row lines for {len(rows)} rows"
        )
    return SdocTable(
        header=tuple(plain_text(cell) for cell in header_raw),
        header_raw=header_raw,
        rows=rows,
        row_lines=row_lines,
        headerless=bool((node.get("options") or {}).get("headerless")),
        line=node["lineStart"],
        line_end=node["lineEnd"],
        section_anchor=anchors[-1] if anchors else "",
        section_title=section_title,
        section_path=anchors,
        source=source,
    )


def _prose(*, lines: list[str], node: dict[str, Any]) -> str:
    """Source lines directly inside a scope, minus its structured children.

    Kept as a filtered slice of the source rather than a re-rendering, because
    the callers that read it are looking for markers — "is this section declared
    dormant?" — and want the text as written. Tables, code blocks and nested
    anchored sections are cut out; unanchored scopes and lists are left in,
    because their text belongs to this section.
    """
    excluded: list[tuple[int, int]] = []

    def collect(children: list[dict[str, Any]]) -> None:
        for child in children or ():
            kind = child.get("type")
            if kind in _NOT_PROSE:
                excluded.append((child["lineStart"], child["lineEnd"]))
                continue
            if kind == "scope" and child.get("hasHeading") and child.get("id"):
                excluded.append((child["lineStart"], child["lineEnd"]))
                continue
            if kind == "scope":
                collect(child.get("children") or [])
            elif child.get("children"):
                collect(child["children"])

    collect(node.get("children") or [])

    start, end = node["lineStart"] + 1, min(node["lineEnd"], len(lines))
    kept = [
        lines[number - 1]
        for number in range(start, end)
        if not any(low <= number <= high for low, high in excluded)
        and lines[number - 1].strip() != "}"
    ]
    return "\n".join(kept).strip()
