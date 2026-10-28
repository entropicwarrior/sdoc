#!/usr/bin/env node
// Builds the generated files of the Claude Code plugin (plugins/sdoc-lexica) from
// their sources, which stay the only place to edit them:
//
//   src/sdoc.js            → plugins/sdoc-lexica/lib/sdoc.mjs
//   src/knowledge-base.js  → plugins/sdoc-lexica/lib/knowledge-base.mjs
//   docs/reference/sdoc-authoring.sdoc → plugins/sdoc-lexica/skills/authoring/reference/
//
// The plugin runs as a mod: Claude Code loads its hooks module as an ES module
// with no Node, so there is no `require` and no `module`. Both sources are
// runtime-neutral already; this rewrites their CommonJS import and export
// lines, nothing else. The generated files are committed, because a
// marketplace install runs no build step.
//
// The plugin carries no version on purpose: Claude Code then versions it by
// commit, so whatever is merged to the branch coworkers track reaches them,
// a plugin-only fix included, with no number to forget.
//
// Usage: node tools/build-plugin.js [--check]
// --check writes nothing, lists every generated file that differs from what
// a build would write, and exits 1 if any does. test/test-plugin.js runs it.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PLUGIN = path.join(ROOT, "plugins", "sdoc-lexica");

function generatedHeader(source) {
  return `// GENERATED from ${source} by tools/build-plugin.js. Do not edit: edit the\n` +
    `// source and run \`npm run build:plugin\`.\n\n`;
}

// Replaces exactly one match of pattern, or fails: a source that changed shape
// must stop the build, not produce a module that half works.
function replaceOnce(text, pattern, replacement, what) {
  const matches = text.match(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"));
  if (!matches || matches.length !== 1) {
    throw new Error(`${what}: expected exactly one match of ${pattern}, found ${matches ? matches.length : 0}`);
  }
  return text.replace(pattern, replacement);
}

function toEsm(source, { imports = [] } = {}) {
  let text = fs.readFileSync(path.join(ROOT, source), "utf8");
  for (const { from, to } of imports) {
    text = replaceOnce(text,
      new RegExp(`^const (\\{[^}]*\\}) = require\\("${from.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}"\\);$`, "m"),
      `import $1 from "${to}";`, source);
  }
  text = replaceOnce(text, /^module\.exports = \{$/m, "export {", source);
  return generatedHeader(source) + text;
}

// Every generated file: { path (from the repo root), content }.
function outputs() {
  return [
    { path: "plugins/sdoc-lexica/lib/sdoc.mjs", content: toEsm("src/sdoc.js") },
    {
      path: "plugins/sdoc-lexica/lib/knowledge-base.mjs",
      content: toEsm("src/knowledge-base.js", { imports: [{ from: "./sdoc", to: "./sdoc.mjs" }] })
    },
    {
      path: "plugins/sdoc-lexica/skills/authoring/reference/sdoc-authoring.sdoc",
      content: fs.readFileSync(path.join(ROOT, "docs", "reference", "sdoc-authoring.sdoc"), "utf8")
    }
  ];
}

// The generated files that differ from what a build would write.
function stale() {
  return outputs().filter((o) => {
    const full = path.join(ROOT, o.path);
    return !fs.existsSync(full) || fs.readFileSync(full, "utf8") !== o.content;
  }).map((o) => o.path);
}

function main() {
  if (process.argv.includes("--check")) {
    const differ = stale();
    for (const p of differ) console.error(`${p} is out of date: run \`npm run build:plugin\``);
    if (!differ.length) console.log("Plugin: generated files are up to date.");
    process.exitCode = differ.length ? 1 : 0;
    return;
  }
  for (const o of outputs()) {
    const full = path.join(ROOT, o.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, o.content, "utf8");
    console.log(`Wrote ${o.path}`);
  }
}

if (require.main === module) main();

module.exports = { outputs, stale };
