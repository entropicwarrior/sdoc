#!/usr/bin/env python3
"""Tests for the Python binding.

Plain script with assert helpers and a non-zero exit, like `test/test-all.js` —
this repository has no test framework and the binding does not add one.

    python3 bindings/python/test/test_binding.py

Four things have to hold, and nothing else checks them.

**The reference must be reachable, and its absence must be loud.** The binding's
whole reason to exist is that it calls `src/sdoc.js` instead of reimplementing
it. A missing node, a missing parser file or a parser from a different version
of the format must each raise, because a reader that quietly does less has
verified nothing while looking green.

**An installed copy must work, not just this checkout.** Everything else here
runs from a source tree, which is the one layout in which `sdoc.js` is a symlink
and in which a path resolved by counting parent directories is right. So the
wheel is built and the binding is run out of it.

**The shapes a hand-written parser gets wrong must stay right.** Every case in
`fixtures/regressions.sdoc` was read wrongly by the Python parser this binding
replaced. They are regression tests in the literal sense.

**Inline markup must come from the reference too.** `plain_text` and `markers`
walk `parseInline`'s nodes and recognise nothing themselves. The gate that keeps
that honest is the one asserting the reference emits no inline node type this
module has not been taught.
"""

from __future__ import annotations

import functools
import importlib.util
import os
import subprocess
import sys
import zipfile
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PROJECT = _HERE.parent
_REPO = _PROJECT.parent.parent
sys.path.insert(0, str(_PROJECT / "src"))

from sdoc import (  # noqa: E402
    MARKER_SIGILS,
    NODE_ENV_VAR,
    SDOC_FORMAT_VERSION,
    SDOC_JS_ENV_VAR,
    NodeUnavailableError,
    SdocReferenceError,
    markers,
    node_executable,
    parse_documents,
    parse_inline,
    parse_sdoc,
    parse_sdoc_documents,
    plain_text,
)
from sdoc import reference as reference_module  # noqa: E402
from sdoc.inline import KNOWN_INLINE_TYPES, plain_text_of  # noqa: E402

_FIXTURE = _HERE / "fixtures" / "regressions.sdoc"

_passed = 0
_failed = 0


def test(name, fn):
    global _passed, _failed
    try:
        fn()
        _passed += 1
        print("  PASS: " + name)
    except Exception as error:  # noqa: BLE001 - a test runner reports, it does not raise
        _failed += 1
        print("  FAIL: " + name + " — " + str(error))


def assert_(condition, message="assertion failed"):
    if not condition:
        raise AssertionError(message)


def assert_eq(actual, expected, message=""):
    if actual != expected:
        raise AssertionError(f"{message}expected {expected!r}, got {actual!r}")


def assert_raises(exception_type, fn, *, containing=()):
    try:
        fn()
    except exception_type as raised:
        for fragment in containing:
            assert_(
                fragment in str(raised),
                f"the {exception_type.__name__} does not mention {fragment!r}: {raised}",
            )
        return
    raise AssertionError(f"expected {exception_type.__name__}, nothing was raised")


def repo_documents():
    return sorted(
        path
        for path in _REPO.rglob("*.sdoc")
        if "node_modules" not in path.parts and ".git" not in path.parts
    )


# ============================================================
print("--- The reference is reachable and its absence is loud ---")


def _running_format_version():
    completed = subprocess.run(
        [
            node_executable(),
            "-e",
            "process.stdout.write(require(process.argv[1]).SDOC_FORMAT_VERSION)",
            str(reference_module.reference_sdoc_js()),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return completed.stdout.strip()


test("the parser that runs declares the format version the binding is pinned to", lambda: (
    assert_eq(_running_format_version(), SDOC_FORMAT_VERSION)
))


def _worker_and_binding_agree():
    worker = (Path(reference_module.__file__).parent / "bridge.js").read_text()
    expected = ", ".join(f'"{part}"' for part in reference_module.REFERENCE_RELATIVE_PATH)
    assert_(
        f"path.join(__dirname, {expected})" in worker,
        "bridge.js does not resolve the parser as __dirname + "
        f"{list(reference_module.REFERENCE_RELATIVE_PATH)}, which is where "
        "reference.REFERENCE_RELATIVE_PATH says it is. Run without SDOC_JS set "
        "— which is how it runs installed — the worker would load a different "
        "file, or none.",
    )


test("the worker and the binding name the same parser", _worker_and_binding_agree)


def _handshake_rejects_another_format_version():
    # A parser that answers, and declares a version this binding was not
    # written against. It must be refused rather than read as if it were this
    # version — reading v0.3 documents under v0.2's rules is the silent
    # failure the handshake exists to prevent.
    other = _HERE / "_tmp_other_version.js"
    other.write_text(
        'module.exports = { SDOC_FORMAT_VERSION: "9.9", '
        "parseSdoc: () => ({ nodes: [], errors: [] }), parseInline: () => [] };\n"
    )
    reference_module.shutdown()
    os.environ[SDOC_JS_ENV_VAR] = str(other)
    try:
        assert_raises(
            SdocReferenceError,
            lambda: parse_inline(["anything"]),
            containing=("9.9", SDOC_FORMAT_VERSION),
        )
    finally:
        os.environ.pop(SDOC_JS_ENV_VAR, None)
        other.unlink()
        reference_module.shutdown()


test("a parser declaring another format version is refused", _handshake_rejects_another_format_version)


def _missing_parser_file_raises():
    reference_module.shutdown()
    os.environ[SDOC_JS_ENV_VAR] = str(_HERE / "no-such-parser.js")
    try:
        assert_raises(
            SdocReferenceError,
            lambda: parse_inline(["anything"]),
            containing=("no-such-parser.js", SDOC_JS_ENV_VAR),
        )
    finally:
        os.environ.pop(SDOC_JS_ENV_VAR, None)
        reference_module.shutdown()


test("a parser file that is not there raises", _missing_parser_file_raises)


def _missing_node_raises():
    saved_path = os.environ.get("PATH")
    saved_node = os.environ.pop(NODE_ENV_VAR, None)
    os.environ["PATH"] = str(_HERE / "no-such-directory")
    try:
        assert_raises(
            NodeUnavailableError,
            node_executable,
            containing=("not a skip", "brew install node", "apt install nodejs", NODE_ENV_VAR),
        )
    finally:
        if saved_path is not None:
            os.environ["PATH"] = saved_path
        if saved_node is not None:
            os.environ[NODE_ENV_VAR] = saved_node


test("a missing node raises rather than skipping, and says what to install", _missing_node_raises)


def _bogus_node_override_raises():
    saved = os.environ.get(NODE_ENV_VAR)
    os.environ[NODE_ENV_VAR] = str(_HERE / "no-such-node")
    try:
        # A named location is authoritative. Falling back to a node found on the
        # PATH would run against a toolchain nobody asked for.
        assert_raises(NodeUnavailableError, node_executable)
    finally:
        os.environ.pop(NODE_ENV_VAR, None)
        if saved is not None:
            os.environ[NODE_ENV_VAR] = saved


test("an override pointing at no node raises rather than falling back", _bogus_node_override_raises)


def _a_worker_that_dies_is_a_broken_toolchain():
    # A parser that loads and then throws: the worker exits, and the binding
    # reads end-of-stream where a reply should be. It must say the toolchain is
    # broken and hand back what the worker said on the way out. Answering
    # "nothing" instead would look exactly like a document with no content.
    exploding = _HERE / "_tmp_exploding.js"
    exploding.write_text('throw new Error("detonated on require");\n')
    reference_module.shutdown()
    os.environ[SDOC_JS_ENV_VAR] = str(exploding)
    try:
        assert_raises(
            SdocReferenceError,
            lambda: parse_inline(["anything"]),
            containing=("broken toolchain", "detonated on require"),
        )
    finally:
        os.environ.pop(SDOC_JS_ENV_VAR, None)
        exploding.unlink()
        reference_module.shutdown()


test("a worker that dies is reported as a broken toolchain, with its stderr", _a_worker_that_dies_is_a_broken_toolchain)


def _worker_restarts_after_shutdown():
    first = plain_text("{+a+}")
    reference_module.shutdown()
    assert_eq(reference_module._WORKER_PROCESS, None)
    reference_module.clear_cache()
    assert_eq(plain_text("{+a+}"), first)


test("the worker restarts after being shut down", _worker_restarts_after_shutdown)


# ============================================================
print("\n--- The shapes a hand-written parser gets wrong ---")


@functools.cache
def fixture():
    """The regression fixture, parsed once.

    Lazy so that a bridge that cannot read it reports as one failing test with
    the reason attached, instead of aborting the run at import and taking every
    later gate's result with it.
    """
    return parse_sdoc(_FIXTURE)


def fixture_table(anchor):
    """The one table whose nearest anchored section is ``anchor``."""
    return {table.section_anchor: table for table in fixture().tables}[anchor]


test("the fixture parses with no recovery at all", lambda: (
    assert_eq(fixture().diagnostics, (), "the reference had to recover: ")
))

test("a row with fewer cells than the header is accepted", lambda: (
    assert_eq(fixture_table("short-row").header, ("Property", "Where", "Note")),
    assert_eq(
        [[cell.text for cell in row] for row in fixture_table("short-row").rows],
        [["Contiguous", "spans.py", "it is"], ["Short row", "only two cells"]],
    ),
))


def _directive_row_is_not_data():
    # Two assertions in one because they are one fact: the reference removes the
    # directive row from `rows`, so row-to-line attribution must remove the same
    # line. Getting only half right is worse than getting neither — every
    # citation after the directive row is off by one, and it looks right.
    table = fixture_table("directive-row")
    assert_eq(
        [[cell.text for cell in row] for row in table.rows],
        [["0", "0"], ["0.5", "1.303713"]],
    )
    lines = _FIXTURE.read_text().split("\n")
    assert_eq(lines[table.row_lines[0] - 1].strip(), "0 | 0")
    assert_eq(lines[table.row_lines[1] - 1].strip(), "0.5 | 1.303713")


test("a column directive row is not a data row, and rows keep their true lines", _directive_row_is_not_data)

test("a heading with the brace on the next line is a section", lambda: (
    assert_eq(
        fixture().section("next-line-nested").path,
        ("regressions", "next-line-brace", "next-line-nested"),
    ),
    assert_eq(fixture_table("next-line-nested").header, ("Field", "Type")),
))


def _unanchored_scope_is_transparent():
    table = fixture_table("transparent")
    assert_eq(table.section_path, ("regressions", "transparent"))
    assert_eq(fixture().tables_in("transparent"), (table,))
    heading = fixture().heading_before(table.line)
    # The scope is transparent to section attribution and still visible as a
    # heading. Both halves, because a caller uses each to tell a table in an
    # unanchored subsection from one in a sibling.
    assert_(heading is not None, "no heading before the table")
    assert_eq(heading.title, "Modifiable Parameters")
    assert_eq(heading.anchor, None)


test("an unanchored scope is transparent to section attribution", _unanchored_scope_is_transparent)

test("a scope type annotation is not part of the title", lambda: (
    assert_(
        "Overlap With Homopolymer Rule" in [h.title for h in fixture().headings],
        "the :warning annotation was left in the title: "
        + repr([h.title for h in fixture().headings]),
    )
))

test("an escaped pipe is cell content, unescaped, and not a column break", lambda: (
    assert_eq(
        [cell.raw for cell in fixture_table("escaped-pipes").rows[0]],
        ["`AGTC`", "|2-2| - 0 = 0"],
    )
))


def _headerless_keeps_every_body_line():
    table = fixture_table("headerless")
    assert_eq(table.headerless, True)
    assert_eq(table.header, ())
    assert_eq([[cell.text for cell in row] for row in table.rows], [["a", "b"], ["c", "d"]])
    lines = _FIXTURE.read_text().split("\n")
    assert_eq([lines[n - 1].strip() for n in table.row_lines], ["a | b", "c | d"])


test("a headerless table keeps every body line as a row", _headerless_keeps_every_body_line)


def _column_lookup_refuses_to_guess():
    assert_raises(
        Exception,
        lambda: fixture_table("short-row").column("Nonexistent"),
        containing=("Nonexistent",),
    )
    assert_eq(fixture_table("short-row").column("Where"), 1)


test("asking for a column that is not there raises rather than returning -1", _column_lookup_refuses_to_guess)


def _section_prose_excludes_its_tables():
    # `prose` is what a caller scans for markers. If a table's rows were left in
    # it, every cell of every table would answer marker questions asked of the
    # section — @markers below would report seven statuses it does not have.
    prose = fixture().section("markers").prose
    assert_("All seven sigils" in prose, f"the section's own text is missing: {prose!r}")
    assert_(
        "positive | plus" not in prose,
        f"the table's rows are in the section's prose: {prose!r}",
    )
    assert_eq(markers(prose), ())


test("a section's prose excludes the tables inside it", _section_prose_excludes_its_tables)


def _a_duplicate_anchor_is_refused():
    # Two sections with one address. `section(anchor)` would return whichever
    # happened to be built last, and a caller reading a document by anchor would
    # silently read the wrong half of it.
    scratch = _HERE / "_tmp_duplicate.sdoc"
    try:
        scratch.write_text(
            "# One @same {\n    A.\n}\n# Two @same {\n    B.\n}\n", encoding="utf-8"
        )
        assert_raises(Exception, lambda: parse_sdoc(scratch), containing=("same",))
    finally:
        scratch.unlink(missing_ok=True)


test("two sections with the same anchor are refused, not silently merged", _a_duplicate_anchor_is_refused)


def _cache_notices_a_file_changing():
    # A caller that rewrites a file and re-parses it inside one session — every
    # mutation test does — must be served the mutation, not the cached parse.
    scratch = _HERE / "_tmp_mutable.sdoc"
    try:
        scratch.write_text("# Doc @doc {\n    Text.\n}\n", encoding="utf-8")
        assert_eq(sorted(parse_sdoc(scratch).sections_by_anchor), ["doc"])
        scratch.write_text(
            "# Doc @doc {\n    Text.\n}\n# Two @two {\n    More.\n}\n", encoding="utf-8"
        )
        assert_eq(sorted(parse_sdoc(scratch).sections_by_anchor), ["doc", "two"])
    finally:
        scratch.unlink(missing_ok=True)


test("the parse cache notices a file changing", _cache_notices_a_file_changing)


def _reference_output_is_unflattened():
    # The typed model is a projection; anything it does not surface must still
    # be reachable, or the next thing a consumer needs from the format becomes a
    # reason to write a parser again.
    payload = parse_documents([_FIXTURE])[_FIXTURE.resolve()]
    assert_eq(payload["errors"], [])
    assert_eq(payload["nodes"][0]["type"], "scope")
    assert_(
        any(node.get("id") == "regressions" for node in payload["nodes"]),
        "the reference's own nodes did not come through",
    )


test("parse_documents hands back the reference's own AST", _reference_output_is_unflattened)


# ============================================================
print("\n--- Inline markup comes from the reference too ---")


def _every_sigil_the_reference_implements_is_known():
    # MARKER_SIGILS is a second record of a fact `sdoc.js` already holds, so ask
    # the parser: feed it each sigil and check it names the marker type this
    # module maps back to that sigil. A sigil the parser gained and this table
    # lacks would otherwise read as literal text forever.
    written = [f"{{{sigil}body{sigil}}}" for sigil in MARKER_SIGILS.values()]
    for sigil, nodes in zip(MARKER_SIGILS.values(), parse_inline(written)):
        assert_eq(len(nodes), 1, f"{sigil} did not parse to one node: ")
        assert_eq(
            MARKER_SIGILS.get(nodes[0]["type"]),
            sigil,
            f"the reference calls {{{sigil}…{sigil}}} a {nodes[0]['type']!r}: ",
        )


test("every sigil in MARKER_SIGILS is the marker the reference says it is", _every_sigil_the_reference_implements_is_known)

test("every marker the reference implements is stripped, all seven", lambda: (
    assert_eq(
        plain_text("{+good+} {=neutral=} {^note^} {?caution?} {!warning!} {-bad-} {~highlight~}"),
        "good neutral note caution warning bad highlight",
    )
))

test("markers are read off the reference, sigil and body", lambda: (
    assert_eq(
        markers("state {?Dormant: pending a ruling?} and {+shipped+}"),
        (("?", "Dormant: pending a ruling"), ("+", "shipped")),
    )
))

test("every sigil is reported by markers, all seven", lambda: (
    assert_eq(
        markers("{+a+} {=b=} {^c^} {?d?} {!e!} {-f-} {~g~}"),
        (("+", "a"), ("=", "b"), ("^", "c"), ("?", "d"), ("!", "e"), ("-", "f"), ("~", "g")),
    )
))

test("a marker inside a marker is reported as well as the one around it", lambda: (
    assert_eq(
        markers("{?open, {+resolved+} in part?}"),
        (("?", "open, resolved in part"), ("+", "resolved")),
    )
))

test("a marker body keeps its own markup reduced, not raw", lambda: (
    assert_eq(markers("{?see `spans.py` and [the note](x.sdoc)?}"), (("?", "see spans.py and the note"),))
))

test("link text survives and the target does not", lambda: (
    assert_eq(plain_text("see [the spec](lexica/specification.sdoc) for more"), "see the spec for more")
))

test("an escape is resolved by the parser, not left as a backslash", lambda: (
    assert_eq(plain_text(r"\@anchor and \*not emphasis\*"), "@anchor and *not emphasis*")
))

test("a cross-reference keeps its identifier", lambda: (
    assert_eq(plain_text("defined at @table-options above"), "defined at @table-options above")
))

test("code, maths and emphasis lose their delimiters and keep their content", lambda: (
    assert_eq(plain_text("`AGTC` is $N^2$ **fast** and *neat* and ~~gone~~"), "AGTC is N^2 fast and neat and gone")
))

test("whitespace is collapsed so a folded cell compares equal to a flat one", lambda: (
    assert_eq(plain_text("two   spaces\tand a tab"), "two spaces and a tab")
))


def _no_inline_type_falls_through():
    # The one gate that keeps this module honest as `sdoc.js` grows. Every
    # inline construct the specification lists, plus every string in every
    # document in the repository: if the reference emits a node type
    # `plain_text_of` has not been taught, it lands in the fallback, which keeps
    # the text but knows nothing about it — an image would contribute its URL,
    # a future construct its delimiters. Better a failing test than prose that
    # quietly reads slightly wrong.
    zoo = [
        "plain text",
        "`code span` and ``",
        "$x^2$ and $$E = mc^2$$",
        "**strong** *em* ~~strike~~",
        "{+p+}{=n+=}{^o^}{?c?}{!w!}{-m-}{~h~}",
        "[label](target.sdoc) and <https://example.com> and https://example.com/x",
        "![alt text](image.png =50% center)",
        "[@smith2020] and [@a, @b]",
        "@anchor-name",
        "#1a73e8 swatch",
        "{copy}literal{/copy}",
        "person@example.com",
        "mailto:person@example.com",
        r"\@escaped \| \* \$ \`",
    ]
    for path, document in parse_sdoc_documents(repo_documents()).items():
        for table in document.tables:
            zoo.extend(table.header_raw)
            zoo.extend(cell.raw for row in table.rows for cell in row)
        zoo.extend(heading.title for heading in document.headings)
        zoo.extend(section.prose for section in document.sections)

    seen = set()

    def walk(nodes):
        for node in nodes:
            seen.add(node["type"])
            if node.get("children"):
                walk(node["children"])

    for nodes in parse_inline(zoo):
        walk(nodes)

    unknown = sorted(seen - KNOWN_INLINE_TYPES)
    assert_(
        not unknown,
        f"the reference parser emits inline node types this binding does not "
        f"reduce: {unknown}. sdoc.js has grown a construct; teach "
        "sdoc/inline.py what it means and add it to KNOWN_INLINE_TYPES.",
    )
    # And the reverse: nothing is claimed that was never seen, so the set cannot
    # silently accumulate types the format dropped.
    assert_(
        len(seen) > 15,
        f"only {len(seen)} inline node types were produced; the zoo is not "
        "exercising the grammar and this gate is checking nothing.",
    )


test("no inline node type the reference emits falls through unreduced", _no_inline_type_falls_through)

test("plain_text_of over an empty AST is empty, not an error", lambda: (
    assert_eq(plain_text_of([]), "")
))


# ============================================================
print("\n--- Every document in the repository ---")


def _every_document_parses():
    documents = repo_documents()
    assert_(
        len(documents) >= 20,
        f"found only {len(documents)} sdoc documents in {_REPO}; the sweep has "
        "stopped seeing the repository and is checking nothing.",
    )
    parsed = parse_sdoc_documents(documents)
    assert_eq(len(parsed), len(documents))
    unhappy = sorted(
        str(path.relative_to(_REPO))
        for path, document in parsed.items()
        if document.diagnostics
    )
    # Pinned as a set rather than tolerated generally: a recovered parse is where
    # a table quietly goes missing, and "some documents have warnings" is not a
    # state anyone reviews.
    assert_eq(unhappy, [], "documents the reference had to recover from: ")


test("every sdoc document in the repository parses cleanly", _every_document_parses)


def _the_examples_tables_are_all_there():
    document = parse_sdoc(_REPO / "examples" / "example.sdoc")
    assert_(
        len(document.tables) >= 17,
        f"examples/example.sdoc yielded {len(document.tables)} tables; it had 17. "
        "A short table count is the failure this binding exists to rule out.",
    )
    lines = (_REPO / "examples" / "example.sdoc").read_text().split("\n")
    for table in document.tables:
        assert_eq(
            len(table.row_lines),
            len(table.rows),
            f"table at line {table.line} has a row/line mismatch: ",
        )
        for row, line_number in zip(table.rows, table.row_lines):
            # Read the file back rather than pinning literal line numbers, which
            # the example is free to move. An off-by-one here sends every reader
            # of every future citation to the wrong row and looks plausible.
            source = lines[line_number - 1]
            assert_(
                row[0].raw.split("|")[0].strip() in source,
                f"row {row[0].raw!r} is cited at line {line_number}, which is "
                f"{source.strip()!r}",
            )


test("every row in examples/example.sdoc is cited on the line it is really on", _the_examples_tables_are_all_there)


def _the_specification_reads_as_a_document():
    document = parse_sdoc(_REPO / "lexica" / "specification.sdoc")
    for anchor in ("tables", "table-options", "table-formulas", "inline-formatting"):
        section = document.section(anchor)
        assert_(section.prose, f"@{anchor} came back with no prose")
    assert_eq(document.section("table-options").parent_anchor, "tables")


test("the specification's own table sections are addressable by anchor", _the_specification_reads_as_a_document)


# ============================================================
print("\n--- An installed copy, not just this checkout ---")


def _build_wheel(into: Path) -> Path:
    """Build a wheel with this project's own declared backend."""
    import contextlib
    import io

    try:
        from setuptools import build_meta
    except ImportError as error:
        # Not opted out of: this test is the only one that sees the installed
        # layout, and reporting it as absent rather than as failed leaves the
        # packaging of the parser unchecked, which is the gap it exists for.
        raise AssertionError(
            "setuptools is not importable, so the wheel this project ships "
            "cannot be built and inspected. It is the declared build backend "
            "(pyproject.toml [build-system]). Install it — `pip install "
            "setuptools` — or run this suite from a virtualenv that has it."
        ) from error

    into.mkdir(parents=True, exist_ok=True)
    cwd = os.getcwd()
    os.chdir(_PROJECT)
    try:
        # setuptools narrates the build on stdout; the test output is the report.
        with contextlib.redirect_stdout(io.StringIO()):
            return into / build_meta.build_wheel(str(into))
    finally:
        os.chdir(cwd)


def _the_binding_works_from_a_wheel():
    # This is the failure the layout is arranged to prevent, and it is invisible
    # to every other test here: they all run from a source tree, where `sdoc.js`
    # is a symlink to the repository's own parser and where anything resolved by
    # counting parent directories is right. Installed, `sdoc/` sits in
    # site-packages, there is no repository above it, and a parser addressed that
    # way is simply absent — the package works where it was written and nowhere
    # else.
    import shutil
    import tempfile

    # Resolved: on macOS the temporary directory is reached through a symlink,
    # and the containment check below compares real paths.
    scratch = Path(tempfile.mkdtemp(prefix="sdoc-wheel-")).resolve()
    try:
        wheel = _build_wheel(scratch / "dist")
        installed = scratch / "site-packages"
        with zipfile.ZipFile(wheel) as archive:
            members = archive.namelist()
            for shipped in ("sdoc/sdoc.js", "sdoc/bridge.js", "sdoc/reference.py"):
                assert_(
                    shipped in members,
                    f"the wheel does not contain {shipped}. Every sdoc read in "
                    "an installed copy is then a hard error while this checkout "
                    "stays green. pyproject.toml's package-data is what ships it.",
                )
            archive.extractall(installed)

        # The symlink must have been dereferenced: a wheel carrying a dangling
        # link installs a parser that is not there.
        shipped_parser = installed / "sdoc" / "sdoc.js"
        assert_(
            not shipped_parser.is_symlink() and shipped_parser.is_file(),
            f"{shipped_parser} is not a real file in the built wheel",
        )
        assert_eq(
            shipped_parser.read_bytes(),
            (_REPO / "src" / "sdoc.js").read_bytes(),
            "the wheel's parser is not the repository's parser: ",
        )

        # Load by file path, not by import: this must be about the installed
        # layout, and the module must find its parser without help from the
        # package it was imported as.
        module_path = installed / "sdoc" / "reference.py"
        spec = importlib.util.spec_from_file_location("_installed_sdoc_reference", module_path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        saved = os.environ.pop(SDOC_JS_ENV_VAR, None)  # would mask the bug under test
        try:
            spec.loader.exec_module(module)
            assert_(
                module.REFERENCE_SDOC_JS.is_relative_to(installed),
                f"the installed binding looks for the parser at "
                f"{module.REFERENCE_SDOC_JS}, outside the tree it was installed "
                f"into ({installed}). It resolved a path relative to something "
                "other than itself, so it works only where a checkout happens "
                "to sit at the right offset.",
            )
            document = scratch / "installed.sdoc"
            document.write_text("# Doc @doc {\n    Text.\n}\n", encoding="utf-8")
            # The parse is the part that matters: an assertion about where the
            # path points would still pass if the wheel shipped no parser there.
            payload = module.parse_documents([document])[document.resolve()]
            assert_eq(payload["nodes"][0]["id"], "doc")
            assert_eq(module.parse_inline(["{~h~}"])[0][0]["type"], "mark_highlight")
        finally:
            module.shutdown()
            sys.modules.pop(spec.name, None)
            if saved is not None:
                os.environ[SDOC_JS_ENV_VAR] = saved
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
        # setuptools builds in the project directory; leaving those behind makes
        # the next run's wheel a copy of a stale build tree.
        for leftover in ("build", "src/sdoc.egg-info"):
            shutil.rmtree(_PROJECT / leftover, ignore_errors=True)


test("the binding works from a wheel built by this project's own config", _the_binding_works_from_a_wheel)


# ============================================================
print("\n--- Results: " + str(_passed) + " passed, " + str(_failed) + " failed ---")
if _failed > 0:
    sys.exit(1)
