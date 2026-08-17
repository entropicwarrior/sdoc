// The Python binding's worker process: reference parser in, JSON out.
//
// Deliberately thin. Everything about the sdoc grammar — block and inline —
// lives in `sdoc.js` beside this file; this worker exists so a Python caller
// can reach it without re-deriving any of it. It does three things:
//
//   1. speaks a newline-delimited JSON request/response protocol on stdio, so
//      one node process serves a whole Python session,
//   2. calls `parseSdoc` on requested documents, and
//   3. attaches a 1-based source line to every table ROW.
//
// (3) needs explaining, because it is the one place this file touches the
// grammar at all. The reference table node carries `lineStart`/`lineEnd` for
// the block but no per-row line, and a consumer that cites rows by line
// ("tests.sdoc:412: ...") has to get them from somewhere. Rather than
// re-implement the row grammar we recover the lines from the reference's OWN
// OUTPUT: `parseTableBody` consumes exactly one source line per row, skips
// blank lines and the closing brace, and may splice out at most one
// column-directive row. So the non-blank body lines are the rows, in order,
// with at most one extra. Anything else is a shape this worker does not
// understand, and it throws rather than guessing — a row attributed to the
// wrong line is a wrong citation, and a silently dropped row is a short
// table, which is the exact failure a consumer's row counts exist to catch.
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

function bodyLineNumbers(lines, table) {
  // 1-based line numbers of the table block's non-blank body lines.
  const candidates = [];
  const last = Math.min(table.lineEnd, lines.length);
  for (let lineNo = table.lineStart + 1; lineNo <= last; lineNo += 1) {
    const trimmed = (lines[lineNo - 1] || "").trim();
    if (trimmed === "" || trimmed === "}") continue;
    candidates.push(lineNo);
  }
  return candidates;
}

function attachRowLines(lines, table) {
  const headerless = Boolean(table.options && table.options.headerless);
  const headerRows = headerless ? 0 : 1;
  const candidates = bodyLineNumbers(lines, table);
  const surplus = candidates.length - (headerRows + table.rows.length);
  if (surplus === 1) {
    // parseTableBody spliced out a column-directive row at this index.
    candidates.splice(headerless ? 0 : 1, 1);
  } else if (surplus !== 0) {
    // Unreachable against today's `parseTableBody`, and deliberately kept: the
    // shapes that could produce it — a second directive row, a code fence, a
    // list, a blockquote, a heading, a brace inside a cell — were all tried and
    // all come out with a surplus of 0 or 1. So this fires only if the table
    // body grammar changes underneath the binding, which is exactly when
    // guessing would be worst. Its message IS exercised: flip `headerRows`
    // below and the fixture's headerless table lands here.
    throw new Error(
      "table at line " + table.lineStart + " has " + table.rows.length +
      " parsed rows but " + candidates.length + " non-blank body lines; this " +
      "bridge cannot attribute rows to source lines and refuses to guess"
    );
  }
  table.rowLines = candidates.slice(headerRows);
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
    if (node.type === "table") attachRowLines(lines, node);
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
