// The Python binding's worker process: reference parser in, JSON out.
//
// Deliberately thin. Everything about the sdoc grammar — block and inline —
// lives in `sdoc.js` beside this file; this worker exists so a Python caller
// can reach it without re-deriving any of it. It does two things:
//
//   1. speaks a newline-delimited JSON request/response protocol on stdio, so
//      one node process serves a whole Python session, and
//   2. calls `parseSdoc` on requested documents.
//
// A table ROW's 1-based source line, which a consumer that cites rows by line
// ("tests.sdoc:412: ...") needs, is the reference's own `rowLines`: this file
// does not touch the grammar at all. A table without one row line per row
// means a reference this worker was not written against, and it throws rather
// than guessing: a row attributed to the wrong line is a wrong citation, and a
// silently dropped row is a short table, which is the exact failure a
// consumer's row counts exist to catch.
//
// Protocol. One JSON value per line, in both directions, because
// JSON.stringify never emits a raw newline inside a value.
//
//   -> (on start, unprompted)  {"ready":true,"formatVersion":"0.2"}
//   <- {"id":1,"op":"parse","paths":["/abs/a.sdoc"]}
//   -> {"id":1,"documents":{"/abs/a.sdoc":{nodes,errors,lineCount}}}
//   <- {"id":2,"op":"inline","texts":["{+good+} and `code`"]}
//   -> {"id":2,"inline":[[ ...parseInline nodes... ]]}
//
// A document that cannot be read comes back as {"error": "..."} in its own
// slot; the batch still answers. A request this worker cannot understand at
// all comes back as a top-level {"id":N,"error":"..."}. Nothing is written to
// stdout except responses.

"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");

// Beside this file, not up at a repository root: __dirname is inside the
// installed package as often as it is inside a checkout, and only one of those
// two has a repository above it. In a checkout `sdoc.js` here is a symlink to
// `src/sdoc.js`; in a built wheel it is the file itself. Either way the path
// this worker resolves is the same one, which is why there is no arithmetic
// here to be wrong. `reference.REFERENCE_RELATIVE_PATH` names the same
// component and a test asserts the two agree.
const REFERENCE = path.join(__dirname, "sdoc.js");
const reference = require(process.env.SDOC_JS || REFERENCE);

function checkRowLines(table) {
  const rowLines = table.rowLines;
  if (!Array.isArray(rowLines) || rowLines.length !== (table.rows || []).length) {
    throw new Error(
      "table at line " + table.lineStart + " has " + (table.rows || []).length +
      " parsed rows but " + (Array.isArray(rowLines) ? rowLines.length : "no") +
      " row lines; the reference parser does not record a line per row, and " +
      "this bridge refuses to guess"
    );
  }
}

function walk(nodes, visit) {
  for (const node of nodes || []) {
    visit(node);
    if (node.children) walk(node.children, visit);
    if (node.items) walk(node.items, visit);
  }
}

function parseOne(file) {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  const parsed = reference.parseSdoc(text);
  walk(parsed.nodes, (node) => {
    if (node.type === "table") checkRowLines(node);
  });
  return { nodes: parsed.nodes, errors: parsed.errors || [], lineCount: lines.length };
}

function handleParse(request) {
  const documents = {};
  for (const file of request.paths) {
    try {
      documents[file] = parseOne(file);
    } catch (err) {
      documents[file] = { error: String((err && err.message) || err) };
    }
  }
  return { documents };
}

function handleInline(request) {
  // No try/catch per text: `parseInline` is total over strings — it falls back
  // to literal text for anything it does not recognise — so a throw here is a
  // broken toolchain, and it should surface as one rather than as a per-item
  // "error" the caller might mistake for a statement about the text.
  return { inline: request.texts.map((text) => reference.parseInline(text)) };
}

const OPERATIONS = { parse: handleParse, inline: handleInline };

function respond(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

function main() {
  respond({ ready: true, formatVersion: reference.SDOC_FORMAT_VERSION });
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", (line) => {
    if (line.trim() === "") return;
    let request;
    try {
      request = JSON.parse(line);
    } catch (err) {
      respond({ id: null, error: "request was not JSON: " + String(err && err.message) });
      return;
    }
    const operation = OPERATIONS[request.op];
    if (!operation) {
      respond({ id: request.id, error: "unknown op " + JSON.stringify(request.op) });
      return;
    }
    try {
      respond(Object.assign({ id: request.id }, operation(request)));
    } catch (err) {
      respond({ id: request.id, error: String((err && err.stack) || err) });
    }
  });
  input.on("close", () => process.exit(0));
}

main();
