// Whether the browser tests run here, and the bookkeeping for when they do not.
//
// The browser suites drive a headless Chrome: the slide runtimes, PDF export
// and the geometry the exporters read can only be tested in one. Chrome is not
// a requirement for working on SDOC, so a test that needs it is skipped where
// it is missing — and it is counted as skipped, and the results say so.
//
// That last part is the point of this file. A skipped test used to be counted
// as a pass in one suite and left out of the count altogether in the others,
// so a run on a machine without Chrome reported all green and the same totals,
// and read as though the exporters had been tested when nothing had.
//
// SDOC_SKIP_BROWSER=1 skips them on a machine that does have Chrome — for a
// quick run, or a CI job that should not start a browser.

const fs = require("fs");
const { findChrome } = require("../src/slide-pdf.js");

function reasonToSkip() {
  const flag = (process.env.SDOC_SKIP_BROWSER || "").trim().toLowerCase();
  if (flag && flag !== "0" && flag !== "false" && flag !== "no") return "SDOC_SKIP_BROWSER is set";
  return findChrome() ? null : "Chrome not found";
}

// Decided once, so every test in a run agrees.
const SKIP = reasonToSkip();

class Skipped extends Error {
  constructor() {
    super("skipped: " + SKIP);
    this.name = "Skipped";
  }
}

let count = 0;
let grouping = false;

// For a test that finds out for itself that it needs a browser: call it as the
// test's first line. It throws, and the suite's runner counts a skip.
function skip() {
  if (SKIP) throw new Skipped();
}

function isSkip(err) {
  return err instanceof Skipped;
}

function record(name) {
  count++;
  console.log("  SKIP: " + name + " — " + SKIP);
}

// Tests registered inside fn need a browser. With one they are registered as
// usual. Without one fn still runs, so every test it would register — loops
// included — is counted as skipped, but none of them runs: a suite's test()
// asks skipping() first. What fn sets up at its top level must therefore not
// start a browser itself; the groups in this repo build their harvests lazily.
// A temporary directory fn makes while being skipped is removed afterwards,
// since the test that would have cleaned it up never runs.
function group(fn) {
  if (!SKIP) { fn(); return; }
  const made = [];
  const mkdtempSync = fs.mkdtempSync;
  fs.mkdtempSync = function () {
    const dir = mkdtempSync.apply(fs, arguments);
    made.push(dir);
    return dir;
  };
  grouping = true;
  try {
    fn();
  } finally {
    grouping = false;
    fs.mkdtempSync = mkdtempSync;
    for (const dir of made) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }
}

function skipping() {
  return grouping;
}

// Appended to a suite's Results line: nothing when every test ran.
function summary() {
  return count ? `, ${count} skipped (${SKIP})` : "";
}

module.exports = { SKIP, skip, isSkip, record, group, skipping, summary };
