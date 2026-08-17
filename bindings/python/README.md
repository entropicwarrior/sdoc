# sdoc — Python binding

Read `.sdoc` documents from Python by calling the reference parser, not by
reimplementing it.

sdoc's grammar is specified in [`lexica/specification.sdoc`](../../lexica/specification.sdoc)
and implemented once, in [`src/sdoc.js`](../../src/sdoc.js). This package runs
that implementation under `node` and projects its AST into Python. There is no
Python parser here — no scanning, no line-shape regexes, no inline-markup
regexes — because a second implementation of a specified grammar is wrong in
ways only a second opinion can find, and by then it has been wrong for months.

## Install

Not on PyPI. Consume it as a path dependency on a checkout of this repository:

```toml
# pyproject.toml (PEP 621 / uv / pip)
[project]
dependencies = ["sdoc"]

[tool.uv.sources]
sdoc = { path = "../sdoc/bindings/python", editable = true }
```

```toml
# pyproject.toml (poetry)
[tool.poetry.dependencies]
sdoc = { path = "../sdoc/bindings/python", develop = true }
```

Or directly: `pip install -e /path/to/sdoc/bindings/python`.

Requires **node** on the `PATH`. Any version that can `require` a CommonJS
module will do; the parser has no dependencies. Its absence raises
`NodeUnavailableError` — deliberately an error and never a skip, because a
reader that cannot reach the reference has checked nothing.

## Use

```python
from sdoc import parse_sdoc

document = parse_sdoc("lexica/specification.sdoc")

document.sections            # scopes with a heading AND an anchor
document.headings            # every heading, anchored or not, in source order
document.tables              # every table, in source order
document.diagnostics         # what the parser had to recover from

section = document.section("table-options")
section.path                 # ("tables", "table-options")
section.prose                # source lines directly in this section

table = document.tables_in("tables")[0]
table.header                 # ("Column", "Meaning")
table.rows[0][0].raw         # exactly as written
table.rows[0][0].text        # reduced to comparable plain text
table.row_lines[0]           # the 1-based source line of that row
table.column("Meaning")      # index, or raises — never -1
```

Parse many files in one batch — it is one round trip, not one per file:

```python
from pathlib import Path
from sdoc import parse_sdoc_documents

documents = parse_sdoc_documents(sorted(Path("lexica").rglob("*.sdoc")))
```

Inline markup, also from the reference:

```python
from sdoc import markers, plain_text

plain_text("see [the spec](x.sdoc) for `AGTC`")   # "see the spec for AGTC"
markers("{?Dormant: pending a ruling?}")           # (("?", "Dormant: pending a ruling"),)
```

And the reference parser's own AST, unflattened, when the projection above is
not enough:

```python
from sdoc import parse_documents, parse_inline

parse_documents([Path("a.sdoc")])   # {path: {"nodes": [...], "errors": [...]}}
parse_inline(["**bold** {+ok+}"])   # [[{"type": "strong", ...}, ...]]
```

## What the binding adds to the reference

One thing, and only one: a **1-based source line for every table row**
(`SdocTable.row_lines`). The reference's table node carries `lineStart` and
`lineEnd` for the block but no per-row line, and a consumer that cites rows
("`tests.sdoc:412:`") needs them. They are recovered from the reference's own
output rather than by re-parsing rows — see the note at the top of
[`src/sdoc/bridge.js`](src/sdoc/bridge.js). When the shape is one the worker
cannot attribute confidently it raises, because a row on the wrong line is a
wrong citation and a dropped row is a short table.

## How it runs

One `node` process serves the Python session, speaking newline-delimited JSON
over stdio. It starts on first use and is closed at interpreter exit; call
`shutdown()` to stop it early. Document parses are cached in-process by path,
size and mtime, so re-reading an unchanged file is free and re-reading a changed
one is not.

`sdoc/sdoc.js` is the reference parser: a symlink to `src/sdoc.js` in a checkout,
its dereferenced bytes in a built wheel. Either way the runtime path is
`<package dir>/sdoc.js` — the one resolution that is true of a source checkout
and of `site-packages` alike. On start the worker declares the parser's
`SDOC_FORMAT_VERSION` and the binding refuses to proceed if it is not the
version it was written against.

| Environment variable | Effect |
| --- | --- |
| `SDOC_NODE` | Use this node binary instead of the one on `PATH`. |
| `SDOC_JS` | Load this parser instead of the one shipped beside the package. |

## Tests

```
python3 bindings/python/test/test_binding.py
```

Plain script, assert helpers, non-zero exit on failure — the same idiom as
`test/test-all.js`. It covers the constructs a hand-written Python parser got
wrong (`test/fixtures/regressions.sdoc`), every `.sdoc` document in this
repository, and a wheel built from this project's own configuration, run with no
checkout above it.

That last test builds a wheel, so it needs **setuptools** importable — the build
backend this package declares. Python 3.12 stopped bundling it, so a stock
interpreter or a fresh `venv` does not have it and the test fails rather than
skipping, for the same reason a missing `node` fails: a claim about an installed
copy that was never built is not a claim. Install it with `pip install
setuptools`. Nothing at runtime needs it; the binding itself has no Python
dependencies at all.
