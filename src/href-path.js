// Resolving a link's href to a file on disk, shared by the VS Code extension
// and tools/build-doc.js so the Problems panel and `build-doc --check` agree on
// which links are broken. Node-only: src/sdoc.js also runs in the document
// browser's page, so it cannot use fs.

const fs = require("fs");
const path = require("path");

// A link href may percent-encode path characters (%20 for spaces, %28/%29 for
// parentheses, ...). The file system knows nothing about percent-encoding, so
// resolve against both the raw href and its decoded form.
function hrefCandidates(filePath) {
  const candidates = [filePath];
  try {
    const decoded = decodeURIComponent(filePath);
    if (decoded !== filePath) candidates.push(decoded);
  } catch (e) {
    // Malformed percent sequence (e.g. a literal "%" in a filename) — raw only.
  }
  return candidates;
}

function hrefPathExists(filePath, docDir) {
  return hrefCandidates(filePath).some((candidate) => {
    const absPath = path.isAbsolute(candidate) ? candidate : path.join(docDir, candidate);
    return fs.existsSync(absPath);
  });
}

module.exports = { hrefCandidates, hrefPathExists };
