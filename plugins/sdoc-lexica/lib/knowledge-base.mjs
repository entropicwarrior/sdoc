// GENERATED from src/knowledge-base.js by tools/build-plugin.js. Do not edit: edit the
// source and run `npm run build:plugin`.

// Progressive discovery over SDOC knowledge files: find the lexica/ trees,
// describe each file by its @about, outline a file with the line range of every
// section, read one section as source, search, and hand back the signposts a
// reader or an editor needs. Built for agents, which pay for every line they
// load: each step returns just enough to choose the next one.
//
// Runtime-neutral, like src/sdoc.js: no fs and no path module. Functions take
// a document's text, and the few that walk directories take the listing
// function they need, so the same code runs under Node (tools/build-doc.js)
// and inside Claude Code, where the plugin runs it as a mod with no Node at
// all (plugins/sdoc-lexica, which carries an ES-module copy made by
// tools/build-plugin.js).

import {
  parseSdoc,
  extractMeta,
  inferType,
  extractAbout,
  extractSection,
  listSections,
  getDocumentScope,
  slugify,
  RESERVED_SCOPE_IDS,
  SIGNPOST_IDS,
  extractSignpost,
  extractReadingGuide,
  extractRelatedResources,
  validateSignposts,
  validateRefs,
  validateCitations,
  collectInlineRefs,
  hasUrlScheme
} from "./sdoc.mjs";

// The directory name every Lexica knowledge tree uses.
const KNOWLEDGE_DIR_NAME = "lexica";

// Directories never worth walking into: dependencies, build output. Dot
// directories (.git, .claude, ...) are skipped as well.
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "target", "vendor", "__pycache__"]);

// --- Paths, without Node's path module ---
//
// Both separators are accepted; a path is rebuilt with the separator it
// already uses, so a Windows path stays one.

function separatorOf(p) {
  return p.includes("\\") && !p.includes("/") ? "\\" : "/";
}

function isAbsolutePath(p) {
  return /^([A-Za-z]:)?[\\/]/.test(p);
}

function normalizePath(p) {
  const sep = separatorOf(p);
  const drive = (p.match(/^[A-Za-z]:/) || [""])[0];
  const rest = p.slice(drive.length);
  const absolute = /^[\\/]/.test(rest);
  const out = [];
  for (const segment of rest.split(/[\\/]+/)) {
    if (segment === "" || segment === ".") continue;
    if (segment === ".." && out.length && out[out.length - 1] !== "..") { out.pop(); continue; }
    if (segment === ".." && absolute) continue;
    out.push(segment);
  }
  if (absolute) return drive + sep + out.join(sep);
  return drive + (out.join(sep) || ".");
}

// rel resolved against base; an absolute rel stands on its own.
function joinPath(base, rel) {
  if (isAbsolutePath(rel)) return normalizePath(rel);
  return normalizePath(base + separatorOf(base) + rel);
}

function dirName(p) {
  const normal = normalizePath(p);
  const cut = Math.max(normal.lastIndexOf("/"), normal.lastIndexOf("\\"));
  if (cut < 0) return ".";
  return cut === 0 || /^[A-Za-z]:$/.test(normal.slice(0, cut)) ? normal.slice(0, cut + 1) : normal.slice(0, cut);
}

function baseName(p) {
  return normalizePath(p).split(/[\\/]/).pop();
}

// True when p is base or lies under it.
function isInside(base, p) {
  const b = normalizePath(base).replace(/\\/g, "/").replace(/\/$/, "");
  const q = normalizePath(p).replace(/\\/g, "/");
  return q === b || q.startsWith(b + "/");
}

// p relative to base when it lies under base, else p unchanged.
function shownPath(p, base) {
  if (!base || !isInside(base, p)) return p;
  const b = normalizePath(base).replace(/[\\/]$/, "");
  return normalizePath(p).slice(b.length + 1) || ".";
}

function isSdocFile(p) {
  return /\.sdoc$/i.test(p || "");
}

// --- Walking directories ---
//
// `list(dir)` answers the entries of a directory as [{ name, kind }], kind
// being "file", "dir" or anything else; it may return a promise. A directory
// that cannot be listed is treated as empty.

async function entriesOf(list, dir) {
  try {
    return (await list(dir)) || [];
  } catch {
    return [];
  }
}

function walkable(entry) {
  return entry.kind === "dir" && !entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name);
}

// True when dir holds an .sdoc file at any depth; stops at the first.
async function holdsSdocFile(dir, list) {
  for (const entry of await entriesOf(list, dir)) {
    if (entry.kind === "file" && isSdocFile(entry.name)) return true;
    if (walkable(entry) && await holdsSdocFile(joinPath(dir, entry.name), list)) return true;
  }
  return false;
}

// Every lexica/ directory under root that holds knowledge, sorted. One with no
// .sdoc file in it is passed over: a folder that only shares the name (a
// skill called lexica, say) is not a knowledge tree. A lexica/ directory's
// own subdirectories are part of it, so the walk does not look inside one for
// another. The walk goes breadth first and stops after maxDirs directories,
// so a vast tree costs a bounded number of listings, not a stalled session.
async function findKnowledgeDirs(root, list, { maxDepth = 5, maxDirs = 2000 } = {}) {
  const found = [];
  let level = [normalizePath(root)];
  let visited = 0;
  for (let depth = 0; depth <= maxDepth && level.length; depth++) {
    const next = [];
    for (const dir of level) {
      if (++visited > maxDirs) return found.sort();
      for (const entry of await entriesOf(list, dir)) {
        if (!walkable(entry)) continue;
        const full = joinPath(dir, entry.name);
        if (entry.name !== KNOWLEDGE_DIR_NAME) next.push(full);
        else if (await holdsSdocFile(full, list)) found.push(full);
      }
    }
    level = next.sort();
  }
  return found.sort();
}

// Every .sdoc file under dir, sorted by path.
async function findSdocFiles(dir, list) {
  return (await findSdocEntries(dir, list)).map((e) => e.path);
}

// Every .sdoc file under dir as { path, size, mtimeMs }, sorted by path; size
// and mtimeMs as the listing gives them, undefined when it gives none.
async function findSdocEntries(dir, list) {
  const files = [];
  async function walk(current) {
    for (const entry of await entriesOf(list, current)) {
      const full = joinPath(current, entry.name);
      if (walkable(entry)) await walk(full);
      else if (entry.kind === "file" && isSdocFile(entry.name)) files.push({ path: full, size: entry.size, mtimeMs: entry.mtimeMs });
    }
  }
  await walk(normalizePath(dir));
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// --- One document ---

function documentTitle(nodes, filePath) {
  const doc = getDocumentScope(nodes);
  if (doc && doc.title) return doc.title;
  const first = nodes.find((n) => n.type === "scope" && n.title && !(n.id && RESERVED_SCOPE_IDS.has(n.id.toLowerCase())));
  return first ? first.title : baseName(filePath).replace(/\.sdoc$/i, "");
}

function lineCount(text) {
  return text.split("\n").length;
}

// What a reader needs to decide whether to open a file: { path, type, title,
// about, lines }. about is null when the file has none.
function describeText(text, filePath) {
  const { nodes } = parseSdoc(text);
  const { meta } = extractMeta(nodes);
  return {
    path: filePath,
    type: inferType(baseName(filePath), meta),
    title: documentTitle(nodes, filePath),
    about: extractAbout(nodes),
    lines: lineCount(text)
  };
}

// The headed scopes in document order with their depth, walked exactly as
// listSections walks them (from the root's children, skipping @meta and the
// signposts with everything inside them), so the two line up index for index.
function sectionNodes(nodes) {
  const result = [];
  function walk(list, depth) {
    for (const node of list) {
      if (node.type !== "scope" || !node.hasHeading) continue;
      if (depth === 0 && node.id && RESERVED_SCOPE_IDS.has(node.id.toLowerCase())) continue;
      result.push({ node, depth });
      if (node.children) walk(node.children, depth + 1);
    }
  }
  const doc = getDocumentScope(nodes);
  walk(doc ? doc.children : nodes, 0);
  return result;
}

// Each section of a document with its id, title, depth, line range and
// preview, plus which signposts the document has.
function outlineText(text, filePath) {
  const { nodes } = parseSdoc(text);
  const listed = listSections(nodes);
  const sections = sectionNodes(nodes).map(({ node, depth }, i) => ({
    id: node.id || null,
    derivedId: listed[i] ? listed[i].derivedId : null,
    title: node.title,
    depth,
    lineStart: node.lineStart,
    lineEnd: node.lineEnd,
    preview: listed[i] ? listed[i].preview : ""
  }));
  const doc = getDocumentScope(nodes);
  return {
    path: filePath,
    id: doc && doc.hasHeading && doc.id ? doc.id : null,
    title: documentTitle(nodes, filePath),
    lines: lineCount(text),
    about: extractAbout(nodes),
    signposts: SIGNPOST_IDS.filter((id) => extractSignpost(nodes, id) !== null),
    sections
  };
}

// The scope an id names, the document's own heading scope or a section: an
// explicit @id first, the document's or a section's, then a title slug,
// ignoring case — the order extractSection uses. So a section whose @id is
// the document's title slug is that section. A leading @ or # is ignored.
// Null when nothing has the id.
function scopeNamed(nodes, id) {
  const wanted = String(id || "").trim().replace(/^[@#]/, "");
  const doc = getDocumentScope(nodes);
  const own = doc && doc.hasHeading ? doc : null;
  if (own && own.id === wanted) return own;
  const walked = sectionNodes(nodes);
  const exact = walked.find(({ node }) => node.id === wanted);
  if (exact) return exact.node;
  const lower = wanted.toLowerCase();
  if (own && own.title && slugify(own.title).toLowerCase() === lower) return own;
  const index = listSections(nodes).findIndex((s) => s.derivedId.toLowerCase() === lower);
  return index >= 0 && walked[index] ? walked[index].node : null;
}

// One section as written: { title, id, lineStart, lineEnd, whole, source },
// source being the raw lines from the heading to the closing brace. The
// document's own id names the whole file (whole: true). With { text: true },
// content is the section flattened to plain text instead. Null when no
// section has that id.
function readSectionText(text, id, { text: asText = false } = {}) {
  const { nodes } = parseSdoc(text);
  const node = scopeNamed(nodes, id);
  if (!node) return null;
  const doc = node === getDocumentScope(nodes) ? node : null;
  const result = { title: node.title, id: node.id || null, lineStart: node.lineStart, lineEnd: node.lineEnd, whole: Boolean(doc) };
  if (asText && doc) {
    // extractSection finds no document scope: its sections one by one.
    const listed = listSections(nodes);
    result.content = sectionNodes(nodes)
      .map(({ node: n, depth }, i) => ({ n, depth, derivedId: listed[i] ? listed[i].derivedId : null }))
      .filter(({ depth }) => depth === 0)
      .map(({ n, derivedId }) => {
        const extracted = extractSection(nodes, n.id || derivedId);
        return extracted && extracted.content ? `${n.title}\n${extracted.content}` : n.title;
      }).join("\n\n");
  } else if (asText) {
    const extracted = extractSection(nodes, node.id || String(id).replace(/^[@#]/, ""));
    result.content = extracted ? extracted.content : "";
  } else {
    result.source = text.split("\n").slice(node.lineStart - 1, node.lineEnd).join("\n");
  }
  return result;
}

// The signposts that serve someone about to read or to edit the document:
// { about, readingGuide, relatedResources, editingGuide }, each null when
// absent. readingGuide and relatedResources come as data
// (extractReadingGuide, extractRelatedResources).
function guidesText(text) {
  const { nodes } = parseSdoc(text);
  const resources = extractRelatedResources(nodes);
  return {
    about: extractAbout(nodes),
    readingGuide: extractReadingGuide(nodes),
    relatedResources: resources && resources.length ? resources : null,
    editingGuide: extractSignpost(nodes, "editing-guide")
  };
}

// The lines a signpost (or @meta) of the document spans, { lineStart,
// lineEnd }, or null when it has none: a reader shown those lines has read it.
function signpostRange(text, id) {
  let nodes;
  try { nodes = parseSdoc(text).nodes; } catch { return null; }
  const wanted = String(id || "").replace(/^@/, "").toLowerCase();
  const scope = reservedScopes(nodes).find((n) => n.id.toLowerCase() === wanted);
  return scope ? { lineStart: scope.lineStart, lineEnd: scope.lineEnd } : null;
}

// Every finding for a document: the signposts checked on the full tree (so a
// misplaced @meta is caught too), references and citations on the body. Each
// is { type, severity, message, lineStart }. resolveFilePath(href) says
// whether a linked file exists; without it, file links are not checked.
function checkText(text, { resolveFilePath } = {}) {
  const parsed = parseSdoc(text);
  const body = extractMeta(parsed.nodes).nodes;
  return [
    ...parsed.errors.map((e) => ({ type: "parse-error", severity: "error", message: e.message, lineStart: e.line })),
    ...validateSignposts(parsed.nodes),
    ...validateRefs(body, resolveFilePath ? { resolveFilePath } : {}),
    ...validateCitations(body)
  ];
}

// checkText with an asynchronous resolveFilePath, for a runtime whose file
// system is asynchronous. validateRefs asks synchronously, so this runs it
// twice: once to learn which hrefs it asks about, then with the answers.
async function checkTextAsync(text, { resolveFilePath } = {}) {
  if (!resolveFilePath) return checkText(text);
  const asked = new Set();
  checkText(text, { resolveFilePath: (href) => { asked.add(href); return true; } });
  const found = new Set();
  for (const href of asked) {
    if (await resolveFilePath(href)) found.add(href);
  }
  return checkText(text, { resolveFilePath: (href) => found.has(href) });
}

// --- Many documents ---
//
// io is { read(path), list(dir) }; either may return a promise. A file that
// cannot be read or parsed is skipped: one bad file must not hide the rest.

// The key a file's description is cached under, or null when the listing
// gave no size or time to tell a changed file by.
function describeKey(entry) {
  const known = (n) => typeof n === "number" && Number.isFinite(n);
  return known(entry.mtimeMs) && entry.mtimeMs > 0 && known(entry.size) ? `${entry.path}|${entry.mtimeMs}|${entry.size}` : null;
}

// Every file of dirs, described (describeText). cache, when given, is
// { get(key), set(key, description) }, either possibly a promise, key being
// path|mtimeMs|size from the listing: a file whose key it holds is not read.
// A file the listing gives no size or time for is read and not cached; a
// cache that fails is passed over.
async function listFiles(dirs, io, { cache } = {}) {
  const result = [];
  for (const dir of dirs) {
    for (const entry of await findSdocEntries(dir, io.list)) {
      const key = cache ? describeKey(entry) : null;
      let held = null;
      if (key) {
        try { held = await cache.get(key); } catch { /* read instead */ }
      }
      if (held && typeof held === "object" && typeof held.lines === "number") {
        result.push({ ...held, path: entry.path });
        continue;
      }
      let description = null;
      try { description = describeText(await io.read(entry.path), entry.path); } catch { /* skipped */ }
      if (!description) continue;
      result.push(description);
      if (key) {
        try { await cache.set(key, description); } catch { /* not kept */ }
      }
    }
  }
  return result;
}

// The lines a section holds itself: its range minus the ranges of the
// sections nested in it, so a match is reported once, at the deepest section.
function ownLines(lines, node) {
  const own = [];
  const children = (node.children || []).filter((c) => c.type === "scope" && c.hasHeading);
  for (let n = node.lineStart; n <= node.lineEnd; n++) {
    if (children.some((c) => n >= c.lineStart && n <= c.lineEnd)) continue;
    own.push({ n, text: lines[n - 1] || "" });
  }
  return own;
}

function snippetOf(text, term, width = 140) {
  const clean = text.trim().replace(/\s+/g, " ");
  if (clean.length <= width) return clean;
  const at = Math.max(0, clean.toLowerCase().indexOf(term) - 40);
  return (at > 0 ? "…" : "") + clean.slice(at, at + width) + "…";
}

// Every .sdoc file under dirs as { path, text, nodes }, each once, nodes
// being its parse (null when it does not parse; whoever uses the doc skips
// it). cache, when given, is a Map kept between calls, by path: a file whose
// path, size and modification time (describeKey) it holds is neither read
// nor parsed again. A file the listing gives no size or time for is read
// every time. Whoever uses the nodes must not change them.
async function readDocs(dirs, io, { cache } = {}) {
  const docs = [];
  const seen = new Set();
  for (const dir of dirs) {
    for (const entry of await findSdocEntries(dir, io.list)) {
      const file = entry.path;
      if (seen.has(file)) continue;
      seen.add(file);
      const key = cache ? describeKey(entry) : null;
      const held = key ? cache.get(file) : null;
      if (held && held.key === key) {
        docs.push({ path: file, text: held.text, nodes: held.nodes });
        continue;
      }
      let text;
      try { text = await io.read(file); } catch { continue; }
      const nodes = parsedNodes(text);
      if (key) cache.set(file, { key, text, nodes });
      docs.push({ path: file, text, nodes });
    }
  }
  return docs;
}

// A text's parse, or null when it does not parse.
function parsedNodes(text) {
  try { return parseSdoc(text).nodes; } catch { return null; }
}

// A doc's nodes: those readDocs parsed, else parsed now; null when it does
// not parse.
function nodesOf(doc) {
  return doc.nodes !== undefined ? doc.nodes : parsedNodes(doc.text);
}

// @meta and the signposts of a document: the scopes with a reserved id at the
// level they live at, inside the root or beside it.
function reservedScopes(nodes) {
  const doc = getDocumentScope(nodes);
  const level = doc ? nodes.filter((n) => n !== doc).concat(doc.children) : nodes;
  return level.filter((n) => n.type === "scope" && n.id && RESERVED_SCOPE_IDS.has(n.id.toLowerCase()));
}

// --- Ranked search ---
//
// BM25 over each file's @about, its headed sections and the text it holds
// outside them: a word counts for more the fewer units hold it, its count
// saturates (k1), and a long section's counts are discounted against the
// average length (b). A word in a section's title adds twice its weight
// again; a file's @about, the summary written to be found, weighs half as
// much again as a section.

const RANK_K1 = 1.2;
const RANK_B = 0.75;
const RANK_TITLE = 2;
const RANK_ABOUT = 1.5;
// Fewer sections than this holding the most words of a query no section
// holds whole, and those holding one word fewer are listed after them, so
// long as that is still half the words or more.
const RANK_FALLBACK_MIN = 3;

// The quotes, brackets and sentence punctuation around a word of a query:
// "fsync", (fsync) and fsync? are all fsync.
const QUERY_EDGES = /^["'`‘’“”«»()[\]{}<>,;:!?.]+|["'`‘’“”«»()[\]{}<>,;:!?.]+$/g;

// The query's words, lowercased, each once, without the punctuation around
// them. A one-letter word matches inside almost anything, so it is dropped,
// unless the query is nothing else.
function queryTerms(query) {
  const words = String(query || "").toLowerCase().split(/\s+/).map((w) => w.replace(QUERY_EDGES, ""));
  const all = [...new Set(words.filter(Boolean))];
  const kept = all.filter((t) => t.length > 1);
  return kept.length ? kept : all;
}

// The words of a text, for its length: braces, # and the like are not words.
function wordCount(text) {
  return text.split(/\s+/).filter((w) => /[^{}#|>*\-[\]()]/.test(w)).length;
}

// The text a file holds outside its headed sections and its signposts (a
// preamble, or the whole body of a file with no sections), as a unit, or null
// when it holds none. With a headed root, the unit is the root, named by its
// id or title slug, its heading line not counted as text; without one, the
// file, which no id names, titled (top level).
function rootUnit(filePath, nodes, lines) {
  const doc = getDocumentScope(nodes);
  const headed = doc && doc.hasHeading ? doc : null;
  const scope = doc || { lineStart: 1, lineEnd: lines.length, children: nodes };
  const reserved = reservedScopes(nodes);
  const own = ownLines(lines, scope).filter(({ n }) =>
    !(headed && n === headed.lineStart) && !reserved.some((r) => n >= r.lineStart && n <= r.lineEnd));
  if (!wordCount(own.map((l) => l.text).join("\n"))) return null;
  return {
    path: filePath,
    id: headed && headed.id ? headed.id : null,
    derivedId: headed && headed.title ? slugify(headed.title) : null,
    title: headed && headed.title ? headed.title : "(top level)",
    untitled: !(headed && headed.title),
    lineStart: scope.lineStart,
    lineEnd: scope.lineEnd,
    lines: own
  };
}

// The units a ranked search weighs, in document order: each file's @about,
// the text it holds outside any section, then each headed section with the
// lines it holds itself.
function searchUnits(docs) {
  const units = [];
  for (const doc of docs) {
    const { path: filePath, text } = doc;
    const nodes = nodesOf(doc);
    if (!nodes) continue;
    const lines = text.split("\n");
    const about = extractAbout(nodes);
    if (about) {
      const scope = reservedScopes(nodes).find((n) => n.id.toLowerCase() === "about");
      const first = scope && (scope.children || []).find((c) => c.type === "paragraph");
      units.push({
        path: filePath, id: "about", derivedId: "about", title: "About", about,
        lineStart: scope ? scope.lineStart : 1,
        lineEnd: scope ? scope.lineEnd : 1,
        lines: [{ n: first ? first.lineStart : scope ? scope.lineStart : 1, text: about }]
      });
    }
    const root = rootUnit(filePath, nodes, lines);
    if (root) units.push(root);
    const listed = listSections(nodes);
    sectionNodes(nodes).forEach(({ node }, i) => {
      units.push({
        path: filePath, id: node.id || null, derivedId: listed[i] ? listed[i].derivedId : null, title: node.title,
        lineStart: node.lineStart, lineEnd: node.lineEnd, lines: ownLines(lines, node)
      });
    });
  }
  return units;
}

// Sections ranked by how well their own text answers the query, best first:
// { hits, total, matched, least, terms }. The sections that hold every word
// of the query when any does; else, with two words or more, those that hold
// the most of them (matched says how many), and when fewer than
// RANK_FALLBACK_MIN do, those holding one fewer after them (least), if that is
// half the words or more. total
// counts them all, hits keeps the best limit. Each hit is { path, id, derivedId, title, line, snippet,
// score, missing, lineStart, lineEnd }, missing being the words it lacks; a
// file's @about is a hit with the id "about" and its text as about.
function rankSections(docs, query, { limit = 20 } = {}) {
  const terms = queryTerms(query);
  const none = { hits: [], total: 0, matched: 0, terms };
  if (!terms.length) return none;
  const units = searchUnits(docs).map((u) => {
    const haystack = u.lines.map((l) => l.text).join("\n").toLowerCase();
    const counts = terms.map((t) => haystack.split(t).length - 1);
    return { ...u, counts, held: counts.filter(Boolean).length, length: wordCount(haystack) };
  });
  const matched = units.reduce((most, u) => Math.max(most, u.held), 0);
  if (!matched || (matched < terms.length && terms.length < 2)) return none;
  const n = units.length;
  const average = units.reduce((sum, u) => sum + u.length, 0) / n || 1;
  const idf = terms.map((_, i) => {
    const holding = units.filter((u) => u.counts[i]).length;
    return Math.log(1 + (n - holding + 0.5) / (holding + 0.5));
  });
  const fewest = matched < terms.length && (matched - 1) * 2 >= terms.length &&
    units.filter((u) => u.held === matched).length < RANK_FALLBACK_MIN ? matched - 1 : matched;
  const ranked = units.filter((u) => u.held >= fewest).map((u) => {
    const title = u.about || u.untitled ? "" : String(u.title || "").toLowerCase();
    let score = 0;
    terms.forEach((t, i) => {
      const count = u.counts[i];
      if (!count) return;
      score += idf[i] * count * (RANK_K1 + 1) / (count + RANK_K1 * (1 - RANK_B + RANK_B * u.length / average));
      if (title.includes(t)) score += RANK_TITLE * idf[i];
    });
    if (u.about) score *= RANK_ABOUT;
    // Prefer a body line to the heading line, which repeats the title.
    const term = terms.find((_, i) => u.counts[i]);
    const matching = u.lines.filter((l) => l.text.toLowerCase().includes(term));
    const line = matching.find((l) => !/^\s*#/.test(l.text)) || matching[0] || u.lines[0] || { n: u.lineStart, text: u.title };
    const hit = {
      path: u.path, id: u.id, derivedId: u.derivedId, title: u.title, line: line.n, snippet: snippetOf(line.text, term),
      score, missing: terms.filter((_, i) => !u.counts[i]), lineStart: u.lineStart, lineEnd: u.lineEnd
    };
    if (u.about) hit.about = u.about;
    return hit;
  });
  ranked.sort((a, b) => a.missing.length - b.missing.length || b.score - a.score);
  return { hits: ranked.slice(0, limit), total: ranked.length, matched, least: fewest, terms };
}

// rankSections over every .sdoc file under dirs; cache as readDocs takes it.
async function rankFiles(query, dirs, io, { cache, ...options } = {}) {
  return rankSections(await readDocs(dirs, io, { cache }), query, options);
}

// --- Backlinks ---

// The absolute paths a link's file part may name, from dir: as written, then
// percent-decoded when that differs, as src/href-path.js tries them for
// build-doc --check. A literal % in a name leaves the first alone.
function hrefPaths(dir, file) {
  const paths = [joinPath(dir, file)];
  try {
    const decoded = decodeURIComponent(file);
    if (decoded !== file) paths.push(joinPath(dir, decoded));
  } catch { /* a literal %: as written only */ }
  return paths;
}

// The file and fragment a link's href names, as candidate absolute paths
// (hrefPaths), or null for a web or mail link: one with a URL scheme, as the
// broken-link check tells it (hasUrlScheme), so C:/x.sdoc is a path. An
// empty file part names the file the link is in.
function linkTargets(href, fromPath) {
  if (hasUrlScheme(href)) return null;
  const cut = href.indexOf("#");
  const file = (cut < 0 ? href : href.slice(0, cut)).split("?")[0];
  let fragment = cut < 0 ? "" : href.slice(cut + 1);
  try { fragment = decodeURIComponent(fragment); } catch { /* a literal %: as written */ }
  if (!file) return { paths: [normalizePath(fromPath)], fragment };
  return { paths: hrefPaths(dirName(fromPath), file), fragment };
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Where a line of a document sits, as a function of the line: its deepest
// section (the last in document order that holds it), else the signpost (or
// @meta) that holds it, else neither, the file itself.
function placesIn(nodes) {
  const listed = listSections(nodes);
  const sections = sectionNodes(nodes).map(({ node }, i) => ({
    id: node.id || null, derivedId: listed[i] ? listed[i].derivedId : null, title: node.title, lineStart: node.lineStart, lineEnd: node.lineEnd
  }));
  const reserved = reservedScopes(nodes);
  return (line) => {
    const holds = (s) => line >= s.lineStart && line <= s.lineEnd;
    const section = sections.filter(holds).pop();
    if (section) return { section };
    const signpost = reserved.find(holds);
    return signpost ? { signpost: signpost.id.toLowerCase() } : {};
  };
}

// What links to a file, or to one section of it: { path, section, hits },
// section being the one id names ({ id, derivedId, title, lineStart,
// lineEnd, whole, inside }) or null; null when id names no section of the
// file (or the file is not among docs). Without id, the links from other
// files to the file, whatever their fragment. With id, the links whose
// fragment names that section or one inside it, by @id or title slug alike,
// and the @id references to them in the file itself (an @ref names a section
// of its own file only). section.inside lists the sections inside it ({ id,
// derivedId, title, lineStart, lineEnd }), all searched with it; a hit to one
// of them is marked inside, with to naming which. Each hit is { path, line,
// href or ref, section or signpost }: where the link sits, by its deepest
// section, or the signpost that holds it, or neither when it sits outside any
// section.
function backlinksTexts(docs, targetPath, { id } = {}) {
  const target = normalizePath(targetPath);
  const targetDoc = docs.find((d) => normalizePath(d.path) === target);
  if (!targetDoc) return null;
  const targetNodes = nodesOf(targetDoc);
  if (!targetNodes) return null;
  const wanted = id ? scopeNamed(targetNodes, id) : null;
  if (id && !wanted) return null;
  const whole = wanted && wanted === getDocumentScope(targetNodes);
  const walked = sectionNodes(targetNodes);
  const listed = listSections(targetNodes);
  const described = (node) => {
    const i = walked.findIndex((w) => w.node === node);
    return { id: node.id || null, derivedId: listed[i] ? listed[i].derivedId : slugify(node.title || ""), title: node.title, lineStart: node.lineStart, lineEnd: node.lineEnd };
  };
  const isInside = (node) => !whole && node !== wanted && node.lineStart >= wanted.lineStart && node.lineEnd <= wanted.lineEnd;
  const subsections = wanted && !whole ? walked.filter(({ node }) => isInside(node)).map(({ node }) => described(node)) : [];
  // What a fragment names: { kind, node }, kind "self" for the section
  // wanted, "inside" for one within it, else false.
  const named = new Map();
  const names = (fragment) => {
    if (!named.has(fragment)) {
      const node = scopeNamed(targetNodes, fragment);
      named.set(fragment, { node, kind: !node || !wanted ? false : node === wanted ? "self" : isInside(node) ? "inside" : false });
    }
    return named.get(fragment);
  };
  const insideMark = (kind, node) => (kind === "inside" ? { inside: true, to: described(node) } : {});
  // A reference from within the section to a section inside it moves with
  // it, so it is not counted.
  const within = (line) => wanted && line >= wanted.lineStart && line <= wanted.lineEnd;
  const hits = [];
  const seen = new Set();
  for (const doc of docs) {
    const { path: filePath, text } = doc;
    const from = normalizePath(filePath);
    const own = from === target;
    if (own && !wanted) continue;
    const nodes = nodesOf(doc);
    if (!nodes) continue;
    const { refs, links } = collectInlineRefs(nodes);
    // The line of a paragraph that holds the mark, not the paragraph's first;
    // the second time the same mark is asked for there, the next one. A mark
    // is matched whole, as the parser reads it: @intro not inside
    // @intro-old, a link's (href) not inside a longer href.
    const lines = text.split("\n");
    const asked = new Map();
    const lineOf = (at, mark) => {
      const key = at.lineStart + "\n" + mark.source;
      let skip = asked.get(key) || 0;
      asked.set(key, skip + 1);
      for (let n = at.lineStart; n <= (at.lineEnd || at.lineStart); n++) {
        const count = ((lines[n - 1] || "").match(mark) || []).length;
        if (skip < count) return n;
        skip -= count;
      }
      return at.lineStart;
    };
    const found = [];
    for (const link of links) {
      const to = linkTargets(link.href, from);
      if (!to || !to.paths.includes(target)) continue;
      const { kind, node } = wanted ? (to.fragment ? names(to.fragment) : { kind: whole && "self" }) : { kind: "self" };
      if (!kind) continue;
      const line = lineOf(link, new RegExp(`\\(\\s*${escapeRegExp(link.href)}\\s*\\)`, "g"));
      if (kind === "inside" && own && within(line)) continue;
      found.push({ line, href: link.href, ...insideMark(kind, node) });
    }
    if (own) {
      for (const ref of refs) {
        const { kind, node } = names(ref.id);
        if (!kind) continue;
        const line = lineOf(ref, new RegExp(`(?<![A-Za-z0-9._+-])@${escapeRegExp(ref.id)}(?![A-Za-z0-9_-])`, "g"));
        if (kind === "inside" && within(line)) continue;
        found.push({ line, ref: ref.id, ...insideMark(kind, node) });
      }
    }
    const placeOf = found.length ? placesIn(nodes) : null;
    for (const f of found) {
      const key = `${from}\n${f.line}\n${f.href || "@" + f.ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ path: filePath, ...f, ...placeOf(f.line) });
    }
  }
  hits.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
  const section = wanted
    ? { id: wanted.id || null, derivedId: slugify(wanted.title || ""), title: wanted.title, lineStart: wanted.lineStart, lineEnd: wanted.lineEnd, whole: Boolean(whole), inside: subsections }
    : null;
  return { path: target, section, hits };
}

// backlinksTexts over every .sdoc file under dirs, and over the target
// itself wherever it is, so its own references are found; cache as readDocs
// takes it.
async function backlinksFiles(targetPath, dirs, io, { cache, ...options } = {}) {
  const docs = await readDocs(dirs, io, { cache });
  const target = normalizePath(targetPath);
  if (!docs.some((d) => normalizePath(d.path) === target)) {
    try { docs.push({ path: target, text: await io.read(target) }); } catch { return null; }
  }
  return backlinksTexts(docs, target, options);
}

// --- Text formatting ---
//
// Compact on purpose: these lines go straight into an agent's context. base,
// when given, shortens every path under it to a relative one.

function clip(text, max) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max - 1).trimEnd() + "…";
}

// @id, else (title-slug); nothing for the text of a file with no headed root,
// which no id names.
function sectionLabel(s) {
  return s.id ? "@" + s.id : s.derivedId ? "(" + s.derivedId + ")" : "";
}

// One line per file: path [type] (N lines) — about, or with titles the
// file's title instead. The about is whole unless aboutMax is given: a
// summary cut short misleads more than none. Given now (seconds since the
// epoch), a file whose changed time is known (the same) says how long ago:
// (N lines, changed 3 weeks ago). A file without one reads as it always has.
function formatFileList(files, { base, aboutMax = Infinity, titles = false, now } = {}) {
  return files.map((f) => {
    const type = f.type ? ` [${f.type}]` : "";
    const age = now !== undefined && typeof f.changed === "number" ? formatAge(f.changed, now) : null;
    const changed = age ? `, changed ${age === "today" ? age : age + " ago"}` : "";
    const rest = titles ? " — " + f.title : f.about ? " — " + clip(f.about, aboutMax) : " — (no @about)";
    return `${shownPath(f.path, base)}${type} (${f.lines} lines${changed})${rest}`;
  }).join("\n");
}

// How long before nowSec the time sec is, both in seconds since the epoch,
// in the fewest words: "today" (under a day, or ahead of now), "3 days",
// "3 weeks", "4 months", "2 years".
function formatAge(sec, nowSec) {
  const days = Math.floor((nowSec - sec) / 86400);
  const count = (n, unit) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (!(days >= 1)) return "today";
  if (days < 14) return count(days, "day");
  if (days < 60) return count(Math.floor(days / 7), "week");
  if (days < 365) return count(Math.floor(days / 30), "month");
  return count(Math.floor(days / 365), "year");
}

// The document's id, title and signposts, then one line per section,
// indented by depth: L<start>-<end> @id Title — preview. Sections deeper than
// maxDepth are left out (a deep outline of a large file is itself long).
function formatOutline(o, { base, maxDepth = Infinity, previews = true } = {}) {
  const out = [`${shownPath(o.path, base)}${o.id ? " @" + o.id : ""} — ${o.title} (${o.lines} lines)`];
  if (o.signposts.length) out.push("signposts: " + o.signposts.map((id) => "@" + id).join(", "));
  for (const s of o.sections) {
    if (s.depth > maxDepth) continue;
    const preview = previews && s.preview ? " — " + clip(s.preview, 90) : "";
    out.push(`${"  ".repeat(s.depth)}L${s.lineStart}-${s.lineEnd} ${sectionLabel(s)} ${s.title}${preview}`);
  }
  return out.join("\n");
}

// A section's source with line numbers, in the shape the Read tool prints, so
// an edit can be made from it.
function formatSection(filePath, section, { base, numbers = true } = {}) {
  const head = `${shownPath(filePath, base)} L${section.lineStart}-${section.lineEnd} — ${section.title}`;
  if (section.content !== undefined) return head + "\n" + section.content;
  const body = section.source.split("\n").map((line, i) =>
    numbers ? `${String(section.lineStart + i).padStart(6)}\t${line}` : line).join("\n");
  return head + "\n" + body;
}

// One line per hit: file:line @id Title — snippet, with [no "word"] after the
// title of a hit that lacks words of the query. Given what rankSections
// answers beside its hits (total, matched, terms), a line before the list
// says when no section holds every word, and one after it when the list was
// cut.
function formatSearch(hits, { base, total, matched, least = matched, terms } = {}) {
  const lines = hits.map((h) => {
    const missing = h.missing && h.missing.length ? ` [no ${h.missing.map((t) => `"${t}"`).join(", ")}]` : "";
    const label = sectionLabel(h);
    return `${shownPath(h.path, base)}:${h.line} ${label ? label + " " : ""}${h.title}${missing} — ${h.snippet}`;
  });
  if (terms && matched < terms.length) {
    const held = least < matched ? `${matched} or ${least}` : matched;
    lines.unshift(`No section holds ${terms.length === 2 ? "both words" : `all ${terms.length} words`}; these hold ${held}:`);
  }
  if (total > hits.length) lines.push(`${hits.length} of ${total} matching sections shown, best first.`);
  return lines.join("\n");
}

// The most sections inside the one asked about that formatBacklinks names.
const BACKLINKS_MAX_NAMED = 20;

// What backlinksTexts found, one line per link: file:line, where it sits
// (@id Title, a signpost, or outside any section), then the href or @id it
// links by, and for a link to a section inside the one asked about, which.
// When that section has sections inside it, a last line says they were
// covered and which of them nothing links to, so none is asked about again
// on its own. where names the directories searched, for the line that says
// nothing links there.
function formatBacklinks(found, { base, where = "lexica/" } = {}) {
  const s = found.section;
  const target = shownPath(found.path, base) + (s ? " " + (s.id ? "@" + s.id : "(" + s.derivedId + ")") : "");
  const subsections = (s && s.inside) || [];
  const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const listed = (list) => list.slice(0, BACKLINKS_MAX_NAMED).map(sectionLabel).join(", ") +
    (list.length > BACKLINKS_MAX_NAMED ? `, and ${list.length - BACKLINKS_MAX_NAMED} more` : "");
  if (!found.hits.length) {
    const also = subsections.length ? ` or the ${count(subsections.length, "section")} inside it (${listed(subsections)})` : "";
    return `Nothing in ${where} links to ${target}${also}.`;
  }
  const lines = found.hits.map((h) => {
    const place = h.section ? `${sectionLabel(h.section)} ${h.section.title}` : h.signpost ? "@" + h.signpost : "(outside any section)";
    return `${shownPath(h.path, base)}:${h.line} ${place} — ${h.ref ? "@" + h.ref : h.href}${h.to ? ` (to ${sectionLabel(h.to)})` : ""}`;
  });
  if (subsections.length) {
    const linked = new Set(found.hits.filter((h) => h.to).map((h) => h.to.lineStart));
    const unlinked = subsections.filter((x) => !linked.has(x.lineStart));
    lines.push(`Covers the ${count(subsections.length, "section")} inside it: ` +
      (unlinked.length ? `nothing links to ${listed(unlinked)}.` : "each is linked above."));
  }
  const inside = found.hits.some((h) => h.inside) ? " or a section inside it" : "";
  return `${found.hits.length} link${found.hits.length === 1 ? "" : "s"} to ${target}${inside}:\n${lines.join("\n")}`;
}

// The reading guide and the related resources, for someone about to read. A
// related resource that is a file is given by its path from base, so it can
// be opened as it stands.
function formatReadingGuides(filePath, g, { base } = {}) {
  const parts = [];
  if (g.readingGuide && (g.readingGuide.text || g.readingGuide.entries.length)) {
    const lines = ["Reading guide:"];
    if (g.readingGuide.text) lines.push(g.readingGuide.text);
    for (const e of g.readingGuide.entries) lines.push(`- ${e.sections.map((id) => "@" + id).join(", ")}: ${e.note}`);
    parts.push(lines.join("\n"));
  }
  if (g.relatedResources) {
    const dir = dirName(filePath);
    const lines = ["Related resources:"];
    for (const r of g.relatedResources) {
      const [file, fragment] = r.href.split("#");
      const target = r.kind === "external" ? r.href : shownPath(joinPath(dir, file), base) + (fragment ? "#" + fragment : "");
      lines.push(r.label === target ? `- ${target}: ${r.relation}` : `- ${r.label} (${target}): ${r.relation}`);
    }
    parts.push(lines.join("\n"));
  }
  return parts.join("\n\n");
}

// file:line: [warning: ]message, the shape build-doc --check prints.
function formatFindings(filePath, findings, { base } = {}) {
  return findings.map((f) =>
    `${shownPath(filePath, base)}:${f.lineStart || 1}: ${f.severity === "warning" ? "warning: " : ""}${f.message}`).join("\n");
}

export {
  KNOWLEDGE_DIR_NAME,
  isAbsolutePath,
  normalizePath,
  joinPath,
  dirName,
  baseName,
  isInside,
  shownPath,
  isSdocFile,
  findKnowledgeDirs,
  findSdocFiles,
  describeText,
  outlineText,
  readSectionText,
  guidesText,
  signpostRange,
  checkText,
  checkTextAsync,
  listFiles,
  findSdocEntries,
  readDocs,
  rankSections,
  rankFiles,
  hrefPaths,
  linkTargets,
  backlinksTexts,
  backlinksFiles,
  formatFileList,
  formatAge,
  formatOutline,
  formatSection,
  formatSearch,
  formatBacklinks,
  formatReadingGuides,
  formatFindings
};

// The sources this lib was built from, hashed (tools/build-plugin.js).
export const BUILD = "05a200021b8c";
