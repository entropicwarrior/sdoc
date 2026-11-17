// Temporary directories a test makes, removed when the suite exits.
//
// A fixture directory a test makes and never removes is invisible: the test
// passes and the directory stays. These were found by listing the temp folder
// rather than the process table — some 400 of them, from four fixtures, all
// younger than the three days macOS keeps a temp file. Whatever a test makes
// through tempDir() is removed on exit, however the test ended.

const fs = require("fs");
const os = require("os");
const path = require("path");

const made = [];
process.on("exit", () => {
  for (const dir of made) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

module.exports = { tempDir };
