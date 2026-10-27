// The skeleton "SDOC: New Knowledge File" writes. It lives outside
// extension.js, which cannot load without vscode, so the tests can parse what
// the command produces.

const { slugify, SDOC_FORMAT_VERSION } = require("./sdoc");

// Each @meta property is its own paragraph: on consecutive lines they would
// parse as one, and every key after the first would be lost.
function buildKnowledgeSkeleton(title, kind, uuid, date) {
  return [
    `# ${title} @${slugify(title)}`,
    "{",
    "    @meta {",
    `        uuid: ${uuid}`,
    "",
    `        type: ${kind.toLowerCase()}`,
    "",
    `        date: ${date}`,
    "",
    `        sdoc-version: ${SDOC_FORMAT_VERSION}`,
    "    }",
    "",
    "    @about {",
    "        (Write a 2-5 line summary of this file's content.)",
    "    }",
    "",
    "    ## (Section title)",
    "    {",
    "        (Content goes here.)",
    "    }",
    "}",
    ""
  ].join("\n");
}

module.exports = { buildKnowledgeSkeleton };
