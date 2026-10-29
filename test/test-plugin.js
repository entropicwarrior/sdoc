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

  // Node's process, not the engine's $.process (nor any other x.process).
  await test("nothing the hooks module loads touches Node (no require, fs, path or process)", () => {
    for (const rel of ["hooks/register.mjs", "hooks/handlers.mjs", "lib/knowledge-base.mjs"]) {
      const code = fs.readFileSync(path.join(PLUGIN, rel), "utf8").replace(/^\s*\/\/.*$/gm, "");
      assert(!/\brequire\s*\(|(?<![$\w]\.)\bprocess\.|from "(fs|path|os|node:[a-z]+)"|\bimport\s*\(/.test(code), rel);
    }
    assert(/(?<![$\w]\.)\bprocess\./.test("x(process.env)") && !/(?<![$\w]\.)\bprocess\./.test("$.process.run()"), "the pattern itself");
  });

  await test("the ES-module parser exports what src/sdoc.js does", () => {
    assertEqual(Object.keys(esmSdoc).sort(), Object.keys(sdoc).sort());
    assertEqual(Object.keys(esmKb).filter((k) => k !== "BUILD").sort(), Object.keys(kb).sort());
    assert(/^[0-9a-f]{12}$/.test(esmKb.BUILD), "and BUILD, the sources hashed: " + esmKb.BUILD);
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

  // memoryIo whose listing gives each file's size and time, as $.fs.list
  // does, and which counts its reads in counts.reads. write() moves a file's
  // time on; remove() deletes it.
  const T0 = 1700000000000;
  function statIo(files) {
    const io = memoryIo(files);
    const times = new Map();
    const counts = { reads: 0 };
    return {
      ...io,
      counts,
      read: async (p) => { counts.reads++; return io.read(p); },
      list: async (dir) => (await io.list(dir)).map((e) => {
        const full = dir.replace(/\/$/, "") + "/" + e.name;
        return e.kind === "file" ? { ...e, size: io.store[full].length, mtimeMs: times.get(full) || T0 } : { ...e, size: 0, mtimeMs: 0 };
      }),
      write(p, text) { io.write(p, text); times.set(p, (times.get(p) || T0) + 1000); },
      remove(p) { delete io.store[p]; }
    };
  }

  await test("findSdocEntries gives each file's size and time from the listing, in findSdocFiles' order", async () => {
    const io = statIo({ "/s/lexica/b.sdoc": PLAIN, "/s/lexica/a/z.sdoc": GUIDED, "/s/lexica/x.txt": "x" });
    const entries = await kb.findSdocEntries("/s/lexica", io.list);
    assertEqual(entries.map((e) => e.path), await kb.findSdocFiles("/s/lexica", io.list));
    assertEqual(entries, [
      { path: "/s/lexica/a/z.sdoc", size: GUIDED.length, mtimeMs: T0 },
      { path: "/s/lexica/b.sdoc", size: PLAIN.length, mtimeMs: T0 }
    ]);
    assertEqual((await kb.findSdocEntries("/p/lexica", tree.list)).map((e) => [e.path, e.size, e.mtimeMs]),
      [["/p/lexica/a.sdoc", undefined, undefined], ["/p/lexica/sub/b.sdoc", undefined, undefined]]);
  });

  await test("listFiles reads only the files its cache does not hold, keyed path|mtimeMs|size", async () => {
    const io = statIo({ "/s/lexica/a.sdoc": GUIDED, "/s/lexica/b.sdoc": PLAIN });
    const held = new Map();
    const cache = { get: (k) => held.get(k), set: async (k, d) => { held.set(k, d); } };
    const first = await kb.listFiles(["/s/lexica"], io, { cache });
    assertEqual(io.counts.reads, 2);
    assertEqual([...held.keys()], [`/s/lexica/a.sdoc|${T0}|${GUIDED.length}`, `/s/lexica/b.sdoc|${T0}|${PLAIN.length}`]);
    assertEqual(await kb.listFiles(["/s/lexica"], io, { cache }), first, "the same descriptions");
    assertEqual(io.counts.reads, 2, "none read again");
    io.write("/s/lexica/b.sdoc", PLAIN.replace("Plain file.", "Changed."));
    const third = await kb.listFiles(["/s/lexica"], io, { cache });
    assertEqual(io.counts.reads, 3, "only the changed file");
    assertEqual(third.map((f) => f.about), ["A guided file.", "Changed."]);
  });

  await test("listFiles caches nothing the listing gives no size or time for, and passes over a failing cache", async () => {
    const asked = [];
    const files = await kb.listFiles(["/p/lexica"], tree, { cache: { get: (k) => asked.push(k), set: (k) => asked.push(k) } });
    assertEqual([files.length, asked], [2, []]);
    const broken = { get: () => { throw new Error("x"); }, set: async () => { throw new Error("y"); } };
    const io = statIo({ "/s/lexica/a.sdoc": GUIDED });
    assertEqual((await kb.listFiles(["/s/lexica"], io, { cache: broken })).map((f) => f.title), ["Guided"]);
  });

  await test("formatAge says how long ago in the fewest words", () => {
    const now = 1800000000;
    const days = [0, 0.5, 1, 3, 13, 14, 21, 59, 60, 120, 364, 365, 800];
    assertEqual(days.map((d) => kb.formatAge(now - d * 86400, now)),
      ["today", "today", "1 day", "3 days", "13 days", "2 weeks", "3 weeks", "8 weeks", "2 months", "4 months", "12 months", "1 year", "2 years"]);
    assertEqual(kb.formatAge(now + 86400, now), "today", "a commit dated ahead of the clock");
  });

  await test("formatFileList gives titles instead of summaries, and an age only where one is known", async () => {
    const files = await kb.listFiles(["/p/lexica"], tree);
    const [a, b] = files;
    const now = 1800000000;
    assertEqual(kb.formatFileList(files, { base: "/p", titles: true }).split("\n"),
      [`lexica/a.sdoc [doc] (${a.lines} lines) — Guided`, `lexica/sub/b.sdoc [doc] (${b.lines} lines) — Other`]);
    const dated = [{ ...a, changed: now - 21 * 86400 }, { ...b, changed: now - 60 }];
    assertEqual(kb.formatFileList(dated, { base: "/p", now }).split("\n"), [
      `lexica/a.sdoc [doc] (${a.lines} lines, changed 3 weeks ago) — A guided file.`,
      `lexica/sub/b.sdoc [doc] (${b.lines} lines, changed today) — Plain file.`
    ]);
    assertEqual(kb.formatFileList(dated, { base: "/p", now, titles: true }).split("\n")[0], `lexica/a.sdoc [doc] (${a.lines} lines, changed 3 weeks ago) — Guided`);
    const plain = kb.formatFileList(files, { base: "/p" });
    assertEqual(kb.formatFileList(files, { base: "/p", now }), plain, "no time known, no age");
    assertEqual(kb.formatFileList(dated, { base: "/p" }), plain, "no now, no age");
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

  await test("a section's @id comes before the document's title slug: a section @overview in # Overview is that section", () => {
    const text = "# Overview @spec\n{\n    # Details @overview\n    {\n        Body.\n    }\n}\n";
    const section = kb.readSectionText(text, "overview");
    assertEqual([section.title, section.whole], ["Details", false]);
    assertEqual(kb.readSectionText(text, "spec").whole, true, "the document's own @id still names the file");
    assertEqual(kb.readSectionText(GUIDED, "Guided").whole, true, "and its title slug, when no section has it as an @id");
    const docs = [{ path: "/p/a.sdoc", text }, { path: "/p/b.sdoc", text: "# B @b\n{\n    [d](a.sdoc#overview) and [f](a.sdoc)\n}\n" }];
    assertEqual(kb.backlinksTexts(docs, "/p/a.sdoc", { id: "overview" }).section.title, "Details");
  });

  await test("the outline names the document's id", () => {
    const o = kb.outlineText(GUIDED, "/p/a.sdoc");
    assertEqual(o.id, "guided");
    assert(kb.formatOutline(o, { base: "/p" }).startsWith("a.sdoc @guided — Guided ("), kb.formatOutline(o));
  });

  await test("rankSections finds text outside any section: a root's own text, a file with no headed root", () => {
    const flat = "# Release @release\n{\n    Tag the build with a signed tag before upload.\n}\n";
    const found = kb.rankSections([{ path: "/p/r.sdoc", text: flat }], "signed tag");
    assertEqual(found.hits.map((h) => [h.id, h.title, h.line, h.lineStart, h.lineEnd]), [["release", "Release", 3, 1, 4]]);
    const preamble = doc({ body: "    A preamble on fsync.\n\n    # Part @part\n    {\n        Other words.\n    }" });
    assertEqual(kb.rankSections([{ path: "/p/x.sdoc", text: preamble }], "fsync").hits.map((h) => h.id), ["doc"]);
    assertEqual(kb.rankSections([{ path: "/p/x.sdoc", text: preamble }], "words").hits.map((h) => h.id), ["part"], "a section's text is its own");
    assertEqual(kb.rankSections([{ path: "/p/x.sdoc", text: preamble }], "doc").hits, [], "the root's heading is not its text");
    const loose = "Loose words on fsync.\n\n# A @a\n{\n    x\n}\n\n# B @b\n{\n    y\n}\n";
    const top = kb.rankSections([{ path: "/p/l.sdoc", text: loose }], "fsync").hits;
    assertEqual(top.map((h) => [h.id, h.derivedId, h.title, h.line]), [[null, null, "(top level)", 1]]);
    assertEqual(kb.formatSearch(top, { base: "/p" }), "l.sdoc:1 (top level) — Loose words on fsync.");
  });

  await test("rankSections takes a query's words without the quotes, brackets and punctuation around them", () => {
    const docs = [{ path: "/p/a.sdoc", text: GUIDED }];
    assertEqual(kb.rankSections(docs, '"brace", (scoping)?').terms, ["brace", "scoping"]);
    assertEqual(kb.rankSections(docs, '"brace", (scoping)?').hits.map((h) => [h.id, h.missing]), [["details", []]]);
    assertEqual(kb.rankSections(docs, "node.js build-doc --check @intro").terms, ["node.js", "build-doc", "--check", "@intro"], "inner punctuation stays");
    assertEqual(kb.rankSections(docs, "?! ...").terms, []);
  });

  await test("rankSections puts a short section above a long one that holds the word as often", () => {
    const text = doc({ body: "    # Long @long\n    {\n        A widget, " + "and other words ".repeat(30) + "\n    }\n\n    # Short @short\n    {\n        A widget.\n    }" });
    assertEqual(kb.rankSections([{ path: "/p/x.sdoc", text }], "widget").hits.map((h) => h.id), ["short", "long"]);
  });

  await test("rankSections weighs a word in a title, and a file's @about, above the same word in a body", () => {
    const text = doc({
      signposts: "    @about {\n        Notes on gadgets and more again here, twice.\n    }",
      body: "    # Body @body\n    {\n        Notes on gadgets and more.\n    }\n\n    # Gadgets @gadgets\n    {\n        Notes on things and more, all of them.\n    }"
    });
    const { hits } = kb.rankSections([{ path: "/p/x.sdoc", text }], "gadgets");
    assertEqual(hits.map((h) => h.id), ["gadgets", "about", "body"]);
    assertEqual([hits[1].line, hits[1].lineStart, hits[1].about], [9, 8, "Notes on gadgets and more again here, twice."], "the @about where it is written");
  });

  await test("rankSections falls back to the sections that hold the most words, each with the words it lacks", () => {
    const docs = [{ path: "/p/a.sdoc", text: GUIDED }, { path: "/p/b.sdoc", text: PLAIN }];
    const two = kb.rankSections(docs, "brace scoping nowhere");
    assertEqual([two.matched, two.terms, two.total], [2, ["brace", "scoping", "nowhere"], 1]);
    assertEqual(two.hits.map((h) => [h.id, h.missing]), [["details", ["nowhere"]]]);
    const one = kb.rankSections(docs, "hello nested nowhere");
    assertEqual(one.matched, 1);
    assertEqual(one.hits.map((h) => [h.id || h.derivedId, h.missing]).sort(), [["deeper", ["hello", "nowhere"]], ["intro", ["nested", "nowhere"]]]);
    assertEqual(kb.rankSections(docs, "brace scoping").hits.map((h) => [h.id, h.missing]), [["details", []]], "all words: no fallback");
    assertEqual(kb.rankSections(docs, "nowhere").hits, [], "one word held nowhere: nothing");
    assertEqual(kb.rankSections(docs, "zzz qqq").hits, [], "no word held: nothing");
  });

  await test("rankSections drops repeated and one-letter words, unless the query is only that", () => {
    const docs = [{ path: "/p/a.sdoc", text: GUIDED }];
    assertEqual(kb.rankSections(docs, "a Brace brace").terms, ["brace"]);
    assertEqual(kb.rankSections(docs, "x").terms, ["x"]);
    assertEqual(kb.rankSections(docs, "   "), { hits: [], total: 0, matched: 0, terms: [] });
  });

  await test("rankSections counts every match in total and keeps the best limit", () => {
    const docs = [{ path: "/p/big.sdoc", text: bigDoc(40) }];
    const found = kb.rankSections(docs, "line");
    assertEqual([found.total, found.hits.length], [40, 20]);
    assertEqual(kb.rankSections(docs, "line", { limit: 5 }).hits.length, 5);
  });

  // A file whose sections are linked to: from another directory, by @id and by
  // title slug, from a signpost and from outside any section; and from the
  // file itself, by @id reference and by #id link.
  const TARGET = doc({
    id: "target",
    title: "Target",
    signposts: "    @reading-guide {\n        {[table]\n            Sections | Note\n            @intro | Start here\n        }\n    }",
    body: "    # Intro @intro\n    {\n        Words.\n    }\n\n    # Setup Guide @setup\n    {\n        Read @intro first, or [the intro](#intro).\n    }"
  });
  const FROM = doc({
    id: "from",
    title: "From",
    signposts: "    @related-resources {\n        {[table]\n            Resource | Relation\n            [Target](../target.sdoc) | Source\n        }\n    }",
    body: [
      "    See [the target](../target.sdoc#intro) before anything.",
      "",
      "    # Uses @uses",
      "    {",
      "        [By id](../target.sdoc#setup) and",
      "        [by slug](../target.sdoc#setup-guide).",
      "        Not [on the web](https://example.com/lexica/target.sdoc#intro).",
      "",
      "        # Intro @intro",
      "        {",
      "            Its own @intro, not the target's.",
      "        }",
      "    }"
    ].join("\n")
  });
  const LINKED = [
    { path: "/p/lexica/target.sdoc", text: TARGET },
    { path: "/p/lexica/sub/from.sdoc", text: FROM },
    { path: "/p/lexica/my notes.sdoc", text: doc({ id: "notes", body: "    # N @n\n    {\n        x\n    }" }) },
    { path: "/p/lexica/sub/enc.sdoc", text: doc({ id: "enc", body: "    # E @e\n    {\n        [x](../my%20notes.sdoc#n)\n    }" }) }
  ];
  const lineIn = (text, mark) => text.split("\n").findIndex((l) => l.includes(mark)) + 1;
  const where = (h) => h.section ? h.section.id : h.signpost ? "@" + h.signpost : null;

  await test("backlinksTexts finds a section's links from other files and its references in its own", () => {
    const found = kb.backlinksTexts(LINKED, "/p/lexica/target.sdoc", { id: "intro" });
    assertEqual(found.section && [found.section.id, found.section.title], ["intro", "Intro"]);
    assertEqual(found.hits.map((h) => [h.path, h.line, h.href || "@" + h.ref, where(h)]), [
      ["/p/lexica/sub/from.sdoc", lineIn(FROM, "See [the target]"), "../target.sdoc#intro", null],
      ["/p/lexica/target.sdoc", lineIn(TARGET, "@intro | Start"), "@intro", "@reading-guide"],
      ["/p/lexica/target.sdoc", lineIn(TARGET, "Read @intro"), "#intro", "setup"],
      ["/p/lexica/target.sdoc", lineIn(TARGET, "Read @intro"), "@intro", "setup"]
    ]);
  });

  await test("backlinksTexts takes a link by @id and by title slug alike, at the line that holds it", () => {
    const byId = kb.backlinksTexts(LINKED, "/p/lexica/target.sdoc", { id: "setup" });
    assertEqual(byId.hits.map((h) => [h.line, h.href, where(h)]), [
      [lineIn(FROM, "#setup)"), "../target.sdoc#setup", "uses"],
      [lineIn(FROM, "#setup-guide)"), "../target.sdoc#setup-guide", "uses"]
    ]);
    assertEqual(kb.backlinksTexts(LINKED, "/p/lexica/target.sdoc", { id: "setup-guide" }).hits, byId.hits);
    assertEqual(kb.backlinksTexts(LINKED, "/p/lexica/target.sdoc", { id: "nope" }), null);
  });

  await test("backlinksTexts of a whole file: the links from other files, a signpost's among them; no web link", () => {
    const found = kb.backlinksTexts(LINKED, "/p/lexica/target.sdoc");
    assertEqual(found.section, null);
    assertEqual(found.hits.map((h) => [h.href, where(h)]), [
      ["../target.sdoc", "@related-resources"],
      ["../target.sdoc#intro", null],
      ["../target.sdoc#setup", "uses"],
      ["../target.sdoc#setup-guide", "uses"]
    ]);
    assertEqual(kb.backlinksTexts(LINKED, "/p/lexica/target.sdoc", { id: "target" }).hits.map((h) => h.href), ["../target.sdoc"],
      "the document's own id: links to the file with no fragment");
  });

  await test("backlinksTexts places a reference or link at the line that holds it whole, not a longer one", () => {
    const text = "# T @t\n{\n    # Intro @intro\n    {\n        x\n    }\n\n    # Old @intro-old\n    {\n        y\n    }\n\n" +
      "    # Uses @uses\n    {\n        see @intro-old and [a](#intro-old)\n        then @intro here, [b](#intro)\n    }\n}\n";
    const hits = kb.backlinksTexts([{ path: "/p/t.sdoc", text }], "/p/t.sdoc", { id: "intro" }).hits;
    assertEqual(hits.map((h) => [h.line, h.href || "@" + h.ref]), [[16, "#intro"], [16, "@intro"]]);
  });

  await test("a link's targets: as written then decoded; a URL by its scheme, so a drive letter is a path", () => {
    assertEqual(kb.linkTargets("a%20b.sdoc#x", "/p/l/f.sdoc"), { paths: ["/p/l/a%20b.sdoc", "/p/l/a b.sdoc"], fragment: "x" });
    assertEqual(kb.linkTargets("#x", "/p/l/f.sdoc"), { paths: ["/p/l/f.sdoc"], fragment: "x" });
    assertEqual(kb.linkTargets("https://e.com/a.sdoc#x", "/p/f.sdoc"), null);
    assertEqual(kb.linkTargets("C:/docs/a.sdoc", "/p/f.sdoc").paths, ["C:/docs/a.sdoc"]);
    assertEqual(kb.hrefPaths("/p", "100%.sdoc"), ["/p/100%.sdoc"], "a literal %: as written only");
  });

  await test("backlinksTexts decodes a percent-encoded path", () => {
    assertEqual(kb.backlinksTexts(LINKED, "/p/lexica/my notes.sdoc", { id: "n" }).hits.map((h) => [h.path, h.href]),
      [["/p/lexica/sub/enc.sdoc", "../my%20notes.sdoc#n"]]);
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

  await test("list with detail: titles gives each file's title instead of its summary", async () => {
    const list = (input) => handlers.runTool(tree, "list", input, { cwd: "/p" });
    const { text } = await list({ detail: "titles" });
    assertEqual(text.split("\n").map((l) => l.replace(/\(\d+ lines\)/, "(N lines)")), [
      "app/lexica/c.sdoc [doc] (N lines) — Other",
      "lexica/a.sdoc [doc] (N lines) — Guided",
      "lexica/sub/b.sdoc [doc] (N lines) — Other"
    ]);
    assertEqual((await list({ detail: "summaries" })).text, (await list({})).text);
    assertEqual(handlers.TOOLS.find((t) => t.name === "list").inputSchema.properties.detail.enum, ["summaries", "titles"]);
  });

  await test("parseGitLog takes each file's latest commit, whatever order the commits come in", () => {
    const newestFirst = "\x00300\n\nlexica/a.sdoc\n\x00200\n\nlexica/a.sdoc\nlexica/b.sdoc\n\x00100\n\nlexica/c.sdoc\n";
    const shuffled = "\x00200\n\nlexica/a.sdoc\nlexica/b.sdoc\n\x00100\n\nlexica/c.sdoc\n\x00300\n\nlexica/a.sdoc\n";
    const latest = [["lexica/a.sdoc", 300], ["lexica/b.sdoc", 200], ["lexica/c.sdoc", 100]];
    assertEqual([...handlers.parseGitLog(newestFirst)].sort(), latest);
    assertEqual([...handlers.parseGitLog(shuffled)].sort(), latest);
    assertEqual([...handlers.parseGitLog('\x00100\n\n"lexica/a \\"b\\"\\\\c.sdoc"\nlexica/café.sdoc\n')],
      [['lexica/a "b"\\c.sdoc', 100], ["lexica/café.sdoc", 100]], "quoted as git quotes, and unquoted");
    assertEqual(handlers.parseGitLog("").size, 0);
  });

  // An io whose run answers as git log would, recording each call.
  const NOW = 1800000000;
  const DAY = 86400;
  function gitIo(io, answer) {
    const calls = [];
    const run = async (argv, init) => {
      calls.push({ argv, init });
      return typeof answer === "function" ? answer() : { exitCode: 0, stdout: answer, stderr: "" };
    };
    return { io: { ...io, run, now: async () => NOW * 1000 }, calls };
  }
  const TREE_LOG = `\x00${NOW - 21 * DAY}\n\nlexica/a.sdoc\napp/lexica/c.sdoc\nlexica/img.png\n` +
    `\x00${NOW - 400 * DAY}\n\nlexica/a.sdoc\nlexica/sub/b.sdoc\n`;

  await test("the index and list say when each file last changed, from one git log over the lexica/ dirs", async () => {
    const { io, calls } = gitIo(tree, TREE_LOG);
    const index = await handlers.knowledgeIndex(io, "/p");
    assertEqual(calls.length, 1, "one git log per build");
    assertEqual(calls[0].argv, ["git", "-c", "core.quotePath=false", "log", "--format=%x00%ct", "--name-only", "--relative", "--", "app/lexica", "lexica"]);
    assertEqual(calls[0].init, { cwd: "/p", timeoutMs: 3000 });
    assert(/^lexica\/a\.sdoc \[doc\] \(\d+ lines, changed 3 weeks ago\) — A guided file\.$/m.test(index), index);
    assert(/^lexica\/sub\/b\.sdoc \[doc\] \(\d+ lines, changed 1 year ago\) — Plain file\.$/m.test(index), index);
    assert(/^app\/lexica\/c\.sdoc \[doc\] \(\d+ lines, changed 3 weeks ago\)/m.test(index), index);
    const { text } = await handlers.runTool(io, "list", { detail: "titles" }, { cwd: "/p" });
    assertEqual(calls.length, 2, "one per list");
    assert(/^lexica\/a\.sdoc \[doc\] \(\d+ lines, changed 3 weeks ago\) — Guided$/m.test(text), text);
  });

  await test("a file git does not know has no age, and the titles-only index keeps the ages", async () => {
    const { io } = gitIo(memoryIo(lexicaOf(30, longAbout)), `\x00${NOW - 3 * DAY}\n\nlexica/f-000.sdoc\n`);
    const index = await handlers.knowledgeIndex(io, "/p", { maxChars: 6000 });
    assert(index.includes("lexica/f-000.sdoc [doc] (16 lines, changed 3 days ago) — Doc"), index);
    assert(index.includes("lexica/f-001.sdoc [doc] (16 lines) — Doc"), index);
  });

  await test("with no git, or git failing, the index and list read exactly as before, and never by mtime", async () => {
    const plain = await handlers.knowledgeIndex(tree, "/p");
    const plainList = (await handlers.runTool(tree, "list", {}, { cwd: "/p" })).text;
    const answers = [
      () => ({ exitCode: 128, stdout: "", stderr: "fatal: not a git repository (or any of the parent directories): .git\n" }),
      () => { throw new Error("timed out after 3000 ms"); },
      () => ({ exitCode: 0, stdout: "", stderr: "" })
    ];
    const notes = [];
    for (const answer of answers) {
      const logged = withLog(tree);
      const { io } = gitIo(logged.io, answer);
      assertEqual(await handlers.knowledgeIndex(io, "/p"), plain);
      assertEqual((await handlers.runTool(io, "list", {}, { cwd: "/p" })).text, plainList);
      notes.push(logged.lines[0]);
    }
    assertEqual(notes, [
      "no ages: git log exited with 128 (fatal: not a git repository (or any of the parent directories): .git)",
      "no ages: git log did not run (timed out after 3000 ms)",
      "ages from git log: 0 files"
    ]);
    const dated = statIo({ "/s/lexica/a.sdoc": GUIDED });
    assert(!(await handlers.knowledgeIndex({ ...dated, now: async () => NOW * 1000 }, "/s")).includes("changed"), "a file's time is no age");
  });

  await test("ages from a real git log, with the session's cwd below the repository's root", async () => {
    const { spawnSync } = require("child_process");
    const os = require("os");
    if (spawnSync("git", ["--version"]).status !== 0) {
      console.log("  (no git here: skipped)");
      return;
    }
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-plugin-git-"));
    const now = Math.floor(Date.now() / 1000);
    const git = (args, sec = now) => {
      const date = `${sec} +0000`;
      const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
        { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    };
    const put = (rel, text) => {
      fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      fs.writeFileSync(path.join(repo, rel), text);
    };
    try {
      git(["init", "-q"]);
      put("proj/lexica/old.sdoc", PLAIN);
      put("proj/lexica/new.sdoc", GUIDED);
      put("elsewhere/lexica/x.sdoc", PLAIN);
      git(["add", "-A"]);
      git(["commit", "-q", "--no-verify", "-m", "first"], now - 400 * DAY);
      put("proj/lexica/new.sdoc", GUIDED.replace("Hello", "Hi"));
      git(["commit", "-q", "--no-verify", "-am", "second"], now - 3 * DAY);
      put("proj/lexica/untracked.sdoc", PLAIN);
      const run = async (argv, init) => {
        const r = spawnSync(argv[0], argv.slice(1), { cwd: init.cwd, encoding: "utf8", timeout: init.timeoutMs });
        return { exitCode: r.status === null ? 1 : r.status, stdout: r.stdout, stderr: r.stderr };
      };
      const io = { ...nodeIo, run, now: async () => now * 1000 };
      const { text } = await handlers.runTool(io, "list", { detail: "titles" }, { cwd: path.join(repo, "proj") });
      const lines = (t) => t.split("\n").length;
      assertEqual(text.split("\n"), [
        `lexica/new.sdoc [doc] (${lines(GUIDED)} lines, changed 3 days ago) — Guided`,
        `lexica/old.sdoc [doc] (${lines(PLAIN)} lines, changed 1 year ago) — Other`,
        `lexica/untracked.sdoc [doc] (${lines(PLAIN)} lines) — Other`
      ]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  // $.store in memory: JSON in, JSON out, and a write refused past limit
  // characters of JSON in all, as the engine refuses one past 4 MiB.
  function memoryStore() {
    const data = new Map();
    const store = {
      data,
      limit: Infinity,
      get: async (k) => (data.has(k) ? JSON.parse(JSON.stringify(data.get(k))) : undefined),
      set: async (k, v) => {
        const next = new Map(data).set(k, JSON.parse(JSON.stringify(v)));
        if (JSON.stringify(Object.fromEntries(next)).length > store.limit) throw new Error("the store is over its limit");
        data.set(k, next.get(k));
      },
      delete: async (k) => { data.delete(k); },
      keys: async () => [...data.keys()]
    };
    return store;
  }

  await test("descriptions are kept between builds under describe:v1:<cwd>; a changed file is read again, a deleted one dropped", async () => {
    const files = statIo({ "/s/lexica/a.sdoc": GUIDED, "/s/lexica/b.sdoc": PLAIN });
    const storage = memoryStore();
    const { io, lines } = withLog({ ...files, storage, now: async () => NOW * 1000 });
    const first = await handlers.knowledgeIndex(io, "/s");
    assertEqual(files.counts.reads, 2);
    assertEqual([...storage.data.keys()], ["describe:v1:/s"]);
    assertEqual(handlers.DESCRIBE_KEY_PREFIX, "describe:v1:");
    assertEqual(Object.keys(storage.data.get("describe:v1:/s").files), ["/s/lexica/a.sdoc", "/s/lexica/b.sdoc"]);
    assertEqual(await handlers.knowledgeIndex(io, "/s"), first, "the same index");
    assertEqual(files.counts.reads, 2, "nothing read: every description from the cache");
    await handlers.runTool(io, "list", {}, { cwd: "/s" });
    assertEqual(files.counts.reads, 2, "the list tool uses it too");
    await handlers.runTool(io, "list", { dirs: ["lexica"] }, { cwd: "/s" });
    assertEqual(files.counts.reads, 4, "but not for dirs it is given");
    files.write("/s/lexica/a.sdoc", GUIDED.replace("A guided file.", "Changed."));
    files.remove("/s/lexica/b.sdoc");
    const third = await handlers.knowledgeIndex(io, "/s");
    assertEqual(files.counts.reads, 5, "only the changed file");
    assert(third.includes("Changed.") && !third.includes("b.sdoc"), third);
    assertEqual(Object.keys(storage.data.get("describe:v1:/s").files), ["/s/lexica/a.sdoc"], "the deleted file dropped");
    assertEqual(lines.filter((l) => l.startsWith("descriptions:")), [
      "descriptions: 0 of 2 knowledge files from the cache, 2 read",
      "descriptions: 2 of 2 knowledge files from the cache, 0 read",
      "descriptions: 2 of 2 knowledge files from the cache, 0 read",
      "descriptions: 0 of 1 knowledge file from the cache, 1 read"
    ]);
  });

  await test("descriptions another build of the plugin made are passed over whole, and replaced", async () => {
    const files = statIo({ "/s/lexica/a.sdoc": GUIDED });
    const storage = memoryStore();
    const io = { ...files, storage, now: async () => NOW * 1000 };
    await handlers.knowledgeIndex(io, "/s");
    assertEqual(storage.data.get("describe:v1:/s").build, esmKb.BUILD);
    const held = storage.data.get("describe:v1:/s");
    const stale = { ...held, build: "older", files: { "/s/lexica/a.sdoc": { ...held.files["/s/lexica/a.sdoc"], desc: { ...held.files["/s/lexica/a.sdoc"].desc, title: "Stale" } } } };
    await storage.set("describe:v1:/s", stale);
    const index = await handlers.knowledgeIndex(io, "/s");
    assertEqual(files.counts.reads, 2, "read again");
    assert(!index.includes("Stale") && storage.data.get("describe:v1:/s").build === esmKb.BUILD, index);
    await storage.set("describe:v1:/s", { at: held.at, files: stale.files });
    await handlers.knowledgeIndex(io, "/s");
    assertEqual(files.counts.reads, 3, "an entry from before builds were kept is passed over too");
  });

  await test("with the conversation's state, lexica/ is found once, again after a reset, and an empty answer is not kept", async () => {
    let lists = 0;
    const files = memoryIo({ "/p/lexica/a.sdoc": GUIDED, "/p/src/x.go": "x" });
    const io = { ...files, list: async (d) => { lists++; return files.list(d); } };
    const state = handlers.createState();
    assertEqual(await handlers.knowledgeDirs(io, "/p", state), ["/p/lexica"]);
    const walked = lists;
    await handlers.runTool(io, "search", { query: "hello" }, { cwd: "/p", state });
    await handlers.subagentBriefing(io, "/p", { state });
    await handlers.knowledgeDirs(io, "/p", state);
    assert(lists < walked * 3, `the project is not walked again: ${walked} listings, then ${lists}`);
    handlers.resetState(state);
    const before = lists;
    await handlers.knowledgeDirs(io, "/p", state);
    assert(lists > before, "a reset walks again");
    const none = memoryIo({ "/q/src/x.go": "x" });
    const empty = handlers.createState();
    assertEqual(await handlers.knowledgeDirs(none, "/q", empty), []);
    none.write("/q/lexica/new.sdoc", PLAIN);
    assertEqual(await handlers.knowledgeDirs(none, "/q", empty), ["/q/lexica"], "the first lexica/ made is seen at once");
  });

  await test("search and backlinks read and parse a file again only when its size or time changes, and answer the same", async () => {
    const files = statIo({ "/p/lexica/a.sdoc": GUIDED, "/p/lexica/b.sdoc": doc({ id: "b", body: "    See [intro](a.sdoc#intro) on brace scoping." }) });
    const state = handlers.createState();
    const search = (st) => handlers.runTool(files, "search", { query: "brace scoping" }, { cwd: "/p", state: st });
    const links = (st) => handlers.runTool(files, "backlinks", { file: "lexica/a.sdoc#intro" }, { cwd: "/p", state: st });
    const first = await search(state);
    const reads = files.counts.reads;
    assertEqual(await search(state), first);
    assertEqual((await links(state)).text, (await links(undefined)).text, "backlinks with the cache answers as without");
    assertEqual(files.counts.reads, reads + 1 + 3, "the cached call reads only the file it names; the uncached one, every file");
    files.write("/p/lexica/b.sdoc", doc({ id: "b", body: "    Nothing here now." }));
    const after = await search(state);
    assertEqual(files.counts.reads, reads + 5, "the changed file only");
    assertEqual(after.text, (await search(undefined)).text, "and the answer is the new text's");
  });

  await test("an unchanged cache is not rewritten until a day has passed", async () => {
    const files = statIo({ "/s/lexica/a.sdoc": GUIDED });
    const storage = memoryStore();
    let now = NOW * 1000;
    let writes = 0;
    const counted = { ...storage, set: async (k, v) => { writes++; return storage.set(k, v); } };
    const io = { ...files, storage: counted, now: async () => now };
    await handlers.knowledgeIndex(io, "/s");
    await handlers.knowledgeIndex(io, "/s");
    assertEqual(writes, 1);
    now += DAY * 1000;
    await handlers.knowledgeIndex(io, "/s");
    assertEqual([writes, storage.data.get("describe:v1:/s").at], [2, now], "the entry's time says it is still in use");
  });

  await test("a store too full for the descriptions drops the oldest describe: entry and tries once more", async () => {
    const storage = memoryStore();
    const filler = (at) => ({ at, files: { "/x.sdoc": { k: "k", desc: { lines: 1, title: "x".repeat(400) } } } });
    await storage.set("unrelated", { at: 0 });
    await storage.set("describe:v1:/newer", filler(NOW * 1000 - 1000));
    await storage.set("describe:v0:/older", filler(NOW * 1000 - 2000));
    storage.limit = JSON.stringify(Object.fromEntries(storage.data)).length + 100;
    const { io, lines } = withLog({ ...statIo({ "/s/lexica/a.sdoc": GUIDED }), storage, now: async () => NOW * 1000 });
    assert((await handlers.knowledgeIndex(io, "/s")).includes("lexica/a.sdoc"));
    assertEqual([...storage.data.keys()], ["unrelated", "describe:v1:/newer", "describe:v1:/s"]);
    assert(lines.includes("descriptions: 0 of 1 knowledge file from the cache, 1 read; kept after dropping describe:v0:/older, the oldest"), lines.join("\n"));
  });

  await test("a store that refuses or fails leaves the files to be read, and the index as it was", async () => {
    const files = statIo({ "/s/lexica/a.sdoc": GUIDED });
    const plain = await handlers.knowledgeIndex(files, "/s");
    const refusing = { get: async () => undefined, set: async () => { throw new Error("full"); }, delete: async () => {}, keys: async () => [] };
    const r = withLog({ ...files, storage: refusing });
    assertEqual(await handlers.knowledgeIndex(r.io, "/s"), plain);
    assertEqual(r.lines[0], "descriptions: 0 of 1 knowledge file from the cache, 1 read; not kept: the store refused them");
    const unreadable = withLog({ ...files, storage: { get: async () => { throw new Error("corrupt"); } } });
    assertEqual(await handlers.knowledgeIndex(unreadable.io, "/s"), plain);
    assert(!unreadable.lines.some((l) => l.startsWith("descriptions:")), "no cache, no note");
    const junk = { ...memoryStore(), get: async () => ({ at: "x", files: { "/s/lexica/a.sdoc": { k: 3, desc: null } } }) };
    assertEqual(await handlers.knowledgeIndex({ ...files, storage: junk }, "/s"), plain, "an entry of another shape is not used");
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

  // An edit that ran, as the hook sees it: beforeEdit, then afterEdit with
  // the file as it is. What it adds to the result, or null.
  async function edited(io, state, options) {
    const { snapshot, guide } = await handlers.beforeEdit(io, state, options);
    return handlers.afterEdit(io, { ...options, snapshot, guide, state });
  }

  await test("the first edit of a file with an editing guide is never refused: its result carries the guide, once", async () => {
    const state = handlers.createState();
    const before = await handlers.beforeEdit(tree, state, { filePath: "/p/lexica/a.sdoc", cwd: "/p" });
    assert(!("deny" in before) && Array.isArray(before.snapshot) && before.guide, JSON.stringify(before));
    const first = await handlers.afterEdit(tree, { filePath: "/p/lexica/a.sdoc", cwd: "/p", snapshot: before.snapshot, guide: before.guide, state });
    assert(first.startsWith("This edit changed lexica/a.sdoc, which has an editing guide that was not shown before the change: " +
      "the change has not been checked against it.") && first.includes("Keep sections short."), first);
    assertEqual(await edited(tree, state, { filePath: "/p/lexica/a.sdoc", cwd: "/p" }), null, "once");
  });

  await test("a failed edit does not count as showing the guide; two sent at once carry it once", async () => {
    const state = handlers.createState();
    await handlers.beforeEdit(tree, state, { filePath: "/p/lexica/a.sdoc", cwd: "/p" });
    const a = await handlers.beforeEdit(tree, state, { filePath: "/p/lexica/a.sdoc", cwd: "/p" });
    const b = await handlers.beforeEdit(tree, state, { filePath: "/p/lexica/a.sdoc", cwd: "/p" });
    assert(a.guide && b.guide, "the first one failed: the guide is still to show");
    const shown = [a, b].map((x) => handlers.afterEdit(tree, { filePath: "/p/lexica/a.sdoc", cwd: "/p", snapshot: x.snapshot, guide: x.guide, state }));
    assertEqual((await Promise.all(shown)).map((t) => Boolean(t && t.includes("Keep sections short."))).sort(), [false, true]);
  });

  await test("each agent is given the guide once; a reset (compaction, /clear) gives it again", async () => {
    const state = handlers.createState();
    await edited(tree, state, { filePath: "/p/lexica/a.sdoc", cwd: "/p" });
    assert((await edited(tree, state, { filePath: "/p/lexica/a.sdoc", agentId: "sub-1", cwd: "/p" })).includes("Keep sections short."));
    handlers.resetState(state);
    assert((await edited(tree, state, { filePath: "/p/lexica/a.sdoc", cwd: "/p" })).includes("Keep sections short."));
  });

  await test("a Read whose lines held the editing guide counts as showing it: the first edit is not given it again", async () => {
    const io = memoryIo({ "/p/lexica/a.sdoc": GUIDED });
    const guide = kb.signpostRange(GUIDED, "editing-guide");
    assert(guide && guide.lineStart > 1, JSON.stringify(guide));
    const whole = handlers.createState();
    await handlers.afterRead(io, whole, { filePath: "/p/lexica/a.sdoc", cwd: "/p" });
    assert(!(await handlers.beforeEdit(io, whole, { filePath: "/p/lexica/a.sdoc", cwd: "/p" })).guide, "a whole Read");
    const ranged = handlers.createState();
    await handlers.afterRead(io, ranged, { filePath: "/p/lexica/a.sdoc", offset: guide.lineStart - 1, limit: guide.lineEnd - guide.lineStart + 2, cwd: "/p" });
    assert(!(await handlers.beforeEdit(io, ranged, { filePath: "/p/lexica/a.sdoc", cwd: "/p" })).guide, "a ranged Read over the guide");
    const part = handlers.createState();
    await handlers.afterRead(io, part, { filePath: "/p/lexica/a.sdoc", offset: guide.lineStart + 1, limit: 50, cwd: "/p" });
    assert((await handlers.beforeEdit(io, part, { filePath: "/p/lexica/a.sdoc", cwd: "/p" })).guide, "a Read of part of it still has it to show");
    const other = handlers.createState();
    await handlers.afterRead(io, other, { filePath: "/p/lexica/a.sdoc", agentId: "sub-1", cwd: "/p" });
    assert((await handlers.beforeEdit(io, other, { filePath: "/p/lexica/a.sdoc", cwd: "/p" })).guide, "per agent: another agent's Read is not this one's");
  });

  await test("the read tool, or search with read: true, showing the editing guide counts too; a section without it does not", async () => {
    const io = memoryIo({ "/p/lexica/a.sdoc": GUIDED });
    const byId = handlers.createState();
    await handlers.runTool(io, "read", { file: "lexica/a.sdoc", ids: ["intro"] }, { cwd: "/p", state: byId });
    assert((await handlers.beforeEdit(io, byId, { filePath: "/p/lexica/a.sdoc", cwd: "/p" })).guide, "a section: the guide was not shown");
    const whole = handlers.createState();
    await handlers.runTool(io, "read", { file: "lexica/a.sdoc", ids: ["guided"] }, { cwd: "/p", state: whole });
    assert(!(await handlers.beforeEdit(io, whole, { filePath: "/p/lexica/a.sdoc", cwd: "/p" })).guide, "the whole file, by its own id");
    const flat = "# Notes @notes\n{\n    @editing-guide {\n        Keep it short.\n    }\n\n    Loose words on fsync.\n}\n";
    const io2 = memoryIo({ "/p/lexica/n.sdoc": flat });
    const searched = handlers.createState();
    await handlers.runTool(io2, "search", { query: "fsync", read: true }, { cwd: "/p", state: searched });
    assert(!(await handlers.beforeEdit(io2, searched, { filePath: "/p/lexica/n.sdoc", cwd: "/p" })).guide, "a search hit shown whole, the guide in it");
  });

  await test("a file with no editing guide, or a new file, has no guide to give", async () => {
    const state = handlers.createState();
    assert(!(await handlers.beforeEdit(tree, state, { filePath: "/p/lexica/sub/b.sdoc", cwd: "/p" })).guide);
    assertEqual(await handlers.beforeEdit(tree, state, { filePath: "/p/lexica/new.sdoc", cwd: "/p" }), { snapshot: [], guide: null });
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
    assert(report && report.includes("x.sdoc:") && report.includes("@elsewhere") && report.includes("The errors leave the file failing its check"), report);
    assert(!report.includes("@nowhere"), "the finding that was there before is not reported");
  });

  await test("a finding that differs from one before only by a number is new: @req-1 to @req-2, ch1.sdoc to ch2.sdoc", async () => {
    const before = doc({ body: "    # A @a\n    {\n        See @req-1 and [c](ch1.sdoc).\n    }" });
    const io = memoryIo({ "/p/x.sdoc": before });
    const { snapshot } = await handlers.beforeEdit(io, handlers.createState(), { filePath: "/p/x.sdoc", cwd: "/p" });
    io.write("/p/x.sdoc", "\n" + before.replace("@req-1", "@req-2").replace("ch1.sdoc", "ch2.sdoc"));
    const report = await handlers.afterEdit(io, { filePath: "/p/x.sdoc", snapshot, cwd: "/p" });
    assert(report && report.includes("2 findings") && report.includes("@req-2") && report.includes("ch2.sdoc"), report);
    const unclosed = "# A @a\n{\n    # B @b\n    {\n        x\n";
    const shifted = memoryIo({ "/p/u.sdoc": unclosed });
    const held = await handlers.beforeEdit(shifted, handlers.createState(), { filePath: "/p/u.sdoc", cwd: "/p" });
    shifted.write("/p/u.sdoc", "\n\n" + unclosed);
    assertEqual(await handlers.afterEdit(shifted, { filePath: "/p/u.sdoc", snapshot: held.snapshot, cwd: "/p" }), null, "a line number in a message moves, and is the same finding");
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

  await test("a first edit's result carries the sections the editing guide links to, whole", async () => {
    const io = memoryIo({
      "/p/lexica/specs/x.sdoc": linking("Follow [the rules](../skills/rules.sdoc#spec-rules) and [local](#local), not [web](https://example.com/a.sdoc#b)."),
      "/p/lexica/skills/rules.sdoc": RULES
    });
    const deny = (await handlers.beforeEdit(io, handlers.createState(), { filePath: "/p/lexica/specs/x.sdoc", cwd: "/p" })).guide.text;
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
    assert(/rules\.sdoc @long \(L\d+-\d+\): too long to include, so not shown here; mcp__sdoc-lexica__read reads it\.$/m.test(text), text);
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

  await test("a guide's link is followed as written, then decoded, as the check resolves it", async () => {
    const io = memoryIo({ "/p/x.sdoc": PLAIN, "/p/a%20b.sdoc": RULES, "/p/c d.sdoc": RULES });
    assertEqual((await handlers.linkedSections(io, "/p/x.sdoc", "[a](a%20b.sdoc#spec-rules)", "/p")).count, 1, "a file named with a literal %20");
    assertEqual((await handlers.linkedSections(io, "/p/x.sdoc", "[c](c%20d.sdoc#spec-rules)", "/p")).count, 1, "a file named with a space");
  });

  await test("an edit that leaves the file clean reports nothing", async () => {
    const io = memoryIo({ "/p/x.sdoc": PLAIN });
    const { snapshot } = await handlers.beforeEdit(io, handlers.createState(), { filePath: "/p/x.sdoc", cwd: "/p" });
    io.write("/p/x.sdoc", PLAIN.replace("Text.", "More text."));
    assertEqual(await handlers.afterEdit(io, { filePath: "/p/x.sdoc", snapshot, cwd: "/p" }), null);
  });

  await test("a link that leaves the project is not looked at, nor reported broken; one inside it is", async () => {
    const io = memoryIo({ "/p/x.sdoc": PLAIN });
    const asked = [];
    const watched = { ...io, exists: async (p) => { asked.push(p); return io.exists(p); } };
    io.write("/p/x.sdoc", doc({ body: "    # A @a\n    {\n        [out](../elsewhere/y.sdoc) [abs](/etc/z.sdoc) [in](gone.sdoc)\n    }" }));
    const report = await handlers.afterEdit(watched, { filePath: "/p/x.sdoc", snapshot: [], cwd: "/p" });
    assert(report.includes("gone.sdoc") && !report.includes("elsewhere") && !report.includes("/etc/z.sdoc"), report);
    assert(asked.every((p) => p.startsWith("/p/")), "nothing outside the project was looked at: " + asked.join(", "));
    const checked = await handlers.runTool(watched, "check", { files: ["x.sdoc"] }, { cwd: "/p" });
    assert(checked.text.includes("gone.sdoc") && !checked.text.includes("elsewhere"), checked.text);
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

  await test("a command's findings before are taken before it runs: a link it breaks with rm is reported", async () => {
    const io = memoryIo({ "/p/lexica/a.sdoc": doc({ body: "    # A @a\n    {\n        See [x](x.sdoc).\n    }" }), "/p/lexica/x.sdoc": PLAIN });
    const snapshot = await handlers.beforeBash(io, { command: "rm lexica/x.sdoc && sed -i 's/See/Read/' lexica/a.sdoc", cwd: "/p" });
    delete io.store["/p/lexica/x.sdoc"];
    io.write("/p/lexica/a.sdoc", io.store["/p/lexica/a.sdoc"].replace("See", "Read"));
    const report = await handlers.afterBash(io, handlers.createState(), { snapshot, cwd: "/p" });
    assert(report && report.includes("Broken link: file not found — x.sdoc"), report);
  });

  await test("a command's paths are resolved from the shell's directory, which a cd moved; shown from the project", async () => {
    const io = memoryIo({ "/p/lexica/a.sdoc": GUIDED });
    const snapshot = await handlers.beforeBash(io, { command: "sed -i 's/Hello/Hi/' a.sdoc", cwd: "/p", shellCwd: "/p/lexica" });
    assertEqual([...snapshot.keys()], ["/p/lexica/a.sdoc"]);
    io.write("/p/lexica/a.sdoc", GUIDED.replace("Hello there.", "Hi @nowhere."));
    const report = await handlers.afterBash(io, handlers.createState(), { snapshot, cwd: "/p" });
    assert(report.includes("This command changed lexica/a.sdoc"), report);
  });

  await test("the project is the session's root, wherever the shell is, but a helper's own worktree is its project", async () => {
    const io = memoryIo({
      "/p/.git/HEAD": "ref",
      "/p/.claude/worktrees/a/.git": "gitdir: /p/.git/worktrees/a\n",
      "/p/vendor/m/.git": "gitdir: ../../.git/modules/m\n",
      "/w/x/.git": "gitdir: /p/.git/worktrees/x\n"
    });
    const at = (shell) => handlers.projectFor(io, { root: "/p", shell });
    assertEqual(await at("/p"), "/p");
    assertEqual(await at("/p/lexica"), "/p", "a cd into a subdirectory");
    assertEqual(await at("/p/.claude/worktrees/a"), "/p/.claude/worktrees/a", "a helper's worktree");
    assertEqual(await at("/p/.claude/worktrees/a/lexica/sub"), "/p/.claude/worktrees/a", "below it");
    assertEqual(await at("/p/vendor/m"), "/p", "a submodule is not a worktree");
    assertEqual(await at("/w/x/src"), "/w/x", "a worktree outside the project's folder");
    assertEqual(await at("/tmp/elsewhere"), "/p", "a cd anywhere else");
    assertEqual(await handlers.projectFor(io, { shell: "/p/lexica" }), "/p/lexica", "no root(): the shell's directory");
  });

  await test("the hooks module takes the project from root(), which a shell cd does not move, and Bash paths from cwd()", () => {
    const source = fs.readFileSync(path.join(PLUGIN, "hooks", "register.mjs"), "utf8");
    assert(/await \$\.session\.root\(\)/.test(source), "root()");
    assert(/projectFor\(ioOf\(\$\), \{ root, shell: await \$\.session\.cwd\(\) \}\)/.test(source), "the project from root() and the shell's directory");
    assert(/shellCwd: await \$\.session\.cwd\(\)/.test(source), "the shell's directory for a command's paths");
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
    assert((await edited(io, state, { filePath: "/p/lexica/a.sdoc", cwd: "/p" })).includes("Keep sections short."));
    let snapshot = await handlers.beforeBash(io, { command: "sed -i 's/Hello/Hi/' lexica/a.sdoc", cwd: "/p" });
    io.write("/p/lexica/a.sdoc", GUIDED.replace("Hello", "Hi"));
    assertEqual(await handlers.afterBash(io, state, { snapshot, cwd: "/p" }), null, "shown with the Edit");
    snapshot = await handlers.beforeBash(io, { command: "sed -i 's/Hi/Hey/' lexica/a.sdoc", cwd: "/p" });
    io.write("/p/lexica/a.sdoc", GUIDED.replace("Hello", "Hey"));
    assert((await handlers.afterBash(io, state, { snapshot, agentId: "sub-1", cwd: "/p" })).includes("Keep sections short."), "a subagent gets its own");
    assert(!(await handlers.beforeEdit(io, state, { filePath: "/p/lexica/a.sdoc", agentId: "sub-1", cwd: "/p" })).guide, "and is then not given it again");
  });

  await test("the hooks module watches Bash, and none of the events a user plugin is passed over on", () => {
    const source = fs.readFileSync(path.join(PLUGIN, "hooks", "register.mjs"), "utf8");
    assert(/on\("tool\.call", \{ tool: "Bash", command: NAMES_SDOC \}/.test(source), "Bash");
    for (const event of ["prompt.context", "session.compact", "session.append", "classic.SessionStart"]) {
      assert(!source.includes(`on("${event}"`), event);
    }
  });

  // Text a hook adds that reads as orders can be taken for a prompt
  // injection, so the plugin's own sentences state facts. What a file says,
  // its guides, is the file's, and left out of this.
  await test("what the hooks add states facts: none of the plugin's own sentences opens with a command", async () => {
    const io = memoryIo({
      "/p/lexica/a.sdoc": GUIDED,
      "/p/lexica/big.sdoc": bigDoc(40),
      "/p/x.sdoc": doc({ body: "    # A @a\n    {\n        Text.\n    }" }),
      "/p/rules.sdoc": RULES
    });
    const lead = (text) => text.split("\n\n")[0];
    const index = await handlers.knowledgeIndex(io, "/p");
    const nudge = await handlers.afterRead(io, handlers.createState(), { filePath: "/p/lexica/big.sdoc", cwd: "/p" });
    const deny = await edited(io, handlers.createState(), { filePath: "/p/lexica/a.sdoc", cwd: "/p" });
    const snapshot = await handlers.beforeBash(io, { command: "sed -i 's/Hello/Hi/' lexica/a.sdoc", cwd: "/p" });
    io.write("/p/lexica/a.sdoc", GUIDED.replace("Hello there.", "Hi @nowhere and @elsewhere."));
    const bash = await handlers.afterBash(io, handlers.createState(), { snapshot, cwd: "/p" });
    const pointer = (await handlers.linkedSections(io, "/p/x.sdoc", "[long](rules.sdoc#long)", "/p")).text;
    const plugin = [
      ...index.split("\n").filter((line) => !/^\S+\.sdoc( \[\w+\])? \(\d+ lines/.test(line)),
      handlers.SUBAGENT_LEAD,
      lead(nudge),
      lead(deny),
      ...bash.split("\n\n").filter((part) => /^(This command|The command)/.test(part)).map((part) => part.split("\n")[0]),
      pointer.split("\n").pop()
    ];
    assert(plugin.some((s) => s.includes("failing its check")), "the findings line, with errors: " + plugin.join("\n"));
    const COMMANDS = /^(Load|Outline|Read|Search|List|Check|Fix|Make|Use|Correct|Follow|Call|Open|Edit|Run|Keep|Prefer|Avoid|Try|Never|Always|Do|Don't|Next|Before)\b/i;
    for (const text of plugin) {
      for (const sentence of text.split(/(?<=[.:;])\s+|\n/).map((s) => s.replace(/^-\s+/, "").trim()).filter(Boolean)) {
        assert(!COMMANDS.test(sentence), `a command: "${sentence}"`);
      }
    }
  });

  // ============================================================
  console.log("\n--- The mod: subagents ---");

  await test("a new subagent is briefed; a fork, a resumed agent and a workflow agent are not", () => {
    assertEqual(handlers.shouldBrief({ prompt: "x", subagentType: "general-purpose", fork: false }), true);
    assertEqual(handlers.shouldBrief({ prompt: "x", isTeammate: true, fork: false }), true, "a teammate starts with nothing too");
    assertEqual(handlers.shouldBrief({ prompt: "x", fork: true }), false);
    assertEqual(handlers.shouldBrief({ prompt: "x", fork: false, resume: { agentId: "a1" } }), false);
    assertEqual(handlers.shouldBrief({ prompt: "x", fork: false, workflow: { runId: "wf_1", agentIndex: 1 } }), false);
  });

  await test("the brief is the lead line and the knowledge index, and says so in the log", async () => {
    const { io, lines } = withLog(tree);
    const brief = await handlers.subagentBriefing(io, "/p", { who: "subagent Explore" });
    assert(brief.startsWith(handlers.SUBAGENT_LEAD + "\n"), brief.slice(0, 200));
    assert(brief.includes("lexica/a.sdoc [doc]") && brief.includes("A guided file."), brief);
    assert(brief.length <= handlers.SUBAGENT_BRIEF_CHARS, "length " + brief.length);
    assertEqual(lines.length, 1, "one line per brief");
    assert(lines[0].startsWith("subagent Explore: ") && lines[0].includes("3 knowledge files"), lines[0]);
  });

  await test("the brief stays within 3000 chars: titles when the summaries do not fit, then a count", async () => {
    const titles = await handlers.subagentBriefing(memoryIo(lexicaOf(10, longAbout)), "/p");
    assert(titles.length <= 3000, "length " + titles.length);
    assert(titles.includes("lexica/f-009.sdoc [doc] (16 lines) — Doc"), "every file, by title");
    assert(!titles.includes("Long summary"), "no summary at all, rather than a clipped one");
    const counted = await handlers.subagentBriefing(memoryIo(lexicaOf(200, () => PLAIN)), "/p");
    assert(counted.length <= 3000, "length " + counted.length);
    assert(/… and \d+ more files\./.test(counted), counted.slice(-200));
  });

  await test("no brief for a project without lexica/", async () => {
    const { io, lines } = withLog(memoryIo({ "/q/README.md": "x" }));
    assertEqual(await handlers.subagentBriefing(io, "/q", { who: "subagent Plan" }), null);
    assertEqual(lines, ["subagent Plan: not briefed, no lexica/ directory in this project"]);
  });

  const PLUGIN_TOOLS = handlers.TOOLS.map((t) => "mcp__sdoc-lexica__" + t.name);

  await test("the research agent reads only: the plugin's tools as given, Read, Grep and Glob", () => {
    const spec = handlers.researchAgentSpec(PLUGIN_TOOLS);
    assertEqual(spec.name, "research");
    assertEqual(spec.tools, [...PLUGIN_TOOLS, "Read", "Grep", "Glob"]);
    for (const tool of ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "Agent"]) assert(!spec.tools.includes(tool), tool);
    assert(!("model" in spec), "no model: it inherits, until the evals say otherwise");
    const other = handlers.researchAgentSpec(["mcp__other__search", "mcp__other__read"]);
    assertEqual(other.tools, ["mcp__other__search", "mcp__other__read", "Read", "Grep", "Glob"], "names from the list, not literals");
    assert(other.prompt.includes("mcp__other__search") && other.prompt.includes("mcp__other__read"), other.prompt);
    assert(!other.prompt.includes("mcp__sdoc-lexica__"), "no name the list does not give");
  });

  await test("the research agent is described in the third person and asked for cited answers of 200 words at most", () => {
    const { description, prompt } = handlers.researchAgentSpec(PLUGIN_TOOLS);
    assert(/^Answers questions from the project's lexica\/ knowledge/.test(description) && description.includes("Use for"), description);
    assert(/Not for a question you already know where to look for[^.]*in one place/.test(description),
      "steered away from a question it knows where to find, in one place: Sonnet sent it one in every run");
    assert(prompt.includes("At most 200 words"), "the word cap");
    assert(prompt.includes("path @id (Lx-y)"), "a citation after each claim");
    assert(prompt.includes("does not cover"), "what the knowledge lacks, said plainly");
    assert(prompt.includes("Never read a large file whole") && prompt.includes("read-only"), prompt);
    assert(prompt.indexOf("mcp__sdoc-lexica__search") < prompt.indexOf("mcp__sdoc-lexica__outline") &&
      prompt.indexOf("mcp__sdoc-lexica__outline") < prompt.indexOf("mcp__sdoc-lexica__read"), "search, then outline, then read");
  });

  await test("the hooks module briefs subagents at agent.spawn, with a fallback, and registers the research agent", () => {
    const source = fs.readFileSync(path.join(PLUGIN, "hooks", "register.mjs"), "utf8");
    assert(/on\("agent\.spawn", async/.test(source), "agent.spawn");
    assert(/next\(brief \? \{ \.\.\.e, prompt: e\.prompt \+ "\\n\\n" \+ brief \} : e\)/.test(source), "the brief goes after the prompt");
    assert(/subagents\.briefed\.add\(started\.agentId\)/.test(source), "the spawn hook keeps each agent it started");
    assert(/on\("tool\.call", async \(\$, e, next\) => \{\n\s+if \(!subagents\.hasKnowledge \|\| !e\.agentId \|\|\n\s+subagents\.briefed\.has\(e\.agentId\)/.test(source),
      "the fallback passes over an agent the spawn hook saw, and only that one");
    assert(!/spawnHookRan/.test(source), "no flag stands the fallback down for the whole session");
    assert(/\$\.agent\.register\(researchAgentSpec\(\[\.\.\.tools\.keys\(\)\]\)\)/.test(source), "the research agent, with the tools as registered");
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

  await test("the transcript is fetched only when usage says the opening may have changed: a /clear, or fewer tokens", () => {
    const state = handlers.createState();
    const usage = (startedAt, tokens) => ({ startedAt, context: { tokens, window: 200000 } });
    const why = (u) => handlers.openingMayHaveChanged(state, u)[0];
    assertEqual(why(usage(1, 5000)), "no opening recorded yet", "the first prompt");
    assertEqual(why(usage(1, 6000)), "no opening recorded yet", "and until one is: the first prompt's transcript is empty");
    handlers.lostOpening(state, handlers.openingOf([user("hi")]));
    assertEqual(why(usage(1, 9000)), null, "the context grew: nothing lost");
    assertEqual(handlers.openingMayHaveChanged(state, usage(1, 9000)), [null, "context tokens 9000 → 9000"], "no response since: the same");
    assertEqual(why(usage(1, 3000)), "fewer context tokens (a compaction)");
    assertEqual(why(usage(2, 4000)), "the session started over (a /clear)");
    assertEqual(why(usage(2, undefined)), "usage unknown", "no token count: fetched");
    assertEqual(why(undefined), "usage unknown", "no usage at all: fetched");
    assertEqual(why(usage(2, 6000)), "usage unknown", "and the prompt after, against no figure");
    assertEqual(why(usage(2, 7000)), null);
  });

  await test("a transcript that fills the messages window tells nothing of its opening", () => {
    const many = (n) => Array.from({ length: n }, (_, i) => (i % 2 ? reply : user("m" + i)));
    assertEqual(handlers.openingKnown(many(10)), true);
    assertEqual(handlers.openingKnown([]), true, "no message yet: a /clear");
    assertEqual(handlers.openingKnown(many(handlers.MESSAGES_WINDOW)), false);
    assertEqual(handlers.openingKnown(many(handlers.MESSAGES_WINDOW - 1)), false, "opening on a user message drops one");
    assertEqual(handlers.openingKnown(undefined), false);
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

  await test("search falls back to the sections holding the most words, each line saying which it lacks", async () => {
    const { text } = await run("search", { query: "brace scoping nowhere" });
    assert(text.startsWith("No section holds all 3 words; these hold 2:\nlexica/a.sdoc:"), text);
    assert(/^lexica\/a\.sdoc:\d+ @details Details \[no "nowhere"\] — More words about brace scoping\.$/m.test(text), text);
    assert((await run("search", { query: "brace nowhere" })).text.startsWith("No section holds both words; these hold 1:\n"));
    assert(!(await run("search", { query: "brace scoping" })).text.includes("No section"), "every word held: no header");
    assertEqual((await run("search", { query: "zzz qqq" })).text, 'Nothing matches "zzz qqq".');
  });

  await test("search lists the sections one word short after the best when few hold the most", async () => {
    const text = doc({ id: "wal", body: [
      "    # Recovery @recovery", "    {", "        wal replay checksum torn segment", "    }",
      "    # Torn writes @torn", "    {", "        wal checksum torn crc32c", "    }",
      "    # Other @other", "    {", "        wal only", "    }"
    ].join("\n") });
    const found = kb.rankSections([{ path: "/p/x.sdoc", text }], "wal replay checksum torn crc32c segment");
    assertEqual([found.matched, found.least], [5, 4]);
    assertEqual(found.hits.map((h) => h.id), ["recovery", "torn"]);
    assert(kb.formatSearch(found.hits, { ...found, base: "/p" }).startsWith("No section holds all 6 words; these hold 5 or 4:\n"));
    // One word short of 3 is not half of them: no second tier.
    assertEqual(kb.rankSections([{ path: "/p/x.sdoc", text }], "replay crc32c nowhere").least, 1);
  });

  await test("backlinks to a section count the links to a section inside it, from outside it", async () => {
    const target = doc({ id: "t", body: "    # Compaction @compaction\n    {\n        # Triggers @triggers\n        {\n            x\n        }\n        See @triggers.\n    }" });
    const from = doc({ id: "f", body: "    See [the triggers](t.sdoc#triggers)." });
    const found = kb.backlinksTexts([{ path: "/p/t.sdoc", text: target }, { path: "/p/f.sdoc", text: from }], "/p/t.sdoc", { id: "compaction" });
    assertEqual(found.hits.map((h) => [h.path, h.href || "@" + h.ref, Boolean(h.inside)]), [["/p/f.sdoc", "t.sdoc#triggers", true]]);
    assert(kb.formatBacklinks(found, { base: "/p" }).startsWith("1 link to t.sdoc @compaction or a section inside it:\n"));
  });

  await test("backlinks to a section names the section inside it each link goes to, and those nothing links to", async () => {
    const target = doc({ id: "t", body: "    # Compaction @compaction\n    {\n        # Triggers @triggers\n        {\n            x\n        }\n\n" +
      "        # Strategy @strategy\n        {\n            # Manual Runs\n            {\n                y\n            }\n        }\n    }" });
    const from = doc({ id: "f", body: "    See [the triggers](t.sdoc#triggers) and [it](t.sdoc#compaction)." });
    const docs = [{ path: "/p/t.sdoc", text: target }, { path: "/p/f.sdoc", text: from }];
    const found = kb.backlinksTexts(docs, "/p/t.sdoc", { id: "compaction" });
    assertEqual(found.section.inside.map((x) => x.id || x.derivedId), ["triggers", "strategy", "manual-runs"]);
    assertEqual(kb.formatBacklinks(found, { base: "/p" }).split("\n"), [
      "2 links to t.sdoc @compaction or a section inside it:",
      `f.sdoc:${lineIn(from, "See [the")} (outside any section) — t.sdoc#triggers (to @triggers)`,
      `f.sdoc:${lineIn(from, "See [the")} (outside any section) — t.sdoc#compaction`,
      "Covers the 3 sections inside it: nothing links to @strategy, (manual-runs)."
    ]);
    const none = kb.backlinksTexts([{ path: "/p/t.sdoc", text: target }], "/p/t.sdoc", { id: "strategy" });
    assertEqual(kb.formatBacklinks(none, { base: "/p" }), "Nothing in lexica/ links to t.sdoc @strategy or the 1 section inside it ((manual-runs)).");
    assertEqual(kb.backlinksTexts(docs, "/p/t.sdoc", { id: "triggers" }).section.inside, [], "a section with none inside it");
    assertEqual(kb.backlinksTexts(docs, "/p/t.sdoc", { id: "t" }).section.inside, [], "the whole file: its links, not its sections'");
  });

  await test("search says when its list was cut", async () => {
    const io = memoryIo({ "/p/lexica/big.sdoc": bigDoc(40) });
    const lines = (await handlers.runTool(io, "search", { query: "line" }, { cwd: "/p" })).text.split("\n");
    assertEqual(lines.length, 21);
    assertEqual(lines[20], "20 of 40 matching sections shown, best first.");
  });

  // A search hit's section, as read: true shows it: its head line, then its
  // source with line numbers.
  const shownSection = (title) => new RegExp(`^\\S+ L\\d+-\\d+ — ${title}\\n\\s+\\d+\\t`, "m");

  await test("search with read: true adds the best sections whole after the list, and an @about hit's summary", async () => {
    const { text } = await run("search", { query: "brace scoping", read: true });
    assert(text.startsWith("lexica/a.sdoc:") && shownSection("Details").test(text), text);
    assert(/^\s+\d+\t\s+Nested text\.$/m.test(text), "the section whole, with what is nested in it");
    const about = (await run("search", { query: "plain", read: true })).text;
    assert(/^lexica\/sub\/b\.sdoc L8-10 — About\nPlain file\.$/m.test(about), about);
    const partial = (await run("search", { query: "brace scoping nowhere", read: true })).text;
    assert(partial.startsWith("No section holds all 3 words") && shownSection("Details").test(partial), partial);
  });

  await test("search's read: true passes over a section inside one it shows", async () => {
    const nested = doc({ id: "n", body: "    # Parent @parent\n    {\n        Widget widget widget overview.\n\n        # Child @child\n        {\n            One widget here.\n        }\n    }" });
    const io = memoryIo({ "/p/lexica/n.sdoc": nested });
    const { text } = await handlers.runTool(io, "search", { query: "widget", read: true }, { cwd: "/p" });
    assert(/^lexica\/n\.sdoc:\d+ @child Child — One widget here\.$/m.test(text), "the child is listed");
    assert(shownSection("Parent").test(text) && !shownSection("Child").test(text), text);
  });

  await test("search's read: true stays within its budget, naming each section that does not fit, never cutting one", async () => {
    const part = (i) => `    # Part ${i} @part-${i}\n    {\n        Target ${"filler words here. ".repeat(100)}\n    }`;
    const io = memoryIo({
      "/p/lexica/many/m.sdoc": doc({ id: "many", body: Array.from({ length: 7 }, (_, i) => part(i)).join("\n\n") }),
      "/p/lexica/long/l.sdoc": doc({ id: "long", body: `    # Target Long @long\n    {\n        ${"Very long words. ".repeat(500)}\n    }\n\n    # Short @short\n    {\n        One target.\n    }` })
    });
    const many = (await handlers.runTool(io, "search", { query: "target", read: true, dirs: ["lexica/many"] }, { cwd: "/p" })).text;
    const sections = many.slice(many.indexOf("\n\n") + 2);
    assertEqual((sections.match(/^lexica\/many\/m\.sdoc L\d+-\d+ — Part \d+$/gm) || []).length, 2, "two fit");
    assert(sections.length < handlers.SEARCH_READ_CHARS + 600, "length " + sections.length);
    const pointers = sections.match(/^- lexica\/many\/m\.sdoc @part-\d+ \(L\d+-\d+\): not included, \d+ chars with \d+ of 6000 left; mcp__sdoc-lexica__read reads it\.$/gm) || [];
    assertEqual(pointers.length, 3, "five sections in all");
    const long = (await handlers.runTool(io, "search", { query: "target", read: true, dirs: ["lexica/long"] }, { cwd: "/p" })).text;
    assert(/^- lexica\/long\/l\.sdoc @long \(L\d+-\d+\): not included/m.test(long), long);
    assert(shownSection("Short").test(long) && !long.includes("Very long words."), "the next one that fits, and nothing of the one that does not");
  });

  await test("search's read: true does not count a file as met: its first outline still has the reading guide", async () => {
    const ctx = { cwd: "/p", state: handlers.createState() };
    await handlers.runTool(tree, "search", { query: "brace", read: true }, ctx);
    assert((await handlers.runTool(tree, "outline", { file: "lexica/a.sdoc" }, ctx)).text.includes("Reading guide:"));
  });

  await test("outline's depth keeps the top levels and counts the rest; previews: false leaves out the first words", async () => {
    const top = (await run("outline", { file: "lexica/a.sdoc", depth: 1 })).text;
    assert(top.includes("@details Details") && !top.includes("Deeper"), top);
    assert(top.endsWith("\n(1 deeper section not shown)"), top);
    const all = (await run("outline", { file: "lexica/a.sdoc", depth: 2 })).text;
    assert(all.includes("(deeper) Deeper") && !all.includes("not shown"), all);
    assert(all.includes("@intro Intro — Hello there."), all);
    const bare = (await run("outline", { file: "lexica/a.sdoc", previews: false })).text;
    assert(/ @intro Intro$/m.test(bare) && !bare.includes("Hello there."), bare);
  });

  await test("outline takes several files, each with its signposts on a first meeting", async () => {
    const ctx = { cwd: "/p", state: handlers.createState() };
    const { text } = await handlers.runTool(tree, "outline", { files: ["lexica/a.sdoc", "lexica/sub/b.sdoc"] }, ctx);
    assert(text.includes("lexica/a.sdoc @guided — Guided") && text.includes("\n\nlexica/sub/b.sdoc @other — Other"), text);
    assertEqual(text.split("Reading guide:").length - 1, 1);
    const again = (await handlers.runTool(tree, "outline", { file: "lexica/a.sdoc", files: ["lexica/a.sdoc"] }, ctx)).text;
    assert(!again.includes("Reading guide:"), "once per file");
    assertEqual(again.split("lexica/a.sdoc @guided").length - 1, 1, "a file named twice is outlined once");
  });

  await test("outline outlines at most 20 files, says how many it left, and needs file or files", async () => {
    const io = memoryIo(lexicaOf(22, () => PLAIN));
    const files = Object.keys(io.store).map((p) => p.replace("/p/", ""));
    const { text } = await handlers.runTool(io, "outline", { files }, { cwd: "/p" });
    assertEqual(text.split("@other — Other").length - 1, handlers.OUTLINE_MAX_FILES);
    assert(text.endsWith("\n\n(2 more files not outlined: at most 20 per call.)"), text.slice(-200));
    assertEqual((await run("outline", {})).error, "Missing file: pass file or files.");
  });

  await test("the guard checks outline's files, and backlinks' file and dirs", () => {
    const roots = ["/p"];
    assertEqual(handlers.toolPaths("outline", { file: "a.sdoc", files: ["b.sdoc"] }, "/p"), ["/p/a.sdoc", "/p/b.sdoc"]);
    assert(handlers.isWithin("outline", { files: ["lexica/a.sdoc"] }, "/p", roots));
    assert(!handlers.isWithin("outline", { file: "lexica/a.sdoc", files: ["/etc/x.sdoc"] }, "/p", roots));
    assertEqual(handlers.toolPaths("backlinks", { file: "lexica/a.sdoc#intro", dirs: ["docs"] }, "/p"), ["/p/lexica/a.sdoc", "/p/docs"]);
    assert(handlers.isWithin("backlinks", { file: "lexica/a.sdoc#intro" }, "/p", roots));
    assert(!handlers.isWithin("backlinks", { file: "../x.sdoc#a" }, "/p", roots));
    assert(!handlers.isWithin("backlinks", { file: "lexica/a.sdoc", dirs: ["/"] }, "/p", roots));
  });

  const linkedIo = memoryIo({
    "/p/lexica/target.sdoc": TARGET,
    "/p/lexica/sub/from.sdoc": FROM,
    "/p/docs/self.sdoc": doc({ id: "self", body: "    # A @a\n    {\n        x\n    }\n\n    # B @b\n    {\n        See @a.\n    }" })
  });
  const backlinks = (input) => handlers.runTool(linkedIo, "backlinks", input, { cwd: "/p" });

  await test("backlinks answers a line per link: file:line, the section it sits in, and the href or @id", async () => {
    const { text } = await backlinks({ file: "lexica/target.sdoc#intro" });
    assertEqual(text, [
      "4 links to lexica/target.sdoc @intro:",
      `lexica/sub/from.sdoc:${lineIn(FROM, "See [the target]")} (outside any section) — ../target.sdoc#intro`,
      `lexica/target.sdoc:${lineIn(TARGET, "@intro | Start")} @reading-guide — @intro`,
      `lexica/target.sdoc:${lineIn(TARGET, "Read @intro")} @setup Setup Guide — #intro`,
      `lexica/target.sdoc:${lineIn(TARGET, "Read @intro")} @setup Setup Guide — @intro`
    ].join("\n"));
    assertEqual((await backlinks({ file: "lexica/target.sdoc", id: "intro" })).text, text, "id as its own argument");
    assert((await backlinks({ file: "lexica/target.sdoc" })).text.startsWith("4 links to lexica/target.sdoc:\n"));
  });

  await test("backlinks finds the file's own references wherever the file is, and says when nothing links", async () => {
    assertEqual((await backlinks({ file: "docs/self.sdoc#a" })).text, `1 link to docs/self.sdoc @a:\ndocs/self.sdoc:${lineIn(doc({ id: "self", body: "    # A @a\n    {\n        x\n    }\n\n    # B @b\n    {\n        See @a.\n    }" }), "See @a")} @b B — @a`);
    assertEqual((await backlinks({ file: "lexica/sub/from.sdoc", id: "uses" })).text,
      "Nothing in lexica/ links to lexica/sub/from.sdoc @uses or the 1 section inside it (@intro).");
    assertEqual((await backlinks({ file: "lexica/target.sdoc#setup", dirs: ["docs"] })).text, "Nothing in docs/ links to lexica/target.sdoc @setup.");
  });

  await test("backlinks of an unknown id answers the ids the file has, as read does", async () => {
    assertEqual((await backlinks({ file: "lexica/target.sdoc", id: "nope" })).error,
      'No section "nope" in lexica/target.sdoc. Its ids: @target (the whole file), @intro, @setup.');
    assert((await backlinks({ file: "lexica/none.sdoc#x" })).error.includes("No such file: lexica/none.sdoc"));
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
    assert(!(await handlers.beforeEdit(tree, other, { filePath: "/p/lexica/a.sdoc", cwd: "/p" })).guide, "the editing guide was shown: the first edit is not given it again");
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
  console.log("\n--- The mod: mentions and permissions ---");

  await test("a mention's id names its section's lines, by @id or title slug", () => {
    assertEqual(handlers.mentionRange(GUIDED, "intro"), { offset: 32, limit: 4 });
    assertEqual(handlers.mentionRange(GUIDED, "#details"), { offset: 37, limit: 9 });
    assertEqual(handlers.mentionRange(GUIDED, "deeper"), { offset: 41, limit: 4 }, "a heading with no @id, by its slug");
  });

  await test("a mention of the document's own id reads the whole file; an unknown one lists the ids", () => {
    assertEqual(handlers.mentionRange(GUIDED, "guided"), null);
    assertEqual(handlers.mentionRange(GUIDED, "nope"), { unknown: true, ids: ["@guided (the whole file)", "@intro", "@details", "deeper"] });
  });

  await test("an unknown id in a mention is told as read tells it, and noted", async () => {
    const { io, lines } = withLog(tree);
    const plan = await handlers.mentionRead(io, { filePath: "/p/lexica/a.sdoc", fragment: "nope", cwd: "/p" });
    assertEqual(plan, { missing: 'No section "nope" in lexica/a.sdoc. Its ids: @guided (the whole file), @intro, @details, deeper.' });
    assertEqual(await handlers.mentionRead(io, { filePath: "/p/lexica/a.sdoc", fragment: "intro", cwd: "/p" }), { offset: 32, limit: 4 });
    assertEqual(await handlers.mentionRead(io, { filePath: "/p/lexica/a.sdoc", fragment: "guided", cwd: "/p" }), {});
    assertEqual(await handlers.mentionRead(io, { filePath: "/p/lexica/gone.sdoc", fragment: "x", cwd: "/p" }), null);
    assertEqual(lines, [
      "mention lexica/a.sdoc#nope: no such section, attached whole with its ids",
      "mention lexica/a.sdoc#intro: attached L32-35 only",
      "mention lexica/a.sdoc#guided: the document's own id, attached whole",
      "mention lexica/gone.sdoc#x: could not read it, left to the engine"
    ]);
  });

  const outlineOf = (ids) => ({ sections: ids.map((id, i) => ({ id, derivedId: id, title: "Title " + id, lineStart: 10 * i + 1, lineEnd: 10 * i + 9 })) });

  await test("section suggestions: prefix matches first, then those that hold it, in document order", () => {
    const rows = handlers.sectionSuggestions(outlineOf(["write-ahead", "log-format", "compaction", "log-replay"]), "log", "@lexica/a.sdoc");
    assertEqual(rows.map((r) => r.label), ["#log-format", "#log-replay"], "only ids that hold log");
    const held = handlers.sectionSuggestions(outlineOf(["catalog", "log", "blog-post"]), "log", "@a.sdoc");
    assertEqual(held.map((r) => r.label), ["#log", "#catalog", "#blog-post"]);
  });

  await test("a suggestion writes the token's file part and the id, labelled #id, its lines and title beside", () => {
    const [row] = handlers.sectionSuggestions(outlineOf(["intro"]), "", "@lexica/a.sdoc");
    assertEqual(row, { text: "@lexica/a.sdoc#intro", label: "#intro", description: "L1-9 Title intro" });
    const byTitle = handlers.sectionSuggestions({ sections: [{ id: "wal", title: "Write-ahead log", lineStart: 3, lineEnd: 7 }] }, "write", "@a.sdoc");
    assertEqual(byTitle.map((r) => r.label), ["#wal"], "a title that holds the prefix");
  });

  await test("section suggestions stop at fifteen, and a heading with no @id is offered by its slug", async () => {
    const many = handlers.sectionSuggestions(outlineOf(Array.from({ length: 40 }, (_, i) => "part-" + i)), "", "@a.sdoc");
    assertEqual(many.length, handlers.MAX_SUGGESTIONS);
    assertEqual(handlers.MAX_SUGGESTIONS, 15);
    const rows = await handlers.mentionSuggestions(tree, { token: "@lexica/a.sdoc#de", cwd: "/p" });
    assertEqual(rows.map((r) => r.text), ["@lexica/a.sdoc#details", "@lexica/a.sdoc#deeper"]);
  });

  await test("suggestions only for a file inside the project, as written and through links", async () => {
    assertEqual(await handlers.mentionSuggestions(tree, { token: "@../q/lexica/a.sdoc#", cwd: "/p" }), []);
    const linked = { ...tree, realPath: async (p) => p === "/p/lexica/a.sdoc" ? "/elsewhere/a.sdoc" : p };
    assertEqual(await handlers.mentionSuggestions(linked, { token: "@lexica/a.sdoc#", cwd: "/p" }), []);
    assertEqual(await handlers.insideProject(linked, "/p/lexica/a.sdoc", "/p"), false);
    assertEqual(await handlers.insideProject(linked, "/p/lexica/sub/b.sdoc", "/p"), true);
    assertEqual(await handlers.mentionSuggestions(tree, { token: "@lexica/a.sdoc", cwd: "/p" }), [], "no # yet");
  });

  await test("suggestions keep the last file's outline while its text is unchanged", async () => {
    const io = memoryIo({ "/p/a.sdoc": GUIDED });
    const cache = {};
    await handlers.mentionSuggestions(io, { token: "@a.sdoc#in", cwd: "/p", cache });
    const kept = cache.outline;
    assert(kept && cache.path === "/p/a.sdoc", "cached");
    await handlers.mentionSuggestions(io, { token: "@a.sdoc#int", cwd: "/p", cache });
    assert(cache.outline === kept, "not parsed again");
    io.write("/p/a.sdoc", GUIDED.replace("# Intro @intro", "# Intro @opening"));
    const rows = await handlers.mentionSuggestions(io, { token: "@a.sdoc#op", cwd: "/p", cache });
    assert(cache.outline !== kept && rows.length === 1 && rows[0].label === "#opening", JSON.stringify(rows));
  });

  await test("the hooks module hooks prompt.mention and prompt.autocomplete on .sdoc paths", () => {
    const source = fs.readFileSync(path.join(PLUGIN, "hooks", "register.mjs"), "utf8");
    assert(/on\("prompt\.mention", \{ path: \/\\\.sdoc\(#\[\^\/\]\*\)\?\$\/i \}/.test(source), "prompt.mention");
    assert(/on\("prompt\.autocomplete", \{ token: \/\^@\[\^\\s#\]\+\\\.sdoc#\[\\w-\]\*\$\/i \}/.test(source), "prompt.autocomplete");
    assert(/on\("session\.end"[\s\S]*allowed\.clear\(\)/.test(source), "session allowances end with the session");
  });

  await test("a tool call's paths are put to the check as Read of a file, Glob of a directory", () => {
    assertEqual(handlers.toolRequests("list", { dirs: ["docs", "/x"] }, "/p"), [{ path: "/p/docs", kind: "dir" }, { path: "/x", kind: "dir" }]);
    assertEqual(handlers.toolRequests("search", { query: "q" }, "/p"), [], "the lexica/ dirs: none named");
    assertEqual(handlers.toolRequests("check", { files: ["a.sdoc"] }, "/p"), [{ path: "/p/a.sdoc", kind: "file" }]);
    assertEqual(handlers.checkRequest({ path: "/p/a.sdoc", kind: "file" }), { tool: "Read", input: { file_path: "/p/a.sdoc" } });
    assertEqual(handlers.checkRequest({ path: "/x", kind: "dir" }), { tool: "Glob", input: { pattern: "**/*.sdoc", path: "/x" } });
  });

  // io whose permission settings deny reading the paths given (a Read rule).
  const denying = (io, paths) => ({ ...io, denied: async (p) => paths.includes(p) });

  await test("readDenied: a deny as written or where a link leads; no io.denied, or a failing check, denies nothing", async () => {
    const io = denying({ realPath: async (p) => (p === "/p/link.sdoc" ? "/p/secret.sdoc" : p) }, ["/p/secret.sdoc"]);
    assertEqual(await handlers.readDenied(io, "/p/secret.sdoc"), true);
    assertEqual(await handlers.readDenied(io, "/p/link.sdoc"), true, "through a link");
    assertEqual(await handlers.readDenied(io, "/p/open.sdoc"), false);
    assertEqual(await handlers.readDenied({}, "/p/secret.sdoc"), false);
    assertEqual(await handlers.readDenied({ denied: async () => { throw new Error("x"); } }, "/p/a.sdoc"), false);
  });

  await test("list, search and backlinks leave out the files the permission settings deny, and say how many", async () => {
    const io = denying(memoryIo({
      "/p/lexica/a.sdoc": doc({ id: "a", body: "    # A @a\n    {\n        Open words on fsync.\n    }" }),
      "/p/lexica/private/s.sdoc": doc({ id: "s", signposts: "    @about {\n        Secret summary.\n    }", body: "    # S @s\n    {\n        Secret fsync, see [a](../a.sdoc#a).\n    }" })
    }), ["/p/lexica/private/s.sdoc"]);
    const list = (await handlers.runTool(io, "list", {}, { cwd: "/p" })).text;
    assert(!list.includes("Secret") && list.endsWith("(1 .sdoc file left out: the permission settings deny reading it.)"), list);
    assert(!(await handlers.runTool(io, "list", { dirs: ["lexica"] }, { cwd: "/p" })).text.includes("Secret"), "a dir given, too");
    const search = (await handlers.runTool(io, "search", { query: "fsync", read: true }, { cwd: "/p" })).text;
    assert(!search.includes("Secret") && search.includes("lexica/a.sdoc") && search.includes("1 .sdoc file left out"), search);
    assert((await handlers.runTool(io, "search", { query: "secret" }, { cwd: "/p" })).text.startsWith('Nothing matches "secret".\n(1 .sdoc file left out'));
    const links = (await handlers.runTool(io, "backlinks", { file: "lexica/a.sdoc#a" }, { cwd: "/p" })).text;
    assert(links.startsWith("Nothing in lexica/ links to lexica/a.sdoc @a.") && links.includes("1 .sdoc file left out"), links);
    assert(!(await handlers.runTool(memoryIo(io.store), "list", {}, { cwd: "/p" })).text.includes("left out"), "nothing denied, nothing said");
  });

  await test("the index leaves out a file the permission settings deny, its cached description too, and says so", async () => {
    const files = statIo({ "/s/lexica/a.sdoc": GUIDED, "/s/lexica/s.sdoc": PLAIN.replace("Plain file.", "Secret summary.") });
    const storage = memoryStore();
    const io = { ...files, storage, now: async () => NOW * 1000 };
    assert((await handlers.knowledgeIndex(io, "/s")).includes("Secret summary."), "cached while allowed");
    const index = await handlers.knowledgeIndex(denying(io, ["/s/lexica/s.sdoc"]), "/s");
    assert(!index.includes("Secret") && index.includes("lexica/a.sdoc") && index.endsWith("(1 .sdoc file left out: the permission settings deny reading it.)"), index);
    const brief = await handlers.subagentBriefing(denying(io, ["/s/lexica/s.sdoc"]), "/s");
    assert(!brief.includes("Secret"), "the brief too");
  });

  await test("a file the permission settings deny: not followed from a guide, not watched by Edit or Bash, offered no ids", async () => {
    const io = denying(memoryIo({ "/p/x.sdoc": PLAIN, "/p/lexica/rules.sdoc": RULES, "/p/lexica/a.sdoc": GUIDED }), ["/p/lexica/rules.sdoc", "/p/lexica/a.sdoc"]);
    assertEqual(await handlers.linkedSections(io, "/p/x.sdoc", "[a](lexica/rules.sdoc#spec-rules)", "/p"), { text: "", count: 0 });
    const before = await handlers.beforeEdit(io, handlers.createState(), { filePath: "/p/lexica/a.sdoc", cwd: "/p" });
    assertEqual(before, { snapshot: null, guide: null }, "not the guide of a file it may not read");
    io.write("/p/lexica/a.sdoc", GUIDED.replace("Hello there.", "Hi @nowhere."));
    assertEqual(await handlers.afterEdit(io, { filePath: "/p/lexica/a.sdoc", snapshot: before.snapshot, cwd: "/p" }), null, "nor its findings");
    assertEqual((await handlers.beforeBash(io, { command: "sed -i 's/a/b/' lexica/a.sdoc x.sdoc", cwd: "/p" })).size, 1, "only the file it may read");
    assertEqual(await handlers.mentionSuggestions(io, { token: "@lexica/a.sdoc#", cwd: "/p" }), []);
  });

  // A permission check and a person, scripted: verdicts by path (allow when
  // not given), answers in turn (a function, to throw or wait).
  function permissions(verdicts = {}, answers = []) {
    const checked = [];
    const questions = [];
    return {
      checked,
      questions,
      check: async (request) => {
        const p = request.input.file_path || request.input.path;
        checked.push(request.tool + " " + p);
        return verdicts[p] || { decision: "allow" };
      },
      ask: async (question, options) => {
        questions.push(question);
        assertEqual(options.options, handlers.CONSENT_OPTIONS);
        const answer = answers.shift();
        return typeof answer === "function" ? answer() : answer;
      }
    };
  }
  const outside = { decision: "ask" };
  const deps = (perm, more = {}) => ({ check: perm.check, ask: perm.ask, roots: ["/p", "/plugin"], tool: "mcp__sdoc-lexica__outline", name: "outline", cwd: "/p", ...more });

  await test("ownToolRequest: the call under the tool's full name, with only its own arguments", async () => {
    const request = handlers.ownToolRequest("search", { query: "wal", dirs: ["lexica"], agentId: "a1", tool_use_id: "t" }, "mcp__sdoc-lexica__search");
    assertEqual(request, { tool: "mcp__sdoc-lexica__search", input: { query: "wal", dirs: ["lexica"] } });
    const source = fs.readFileSync(path.join(PLUGIN, "hooks", "register.mjs"), "utf8");
    assert(/own\.decision === "deny" && own\.rule/.test(source), "only a settings rule denies the tool by name");
  });

  await test("consent: a deny stands with its reason, inside the project too, and asks nothing", async () => {
    const perm = permissions({ "/p/secrets/a.sdoc": { decision: "deny", reason: "Permission to read /p/secrets/a.sdoc has been denied.", rule: "Read(./secrets/**)" }, "/x/b.sdoc": outside }, ["Allow once"]);
    const verdict = await handlers.consent([{ path: "/x/b.sdoc", kind: "file" }, { path: "/p/secrets/a.sdoc", kind: "file" }], deps(perm));
    assertEqual(verdict, { deny: "mcp__sdoc-lexica__outline may not read secrets/a.sdoc: Permission to read /p/secrets/a.sdoc has been denied." });
    assertEqual(perm.questions, [], "a deny is not put to the person");
    const bare = permissions({ "/p/a.sdoc": { decision: "deny", rule: "Read(./a.sdoc)" } });
    assertEqual((await handlers.consent([{ path: "/p/a.sdoc", kind: "file" }], deps(bare))).deny, "mcp__sdoc-lexica__outline may not read a.sdoc: denied by Read(./a.sdoc)");
  });

  await test("consent: allowed, or an ask inside the project or the plugin, runs without a question", async () => {
    const perm = permissions({ "/p/lexica/a.sdoc": outside, "/plugin/skills/guide.sdoc": outside });
    const paths = [{ path: "/p/lexica/a.sdoc", kind: "file" }, { path: "/plugin/skills/guide.sdoc", kind: "file" }, { path: "/y/c.sdoc", kind: "file" }];
    assertEqual(await handlers.consent(paths, deps(perm)), { allow: true });
    assertEqual(perm.questions, []);
    assertEqual(perm.checked, ["Read /p/lexica/a.sdoc", "Read /plugin/skills/guide.sdoc", "Read /y/c.sdoc"], "one check per path");
    assertEqual(await handlers.consent([], deps(permissions())), { allow: true }, "no path named");
  });

  await test("consent: an ask outside the project asks once; Allow once lets this call through only", async () => {
    const perm = permissions({ "/x/a.sdoc": outside, "/x/b.sdoc": outside }, ["Allow once", "Deny"]);
    const allowed = new Set();
    const paths = [{ path: "/x/a.sdoc", kind: "file" }, { path: "/x/b.sdoc", kind: "file" }];
    assertEqual(await handlers.consent(paths, deps(perm, { allowed })), { allow: true });
    assertEqual(perm.questions, ["Allow mcp__sdoc-lexica__outline to read /x/a.sdoc, /x/b.sdoc, outside the project?"]);
    assertEqual(allowed.size, 0);
    assertEqual(await handlers.consent(paths, deps(perm, { allowed })), { deny: "The user did not allow mcp__sdoc-lexica__outline to read /x/a.sdoc, /x/b.sdoc." });
    assertEqual(perm.questions.length, 2, "asked again");
  });

  await test("consent: Allow for this session covers what the question named, a file or a directory's subtree, until cleared", async () => {
    const perm = permissions({ "/x/docs/a.sdoc": outside, "/x/docs/b.sdoc": outside, "/y": outside, "/y/deep/c.sdoc": outside }, ["Allow for this session", "Deny", "Allow for this session"]);
    const allowed = new Set();
    assertEqual(await handlers.consent([{ path: "/x/docs/a.sdoc", kind: "file" }], deps(perm, { allowed })), { allow: true });
    assertEqual([...allowed], ["/x/docs/a.sdoc"], "the file, not its directory");
    assertEqual(await handlers.consent([{ path: "/x/docs/a.sdoc", kind: "file" }], deps(perm, { allowed })), { allow: true });
    assertEqual(perm.questions.length, 1, "the file is not asked about again");
    assert((await handlers.consent([{ path: "/x/docs/b.sdoc", kind: "file" }], deps(perm, { allowed }))).deny, "a file beside it is asked about");
    await handlers.consent([{ path: "/y", kind: "dir" }], deps(perm, { allowed, tool: "mcp__sdoc-lexica__search" }));
    assertEqual(perm.questions[2], "Allow mcp__sdoc-lexica__search to read the .sdoc files under /y, outside the project?");
    assert(allowed.has("/y"), "a directory allows itself");
    assertEqual(await handlers.consent([{ path: "/y/deep/c.sdoc", kind: "file" }], deps(perm, { allowed })), { allow: true });
    assertEqual(perm.questions.length, 3, "and its subtree");
    const denied = permissions({ "/x/docs/c.sdoc": { decision: "deny", reason: "no" } });
    assert((await handlers.consent([{ path: "/x/docs/c.sdoc", kind: "file" }], deps(denied, { allowed }))).deny, "a deny still stands in an allowed directory");
  });

  await test("consent: a path is checked where it leads too, and the real path asked about", async () => {
    const io = { realPath: async (p) => p === "/p/lexica/link.sdoc" ? "/etc/secret.sdoc" : p };
    const perm = permissions({ "/etc/secret.sdoc": outside }, ["Allow once"]);
    assertEqual(await handlers.consent([{ path: "/p/lexica/link.sdoc", kind: "file" }], deps(perm, { io })), { allow: true });
    assertEqual(perm.checked, ["Read /p/lexica/link.sdoc", "Read /etc/secret.sdoc"]);
    assertEqual(perm.questions, ["Allow mcp__sdoc-lexica__outline to read /etc/secret.sdoc, outside the project?"]);
    const denied = permissions({ "/etc/secret.sdoc": { decision: "deny", reason: "denied" } });
    assert((await handlers.consent([{ path: "/p/lexica/link.sdoc", kind: "file" }], deps(denied, { io }))).deny.includes("/etc/secret.sdoc"));
  });

  await test("consent: text typed under Other refuses, and is passed on", async () => {
    const perm = permissions({ "/x/a.sdoc": outside }, ["use the copy in lexica/ instead"]);
    assertEqual(await handlers.consent([{ path: "/x/a.sdoc", kind: "file" }], deps(perm)),
      { deny: "The user did not allow mcp__sdoc-lexica__outline to read /x/a.sdoc. They said: use the copy in lexica/ instead" });
  });

  await test("consent: with no one to ask (claude -p, a dismissed question), today's refusal", async () => {
    const perm = permissions({ "/x/a.sdoc": outside }, [() => { throw new Error("no one to ask"); }]);
    const { io, lines } = withLog(memoryIo({}));
    assertEqual(await handlers.consent([{ path: "/x/a.sdoc", kind: "file" }], deps(perm, { io })),
      { deny: "mcp__sdoc-lexica__outline reads only inside the project (/p). Use Read for a file elsewhere." });
    assertEqual(lines, ["tool outline: refused, it names a path outside the project"]);
  });

  await test("consent: calls racing for the same paths share one question", async () => {
    let answer;
    const perm = permissions({ "/x/a.sdoc": outside }, [() => new Promise((resolve) => { answer = resolve; })]);
    const pending = new Map();
    const paths = [{ path: "/x/a.sdoc", kind: "file" }];
    const both = Promise.all([handlers.consent(paths, deps(perm, { pending })), handlers.consent(paths, deps(perm, { pending }))]);
    while (!answer) await new Promise((resolve) => setImmediate(resolve));
    answer("Allow once");
    assertEqual(await both, [{ allow: true }, { allow: true }]);
    assertEqual(perm.questions.length, 1);
    assertEqual(pending.size, 0, "settled questions are let go");
  });

  await test("consent notes what it decided", async () => {
    const { io, lines } = withLog(memoryIo({}));
    const perm = permissions({ "/x/a.sdoc": outside, "/p/s.sdoc": { decision: "deny", rule: "Read(./s.sdoc)" } }, ["Allow for this session"]);
    const allowed = new Set();
    await handlers.consent([{ path: "/x/a.sdoc", kind: "file" }], deps(perm, { io, allowed }));
    await handlers.consent([{ path: "/x/a.sdoc", kind: "file" }], deps(perm, { io, allowed }));
    await handlers.consent([{ path: "/p/s.sdoc", kind: "file" }], deps(perm, { io, allowed }));
    assertEqual(lines, [
      "tool outline: /x/a.sdoc allowed for this session",
      "tool outline: /x/a.sdoc allowed earlier in this session",
      "tool outline: refused, the permission settings deny Read of s.sdoc (Read(./s.sdoc))"
    ]);
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

  await test("a Read notes what it added, and why it added nothing, and an editing guide it showed", async () => {
    const { io, lines } = withLog(tree);
    const state = handlers.createState();
    await handlers.afterRead(io, state, { filePath: "/p/lexica/a.sdoc", cwd: "/p" });
    await handlers.afterRead(io, state, { filePath: "/p/lexica/a.sdoc", cwd: "/p" });
    await handlers.afterRead(io, state, { filePath: "/p/lexica/sub/b.sdoc", agentId: "sub-1", cwd: "/p" });
    assertEqual(lines, [
      "Read lexica/a.sdoc: added its reading guide and related resources; its editing guide was in the lines read, so its first edit is not given it again",
      "Read lexica/a.sdoc: nothing added (already shown in this conversation)",
      "Read lexica/sub/b.sdoc (agent sub-1): nothing added (no reading guide or related resources)"
    ]);
  });

  await test("an edit notes what the check found, and the guide it added", async () => {
    const { io, lines } = withLog(memoryIo({ "/p/a.sdoc": GUIDED }));
    const state = handlers.createState();
    const { snapshot, guide } = await handlers.beforeEdit(io, state, { filePath: "/p/a.sdoc", cwd: "/p" });
    await handlers.afterEdit(io, { filePath: "/p/a.sdoc", snapshot, cwd: "/p", guide, state });
    const broken = memoryIo({ "/p/a.sdoc": GUIDED.replace("Hello there.", "Hello @nowhere.") });
    await handlers.afterEdit({ ...broken, log: io.log }, { filePath: "/p/a.sdoc", snapshot, cwd: "/p", guide, state, agentId: "sub-1" });
    assertEqual(lines, [
      "Edit a.sdoc: checked, no new findings; added its editing guide, after the edit",
      "Edit a.sdoc (agent sub-1): checked, reported 1 new finding; added its editing guide, after the edit"
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

  // The engine lists description and when_to_use together, cut at 1,536
  // characters; the description says what the skill does, in the third
  // person, and when_to_use when to load it.
  await test("each skill's description is in the third person, its triggers in when_to_use, within 1,536 chars", () => {
    const field = (front, key) => {
      const m = new RegExp(`^${key}: (.*)$`, "m").exec(front);
      return m ? m[1].replace(/^"(.*)"$/, "$1") : null;
    };
    for (const { name, text } of skills) {
      const front = text.match(/^---\n([\s\S]*?)\n---\n/)[1];
      const description = field(front, "description");
      const whenToUse = field(front, "when_to_use");
      assert(/^[A-Z][a-z]+s\b/.test(description), `${name}: "${description.slice(0, 30)}…" is not in the third person`);
      assert(!/\bUse (when|whenever|for)\b/.test(description), name + ": the triggers belong in when_to_use");
      assert(whenToUse && whenToUse.length > 40, name + ": when_to_use");
      assert(description.length + whenToUse.length <= 1536, `${name}: ${description.length + whenToUse.length} chars`);
    }
    assertEqual(skills.map(({ text }) => /^paths: \["\*\*\/\*\.sdoc"\]$/m.test(text)), [true, false], "paths on the authoring skill only");
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
