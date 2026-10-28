// What the sdoc plugin does, written against a small io adapter so the same
// code runs inside Claude Code, where register.mjs binds it to the engine's
// file system, and under Node, where test/test-plugin.js binds it to fs:
//
//   io.read(path)   → the file's text
//   io.list(dir)    → [{ name, kind }], kind "file", "dir" or other
//   io.exists(path) → boolean
//   io.log(text, { quiet })
//                   → optional: one line saying what the plugin just did, for
//                     whoever is checking that it works (the verbose option);
//                     quiet when the session already shows it (a tool's answer)
//   io.realPath(p)  → optional: where p leads through links
//
// each possibly a promise. Paths are absolute; cwd is the session's directory.
// Nothing here throws on a missing or unparsable file: the plugin stays quiet
// rather than get in the way of the work.

import * as kb from "../lib/knowledge-base.mjs";

// Past this many lines, reading a file whole earns a pointer to its outline.
export const LARGE_FILE_LINES = 300;

// How much the knowledge index may add to a conversation's first prompt, in
// characters, by the plugin's indexSize option: about 1,500, 3,000 or 6,000
// tokens.
export const INDEX_SIZES = { "6k": 6000, "12k": 12000, "24k": 24000 };
export const DEFAULT_INDEX_SIZE = "12k";

// The budget for an indexSize value; the default for anything else.
export function indexBudget(size) {
  return INDEX_SIZES[size] || INDEX_SIZES[DEFAULT_INDEX_SIZE];
}

// What the conversation has been shown: the knowledge index, once; per agent
// and file, the reading signposts and the large-file pointer on a first Read
// and the editing guide on a first edit. Reset when the conversation is
// compacted or cleared, since what was shown is then gone from it.
export function createState() {
  return { indexSent: false, readSeen: new Set(), nudged: new Set(), editAcked: new Set(), opening: null };
}

export function resetState(state) {
  state.indexSent = false;
  state.readSeen.clear();
  state.nudged.clear();
  state.editAcked.clear();
}

// A short fingerprint of the conversation's opening message (FNV-1a over its
// content), or null when it has none yet.
export function openingOf(messages) {
  const first = messages && messages[0];
  if (!first) return null;
  const text = JSON.stringify(first.content);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${text.length}:${hash.toString(16)}`;
}

// Whether the conversation lost its opening since the last prompt, recording
// the one it has now. Only a compaction (its summary takes the place of what
// it replaced) or a /clear changes the opening message, so this tells the
// plugin that what it showed is gone. Claude Code's own signals for either
// are passed over for a user plugin (docs/guide/claude-code-plugin.sdoc).
export function lostOpening(state, opening) {
  const lost = state.opening !== null && opening !== state.opening;
  state.opening = opening;
  return lost;
}

function seenKey(agentId, filePath) {
  return (agentId || "main") + "\n" + kb.normalizePath(filePath);
}

function note(io, text, { quiet = false } = {}) {
  if (!io.log) return;
  try { io.log(text, { quiet }); } catch { /* a log line must never break a hook */ }
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

async function readText(io, filePath) {
  try {
    return await io.read(filePath);
  } catch {
    return null;
  }
}

// --- The knowledge index ---

export async function knowledgeDirs(io, cwd) {
  return kb.findKnowledgeDirs(cwd, io.list);
}

// The index's lines, one per file: path [type] (N lines), then the file's
// @about whole, or with titlesOnly its title. A summary is never cut short: a
// clipped one misleads more than none.
function indexLines(files, cwd, titlesOnly) {
  if (!titlesOnly) return kb.formatFileList(files, { base: cwd }).split("\n").filter(Boolean);
  return files.map((f) => `${kb.shownPath(f.path, cwd)}${f.type ? ` [${f.type}]` : ""} (${f.lines} lines) — ${f.title}`);
}

// The lexica/ files and how to load them progressively, in at most maxChars
// characters; null when the project has no lexica/ directory. Every file with
// its whole summary when they fit; else every file with its title instead;
// and only when even that does not fit, as many files as do, and a count of
// the rest.
export async function knowledgeIndex(io, cwd, { maxChars = indexBudget(), dirs } = {}) {
  dirs = dirs || await knowledgeDirs(io, cwd);
  if (!dirs.length) return null;
  const files = await kb.listFiles(dirs, io);
  const head = [
    "This project keeps its knowledge in SDOC files under lexica/ (type doc: what something is; type skill: how to do something). Load it progressively instead of reading files whole:",
    "- mcp__sdoc-lexica__outline lists a file's sections with their line ranges; mcp__sdoc-lexica__read reads the sections you need; mcp__sdoc-lexica__search finds sections by words; mcp__sdoc-lexica__list lists files with their summaries.",
    `- Outline a file over ${LARGE_FILE_LINES} lines before reading it, then read sections or Read with offset/limit.`,
    "Before starting a task, check the index for files whose summary or title matches it.",
    ""
  ].join("\n");
  // Room for the closing line that says what was left out.
  const room = maxChars - head.length - 120;
  const size = (lines) => lines.reduce((n, line) => n + line.length + 1, 0);
  let titlesOnly = false;
  let lines = indexLines(files, cwd, false);
  if (size(lines) > room) {
    titlesOnly = true;
    lines = indexLines(files, cwd, true);
  }
  const kept = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > room) break;
    kept.push(line);
    used += line.length + 1;
  }
  const left = lines.length - kept.length;
  if (left) kept.push(`… and ${left} more files. mcp__sdoc-lexica__list shows them all, with their summaries.`);
  else if (titlesOnly) kept.push("(Titles only: the summaries did not fit. mcp__sdoc-lexica__list shows them.)");
  if (!files.length) kept.push("(no .sdoc files yet)");
  const index = head + kept.join("\n");
  const detail = left ? `; titles only, and ${left} left out` : titlesOnly ? "; titles only" : "";
  note(io, `index attached to the prompt: ${plural(files.length, "knowledge file")} from ` +
    `${dirs.map((d) => kb.shownPath(d, cwd)).join(", ")} (${index.length} of ${maxChars} chars${detail})`);
  return index;
}

// The index to attach to a prompt, or null: the first prompt of a
// conversation carries it, and the first after a reset again.
export async function indexForPrompt(io, state, cwd, { maxChars } = {}) {
  if (state.indexSent) return null;
  state.indexSent = true;
  const index = await knowledgeIndex(io, cwd, { maxChars });
  if (!index) note(io, "no index: no lexica/ directory with .sdoc files in this project");
  return index;
}

// --- Reading ---

// The reading guide and related resources of a file this agent has not met
// yet in the conversation, as { text, what }, or null when it has, or the
// file has neither. The file counts as met from now on, however it was
// opened: Read, or the outline, read and guides tools.
function firstMeeting(state, { filePath, text, agentId, cwd }) {
  const key = seenKey(agentId, filePath);
  if (state.readSeen.has(key)) return null;
  state.readSeen.add(key);
  const g = kb.guidesText(text);
  const guides = kb.formatReadingGuides(filePath, g, { base: cwd });
  if (!guides) return null;
  const what = "its " + [g.readingGuide ? "reading guide" : null, g.relatedResources ? "related resources" : null].filter(Boolean).join(" and ");
  return { text: `${kb.shownPath(filePath, cwd)} has signposts for whoever reads it.\n\n${guides}`, what };
}

// What to add after a Read of an .sdoc file, or null: on the first Read of
// the file by this agent, its reading guide and related resources; and, when
// a large file was read whole, its outline, once.
export async function afterRead(io, state, { filePath, offset, limit, agentId, cwd }) {
  const shown = kb.shownPath(filePath, cwd);
  const text = await readText(io, filePath);
  if (text === null) {
    note(io, `Read ${shown}: could not read it, nothing added`);
    return null;
  }
  const key = seenKey(agentId, filePath);
  const firstRead = !state.readSeen.has(key);
  const added = [];
  const parts = [];
  const signposts = firstMeeting(state, { filePath, text, agentId, cwd });
  if (signposts) {
    parts.push(signposts.text);
    added.push(signposts.what);
  }
  const lineCount = text.split("\n").length;
  const wasWhole = offset === undefined && limit === undefined;
  if (lineCount > LARGE_FILE_LINES && wasWhole && !state.nudged.has(key)) {
    state.nudged.add(key);
    const outline = kb.formatOutline(kb.outlineText(text, filePath), { base: cwd, maxDepth: 1, previews: false });
    parts.push(`${shown} has ${lineCount} lines and was read whole. Next time read only the sections you need: mcp__sdoc-lexica__read with their ids, or Read with offset/limit from these ranges.\n\n${outline}`);
    added.push(`its outline (${lineCount} lines read whole)`);
  }
  const who = agentId ? ` (agent ${agentId})` : "";
  note(io, added.length
    ? `Read ${shown}${who}: added ${added.join(" and ")}`
    : `Read ${shown}${who}: nothing added (${firstRead ? "no reading guide or related resources" : "already shown in this conversation"})`);
  return parts.length ? parts.join("\n\n") : null;
}

// --- Editing ---

// Whether a linked file exists, trying the href as written and percent-decoded,
// as src/href-path.js does for build-doc --check.
async function hrefExists(io, docDir, href) {
  const candidates = [href];
  try {
    const decoded = decodeURIComponent(href);
    if (decoded !== href) candidates.push(decoded);
  } catch { /* a literal % in a name: as written only */ }
  for (const candidate of candidates) {
    try {
      if (await io.exists(kb.joinPath(docDir, candidate))) return true;
    } catch { /* unreachable: not there */ }
  }
  return false;
}

async function findingsOf(io, filePath, text) {
  const docDir = kb.dirName(filePath);
  return kb.checkTextAsync(text, { resolveFilePath: (href) => hrefExists(io, docDir, href) });
}

// What identifies a finding across an edit. Line numbers move when lines are
// added above, so they are left out, in the message too.
function fingerprint(finding) {
  return finding.type + "\n" + String(finding.message).replace(/\d+/g, "#");
}

// The most an editing guide's linked sections add to it, in characters.
export const LINKED_GUIDE_CHARS = 6000;

// Where a path leads through links, when the io can tell; else the path.
async function realPath(io, path) {
  if (!io.realPath) return path;
  try { return (await io.realPath(path)) || path; } catch { return path; }
}

// The sections an editing guide links to ([text](file.sdoc#id), or #id in
// the same file), whole: a guide that only points elsewhere is followed less
// often than one that is read. At most LINKED_GUIDE_CHARS in all; a section
// that does not fit is named with its range instead, never cut. Only .sdoc
// files inside the project are followed, as written and through links.
// { text, count }, text "" when the guide links to no section.
export async function linkedSections(io, filePath, guide, cwd) {
  const parts = [];
  const pointers = [];
  const seen = new Set();
  let room = LINKED_GUIDE_CHARS;
  const roots = [cwd, await realPath(io, cwd)];
  for (const [, href] of String(guide).matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
    const [file, fragment] = href.split("#");
    if (!fragment) continue;
    let decoded = file;
    try { decoded = decodeURIComponent(file); } catch { /* a literal %: as written */ }
    const target = file ? kb.joinPath(kb.dirName(filePath), decoded) : kb.normalizePath(filePath);
    if (!kb.isSdocFile(target) || !kb.isInside(cwd, target) || seen.has(target + "#" + fragment)) continue;
    seen.add(target + "#" + fragment);
    const real = await realPath(io, target);
    if (!roots.some((root) => kb.isInside(root, real))) continue;
    const text = await readText(io, target);
    const section = text === null ? null : kb.readSectionText(text, fragment, { text: true });
    if (!section) continue;
    const shown = kb.formatSection(target, section, { base: cwd });
    if (shown.length <= room) {
      parts.push(shown);
      room -= shown.length;
    } else {
      pointers.push(`- ${kb.shownPath(target, cwd)} @${section.id || fragment} (L${section.lineStart}-${section.lineEnd}): ` +
        "too long to include; read it with mcp__sdoc-lexica__read before editing.");
    }
  }
  const count = parts.length + pointers.length;
  if (!count) return { text: "", count: 0 };
  return { text: "The sections the guide links to:\n\n" + parts.concat(pointers.length ? [pointers.join("\n")] : []).join("\n\n"), count };
}

// The editing guide of a file, with the sections it links to: { text, what },
// or null when the file has none.
async function editingGuideOf(io, filePath, fileText, cwd) {
  const guide = kb.guidesText(fileText).editingGuide;
  if (!guide) return null;
  const linked = await linkedSections(io, filePath, guide, cwd);
  return {
    text: `Editing guide:\n${guide}${linked.text ? "\n\n" + linked.text : ""}`,
    what: "its editing guide" + (linked.count ? ` and ${plural(linked.count, "linked section")}` : "")
  };
}

// Before an edit of an .sdoc file: { deny } when the file has an
// @editing-guide this agent has not been shown yet (the edit is refused once,
// with the guide; the retry goes through), else { snapshot }, the file's
// findings now, so afterEdit reports only what the edit added.
export async function beforeEdit(io, state, { filePath, agentId, cwd }) {
  const exists = await (async () => io.exists(filePath))().catch(() => false);
  const text = exists ? await readText(io, filePath) : null;
  if (text === null) return { snapshot: [] };
  const key = seenKey(agentId, filePath);
  if (!state.editAcked.has(key)) {
    state.editAcked.add(key);
    const guide = await editingGuideOf(io, filePath, text, cwd);
    if (guide) {
      note(io, `Edit ${kb.shownPath(filePath, cwd)}${agentId ? ` (agent ${agentId})` : ""}: refused once, with ${guide.what}`);
      return {
        deny: `Not applied yet: ${kb.shownPath(filePath, cwd)} has an editing guide, and this is the first edit to it. ` +
          `Make the edit again following the guide below; it will go through.\n\n${guide.text}`
      };
    }
  }
  return { snapshot: await findingsOf(io, filePath, text) };
}

// The findings in text that snapshot did not have, a finding counted as
// often as it occurs.
async function addedFindings(io, filePath, text, snapshot) {
  const before = new Map();
  for (const f of snapshot || []) before.set(fingerprint(f), (before.get(fingerprint(f)) || 0) + 1);
  return (await findingsOf(io, filePath, text)).filter((f) => {
    const left = before.get(fingerprint(f)) || 0;
    if (left) before.set(fingerprint(f), left - 1);
    return !left;
  });
}

function findingsReport(filePath, added, cwd, by) {
  const errors = added.filter((f) => f.severity !== "warning").length;
  const advice = errors ? " Fix the errors before going on." : "";
  return `${by} added ${plural(added.length, "finding")} to ${kb.shownPath(filePath, cwd)}.${advice}\n` +
    kb.formatFindings(filePath, added, { base: cwd });
}

// After an edit: the findings the edit added (parse errors, signposts,
// references, citations), or null when it added none.
export async function afterEdit(io, { filePath, snapshot, cwd }) {
  const text = await readText(io, filePath);
  if (text === null) return null;
  const added = await addedFindings(io, filePath, text, snapshot);
  const shown = kb.shownPath(filePath, cwd);
  if (!added.length) {
    note(io, `Edit ${shown}: checked, no new findings`);
    return null;
  }
  note(io, `Edit ${shown}: checked, reported ${plural(added.length, "new finding")}`);
  return findingsReport(filePath, added, cwd, "The edit");
}

// --- Changes made through Bash ---
//
// sed -i, a script or a redirect changes a file without Edit, so without the
// hooks above. A command that names .sdoc files has them read before it runs
// and again after; a file it changed gets what an edit would: the editing
// guide, after the fact here, and the findings the change added. A file the
// command changes without naming it goes unseen.

// The most files one command is watched for.
export const MAX_BASH_FILES = 20;

// The .sdoc files a shell command names, as absolute paths: each token ending
// in .sdoc, globs and ~ left out, resolved from cwd, or from the directory a
// leading `cd dir &&` moves to.
export function sdocPathsIn(command, cwd) {
  let base = cwd;
  const cd = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*(?:&&|;)/.exec(command);
  if (cd) base = kb.joinPath(cwd, cd[1] || cd[2] || cd[3]);
  const paths = new Set();
  for (const [token] of String(command).matchAll(/[^\s'"`;|&<>(){}=,]+\.sdoc(?![\w-]|\.\w)/gi)) {
    if (/[*?[\]]/.test(token) || token.startsWith("~")) continue;
    paths.add(kb.joinPath(base, token));
    if (paths.size === MAX_BASH_FILES) break;
  }
  return [...paths];
}

// Before a command: the text of each .sdoc file it names, null for one that
// does not exist yet. An empty map when it names none.
export async function beforeBash(io, { command, cwd }) {
  const snapshot = new Map();
  for (const filePath of sdocPathsIn(command, cwd)) snapshot.set(filePath, await readText(io, filePath));
  return snapshot;
}

// After a command: for each named file it changed, the editing guide if this
// agent has not been shown it, and the findings the change added; null when
// it changed none, or added nothing worth saying.
export async function afterBash(io, state, { snapshot, agentId, cwd }) {
  const parts = [];
  let changed = 0;
  for (const [filePath, before] of snapshot) {
    const after = await readText(io, filePath);
    if (after === null || after === before) continue;
    changed++;
    const shown = kb.shownPath(filePath, cwd);
    const key = seenKey(agentId, filePath);
    const added = [];
    if (!state.editAcked.has(key)) {
      state.editAcked.add(key);
      const guide = await editingGuideOf(io, filePath, before === null ? after : before, cwd);
      if (guide) {
        parts.push(`This command changed ${shown}, which has an editing guide that was not shown before the change. ` +
          `Check the change against it, and correct what does not follow it.\n\n${guide.text}`);
        added.push(guide.what + ", after the change");
      }
    }
    const found = await addedFindings(io, filePath, after, before === null ? [] : await findingsOf(io, filePath, before));
    if (found.length) parts.push(findingsReport(filePath, found, cwd, "The command"));
    added.push(found.length ? `reported ${plural(found.length, "new finding")}` : "no new findings");
    note(io, `Bash changed ${shown}${agentId ? ` (agent ${agentId})` : ""}: ${added.join("; ")}`);
  }
  if (snapshot.size && !changed) {
    note(io, `Bash named ${plural(snapshot.size, ".sdoc file")} and changed none`, { quiet: true });
  }
  return parts.length ? parts.join("\n\n") : null;
}

// --- Tools ---

const FILE = { type: "string", description: "Path of an .sdoc file, absolute or relative to the project." };
const DIRS = { type: "array", items: { type: "string" }, description: "Directories to look in, absolute or relative to the project. Default: every lexica/ directory." };

// The tools the model calls, as mcp__sdoc-lexica__<name>. All read-only.
export const TOOLS = [
  {
    name: "list",
    description: "List SDOC knowledge files: one line per .sdoc file with its type, size and @about summary. With no dirs, every lexica/ directory of the project. Start here to choose which file to open.",
    inputSchema: { type: "object", properties: { dirs: DIRS } }
  },
  {
    name: "outline",
    description: "Outline an .sdoc file: each section's @id, title, line range and first words, and which signposts the file has. Use it before reading a large file, then read only the sections you need.",
    inputSchema: { type: "object", properties: { file: FILE }, required: ["file"] }
  },
  {
    name: "read",
    description: "Read sections of an .sdoc file by id: the @id, or for a heading without one the slug outline shows in parentheses; the file's own id reads it whole (a large file answers with its outline instead). Returns each section's source with line numbers; text: true returns plain text instead. To change a section, Read its lines first (offset and limit from its range): Edit refuses a file that Read has not opened.",
    inputSchema: {
      type: "object",
      properties: {
        file: FILE,
        ids: { type: "array", items: { type: "string" }, description: "Section ids, from outline." },
        text: { type: "boolean", description: "Plain text instead of source." }
      },
      required: ["file", "ids"]
    }
  },
  {
    name: "search",
    description: "Search SDOC files for the sections that hold every word of the query, ignoring case. Best matches first, each with file:line, section id and a snippet. With no dirs, every lexica/ directory of the project.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, dirs: DIRS }, required: ["query"] }
  },
  {
    name: "guides",
    description: "The signposts of an .sdoc file: its @about, reading guide, related resources and editing guide.",
    inputSchema: { type: "object", properties: { file: FILE }, required: ["file"] }
  },
  {
    name: "check",
    description: "Check .sdoc files for parse errors and signpost, reference and citation problems, with line numbers: the findings build-doc --check reports.",
    inputSchema: { type: "object", properties: { files: { type: "array", items: FILE } }, required: ["files"] }
  }
];

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

function asList(value) {
  if (value === undefined || value === null || value === "") return [];
  return (Array.isArray(value) ? value : String(value).split(",")).map((v) => String(v).trim()).filter(Boolean);
}

// The paths a tool call names, resolved against cwd.
export function toolPaths(name, input, cwd) {
  const resolve = (p) => kb.joinPath(cwd, p);
  if (name === "list" || name === "search") return asList(input.dirs).map(resolve);
  if (name === "check") return asList(input.files).map(resolve);
  return input.file ? [resolve(String(input.file))] : [];
}

// True when every path the call names lies under one of roots, as written.
// register.mjs also checks where each path leads, through links.
export function isWithin(name, input, cwd, roots) {
  return TOOL_NAMES.has(name) && toolPaths(name, input, cwd).every((p) => roots.some((r) => kb.isInside(r, p)));
}

// Runs a tool: { text } or { error }. With the conversation's state, the
// first outline or read of a file by an agent carries the file's reading
// guide and related resources, as a first Read does.
export async function runTool(io, name, input, { cwd, state, agentId }) {
  const outcome = await toolOutcome(io, name, input, { cwd, state, agentId });
  const args = toolPaths(name, input, cwd).map((p) => kb.shownPath(p, cwd)).concat(input.query ? [`"${input.query}"`] : []).join(" ");
  const who = agentId ? ` (agent ${agentId})` : "";
  // The session shows the call and its answer already: the note is worth a
  // line there only for what it does not show.
  note(io, outcome.error
    ? `tool ${name}${args ? " " + args : ""}${who}: error: ${outcome.error}`
    : `tool ${name}${args ? " " + args : ""}${who}: answered ${plural(outcome.text.length, "char")}` +
      (outcome.withSignposts ? `, with ${outcome.withSignposts}` : ""),
  { quiet: !outcome.error && !outcome.withSignposts });
  return { text: outcome.text, error: outcome.error };
}

async function toolOutcome(io, name, input, { cwd, state, agentId }) {
  const base = cwd;
  const resolve = (p) => kb.joinPath(cwd, String(p));
  async function fileText(file) {
    if (!file) throw new Error("Missing file.");
    const text = await readText(io, resolve(file));
    if (text === null) throw new Error(`No such file: ${file}`);
    return text;
  }
  async function dirsOf(given) {
    const dirs = asList(given).map(resolve);
    if (dirs.length) return dirs;
    const found = await knowledgeDirs(io, cwd);
    if (!found.length) throw new Error(`No lexica/ directory under ${cwd}. Pass dirs to look elsewhere.`);
    return found;
  }
  // The file's signposts appended on this agent's first meeting with it.
  function withSignposts(file, text, answer) {
    const signposts = state ? firstMeeting(state, { filePath: resolve(file), text, agentId, cwd }) : null;
    return signposts ? { text: answer + "\n\n" + signposts.text, withSignposts: signposts.what } : { text: answer };
  }

  try {
    switch (name) {
      case "list": {
        const files = await kb.listFiles(await dirsOf(input.dirs), io);
        return { text: files.length ? kb.formatFileList(files, { base }) : "No .sdoc files there." };
      }
      case "outline": {
        const text = await fileText(input.file);
        return withSignposts(input.file, text, kb.formatOutline(kb.outlineText(text, resolve(input.file)), { base }));
      }
      case "read": {
        const text = await fileText(input.file);
        const ids = asList(input.ids);
        if (!ids.length) throw new Error("Missing ids: mcp__sdoc-lexica__outline lists them.");
        const lines = text.split("\n").length;
        let outline = null;
        const outlineOnce = () => outline || (outline = kb.outlineText(text, resolve(input.file)));
        const parts = ids.map((id) => {
          const section = kb.readSectionText(text, id, { text: Boolean(input.text) });
          if (!section) {
            const o = outlineOnce();
            const known = (o.id ? ["@" + o.id + " (the whole file)"] : [])
              .concat(o.sections.map((s) => s.id ? "@" + s.id : s.derivedId));
            return `No section "${id}" in ${input.file}. Its ids: ${known.join(", ")}.`;
          }
          if (section.whole && lines > LARGE_FILE_LINES) {
            return `${input.file} has ${lines} lines, so here is its outline rather than the whole file. ` +
              `Read the sections you need by id.\n\n${kb.formatOutline(outlineOnce(), { base })}`;
          }
          return kb.formatSection(resolve(input.file), section, { base });
        });
        return withSignposts(input.file, text, parts.join("\n\n"));
      }
      case "search": {
        if (!input.query) throw new Error("Missing query.");
        const hits = await kb.searchFiles(String(input.query), await dirsOf(input.dirs), io);
        return { text: hits.length ? kb.formatSearch(hits, { base }) : `Nothing matches "${input.query}".` };
      }
      case "guides": {
        const file = resolve(input.file);
        const g = kb.guidesText(await fileText(input.file));
        // Asked for outright, so no later first meeting repeats them.
        if (state) state.readSeen.add(seenKey(agentId, file));
        const parts = [];
        if (g.about) parts.push("About:\n" + g.about);
        const reading = kb.formatReadingGuides(file, g, { base });
        if (reading) parts.push(reading);
        if (g.editingGuide) parts.push("Editing guide:\n" + g.editingGuide);
        return { text: parts.join("\n\n") || "No signposts." };
      }
      case "check": {
        const files = asList(input.files);
        if (!files.length) throw new Error("Missing files.");
        const parts = [];
        for (const file of files) {
          const findings = await findingsOf(io, resolve(file), await fileText(file));
          parts.push(findings.length ? kb.formatFindings(resolve(file), findings, { base }) : `${kb.shownPath(resolve(file), base)}: no findings`);
        }
        return { text: parts.join("\n") };
      }
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err.message };
  }
}
