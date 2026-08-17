"""Python binding for the sdoc reference parser.

sdoc's grammar is specified in ``lexica/specification.sdoc`` and implemented
once, in ``src/sdoc.js``. This package lets Python call that implementation
instead of writing a second one.

Two layers, and you can stop at either:

* :mod:`sdoc.reference` runs the parser and hands back its own AST unchanged —
  :func:`parse_documents` for whole files, :func:`parse_inline` for inline
  markup. Use it when you want the format's own nodes.
* :mod:`sdoc.model` projects that AST onto sections, headings and tables, and
  :mod:`sdoc.inline` reduces inline markup to plain text and markers. Use it
  when you want to read a document rather than a syntax tree.

    >>> from sdoc import parse_sdoc
    >>> document = parse_sdoc("lexica/specification.sdoc")
    >>> [table.header for table in document.tables_in("tables")]

Requires ``node`` on the PATH (or at ``$SDOC_NODE``). Its absence is a hard
error, never a skip — see :class:`NodeUnavailableError`.
"""

from sdoc.inline import MARKER_SIGILS, markers, markers_of, plain_text, plain_text_of
from sdoc.model import (
    SdocCell,
    SdocDiagnostic,
    SdocDocument,
    SdocHeading,
    SdocParseError,
    SdocSection,
    SdocTable,
    parse_sdoc,
    parse_sdoc_documents,
)
from sdoc.reference import (
    NODE_ENV_VAR,
    SDOC_FORMAT_VERSION,
    SDOC_JS_ENV_VAR,
    NodeUnavailableError,
    SdocReferenceError,
    clear_cache,
    node_executable,
    parse_documents,
    parse_inline,
    shutdown,
)

__all__ = [
    "MARKER_SIGILS",
    "NODE_ENV_VAR",
    "SDOC_FORMAT_VERSION",
    "SDOC_JS_ENV_VAR",
    "NodeUnavailableError",
    "SdocCell",
    "SdocDiagnostic",
    "SdocDocument",
    "SdocHeading",
    "SdocParseError",
    "SdocReferenceError",
    "SdocSection",
    "SdocTable",
    "clear_cache",
    "markers",
    "markers_of",
    "node_executable",
    "parse_documents",
    "parse_inline",
    "parse_sdoc",
    "parse_sdoc_documents",
    "plain_text",
    "plain_text_of",
    "shutdown",
]
