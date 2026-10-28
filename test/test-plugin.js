// The Claude Code plugin (plugins/sdoc-lexica) and the module it is built on,
// src/knowledge-base.js.
//
// The plugin runs as a mod: Claude Code loads plugins/sdoc-lexica/hooks/register.mjs
// in a runtime of its own, with no Node. Everything it does lives in
// handlers.mjs, written against an io adapter, so it is tested here through
// an in-memory file system, with no Claude Code. What only a live session can
// show (the engine calling the hooks) is checked by hand: see
// docs/guide/claude-code-plugin.sdoc.
//
// Run: node test/test-plugin.js

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const kb = require("../src/knowledge-base");
const sdoc = require("../src/sdoc");
const buildPlugin = require("../tools/build-plugin");

const ROOT = path.join(__dirname, "..");
const PLUGIN = path.join(ROOT, "plugins", "sdoc-lexica");

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log("  PASS: " + name); }
  catch (e) { fail++; console.log("  FAIL: " + name + " — " + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error((msg ? msg + ": " : "") + `expected ${b}, got ${a}`);
}

// A file system in memory: { "/abs/path": text }. Directories exist by
// holding files. write() changes it the way an edit would.
function memoryIo(files) {
  const store = { ...files };
  return {
    store,
    read: async (p) => {
      if (!(p in store)) throw new Error("ENOENT: " + p);
      return store[p];
    },
    exists: async (p) => p in store || Object.keys(store).some((k) => k.startsWith(p.replace(/\/$/, "") + "/")),
    list: async (dir) => {
      const prefix = dir.replace(/\/$/, "") + "/";
      const kinds = new Map();
      for (const key of Object.keys(store)) {
        if (!key.startsWith(prefix)) continue;
        const [first, ...more] = key.slice(prefix.length).split("/");
        kinds.set(first, more.length ? "dir" : "file");
      }
      return [...kinds].map(([name, kind]) => ({ name, kind }));
    },
    write(p, text) { store[p] = text; }
  };
}

// The real file system, for the checks that run over the repository.
const nodeIo = {
  read: (p) => fs.readFileSync(p, "utf8"),
  list: (dir) => fs.readdirSync(dir, { withFileTypes: true }).map((d) => ({ name: d.name, kind: d.isDirectory() ? "dir" : d.isFile() ? "file" : "other" })),
  exists: (p) => fs.existsSync(p)
};

function doc({ id = "doc", title = "Doc", signposts = "", body = "" } = {}) {
  return `# ${title} @${id}\n{\n    @meta {\n        type: doc\n\n        sdoc-version: 0.2\n    }\n${signposts}\n${body}\n}\n`;
}

const GUIDED = doc({
  id: "guided",
  title: "Guided",
  signposts: [
    "    @about {",
    "        A guided file.",
    "    }",
    "",
    "    @related-resources {",
    "        {[table]",
    "            Resource | Relation",
    "            [Other](other.sdoc) | Sibling",
    "            [Upstream](https://example.com) | Source",
    "        }",
    "    }",
    "",
    "    @reading-guide {",
    "        Start with the intro.",
    "",
    "        {[table]",
    "            Sections | Note",
    "            @intro | First",
    "        }",
    "    }",
    "",
    "    @editing-guide {",
    "        Keep sections short.",
    "    }"
  ].join("\n"),
  body: "    # Intro @intro\n    {\n        Hello there.\n    }\n\n    # Details @details\n    {\n        More words about brace scoping.\n\n        # Deeper\n        {\n            Nested text.\n        }\n    }"
});

const PLAIN = doc({ id: "other", title: "Other", signposts: "    @about {\n        Plain file.\n    }", body: "    # Only @only\n    {\n        Text.\n    }" });

function bigDoc(sections) {
  const body = Array.from({ length: sections }, (_, i) =>
    `    # Part ${i} @part-${i}\n    {\n${Array.from({ length: 8 }, () => "        Line of text.").join("\n")}\n    }`).join("\n\n");
  return doc({ id: "big", title: "Big", body });
}

async function main() {
  const handlers = await import(pathToFileURL(path.join(PLUGIN, "hooks", "handlers.mjs")).href);
  const esmSdoc = await import(pathToFileURL(path.join(PLUGIN, "lib", "sdoc.mjs")).href);
  const esmKb = await import(pathToFileURL(path.join(PLUGIN, "lib", "knowledge-base.mjs")).href);

  // ============================================================
  console.log("\n--- Generated files and manifests ---");

  await test("the generated files match their sources (npm run build:plugin)", () => {
    const stale = buildPlugin.stale();
    assert(!stale.length, "out of date: " + stale.join(", "));
  });

  // With a version set, Claude Code updates a plugin only when the number
  // changes, so a fix shipped without a bump never reaches anyone. Without
  // one, each commit on the branch coworkers track is an update.
  await test("plugin.json names the plugin and sets no version (it is versioned by commit)", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8"));
    assertEqual(manifest.name, "sdoc-lexica");
    assert(!("version" in manifest), "a version here pins coworkers to it until someone bumps it");
  });

  await test("the marketplace lists the plugin by a path that holds it", () => {
    const market = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
    assert(market.name && market.owner && market.owner.name, "name and owner.name are required");
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8"));
    const entry = market.plugins.find((p) => p.name === manifest.name);
    assert(entry, "no entry named " + manifest.name);
    assert(fs.existsSync(path.join(ROOT, entry.source, ".claude-plugin", "plugin.json")), "source has no plugin.json");
    assert(!("version" in entry), "a version here pins coworkers to it until someone bumps it");
  });

  await test("hooks.json names a hooks module that exists, and no command hooks (no Node)", () => {
    const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN, "hooks", "hooks.json"), "utf8"));
    assertEqual(Object.keys(hooks), ["modules"]);
    for (const m of hooks.modules) assert(fs.existsSync(path.join(PLUGIN, "hooks", m)), m);
  });

  await test("the plugin has no top-level bin/ (claude.ai and Cowork refuse one)", () => {
    assert(!fs.existsSync(path.join(PLUGIN, "bin")));
  });

  await test("nothing the hooks module loads touches Node (no require, fs, path or process)", () => {
    for (const rel of ["hooks/register.mjs", "hooks/handlers.mjs", "lib/knowledge-base.mjs"]) {
      const code = fs.readFileSync(path.join(PLUGIN, rel), "utf8").replace(/^\s*\/\/.*$/gm, "");
      assert(!/\brequire\s*\(|\bprocess\.|from "(fs|path|os|node:[a-z]+)"|\bimport\s*\(/.test(code), rel);
    }
  });

  await test("the ES-module parser exports what src/sdoc.js does", () => {
    assertEqual(Object.keys(esmSdoc).sort(), Object.keys(sdoc).sort());
    assertEqual(Object.keys(esmKb).sort(), Object.keys(kb).sort());
  });

  await test("the ES-module parser builds the same tree for every .sdoc file in the repo", async () => {
    const files = [];
    for (const dir of ["docs", "lexica", "examples", "test", "themes"]) {
      files.push(...await kb.findSdocFiles(path.join(ROOT, dir), nodeIo.list));
    }
    assert(files.length > 20, "found only " + files.length);
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      assert(JSON.stringify(esmSdoc.parseSdoc(text)) === JSON.stringify(sdoc.parseSdoc(text)), file);
    }
  });

  // ============================================================
  console.log("\n--- Paths without Node ---");

  await test("joinPath resolves . and .., and keeps an absolute path absolute", () => {
    assertEqual(kb.joinPath("/a/b", "c/../d.sdoc"), "/a/b/d.sdoc");
    assertEqual(kb.joinPath("/a/b", "../../../x"), "/x");
    assertEqual(kb.joinPath("/a/b", "/abs/y"), "/abs/y");
    assertEqual(kb.joinPath("a", "./b"), "a/b");
  });

  await test("a Windows path keeps its drive and separator", () => {
    assertEqual(kb.joinPath("C:\\proj\\docs", "..\\lexica\\a.sdoc"), "C:\\proj\\lexica\\a.sdoc");
    assertEqual(kb.dirName("C:\\proj\\a.sdoc"), "C:\\proj");
    assertEqual(kb.dirName("C:\\a.sdoc"), "C:\\");
    assert(kb.isAbsolutePath("C:\\x") && kb.isAbsolutePath("/x") && !kb.isAbsolutePath("x"));
  });

  await test("isInside tells a child from a sibling with a common prefix", () => {
    assert(kb.isInside("/p", "/p/lexica/a.sdoc"));
    assert(kb.isInside("/p", "/p"));
    assert(!kb.isInside("/p", "/proj/a.sdoc"));
    assert(!kb.isInside("/p", "/p/../etc/passwd"));
  });

  await test("shownPath shortens paths under the base only", () => {
    assertEqual(kb.shownPath("/p/lexica/a.sdoc", "/p"), "lexica/a.sdoc");
    assertEqual(kb.shownPath("/q/a.sdoc", "/p"), "/q/a.sdoc");
  });

  // ============================================================
  console.log("\n--- Discovery ---");

  // lines: every note; quiet: those the session shows already, kept out of
  // it with the verbose option.
  function withLog(io) {
    const lines = [];
    const quiet = [];
    return { io: { ...io, log: (text, opts = {}) => { lines.push(text); if (opts.quiet) quiet.push(text); } }, lines, quiet };
  }

  const tree = memoryIo({
    "/p/lexica/a.sdoc": GUIDED,
    "/p/lexica/sub/b.sdoc": PLAIN,
    "/p/lexica/notes.txt": "x",
    "/p/app/lexica/c.sdoc": PLAIN,
    "/p/node_modules/pkg/lexica/d.sdoc": PLAIN,
    "/p/.hidden/lexica/e.sdoc": PLAIN,
    "/p/src/main.js": "x"
  });

  await test("findKnowledgeDirs finds nested lexica/ dirs and skips node_modules and dot dirs", async () => {
    assertEqual(await kb.findKnowledgeDirs("/p", tree.list), ["/p/app/lexica", "/p/lexica"]);
  });

  await test("a lexica/ directory with no .sdoc file in it is not a knowledge tree", async () => {
    const io = memoryIo({ "/r/skills/lexica/SKILL.md": "x", "/r/docs/lexica/deep/a.sdoc": PLAIN });
    assertEqual(await kb.findKnowledgeDirs("/r", io.list), ["/r/docs/lexica"]);
  });

  await test("findKnowledgeDirs stops after maxDirs listings", async () => {
    assertEqual(await kb.findKnowledgeDirs("/p", tree.list, { maxDirs: 1 }), ["/p/lexica"]);
  });

  await test("findSdocFiles walks subdirectories and keeps only .sdoc files", async () => {
    assertEqual(await kb.findSdocFiles("/p/lexica", tree.list), ["/p/lexica/a.sdoc", "/p/lexica/sub/b.sdoc"]);
  });

  await test("findKnowledgeDirs finds this repository's lexica/ on disk", async () => {
    assertEqual(await kb.findKnowledgeDirs(ROOT, nodeIo.list), [path.join(ROOT, "lexica")]);
  });

  await test("listFiles describes each file by type, title, about and size", async () => {
    const files = await kb.listFiles(["/p/lexica"], tree);
    assertEqual(files.map((f) => [f.path, f.type, f.title, f.about]), [
      ["/p/lexica/a.sdoc", "doc", "Guided", "A guided file."],
      ["/p/lexica/sub/b.sdoc", "doc", "Other", "Plain file."]
    ]);
  });

  await test("outlineText lines up with listSections and gives each scope's line range", () => {
    const o = kb.outlineText(GUIDED, "/p/lexica/a.sdoc");
    const listed = sdoc.listSections(sdoc.parseSdoc(GUIDED).nodes);
    assertEqual(o.sections.map((s) => s.id || s.derivedId), listed.map((s) => s.id || s.derivedId));
    const lines = GUIDED.split("\n");
    for (const s of o.sections) {
      assert(lines[s.lineStart - 1].includes("# " + s.title), `heading of ${s.title} at ${s.lineStart}`);
      assert(lines[s.lineEnd - 1].trim() === "}", `closing brace of ${s.title} at ${s.lineEnd}`);
    }
    assertEqual(o.sections.map((s) => s.depth), [0, 0, 1]);
    assertEqual(o.signposts, ["about", "related-resources", "reading-guide", "editing-guide"]);
  });

  await test("outlineText agrees with listSections on every .sdoc file in the repo", async () => {
    for (const file of await kb.findSdocFiles(path.join(ROOT, "docs"), nodeIo.list)) {
      const text = fs.readFileSync(file, "utf8");
      const ids = kb.outlineText(text, file).sections.map((s) => s.derivedId);
      assertEqual(ids, sdoc.listSections(sdoc.parseSdoc(text).nodes).map((s) => s.derivedId), file);
    }
  });

  await test("readSectionText returns a section's source by @id, #id or title slug", () => {
    const byId = kb.readSectionText(GUIDED, "details");
    assert(byId.source.startsWith("    # Details @details") && byId.source.trimEnd().endsWith("}"), byId.source);
    assert(byId.source.includes("Nested text."), "nested sections are part of the source");
    assertEqual(kb.readSectionText(GUIDED, "@intro").lineStart, kb.readSectionText(GUIDED, "#intro").lineStart);
    assertEqual(kb.readSectionText(GUIDED, "deeper").title, "Deeper");
    assertEqual(kb.readSectionText(GUIDED, "Deeper").title, "Deeper");
    assertEqual(kb.readSectionText(GUIDED, "missing"), null);
  });

  await test("readSectionText with text: true flattens to plain text", () => {
    const section = kb.readSectionText(GUIDED, "intro", { text: true });
    assertEqual(section.content, "Hello there.");
    assert(!("source" in section));
  });

  await test("the document's own id, or its title slug, reads the whole file", () => {
    const whole = kb.readSectionText(GUIDED, "guided");
    assert(whole.whole && whole.lineStart === 1, JSON.stringify(whole));
    assert(whole.source.startsWith("# Guided @guided") && whole.source.includes("Nested text."), whole.source);
    assertEqual(kb.readSectionText(GUIDED, "#Guided").lineEnd, whole.lineEnd, "the title slug ignores case");
    const text = kb.readSectionText(GUIDED, "guided", { text: true }).content;
    assert(text.startsWith("Intro\nHello there.") && text.includes("Details\n"), text);
    assertEqual(kb.readSectionText(GUIDED, "intro").whole, false);
  });

  await test("the outline names the document's id", () => {
    const o = kb.outlineText(GUIDED, "/p/a.sdoc");
    assertEqual(o.id, "guided");
    assert(kb.formatOutline(o, { base: "/p" }).startsWith("a.sdoc @guided — Guided ("), kb.formatOutline(o));
  });

  await test("searchTexts needs every word, reports the deepest section, and ranks titles first", () => {
    const docs = [{ path: "/p/a.sdoc", text: GUIDED }, { path: "/p/b.sdoc", text: PLAIN }];
    const hits = kb.searchTexts(docs, "brace SCOPING");
    assertEqual(hits.map((h) => [h.path, h.id]), [["/p/a.sdoc", "details"]]);
    assertEqual(kb.searchTexts(docs, "nested").map((h) => h.title), ["Deeper"]);
    assertEqual(kb.searchTexts(docs, "brace nowhere"), []);
    assertEqual(kb.searchTexts(docs, "plain")[0].id, "about");
    assertEqual(kb.searchTexts(docs, "   "), []);
  });

  await test("guidesText reads the reading guide, related resources and editing guide", () => {
    const g = kb.guidesText(GUIDED);
    assertEqual(g.about, "A guided file.");
    assertEqual(g.readingGuide.entries.map((e) => e.sections), [["intro"]]);
    assertEqual(g.relatedResources.map((r) => r.href), ["other.sdoc", "https://example.com"]);
    assertEqual(g.editingGuide, "Keep sections short.");
    assertEqual(kb.guidesText(PLAIN), { about: "Plain file.", readingGuide: null, relatedResources: null, editingGuide: null });
  });

  await test("checkTextAsync finds what checkText finds, links included", async () => {
    const text = doc({ body: "    # A @a\n    {\n        See [x](missing.sdoc), [y](here.sdoc) and @nowhere.\n    }" });
    const exists = (href) => href === "here.sdoc";
    const sync = kb.checkText(text, { resolveFilePath: exists });
    const async = await kb.checkTextAsync(text, { resolveFilePath: async (href) => exists(href) });
    assertEqual(async, sync);
    assertEqual(sync.map((f) => f.type).sort(), ["broken-link", "broken-ref"]);
  });

  await test("formatReadingGuides gives related files by their path from the base", () => {
    const text = kb.formatReadingGuides("/p/lexica/a.sdoc", kb.guidesText(GUIDED), { base: "/p" });
    assert(text.includes("Other (lexica/other.sdoc): Sibling"), text);
    assert(text.includes("Upstream (https://example.com): Source"), text);
    assert(text.includes("- @intro: First"), text);
  });

  // ============================================================
  console.log("\n--- The mod: index ---");

  await test("no index for a project without lexica/", async () => {
    assertEqual(await handlers.knowledgeIndex(memoryIo({ "/q/README.md": "x" }), "/q"), null);
  });

  await test("the index lists each knowledge file with its about, and the tools to use", async () => {
    const index = await handlers.knowledgeIndex(tree, "/p");
    assert(index.includes("lexica/a.sdoc [doc]") && index.includes("A guided file."), index);
    assert(index.includes("app/lexica/c.sdoc"), index);
    assert(index.includes("mcp__sdoc-lexica__outline") && index.includes("mcp__sdoc-lexica__read"), index);
    assert(!index.includes("node_modules"), index);
  });

  await test("the index goes with the first prompt only, and again after a reset", async () => {
    const state = handlers.createState();
    assert(await handlers.indexForPrompt(tree, state, "/p"));
    assertEqual(await handlers.indexForPrompt(tree, state, "/p"), null);
    handlers.resetState(state);
    assert(await handlers.indexForPrompt(tree, state, "/p"));
  });

  function longAbout(i) {
    return doc({ id: "f" + i, signposts: "    @about {\n        " + "Long summary words ".repeat(20) + "\n    }", body: "    # A @a\n    {\n        x\n    }" });
  }

  function lexicaOf(count, text) {
    const files = {};
    for (let i = 0; i < count; i++) files[`/p/lexica/f-${String(i).padStart(3, "0")}.sdoc`] = text(i);
    return files;
  }

  const LONG_ABOUT = "Long summary words ".repeat(20).trim();

  await test("indexSize maps 6k, 12k and 24k to characters, and anything else to 12k", () => {
    assertEqual(["6k", "12k", "24k"].map(handlers.indexBudget), [6000, 12000, 24000]);
    assertEqual([undefined, "", "48k"].map(handlers.indexBudget), [12000, 12000, 12000]);
  });

  await test("with room, every file is listed with its summary whole", async () => {
    const index = await handlers.knowledgeIndex(memoryIo(lexicaOf(20, longAbout)), "/p", { maxChars: 24000 });
    assert(index.includes("lexica/f-019.sdoc"), "every file");
    assertEqual(index.split(LONG_ABOUT).length - 1, 20, "every summary, whole");
    assert(!index.includes("…"), "nothing cut short");
  });

  await test("when the summaries do not fit, every file is listed by title, and no summary is cut", async () => {
    const { io, lines } = withLog(memoryIo(lexicaOf(30, longAbout)));
    const index = await handlers.knowledgeIndex(io, "/p", { maxChars: 6000 });
    assert(index.length <= 6000, "length " + index.length);
    assert(index.includes("lexica/f-029.sdoc [doc] (16 lines) — Doc"), "every file, by title");
    assert(!index.includes("Long summary"), "no summary at all, rather than a clipped one");
    assert(index.includes("(Titles only: the summaries did not fit."), index.slice(-200));
    assert(lines[0].endsWith("of 6000 chars; titles only)"), lines[0]);
  });

  await test("only when titles alone do not fit are files left out, and counted", async () => {
    for (const maxChars of [6000, 12000]) {
      const index = await handlers.knowledgeIndex(memoryIo(lexicaOf(400, () => PLAIN)), "/p", { maxChars });
      assert(index.length <= maxChars, `length ${index.length} over ${maxChars}`);
      assert(/… and \d+ more files\. mcp__sdoc-lexica__list shows them all/.test(index), index.slice(-200));
    }
  });

  await test("the list tool shows each summary whole", async () => {
    const { text } = await handlers.runTool(memoryIo(lexicaOf(3, longAbout)), "list", {}, { cwd: "/p" });
    assertEqual(text.split(LONG_ABOUT).length - 1, 3);
  });

  // ============================================================
  console.log("\n--- The mod: Read ---");

  await test("the first Read of a file adds its reading guide and related resources, once", async () => {
    const state = handlers.createState();
    const first = await handlers.afterRead(tree, state, { filePath: "/p/lexica/a.sdoc", cwd: "/p" });
    assert(first && first.includes("Reading guide:") && first.includes("Related resources:"), first);
    assert(!first.includes("Keep sections short."), "the editing guide waits for an edit");
    assertEqual(await handlers.afterRead(tree, state, { filePath: "/p/lexica/a.sdoc", cwd: "/p" }), null);
  });

  await test("each agent is shown the guides on its own first Read", async () => {
    const state = handlers.createState();
    await handlers.afterRead(tree, state, { filePath: "/p/lexica/a.sdoc", cwd: "/p" });
    assert(await handlers.afterRead(tree, state, { filePath: "/p/lexica/a.sdoc", agentId: "sub-1", cwd: "/p" }));
  });

  await test("a small file with no reading signposts adds nothing", async () => {
    assertEqual(await handlers.afterRead(tree, handlers.createState(), { filePath: "/p/lexica/sub/b.sdoc", cwd: "/p" }), null);
  });

  await test("a large file read whole gets its outline once; a ranged Read gets none", async () => {
    const io = memoryIo({ "/p/lexica/big.sdoc": bigDoc(40) });
    const state = handlers.createState();
    const ranged = await handlers.afterRead(io, state, { filePath: "/p/lexica/big.sdoc", offset: 1, limit: 50, cwd: "/p" });
    assertEqual(ranged, null);
    const whole = await handlers.afterRead(io, state, { filePath: "/p/lexica/big.sdoc", cwd: "/p" });
    assert(whole && whole.includes("was read whole") && whole.includes("@part-39"), whole);
    assertEqual(await handlers.afterRead(io, state, { filePath: "/p/lexica/big.sdoc", cwd: "/p" }), null);
  });

  await test("a Read of a missing file adds nothing", async () => {
    assertEqual(await handlers.afterRead(tree, handlers.createState(), { filePath: "/p/none.sdoc", cwd: "/p" }), null);
  });

  // ============================================================
  console.log("\n--- The mod: Edit ---");

  await test("the first edit of a file with an editing guide is refused with the guide; the retry goes through", async () => {
    const state = handlers.createState();
    const first = await handlers.beforeEdit(tree, state, { filePath: "/p/lexica/a.sdoc", cwd: "/p" });
    assert(first.deny && first.deny.includes("Keep sections short.") && first.deny.includes("lexica/a.sdoc"), JSON.stringify(first));
    const second = await handlers.beforeEdit(tree, state, { filePath: "/p/lexica/a.sdoc", cwd: "/p" });
    assert(!second.deny && Array.isArray(second.snapshot), JSON.stringify(second));
  });

  await test("each agent is refused once; a reset (compaction, /clear) refuses again", async () => {
    const state = handlers.createState();
    await handlers.beforeEdit(tree, state, { filePath: "/p/lexica/a.sdoc", cwd: "/p" });
    assert((await handlers.beforeEdit(tree, state, { filePath: "/p/lexica/a.sdoc", agentId: "sub-1", cwd: "/p" })).deny);
    handlers.resetState(state);
    assert((await handlers.beforeEdit(tree, state, { filePath: "/p/lexica/a.sdoc", cwd: "/p" })).deny);
  });

  await test("a file with no editing guide, or a new file, is never refused", async () => {
    const state = handlers.createState();
    assert(!(await handlers.beforeEdit(tree, state, { filePath: "/p/lexica/sub/b.sdoc", cwd: "/p" })).deny);
    assertEqual(await handlers.beforeEdit(tree, state, { filePath: "/p/lexica/new.sdoc", cwd: "/p" }), { snapshot: [] });
  });

  await test("after an edit, only the findings the edit added are reported", async () => {
    const io = memoryIo({ "/p/x.sdoc": doc({ body: "    # A @a\n    {\n        See @nowhere.\n    }" }) });
    const state = handlers.createState();
    const { snapshot } = await handlers.beforeEdit(io, state, { filePath: "/p/x.sdoc", cwd: "/p" });
    assertEqual(snapshot.length, 1, "the file starts with one broken reference");
    io.write("/p/x.sdoc", doc({ body: "\n\n    # A @a\n    {\n        See @nowhere.\n    }" }));
    assertEqual(await handlers.afterEdit(io, { filePath: "/p/x.sdoc", snapshot, cwd: "/p" }), null, "moving it down adds nothing");
    io.write("/p/x.sdoc", doc({ body: "    # A @a\n    {\n        See @nowhere and @elsewhere.\n\n    # B {\n        Unclosed.\n    }" }));
    const report = await handlers.afterEdit(io, { filePath: "/p/x.sdoc", snapshot, cwd: "/p" });
    assert(report && report.includes("x.sdoc:") && report.includes("@elsewhere") && report.includes("Fix the errors"), report);
    assert(!report.includes("@nowhere"), "the finding that was there before is not reported");
  });

  // A file whose editing guide links to a section of another file, and to
  // one of its own.
  function linking(guide) {
    return doc({
      id: "spec",
      signposts: `    @editing-guide {\n        ${guide}\n    }`,
      body: "    # Body @body\n    {\n        Words.\n    }\n\n    # Local @local\n    {\n        Keep it local.\n    }"
    });
  }
  const RULES = doc({ id: "rules", body: "    # Spec Rules @spec-rules\n    {\n        Purpose holds the role only.\n    }\n\n    # Long @long\n    {\n" +
    "        " + "Very long rule text. ".repeat(400) + "\n    }" });

  await test("a first edit is refused with the sections the editing guide links to, whole", async () => {
    const io = memoryIo({
      "/p/lexica/specs/x.sdoc": linking("Follow [the rules](../skills/rules.sdoc#spec-rules) and [local](#local), not [web](https://example.com/a.sdoc#b)."),
      "/p/lexica/skills/rules.sdoc": RULES
    });
    const { deny } = await handlers.beforeEdit(io, handlers.createState(), { filePath: "/p/lexica/specs/x.sdoc", cwd: "/p" });
    assert(deny.includes("Editing guide:\nFollow [the rules]"), deny);
    assert(deny.includes("The sections the guide links to:"), deny);
    assert(deny.includes("lexica/skills/rules.sdoc L") && deny.includes("Purpose holds the role only."), deny);
    assert(deny.includes("Keep it local."), "a section of the file itself");
    assert(!deny.includes("example.com/a.sdoc L"), "a web link is not followed");
  });

  await test("a linked section too long to include is named with its range, never cut", async () => {
    const io = memoryIo({ "/p/x.sdoc": linking("See [long](rules.sdoc#long)."), "/p/rules.sdoc": RULES });
    const { text, count } = await handlers.linkedSections(io, "/p/x.sdoc", "See [long](rules.sdoc#long).", "/p");
    assertEqual(count, 1);
    assert(/rules\.sdoc @long \(L\d+-\d+\): too long to include; read it with mcp__sdoc-lexica__read/.test(text), text);
    assert(!text.includes("Very long rule text."), "nothing of it, rather than a part");
    assert(text.length < 400, "length " + text.length);
  });

  await test("a guide's link out of the project, through a path or a link, is not followed", async () => {
    const io = memoryIo({ "/p/x.sdoc": PLAIN, "/p/lexica/link.sdoc": RULES, "/elsewhere/rules.sdoc": RULES });
    const out = await handlers.linkedSections(io, "/p/x.sdoc", "[a](../elsewhere/rules.sdoc#spec-rules)", "/p");
    assertEqual(out, { text: "", count: 0 });
    const linked = { ...io, realPath: async (p) => p === "/p/lexica/link.sdoc" ? "/elsewhere/rules.sdoc" : p };
    assertEqual((await handlers.linkedSections(linked, "/p/x.sdoc", "[a](lexica/link.sdoc#spec-rules)", "/p")).count, 0);
    assertEqual((await handlers.linkedSections(io, "/p/x.sdoc", "[a](lexica/link.sdoc#spec-rules) [b](lexica/link.sdoc#nowhere)", "/p")).count, 1,
      "the same file without the link is followed; a missing section is passed over");
  });

  await test("an edit that leaves the file clean reports nothing", async () => {
    const io = memoryIo({ "/p/x.sdoc": PLAIN });
    const { snapshot } = await handlers.beforeEdit(io, handlers.createState(), { filePath: "/p/x.sdoc", cwd: "/p" });
    io.write("/p/x.sdoc", PLAIN.replace("Text.", "More text."));
    assertEqual(await handlers.afterEdit(io, { filePath: "/p/x.sdoc", snapshot, cwd: "/p" }), null);
  });

  await test("a broken link is reported; a percent-encoded link to a file that exists is not", async () => {
    const io = memoryIo({ "/p/a b.sdoc": PLAIN, "/p/x.sdoc": PLAIN });
    io.write("/p/x.sdoc", doc({ body: "    # A @a\n    {\n        [ok](a%20b.sdoc) [gone](gone.sdoc)\n    }" }));
    const report = await handlers.afterEdit(io, { filePath: "/p/x.sdoc", snapshot: [], cwd: "/p" });
    assert(report.includes("gone.sdoc") && !report.includes("a%20b"), report);
  });

  // ============================================================
  console.log("\n--- The mod: Bash ---");

  await test("a command's .sdoc paths: as written, after a cd, in a script; no globs, no lookalikes", () => {
    assertEqual(handlers.sdocPathsIn("sed -i '' 's/a/b/' lexica/a.sdoc", "/p"), ["/p/lexica/a.sdoc"]);
    assertEqual(handlers.sdocPathsIn("cd lexica && sed -i 's/a/b/' sub/b.sdoc ../c.sdoc", "/p"), ["/p/lexica/sub/b.sdoc", "/p/c.sdoc"]);
    assertEqual(handlers.sdocPathsIn("cd \"/q/my dir\"; perl -pi -e 's/a/b/' x.sdoc", "/p"), ["/q/my dir/x.sdoc"]);
    assertEqual(handlers.sdocPathsIn("python - <<'EOF'\nimport pathlib\np = pathlib.Path(\"lexica/specs/asr.sdoc\")\np.write_text(p.read_text())\nEOF", "/p"),
      ["/p/lexica/specs/asr.sdoc"]);
    assertEqual(handlers.sdocPathsIn("grep -n x lexica/*.sdoc ~/a.sdoc a.sdoc.bak a.sdocs", "/p"), []);
    assertEqual(handlers.sdocPathsIn("echo see a.sdoc#intro --file=/abs/b.sdoc a.sdoc", "/p"), ["/p/a.sdoc", "/abs/b.sdoc"]);
    const many = Array.from({ length: 30 }, (_, i) => `f${i}.sdoc`).join(" ");
    assertEqual(handlers.sdocPathsIn("cat " + many, "/p").length, handlers.MAX_BASH_FILES);
  });

  await test("a command that changes a guided file gets the guide after the change, once, and the findings it added", async () => {
    const io = memoryIo({ "/p/lexica/a.sdoc": GUIDED });
    const state = handlers.createState();
    let snapshot = await handlers.beforeBash(io, { command: "sed -i '' 's/Hello/Hi/' lexica/a.sdoc", cwd: "/p" });
    io.write("/p/lexica/a.sdoc", GUIDED.replace("Hello there.", "Hi @nowhere."));
    const first = await handlers.afterBash(io, state, { snapshot, cwd: "/p" });
    assert(first.includes("This command changed lexica/a.sdoc, which has an editing guide") && first.includes("Keep sections short."), first);
    assert(first.includes("The command added 1 finding to lexica/a.sdoc.") && first.includes("@nowhere"), first);
    assert(!first.includes("other.sdoc"), "the broken link that was there before is not reported");
    snapshot = await handlers.beforeBash(io, { command: "sed -i '' 's/Hi/Hey/' lexica/a.sdoc", cwd: "/p" });
    io.write("/p/lexica/a.sdoc", GUIDED.replace("Hello there.", "Hey @nowhere."));
    assertEqual(await handlers.afterBash(io, state, { snapshot, cwd: "/p" }), null, "the guide once; no new finding");
  });

  await test("a command that changes nothing, or only reads, adds nothing", async () => {
    const { io, lines, quiet } = withLog(memoryIo({ "/p/lexica/a.sdoc": GUIDED }));
    const state = handlers.createState();
    const snapshot = await handlers.beforeBash(io, { command: "grep -n Hello lexica/a.sdoc lexica/none.sdoc", cwd: "/p" });
    assertEqual(snapshot.size, 2);
    assertEqual(await handlers.afterBash(io, state, { snapshot, cwd: "/p" }), null);
    assertEqual(lines, ["Bash named 2 .sdoc files and changed none"]);
    assertEqual(quiet, lines, "kept out of the session: nothing happened");
    assert(!state.editAcked.size, "reading is not editing: the guide still comes with the first edit");
  });

  await test("a file a command creates has all its findings reported, as new", async () => {
    const io = memoryIo({});
    const snapshot = await handlers.beforeBash(io, { command: "cat > lexica/n.sdoc <<'EOF'", cwd: "/p" });
    io.write("/p/lexica/n.sdoc", doc({ body: "    # A @a\n    {\n        See @nowhere.\n    }" }));
    const report = await handlers.afterBash(io, handlers.createState(), { snapshot, cwd: "/p" });
    assert(report && report.includes("@nowhere") && !report.includes("editing guide"), report);
  });

  await test("Edit and Bash share one guide per agent and file", async () => {
    const io = memoryIo({ "/p/lexica/a.sdoc": GUIDED });
    const state = handlers.createState();
    assert((await handlers.beforeEdit(io, state, { filePath: "/p/lexica/a.sdoc", cwd: "/p" })).deny);
    let snapshot = await handlers.beforeBash(io, { command: "sed -i 's/Hello/Hi/' lexica/a.sdoc", cwd: "/p" });
    io.write("/p/lexica/a.sdoc", GUIDED.replace("Hello", "Hi"));
    assertEqual(await handlers.afterBash(io, state, { snapshot, cwd: "/p" }), null, "shown by the refused Edit");
    snapshot = await handlers.beforeBash(io, { command: "sed -i 's/Hi/Hey/' lexica/a.sdoc", cwd: "/p" });
    io.write("/p/lexica/a.sdoc", GUIDED.replace("Hello", "Hey"));
    assert((await handlers.afterBash(io, state, { snapshot, agentId: "sub-1", cwd: "/p" })).includes("Keep sections short."), "a subagent gets its own");
    assert(!(await handlers.beforeEdit(io, state, { filePath: "/p/lexica/a.sdoc", agentId: "sub-1", cwd: "/p" })).deny, "and is then not refused");
  });

  await test("the hooks module watches Bash, and none of the events a user plugin is passed over on", () => {
    const source = fs.readFileSync(path.join(PLUGIN, "hooks", "register.mjs"), "utf8");
    assert(/on\("tool\.call", \{ tool: "Bash", command: NAMES_SDOC \}/.test(source), "Bash");
    for (const event of ["prompt.context", "session.compact", "session.append"]) {
      assert(!source.includes(`on("${event}"`), event);
    }
  });

  // ============================================================
  console.log("\n--- The mod: compaction ---");

  const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
  const reply = { role: "assistant", content: [{ type: "text", text: "OK" }] };

  await test("a conversation that keeps its opening message keeps what it was shown", () => {
    const state = handlers.createState();
    assertEqual(handlers.lostOpening(state, handlers.openingOf([])), false, "the first prompt: nothing yet");
    assertEqual(handlers.lostOpening(state, handlers.openingOf([user("hi")])), false);
    assertEqual(handlers.lostOpening(state, handlers.openingOf([user("hi"), reply, user("more")])), false);
  });

  await test("a compaction (a summary in its place) or a /clear (no message) loses the opening, once", () => {
    const state = handlers.createState();
    handlers.lostOpening(state, handlers.openingOf([user("hi"), reply]));
    assertEqual(handlers.lostOpening(state, handlers.openingOf([user("This session is being continued…"), reply])), true);
    assertEqual(handlers.lostOpening(state, handlers.openingOf([user("This session is being continued…"), reply, user("next")])), false);
    assertEqual(handlers.lostOpening(state, handlers.openingOf([])), true, "cleared");
    assertEqual(handlers.lostOpening(state, handlers.openingOf([user("new start")])), false);
  });

  await test("the opening is told by its whole content, not its first words", () => {
    const head = "<claude-md> the same project instructions </claude-md> ".repeat(50);
    assert(handlers.openingOf([user(head + "first prompt")]) !== handlers.openingOf([user(head + "summary")]));
  });

  // ============================================================
  console.log("\n--- The mod: tools ---");

  const run = (name, input) => handlers.runTool(tree, name, input, { cwd: "/p" });

  await test("list, with no dirs, covers every lexica/ directory", async () => {
    const { text } = await run("list", {});
    assert(text.includes("lexica/a.sdoc") && text.includes("app/lexica/c.sdoc"), text);
  });

  await test("outline and read work from a path relative to the project", async () => {
    const { text: outline } = await run("outline", { file: "lexica/a.sdoc" });
    assert(outline.includes("@intro Intro") && /L\d+-\d+ @details/.test(outline), outline);
    const { text } = await run("read", { file: "lexica/a.sdoc", ids: ["intro", "nope"] });
    assert(/^\s+34\t\s+Hello there\./m.test(text), text);
    assert(text.includes('No section "nope"'), text);
  });

  await test("read of an unknown id answers the ids the file has", async () => {
    const { text } = await run("read", { file: "lexica/a.sdoc", ids: ["nope"] });
    assertEqual(text, 'No section "nope" in lexica/a.sdoc. Its ids: @guided (the whole file), @intro, @details, deeper.');
  });

  await test("read of the file's own id answers the whole file, or a large file's outline", async () => {
    const { text } = await run("read", { file: "lexica/a.sdoc", ids: ["guided"] });
    assert(/^lexica\/a\.sdoc L1-\d+ — Guided\n\s+1\t# Guided @guided/.test(text) && text.includes("Nested text."), text);
    const big = await handlers.runTool(memoryIo({ "/p/big.sdoc": bigDoc(40) }), "read", { file: "big.sdoc", ids: ["big"] }, { cwd: "/p" });
    assert(big.text.startsWith("big.sdoc has ") && big.text.includes("so here is its outline") && big.text.includes("@part-39"), big.text);
    assert(!big.text.includes("Line of text.\n"), "an outline, one line per section, not the source");
  });

  await test("read says how to edit what it shows: Read those lines first", () => {
    const read = handlers.TOOLS.find((t) => t.name === "read");
    assert(read.description.includes("Read its lines first") && !read.description.includes("edited from"), read.description);
  });

  await test("read takes ids as a comma-separated string too", async () => {
    const { text } = await run("read", { file: "lexica/a.sdoc", ids: "intro, details" });
    assert(text.includes("Hello there.") && text.includes("brace scoping"), text);
  });

  await test("search, guides and check answer in text", async () => {
    assert((await run("search", { query: "brace scoping" })).text.includes("@details"));
    assert((await run("guides", { file: "lexica/a.sdoc" })).text.includes("Editing guide:\nKeep sections short."));
    assert((await run("check", { files: ["lexica/a.sdoc"] })).text.includes("lexica/a.sdoc:"), "a.sdoc links to a missing other.sdoc");
    assert((await run("check", { files: ["lexica/sub/b.sdoc"] })).text.includes("no findings"));
  });

  await test("the first outline or read of a file carries its reading guide, once per agent", async () => {
    const state = handlers.createState();
    const ctx = { cwd: "/p", state };
    const outline = (await handlers.runTool(tree, "outline", { file: "lexica/a.sdoc" }, ctx)).text;
    assert(outline.includes("Reading guide:") && outline.includes("Related resources:"), outline);
    const read = (await handlers.runTool(tree, "read", { file: "lexica/a.sdoc", ids: ["intro"] }, ctx)).text;
    assert(!read.includes("Reading guide:"), "already shown by the outline");
    const sub = (await handlers.runTool(tree, "read", { file: "lexica/a.sdoc", ids: ["intro"] }, { ...ctx, agentId: "sub-1" })).text;
    assert(sub.includes("Reading guide:"), "a subagent gets its own");
  });

  await test("a file met through a tool is not given its guides again on Read, nor after the guides tool", async () => {
    const state = handlers.createState();
    await handlers.runTool(tree, "read", { file: "lexica/a.sdoc", ids: ["intro"] }, { cwd: "/p", state });
    assertEqual(await handlers.afterRead(tree, state, { filePath: "/p/lexica/a.sdoc", cwd: "/p" }), null);
    const other = handlers.createState();
    await handlers.runTool(tree, "guides", { file: "lexica/a.sdoc" }, { cwd: "/p", state: other });
    assert(!(await handlers.runTool(tree, "outline", { file: "lexica/a.sdoc" }, { cwd: "/p", state: other })).text.includes("Reading guide:"));
  });

  await test("without the conversation's state, a tool adds no signposts", async () => {
    assert(!(await handlers.runTool(tree, "outline", { file: "lexica/a.sdoc" }, { cwd: "/p" })).text.includes("Reading guide:"));
  });

  await test("a tool given a missing file or no lexica/ answers an error", async () => {
    assert((await run("outline", { file: "nope.sdoc" })).error.includes("No such file"));
    const { error } = await handlers.runTool(memoryIo({}), "list", {}, { cwd: "/q" });
    assert(error && error.includes("No lexica/"), error);
  });

  await test("a tool call is answered only when every path it names is inside a root", () => {
    const roots = ["/p", "/plugin"];
    assert(handlers.isWithin("outline", { file: "lexica/a.sdoc" }, "/p", roots));
    assert(handlers.isWithin("read", { file: "/plugin/skills/authoring/reference/sdoc-authoring.sdoc" }, "/p", roots));
    assert(handlers.isWithin("list", {}, "/p", roots));
    assert(!handlers.isWithin("outline", { file: "../etc/x.sdoc" }, "/p", roots));
    assert(!handlers.isWithin("check", { files: ["a.sdoc", "/etc/b.sdoc"] }, "/p", roots));
    assert(!handlers.isWithin("search", { query: "x", dirs: ["/"] }, "/p", roots));
    assert(!handlers.isWithin("delete", { file: "a.sdoc" }, "/p", roots));
  });

  // ============================================================
  console.log("\n--- The mod: notes (the verbose option) ---");


  await test("the verbose option is declared, off by default", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8"));
    const field = manifest.userConfig && manifest.userConfig.verbose;
    assert(field, "no userConfig.verbose");
    assertEqual([field.type, field.default], ["boolean", false]);
  });

  await test("the indexSize option offers exactly the sizes the handlers know, 12k by default", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8"));
    const field = manifest.userConfig && manifest.userConfig.indexSize;
    assert(field, "no userConfig.indexSize");
    assertEqual([field.type, field.options, field.default], ["string", Object.keys(handlers.INDEX_SIZES), handlers.DEFAULT_INDEX_SIZE]);
    assertEqual(handlers.DEFAULT_INDEX_SIZE, "12k");
  });

  await test("the index notes how many files it attached, or why there is none", async () => {
    const yes = withLog(tree);
    await handlers.indexForPrompt(yes.io, handlers.createState(), "/p");
    assert(/^index attached to the prompt: 3 knowledge files from app\/lexica, lexica \(\d+ of 12000 chars\)$/.test(yes.lines[0]), yes.lines[0]);
    const no = withLog(memoryIo({}));
    await handlers.indexForPrompt(no.io, handlers.createState(), "/q");
    assertEqual(no.lines, ["no index: no lexica/ directory with .sdoc files in this project"]);
  });

  await test("a Read notes what it added, and why it added nothing", async () => {
    const { io, lines } = withLog(tree);
    const state = handlers.createState();
    await handlers.afterRead(io, state, { filePath: "/p/lexica/a.sdoc", cwd: "/p" });
    await handlers.afterRead(io, state, { filePath: "/p/lexica/a.sdoc", cwd: "/p" });
    await handlers.afterRead(io, state, { filePath: "/p/lexica/sub/b.sdoc", agentId: "sub-1", cwd: "/p" });
    assertEqual(lines, [
      "Read lexica/a.sdoc: added its reading guide and related resources",
      "Read lexica/a.sdoc: nothing added (already shown in this conversation)",
      "Read lexica/sub/b.sdoc (agent sub-1): nothing added (no reading guide or related resources)"
    ]);
  });

  await test("an edit notes its refusal, then what the check found", async () => {
    const { io, lines } = withLog(memoryIo({ "/p/a.sdoc": GUIDED }));
    const state = handlers.createState();
    await handlers.beforeEdit(io, state, { filePath: "/p/a.sdoc", cwd: "/p" });
    const { snapshot } = await handlers.beforeEdit(io, state, { filePath: "/p/a.sdoc", cwd: "/p" });
    await handlers.afterEdit(io, { filePath: "/p/a.sdoc", snapshot, cwd: "/p" });
    const broken = memoryIo({ "/p/a.sdoc": GUIDED.replace("Hello there.", "Hello @nowhere.") });
    await handlers.afterEdit({ ...broken, log: io.log }, { filePath: "/p/a.sdoc", snapshot, cwd: "/p" });
    assertEqual(lines, [
      "Edit a.sdoc: refused once, with its editing guide",
      "Edit a.sdoc: checked, no new findings",
      "Edit a.sdoc: checked, reported 1 new finding"
    ]);
  });

  await test("a tool call notes its arguments and its answer, or its error", async () => {
    const { io, lines } = withLog(tree);
    await handlers.runTool(io, "outline", { file: "lexica/a.sdoc" }, { cwd: "/p" });
    await handlers.runTool(io, "search", { query: "brace" }, { cwd: "/p" });
    await handlers.runTool(io, "outline", { file: "nope.sdoc" }, { cwd: "/p" });
    assert(/^tool outline lexica\/a\.sdoc: answered \d+ chars$/.test(lines[0]), lines[0]);
    assert(/^tool search "brace": answered \d+ chars$/.test(lines[1]), lines[1]);
    assertEqual(lines[2], "tool outline nope.sdoc: error: No such file: nope.sdoc");
  });

  await test("a tool's plain answer is noted quietly; its error, or signposts it adds, are not", async () => {
    const { io, lines, quiet } = withLog(tree);
    const ctx = { cwd: "/p", state: handlers.createState() };
    await handlers.runTool(io, "outline", { file: "lexica/a.sdoc" }, ctx);
    await handlers.runTool(io, "outline", { file: "lexica/a.sdoc" }, ctx);
    await handlers.runTool(io, "outline", { file: "nope.sdoc" }, ctx);
    assert(lines[0].endsWith("with its reading guide and related resources"), lines[0]);
    assertEqual(quiet, [lines[1]]);
  });

  await test("a command's change notes what it was given", async () => {
    const { io, lines } = withLog(memoryIo({ "/p/a.sdoc": GUIDED }));
    const snapshot = await handlers.beforeBash(io, { command: "sed -i s/Hello/Hi/ a.sdoc", cwd: "/p" });
    io.write("/p/a.sdoc", GUIDED.replace("Hello", "Hi"));
    await handlers.afterBash(io, handlers.createState(), { snapshot, agentId: "sub-1", cwd: "/p" });
    assertEqual(lines, ["Bash changed a.sdoc (agent sub-1): its editing guide, after the change; no new findings"]);
  });

  await test("a log that throws never breaks a hook", async () => {
    const io = { ...tree, log: () => { throw new Error("boom"); } };
    assert(await handlers.afterRead(io, handlers.createState(), { filePath: "/p/lexica/a.sdoc", cwd: "/p" }));
  });

  // ============================================================
  console.log("\n--- Skills ---");

  // The engine names a skill after its folder (plugin:folder); the
  // frontmatter name does not override it, so the two must agree.
  const skills = ["authoring", "lexica"].map((name) => ({
    name,
    text: fs.readFileSync(path.join(PLUGIN, "skills", name, "SKILL.md"), "utf8")
  }));

  await test("each skill has a name and a description in its frontmatter", () => {
    for (const { name, text } of skills) {
      const front = text.match(/^---\n([\s\S]*?)\n---\n/);
      assert(front, name + ": no frontmatter");
      assert(new RegExp(`^name: ${name}$`, "m").test(front[1]), name + ": name");
      assert(/^description: .{40,}/m.test(front[1]), name + ": description");
    }
  });

  await test("the SDOC examples in the skills parse without error", () => {
    for (const { name, text } of skills) {
      const blocks = [...text.matchAll(/^```\n([\s\S]*?)^```$/gm)].map((m) => m[1]).filter((b) => b.trimStart().startsWith("#"));
      assert(blocks.length, name + ": no example");
      for (const block of blocks) {
        const findings = kb.checkText(block).filter((f) => f.severity === "error");
        assertEqual(findings.map((f) => f.message), [], name);
      }
    }
  });

  await test("every section id the authoring skill points at exists in the bundled guide", () => {
    const guide = fs.readFileSync(path.join(PLUGIN, "skills", "authoring", "reference", "sdoc-authoring.sdoc"), "utf8");
    const ids = new Set(kb.outlineText(guide, "guide").sections.map((s) => s.id));
    const table = skills[0].text.slice(skills[0].text.indexOf("## The full guide"));
    const cited = [...table.matchAll(/`([a-z][a-z0-9-]+)`/g)].map((m) => m[1]);
    assert(cited.length > 10, "cited " + cited.length);
    for (const id of cited) assert(ids.has(id), "no section @" + id);
  });

  // The engine names a tool mcp__<plugin name>__<tool>, so the names the
  // skills and the hooks' messages give change with the plugin's name.
  await test("the skills and the hooks name tools as the engine will, after the plugin's name", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8"));
    const prefix = `mcp__${manifest.name}__`;
    const names = new Set(handlers.TOOLS.map((t) => prefix + t.name));
    const sources = [...skills, { name: "handlers.mjs", text: fs.readFileSync(path.join(PLUGIN, "hooks", "handlers.mjs"), "utf8") }];
    let seen = 0;
    for (const { name, text } of sources) {
      for (const [tool] of text.matchAll(/mcp__[a-z0-9-]+__[a-z]+/g)) {
        assert(names.has(tool), `${name}: ${tool} is not ${prefix}<tool>`);
        seen++;
      }
    }
    assert(seen > 5, "found only " + seen);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
