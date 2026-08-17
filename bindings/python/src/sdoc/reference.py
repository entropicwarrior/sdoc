"""Run the reference sdoc parser from Python.

sdoc is a specified format. This repository carries the EBNF grammar
(``lexica/specification.sdoc``) and the reference implementation
(``src/sdoc.js``) that the format's own tooling — editor extension, renderer,
validator — runs on. A Python consumer that wants to read sdoc has two options:
call the reference, or write a second implementation of the grammar.

The second option has been tried and measured. ETHyR D4 carried a hand-written
Python reader for a while. It was never validated against the specification and
it was wrong in ways nothing local could see: it rejected 3 of the 110 sdoc
documents in reach over a cell-count rule the grammar does not state, silently
lost whole sections written in the brace-on-the-next-line form the grammar does
allow, read the column-alignment directive row as data in 6 tables, and kept
scope *type* annotations (``# Warning :warning {``) inside heading titles. How
much it lost was measured once, by running both readers over all 110 documents
before the old one was deleted: **151 fewer anchored sections, in 6 documents**,
146 of them in the four that write the brace on the following line. It is quoted
as a dated measurement rather than a live figure because the reader it describes
no longer exists, so nothing can recompute it.

So this module calls the reference. Two rules follow from that, and both are
enforced here rather than left to callers:

* **node absent is a hard error, never a skip** (:class:`NodeUnavailableError`).
  A consumer whose specification *is* sdoc and which cannot read sdoc has
  verified nothing, and must say so in red rather than quietly doing less.
* **the parser that runs must be the version this binding was written against**
  (:data:`SDOC_FORMAT_VERSION`). :data:`SDOC_JS_ENV_VAR` can point the worker at
  another checkout, and the version handshake is what stops that from silently
  reading documents with a different version of the format.

There is no vendoring and no provenance record here, because there is nothing to
vendor: ``sdoc.js`` sits beside this file. In a source checkout it is a symlink
to ``src/sdoc.js`` at the repository root; in a built wheel it is that file's
bytes. Either way :data:`REFERENCE_SDOC_JS` is ``<this package>/sdoc.js``, which
is true of a checkout and of ``site-packages`` alike — the alternative, counting
parent directories up to a repository root, gives a directory that exists in a
checkout and does not once installed.

One node process serves the session. It is started on first use, speaks the
newline-delimited JSON protocol documented in ``bridge.js``, and is closed at
interpreter exit. Document parses are additionally cached in-process, keyed by
path, size and mtime, so re-reading an unchanged file is free and re-reading a
*changed* one is not.
"""

from __future__ import annotations

import atexit
import json
import os
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Any

__all__ = [
    "NODE_ENV_VAR",
    "REFERENCE_RELATIVE_PATH",
    "REFERENCE_SDOC_JS",
    "SDOC_FORMAT_VERSION",
    "SDOC_JS_ENV_VAR",
    "NodeUnavailableError",
    "SdocReferenceError",
    "clear_cache",
    "node_executable",
    "parse_documents",
    "parse_inline",
    "reference_sdoc_js",
    "shutdown",
]

#: Override the node binary. Set it when node is installed somewhere the PATH
#: this process inherits cannot see.
NODE_ENV_VAR = "SDOC_NODE"

#: Override the reference parser the worker loads. Exists so a consumer can run
#: this binding against a working checkout of the format without reinstalling.
SDOC_JS_ENV_VAR = "SDOC_JS"

#: The format version this binding was written against. Asserted against the
#: running parser's ``SDOC_FORMAT_VERSION`` when the worker starts, so a parser
#: from a different version of the format cannot be read as if it were this one.
SDOC_FORMAT_VERSION = "0.2"

#: Where the reference parser sits, relative to this package's directory.
#: ``bridge.js`` resolves the same name from ``__dirname`` for the case where it
#: is run without :data:`SDOC_JS_ENV_VAR` set; the two must agree, and
#: ``test_binding.py`` checks that they do.
REFERENCE_RELATIVE_PATH = ("sdoc.js",)

#: The reference parser. Resolved relative to *this file*, so it is found
#: identically from a source checkout and from ``site-packages``; see the module
#: docstring for what the alternative costs.
REFERENCE_SDOC_JS = Path(__file__).resolve().parent.joinpath(*REFERENCE_RELATIVE_PATH)

#: The worker that loads it and speaks JSON.
_WORKER = Path(__file__).resolve().with_name("bridge.js")


class SdocReferenceError(RuntimeError):
    """The reference parser could not be run, or did not answer usefully.

    Distinct from a *document* failing to parse: this says the machinery is
    broken, and no statement about any document can be made.
    """


class NodeUnavailableError(SdocReferenceError):
    """``node`` is not installed, so no sdoc document can be read.

    Deliberately not a test skip. A suite that reads its specification out of
    sdoc files and cannot read them has verified nothing, and a skip reports
    that as an absence rather than as a failure.
    """


def node_executable() -> str:
    """Path to the node binary, or raise :class:`NodeUnavailableError`."""
    override = os.environ.get(NODE_ENV_VAR)
    candidate = override or shutil.which("node")
    if candidate and Path(candidate).exists():
        return candidate
    where = f"{NODE_ENV_VAR}={override!r}" if override else "the PATH"
    raise NodeUnavailableError(
        f"node was not found on {where}, so the reference sdoc parser cannot "
        "run and no sdoc document can be read. This is a failure, not a skip: "
        "a reader that cannot reach the reference has checked nothing.\n"
        "Install it — `brew install node` on macOS, `apt install nodejs` on "
        "Debian/Ubuntu, or actions/setup-node@v4 in CI — or point "
        f"{NODE_ENV_VAR} at an existing binary. Any version that can `require` "
        "a CommonJS module will do; the parser has no dependencies."
    )


def reference_sdoc_js() -> Path:
    """Path to the reference parser the worker will load."""
    override = os.environ.get(SDOC_JS_ENV_VAR)
    path = Path(override) if override else REFERENCE_SDOC_JS
    if not path.is_file():
        raise SdocReferenceError(
            f"the reference sdoc parser is not at {path}. It ships beside this "
            "package as sdoc/sdoc.js — a symlink to src/sdoc.js in a checkout, "
            "the file itself in a built wheel. If this is an installed copy, "
            "the wheel was built without it; pyproject.toml's package-data is "
            f"what ships it. Otherwise point {SDOC_JS_ENV_VAR} at a checkout's "
            "src/sdoc.js."
        )
    return path


# --------------------------------------------------------------------------
# The worker
# --------------------------------------------------------------------------

_LOCK = threading.Lock()
_WORKER_PROCESS: subprocess.Popen[str] | None = None
_NEXT_ID = 0


def _start() -> subprocess.Popen[str]:
    node = node_executable()
    env = dict(os.environ)
    env[SDOC_JS_ENV_VAR] = str(reference_sdoc_js())
    try:
        process = subprocess.Popen(
            [node, str(_WORKER)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )
    except OSError as error:
        raise SdocReferenceError(f"could not run {node} {_WORKER}: {error}") from error

    handshake = _read_line(process, "the worker did not announce itself")
    reported = handshake.get("formatVersion")
    if reported != SDOC_FORMAT_VERSION:
        _terminate(process)
        raise SdocReferenceError(
            f"the sdoc parser at {reference_sdoc_js()} declares format version "
            f"{reported!r}, but this binding is written against "
            f"{SDOC_FORMAT_VERSION!r}. Reading documents with it would apply "
            "one version of the format's rules under the name of another. "
            "Move deliberately: update SDOC_FORMAT_VERSION here, then re-run "
            "this binding's tests to see what changed."
        )
    return process


def _terminate(process: subprocess.Popen[str]) -> None:
    if process.poll() is None:
        try:
            if process.stdin is not None:
                process.stdin.close()
            process.wait(timeout=5)
        except Exception:  # pragma: no cover - the worker is already going away
            process.kill()


def shutdown() -> None:
    """Stop the worker. It restarts on the next request."""
    global _WORKER_PROCESS
    with _LOCK:
        if _WORKER_PROCESS is not None:
            _terminate(_WORKER_PROCESS)
            _WORKER_PROCESS = None


atexit.register(shutdown)


def _drain_stderr(process: subprocess.Popen[str]) -> str:
    """Whatever the worker said on the way out.

    Only called once the worker has stopped answering, so reading its stderr to
    EOF cannot block on a process that is still working.
    """
    if process.stderr is None:
        return ""
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:  # pragma: no cover - hung worker
        process.kill()
        process.wait(timeout=5)
    return process.stderr.read().strip()


def _read_line(process: subprocess.Popen[str], what: str) -> dict[str, Any]:
    assert process.stdout is not None
    line = process.stdout.readline()
    if line == "":
        raise SdocReferenceError(
            f"{what}: the reference sdoc parser's worker exited "
            f"({process.poll()}) with no reply. This is a broken toolchain, "
            f"not a broken document.\nstderr:\n{_drain_stderr(process)}"
        )
    try:
        return json.loads(line)
    except json.JSONDecodeError as error:
        raise SdocReferenceError(
            f"{what}: the worker did not emit JSON: {error}\n"
            f"line starts: {line[:400]!r}"
        ) from error


def _request(**payload: Any) -> dict[str, Any]:
    """Send one request, return its response. Serialised across threads."""
    global _WORKER_PROCESS, _NEXT_ID
    with _LOCK:
        if _WORKER_PROCESS is None or _WORKER_PROCESS.poll() is not None:
            _WORKER_PROCESS = _start()
        process = _WORKER_PROCESS
        _NEXT_ID += 1
        request_id = _NEXT_ID
        assert process.stdin is not None
        try:
            process.stdin.write(json.dumps({"id": request_id, **payload}) + "\n")
            process.stdin.flush()
        except OSError as error:
            _WORKER_PROCESS = None
            raise SdocReferenceError(
                f"could not send a request to the reference sdoc parser's "
                f"worker: {error}\nstderr:\n{_drain_stderr(process)}"
            ) from error
        response = _read_line(process, f"request {request_id}")

    if response.get("id") != request_id:
        # A cushion, not a gate: responses are one-per-request and read under
        # the lock, so nothing today can desynchronise them. It is here because
        # the failure it catches is undetectable downstream — one document's
        # parse returned for another's, with both documents real.
        raise SdocReferenceError(
            f"the worker answered request {response.get('id')!r} when "
            f"{request_id} was asked; the protocol has desynchronised."
        )
    if "error" in response:
        raise SdocReferenceError(
            f"the reference sdoc parser's worker refused the request: "
            f"{response['error']}"
        )
    return response


# --------------------------------------------------------------------------
# Documents
# --------------------------------------------------------------------------

#: Parsed documents, keyed by (resolved path, size, mtime_ns). Keyed on the stat
#: rather than the path alone because a caller that rewrites a file and re-parses
#: it within one session — every mutation test does — would otherwise be served
#: the pre-mutation parse, and pass while proving nothing.
_CACHE: dict[tuple[str, int, int], dict[str, Any]] = {}


def clear_cache() -> None:
    """Forget every cached parse, document and inline alike."""
    _CACHE.clear()
    _INLINE_CACHE.clear()


def _key(path: Path) -> tuple[str, int, int]:
    stat = path.stat()
    return (str(path), stat.st_size, stat.st_mtime_ns)


def parse_documents(paths: list[Path]) -> dict[Path, dict[str, Any]]:
    """Parse documents with the reference parser, one request for the batch.

    Returns each document's ``{"nodes": [...], "errors": [...]}`` — the
    reference parser's own output, unflattened — with a ``rowLines`` list added
    to every table node (see ``bridge.js``). Raises
    :class:`SdocReferenceError` if the parser could not be run at all; a
    document the parser itself could not handle comes back carrying an
    ``error`` key, for the caller to turn into a document-level failure.
    """
    resolved = [Path(p).resolve() for p in paths]
    wanted = [p for p in dict.fromkeys(resolved) if _key(p) not in _CACHE]

    if wanted:
        response = _request(op="parse", paths=[str(p) for p in wanted])
        for path in wanted:
            document = response["documents"].get(str(path))
            if document is None:
                raise SdocReferenceError(
                    f"the reference sdoc parser returned nothing for {path}"
                )
            _CACHE[_key(path)] = document

    return {path: _CACHE[_key(path)] for path in resolved}


# --------------------------------------------------------------------------
# Inline markup
# --------------------------------------------------------------------------

#: Inline ASTs, keyed by the exact source text. Unbounded, like `_CACHE`: the
#: strings are cells and headings from documents already held in memory.
_INLINE_CACHE: dict[str, list[dict[str, Any]]] = {}


def parse_inline(texts: list[str]) -> list[list[dict[str, Any]]]:
    """Inline-parse each string with the reference parser's ``parseInline``.

    Returns the reference's own inline AST per string — ``text``, ``code``,
    ``link``, ``mark_*``, ``ref``, ``citation_ref``, ``image`` and friends. Pass
    every string you have in one call; the round trip is per call, not per
    string, and results are cached by exact text.

    This exists so that no Python code has to know what an inline marker looks
    like. A second implementation of the inline grammar is the same defect as a
    second implementation of the block grammar, one level down.
    """
    wanted = [t for t in dict.fromkeys(texts) if t not in _INLINE_CACHE]
    if wanted:
        response = _request(op="inline", texts=wanted)
        parsed = response["inline"]
        # A cushion, not a gate: the worker maps one result per text, so this
        # cannot fire unless the protocol changes. It is here because the `zip`
        # below would silently pair the wrong AST with the wrong string, and a
        # cell reduced from its neighbour's markup is a wrong answer that reads
        # as a right one.
        if len(parsed) != len(wanted):
            raise SdocReferenceError(
                f"asked the reference parser to inline-parse {len(wanted)} "
                f"strings and got {len(parsed)} results back"
            )
        _INLINE_CACHE.update(zip(wanted, parsed))
    return [_INLINE_CACHE[t] for t in texts]
