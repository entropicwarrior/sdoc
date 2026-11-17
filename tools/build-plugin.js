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
// lines, and adds BUILD to the knowledge-base module (buildId), nothing else.
// The generated files are committed, because a marketplace install runs no
// build step.
//
// It also keeps the plugin's version honest. Claude Code updates an installed
// plugin only when the version in plugin.json changes, so a change shipped
// under the old number reaches no one, and nothing says so. tools/plugin-version.json
// records the version and a digest of every file under plugins/sdoc-lexica at
// that version. A build records a new version; it refuses to record changed
// files under the old one, and says to raise it. A version that only goes up
// is checked too, since Claude Code would not take a lower one for an update.
//
// Usage: node tools/build-plugin.js [--check]
// --check writes nothing, lists every generated file that differs from what
// a build would write and any version problem, and exits 1 if there is one.
// test/test-plugin.js runs both checks.

const crypto = require("crypto");
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

// A short hash of the sources the plugin's lib is built from. The hooks keep
// file descriptions between sessions, keyed by this rather than by the
// plugin's version: a description made by an older parser is discarded when
// this differs, and an update that leaves the parser alone keeps them.
function buildId() {
  const hash = crypto.createHash("sha256");
  for (const source of ["src/sdoc.js", "src/knowledge-base.js"]) hash.update(fs.readFileSync(path.join(ROOT, source), "utf8"));
  return hash.digest("hex").slice(0, 12);
}

function toEsm(source, { imports = [], append = "" } = {}) {
  let text = fs.readFileSync(path.join(ROOT, source), "utf8");
  for (const { from, to } of imports) {
    text = replaceOnce(text,
      new RegExp(`^const (\\{[^}]*\\}) = require\\("${from.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}"\\);$`, "m"),
      `import $1 from "${to}";`, source);
  }
  text = replaceOnce(text, /^module\.exports = \{$/m, "export {", source);
  return generatedHeader(source) + text + append;
}

// Every generated file: { path (from the repo root), content }.
function outputs() {
  return [
    { path: "plugins/sdoc-lexica/lib/sdoc.mjs", content: toEsm("src/sdoc.js") },
    {
      path: "plugins/sdoc-lexica/lib/knowledge-base.mjs",
      content: toEsm("src/knowledge-base.js", {
        imports: [{ from: "./sdoc", to: "./sdoc.mjs" }],
        append: `\n// The sources this lib was built from, hashed (tools/build-plugin.js).\nexport const BUILD = "${buildId()}";\n`
      })
    },
    {
      path: "plugins/sdoc-lexica/skills/authoring/reference/sdoc-authoring.sdoc",
      content: fs.readFileSync(path.join(ROOT, "docs", "reference", "sdoc-authoring.sdoc"), "utf8")
    }
  ];
}

const MANIFEST = path.join(PLUGIN, ".claude-plugin", "plugin.json");
const VERSION_RECORD = path.join(ROOT, "tools", "plugin-version.json");
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

// Every file the plugin ships, as paths from the plugin's folder, sorted. A
// dotfile other than .claude-plugin/ is passed over (.DS_Store and the like),
// since a marketplace install never has it.
function pluginFiles(dir = PLUGIN, prefix = "") {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") && entry.name !== ".claude-plugin") continue;
    const rel = prefix + entry.name;
    if (entry.isDirectory()) files.push(...pluginFiles(path.join(dir, entry.name), rel + "/"));
    else if (entry.isFile()) files.push(rel);
  }
  return files;
}

// A hash of every file the plugin ships, by path and content. Line endings
// are made LF first, so a checkout that turns them to CRLF hashes the same.
function pluginDigest() {
  const hash = crypto.createHash("sha256");
  for (const rel of pluginFiles()) {
    hash.update(rel + "\0");
    hash.update(fs.readFileSync(path.join(PLUGIN, rel), "utf8").replace(/\r\n/g, "\n") + "\0");
  }
  return hash.digest("hex");
}

function pluginVersion() {
  return JSON.parse(fs.readFileSync(MANIFEST, "utf8")).version;
}

function recordedVersion() {
  return fs.existsSync(VERSION_RECORD) ? JSON.parse(fs.readFileSync(VERSION_RECORD, "utf8")) : null;
}

// -1, 0 or 1, as version a is below, equal to or above version b.
function compareVersions(a, b) {
  const x = SEMVER.exec(a).slice(1).map(Number);
  const y = SEMVER.exec(b).slice(1).map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

// What is wrong with the plugin's version, or null: { problem, record }, where
// record is true when a build would fix it by recording the version.
function versionCheck() {
  const version = pluginVersion();
  const where = "plugins/sdoc-lexica/.claude-plugin/plugin.json";
  if (typeof version !== "string" || !SEMVER.test(version)) {
    return { problem: `${where} needs a "version" of the form 1.2.3, not ${JSON.stringify(version)}.`, record: false };
  }
  const record = recordedVersion();
  const digest = pluginDigest();
  if (record && record.digest === digest && record.version === version) return null;
  if (record && record.version === version) {
    return {
      problem: `plugins/sdoc-lexica changed since version ${version} was recorded, and Claude Code updates no one ` +
        `until the version changes: raise "version" in ${where}, then run \`npm run build:plugin\`.`,
      record: false
    };
  }
  if (record && compareVersions(version, record.version) < 0) {
    return { problem: `The version in ${where}, ${version}, is below the recorded ${record.version}: it can only go up.`, record: false };
  }
  return { problem: `Version ${version} is not recorded yet: run \`npm run build:plugin\`.`, record: true };
}

function recordVersion() {
  const record = { version: pluginVersion(), digest: pluginDigest() };
  fs.writeFileSync(VERSION_RECORD, JSON.stringify(record, null, 2) + "\n", "utf8");
  return record;
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
    const version = differ.length ? null : versionCheck();
    if (version) console.error(version.problem);
    if (!differ.length && !version) console.log(`Plugin: generated files are up to date, and version ${pluginVersion()} is recorded.`);
    process.exitCode = differ.length || version ? 1 : 0;
    return;
  }
  for (const o of outputs()) {
    const full = path.join(ROOT, o.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, o.content, "utf8");
    console.log(`Wrote ${o.path}`);
  }
  const version = versionCheck();
  if (version && version.record) {
    recordVersion();
    console.log(`Recorded version ${pluginVersion()} in tools/plugin-version.json`);
  } else if (version) {
    console.error(version.problem);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { outputs, stale, versionCheck, pluginDigest, compareVersions };
