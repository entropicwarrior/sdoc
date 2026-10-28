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
  validateCitations
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
  const files = [];
  async function walk(current) {
    for (const entry of await entriesOf(list, current)) {
      const full = joinPath(current, entry.name);
      if (walkable(entry)) await walk(full);
      else if (entry.kind === "file" && isSdocFile(entry.name)) files.push(full);
    }
  }
  await walk(normalizePath(dir));
  return files.sort();
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

// The section an id names: an explicit @id first, then a title slug, ignoring
// case — the order extractSection uses. A leading @ or # is ignored.
function findSectionNode(nodes, id) {
  const walked = sectionNodes(nodes);
  const listed = listSections(nodes);
  const wanted = String(id || "").trim().replace(/^[@#]/, "");
  const exact = walked.find(({ node }) => node.id === wanted);
  if (exact) return exact.node;
  const lower = wanted.toLowerCase();
  const index = listed.findIndex((s) => s.derivedId.toLowerCase() === lower);
  return index >= 0 && walked[index] ? walked[index].node : null;
}

// The document's own heading scope when id names it, by its @id or its title
// slug, else null.
function documentScopeNamed(nodes, id) {
  const doc = getDocumentScope(nodes);
  if (!doc || !doc.hasHeading) return null;
  const wanted = String(id || "").trim().replace(/^[@#]/, "");
  if (doc.id === wanted) return doc;
  return doc.title && slugify(doc.title).toLowerCase() === wanted.toLowerCase() ? doc : null;
}

// One section as written: { title, id, lineStart, lineEnd, whole, source },
// source being the raw lines from the heading to the closing brace. The
// document's own id names the whole file (whole: true). With { text: true },
// content is the section flattened to plain text instead. Null when no
// section has that id.
function readSectionText(text, id, { text: asText = false } = {}) {
  const { nodes } = parseSdoc(text);
  const doc = documentScopeNamed(nodes, id);
  const node = doc || findSectionNode(nodes, id);
  if (!node) return null;
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

async function listFiles(dirs, io) {
  const result = [];
  for (const dir of dirs) {
    for (const file of await findSdocFiles(dir, io.list)) {
      try { result.push(describeText(await io.read(file), file)); } catch { /* skipped */ }
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

// Sections whose own text holds every word of the query, ignoring case, best
// first: [{ path, id, derivedId, title, line, snippet, score }]. A file's
// @about is searched too, as a section with the id "about".
function searchTexts(docs, query, { limit = 20 } = {}) {
  const terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const hits = [];
  function consider(filePath, unit) {
    const haystack = (unit.title + "\n" + unit.lines.map((l) => l.text).join("\n")).toLowerCase();
    if (!terms.every((t) => haystack.includes(t))) return;
    const score = terms.reduce((sum, t) => sum + haystack.split(t).length - 1, 0) +
      terms.filter((t) => unit.title.toLowerCase().includes(t)).length * 5;
    // Prefer a body line to the heading line, which repeats the title.
    const matching = unit.lines.filter((l) => l.text.toLowerCase().includes(terms[0]));
    const hit = matching.find((l) => !/^\s*#/.test(l.text)) || matching[0] || unit.lines[0] || { n: unit.line, text: unit.title };
    hits.push({ path: filePath, id: unit.id, derivedId: unit.derivedId, title: unit.title, line: hit.n, snippet: snippetOf(hit.text, terms[0]), score });
  }
  for (const { path: filePath, text } of docs) {
    let nodes;
    try { nodes = parseSdoc(text).nodes; } catch { continue; }
    const lines = text.split("\n");
    const about = extractAbout(nodes);
    if (about) consider(filePath, { id: "about", derivedId: "about", title: "About", line: 1, lines: [{ n: 1, text: about }] });
    const listed = listSections(nodes);
    sectionNodes(nodes).forEach(({ node }, i) => {
      consider(filePath, {
        id: node.id || null,
        derivedId: listed[i] ? listed[i].derivedId : null,
        title: node.title,
        line: node.lineStart,
        lines: ownLines(lines, node)
      });
    });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

async function searchFiles(query, dirs, io, options) {
  const docs = [];
  for (const dir of dirs) {
    for (const file of await findSdocFiles(dir, io.list)) {
      try { docs.push({ path: file, text: await io.read(file) }); } catch { /* skipped */ }
    }
  }
  return searchTexts(docs, query, options);
}

// --- Text formatting ---
//
// Compact on purpose: these lines go straight into an agent's context. base,
// when given, shortens every path under it to a relative one.

function clip(text, max) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max - 1).trimEnd() + "…";
}

function sectionLabel(s) {
  return s.id ? "@" + s.id : "(" + s.derivedId + ")";
}

// One line per file: path [type] (N lines) — about. The about is whole unless
// aboutMax is given: a summary cut short misleads more than none.
function formatFileList(files, { base, aboutMax = Infinity } = {}) {
  return files.map((f) => {
    const type = f.type ? ` [${f.type}]` : "";
    const about = f.about ? " — " + clip(f.about, aboutMax) : " — (no @about)";
    return `${shownPath(f.path, base)}${type} (${f.lines} lines)${about}`;
  }).join("\n");
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

function formatSearch(hits, { base } = {}) {
  return hits.map((h) => `${shownPath(h.path, base)}:${h.line} ${h.id ? "@" + h.id : "(" + h.derivedId + ")"} ${h.title} — ${h.snippet}`).join("\n");
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
  checkText,
  checkTextAsync,
  listFiles,
  searchTexts,
  searchFiles,
  formatFileList,
  formatOutline,
  formatSection,
  formatSearch,
  formatReadingGuides,
  formatFindings
};
