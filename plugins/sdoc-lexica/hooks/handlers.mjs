// What the sdoc plugin does, written against a small io adapter so the same
// code runs inside Claude Code, where register.mjs binds it to the engine's
// file system, and under Node, where test/test-plugin.js binds it to fs:
//
//   io.read(path)   → the file's text
//   io.list(dir)    → [{ name, kind, size, mtimeMs }], kind "file", "dir" or
//                     other; size and mtimeMs optional, keying the cache below
//   io.exists(path) → boolean
//   io.log(text, { quiet })
//                   → optional: one line saying what the plugin just did, for
//                     whoever is checking that it works (the verbose option);
//                     quiet when the session already shows it (a tool's answer)
//   io.realPath(p)  → optional: where p leads through links
//   io.run(argv, { cwd, timeoutMs })
//                   → optional: { exitCode, stdout, stderr } of a command run
//                     with no shell; only git log, for when files last changed
//   io.now()        → optional: milliseconds since the epoch
//   io.storage      → optional: { get(key), set(key, value), delete(key),
//                     keys() }, kept between sessions: file descriptions are
//                     cached there
//
// each possibly a promise. Paths are absolute; cwd is the session's directory.
// Nothing here throws on a missing or unparsable file: the plugin stays quiet
// rather than get in the way of the work. The permission check and the
// question to the person are not in io: consent takes them as arguments.
//
// What a hook adds to the conversation (the index, a subagent's brief, the
// signposts, a refusal, the findings) states facts and says what each tool
// does; it gives the model no orders, since a hook's text that reads like a
// command can be taken for a prompt injection. A tool's own description,
// answer and errors are the tool's, and may say what to do.

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

// The files of dirs, described, as { files, now }: each file's type, title,
// about and size, and the time git last saw it change (changed, in seconds),
// where git knows it; now, in seconds, only when git answered. Descriptions
// come from the cache in io.storage, unless cached is false (the cache holds
// the lexica/ directories, not any dirs a tool is given).
async function describedFiles(io, cwd, dirs, { cached = true } = {}) {
  const cache = cached ? await openDescriptions(io, cwd) : null;
  const files = await kb.listFiles(dirs, io, cache ? { cache } : {});
  if (cache) {
    const kept = await cache.save();
    note(io, `descriptions: ${cache.hits} of ${plural(files.length, "knowledge file")} from the cache, ${files.length - cache.hits} read${kept}`);
  }
  const changes = await lastChanges(io, cwd, dirs);
  if (!changes) return { files };
  const now = Math.floor(await nowMs(io) / 1000);
  return {
    files: files.map((f) => {
      const changed = changes.get(changedKey(f.path));
      return changed === undefined ? f : { ...f, changed };
    }),
    now
  };
}

// The index's lines, one per file: path [type] (N lines, and how long ago it
// changed when git knows), then the file's @about whole, or with titlesOnly
// its title. A summary is never cut short: a clipped one misleads more than
// none.
function indexLines(files, cwd, titlesOnly, now) {
  return kb.formatFileList(files, { base: cwd, titles: titlesOnly, now }).split("\n").filter(Boolean);
}

// The lexica/ files and how to load them progressively, in at most maxChars
// characters; null when the project has no lexica/ directory. Every file with
// its whole summary when they fit; else every file with its title instead;
// and only when even that does not fit, as many files as do, and a count of
// the rest.
export async function knowledgeIndex(io, cwd, { maxChars = indexBudget(), dirs } = {}) {
  dirs = dirs || await knowledgeDirs(io, cwd);
  if (!dirs.length) return null;
  const { files, now } = await describedFiles(io, cwd, dirs);
  const head = [
    "This project keeps its knowledge in SDOC files under lexica/ (type doc: what something is; type skill: how to do something), indexed below. The plugin's tools load it by section rather than whole:",
    "- mcp__sdoc-lexica__search finds sections by words; mcp__sdoc-lexica__outline gives a file's section ids and line ranges; mcp__sdoc-lexica__read reads sections by id; mcp__sdoc-lexica__list lists the files with their summaries.",
    `- A file over ${LARGE_FILE_LINES} lines costs a fraction as much read by section (from its outline, with mcp__sdoc-lexica__read or Read offset/limit) as read whole.`,
    "The files whose summary or title matches a task hold what the project knows about it.",
    ""
  ].join("\n");
  // Room for the closing line that says what was left out.
  const room = maxChars - head.length - 120;
  const size = (lines) => lines.reduce((n, line) => n + line.length + 1, 0);
  let titlesOnly = false;
  let lines = indexLines(files, cwd, false, now);
  if (size(lines) > room) {
    titlesOnly = true;
    lines = indexLines(files, cwd, true, now);
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

// --- When each file last changed ---
//
// From git, never from a file's modification time, which a checkout or a copy
// resets: one git log over the directories, each file's time the latest
// commit that touched it. A change not committed yet shows the last commit's
// time; a file git does not track shows none, and nothing does outside a
// repository or when git is slow.

// How long git log may take, in milliseconds.
export const GIT_TIMEOUT_MS = 3000;

// Each path in the output of `git log --format=%x00%ct --name-only` with the
// time of the latest commit that names it, in seconds: a Map. The latest, not
// the first met: git lists commits newest first only by default, and a
// commit can carry an older date than its parent.
export function parseGitLog(text) {
  const times = new Map();
  for (const commit of String(text || "").split("\0")) {
    const [head, ...names] = commit.split("\n");
    const sec = Number(head);
    if (!head.trim() || !Number.isFinite(sec)) continue;
    for (const raw of names) {
      const name = unquoteGitPath(raw.replace(/\r$/, ""));
      if (name && !(times.get(name) >= sec)) times.set(name, sec);
    }
  }
  return times;
}

// A path as git prints it: as it is, or quoted with C escapes when it holds a
// quote, a backslash or a control character (core.quotePath=false leaves
// every other character alone).
function unquoteGitPath(name) {
  if (!/^".*"$/.test(name)) return name;
  const escapes = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", f: "\f", v: "\v" };
  return name.slice(1, -1).replace(/\\([0-7]{3}|.)/g, (m, c) =>
    c.length === 3 ? String.fromCharCode(parseInt(c, 8)) : escapes[c] || c);
}

// The key lastChanges answers a file's time under: its path normalised, with
// / separators whatever the platform, as git writes them.
export function changedKey(p) {
  return kb.normalizePath(p).replace(/\\/g, "/");
}

// When each file under dirs last changed, by git: a Map from changedKey(path)
// to seconds since the epoch, or null when there is no io.run, cwd is not in
// a repository, or git fails or takes over GIT_TIMEOUT_MS. One git log per
// call, from cwd (paths relative to it, so a cwd below the repository's root
// works); register.mjs keeps the answer a minute, so the index and a
// subagent's brief share one run.
export async function lastChanges(io, cwd, dirs) {
  if (!io.run || !dirs.length) return null;
  const argv = ["git", "-c", "core.quotePath=false", "log", "--format=%x00%ct", "--name-only", "--relative", "--",
    ...dirs.map((d) => kb.shownPath(d, cwd))];
  let answer;
  try {
    answer = await io.run(argv, { cwd, timeoutMs: GIT_TIMEOUT_MS });
  } catch (err) {
    note(io, `no ages: git log did not run (${firstLine(err && err.message) || "no reason given"})`);
    return null;
  }
  if (!answer || answer.exitCode !== 0) {
    const why = answer ? firstLine(answer.stderr) : "";
    note(io, `no ages: git log exited with ${answer ? answer.exitCode : "nothing"}${why ? ` (${why})` : ""}`);
    return null;
  }
  const changes = new Map();
  for (const [rel, sec] of parseGitLog(answer.stdout)) changes.set(changedKey(kb.joinPath(cwd, rel)), sec);
  note(io, `ages from git log: ${plural(changes.size, "file")}${answer.isStdoutTruncated ? " (its output was cut at 4 MiB)" : ""}`);
  return changes;
}

function firstLine(text) {
  const line = String(text || "").trim().split("\n")[0];
  return line.length > 120 ? line.slice(0, 119) + "…" : line;
}

// io.now(), else the runtime's own clock.
async function nowMs(io) {
  if (io.now) {
    try {
      const now = await io.now();
      if (Number.isFinite(now)) return now;
    } catch { /* the runtime's clock */ }
  }
  return Date.now();
}

// --- Descriptions kept between sessions ---
//
// Describing a file reads and parses it whole, every file at every index.
// With io.storage (register.mjs binds it to $.store), a build keeps what it
// described under describe:v1:<cwd> as { at, files: { path: { k, desc } } },
// k being path|mtimeMs|size from the listing, so a file whose k has not
// changed is not read again. The entry is rewritten with only the files the
// build saw, which drops a deleted one, and left alone when nothing changed
// and it was written within a day. The store holds 4 MiB in all: when a
// write is refused, the describe: entry written longest ago (another
// project's, most often) goes, and the write is tried once more. A failure
// anywhere leaves the files to be read, as with no store.

// The store key's prefix: the version changes with the shape of what is kept.
export const DESCRIBE_KEY_PREFIX = "describe:v1:";

const DAY_MS = 24 * 60 * 60 * 1000;

// One build's cache: { get, set } for kb.listFiles, hits, and save(), which
// writes back what the build saw and answers what to add to the build's note.
// Null without io.storage, or when the store cannot be read.
async function openDescriptions(io, cwd) {
  if (!io.storage) return null;
  const key = DESCRIBE_KEY_PREFIX + cwd;
  let held;
  try { held = await io.storage.get(key); } catch { return null; }
  const known = new Map();
  const files = held && typeof held === "object" && held.files && typeof held.files === "object" ? held.files : {};
  for (const [path, entry] of Object.entries(files)) {
    if (entry && typeof entry.k === "string" && entry.desc && typeof entry.desc.lines === "number") {
      known.set(entry.k, { path, desc: entry.desc });
    }
  }
  const seen = {};
  let hits = 0;
  let added = 0;
  return {
    get(k) {
      const found = known.get(k);
      if (!found) return undefined;
      hits++;
      seen[found.path] = { k, desc: found.desc };
      return { ...found.desc, path: found.path };
    },
    set(k, desc) {
      const { path, ...rest } = desc;
      seen[path] = { k, desc: rest };
      added++;
    },
    get hits() { return hits; },
    async save() {
      const now = await nowMs(io);
      const recent = held && Number.isFinite(held.at) && now - held.at < DAY_MS;
      if (!added && recent && Object.keys(seen).length === known.size) return "";
      const value = { at: now, files: seen };
      try {
        await io.storage.set(key, value);
        return "";
      } catch { /* full, most likely: make room once */ }
      try {
        const dropped = await dropOldestDescriptions(io.storage);
        if (!dropped) return "; not kept: the store refused them";
        await io.storage.set(key, value);
        return `; kept after dropping ${dropped}, the oldest`;
      } catch (err) {
        return `; not kept: ${firstLine(err && err.message) || "the store refused them"}`;
      }
    }
  };
}

// Deletes the describe: entry (of any version) written longest ago, and
// answers its key; null when the store has none.
async function dropOldestDescriptions(store) {
  let oldest = null;
  let oldestAt = Infinity;
  for (const key of await store.keys()) {
    if (!key.startsWith("describe:")) continue;
    let value;
    try { value = await store.get(key); } catch { /* the oldest, then */ }
    const at = value && Number.isFinite(value.at) ? value.at : 0;
    if (at < oldestAt) {
      oldest = key;
      oldestAt = at;
    }
  }
  if (oldest) await store.delete(oldest);
  return oldest;
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
    parts.push(`${shown} has ${lineCount} lines and was read whole. Its outline, below, gives each section's id and lines: ` +
      `mcp__sdoc-lexica__read reads sections by id, and Read with offset/limit a range of lines, for a fraction of the whole.\n\n${outline}`);
    added.push(`its outline (${lineCount} lines read whole)`);
  }
  const who = agentId ? ` (agent ${agentId})` : "";
  note(io, added.length
    ? `Read ${shown}${who}: added ${added.join(" and ")}`
    : `Read ${shown}${who}: nothing added (${firstRead ? "no reading guide or related resources" : "already shown in this conversation"})`);
  return parts.length ? parts.join("\n\n") : null;
}

// --- Mentions ---
//
// @file.sdoc#id in a prompt attaches the section the id names rather than the
// whole file, and typing the # offers the file's ids. The engine reads lines
// itself (#L10-20); an id is turned into the lines it names. Only files inside
// the project, as written and through links.

// The most section ids offered for one token.
export const MAX_SUGGESTIONS = 15;

// Whether filePath lies inside the project, as written and where it leads.
export async function insideProject(io, filePath, cwd) {
  const roots = [cwd, await realPath(io, cwd)];
  if (!roots.some((root) => kb.isInside(root, filePath))) return false;
  const real = await realPath(io, filePath);
  return roots.some((root) => kb.isInside(root, real));
}

// The ids a file answers to, from its outline: what read, backlinks and a
// mention list when one is missing.
function sectionIdsOf(outline) {
  return (outline.id ? ["@" + outline.id + " (the whole file)"] : [])
    .concat(outline.sections.map((s) => s.id ? "@" + s.id : s.derivedId));
}

// The lines an id names in text, as the engine's read takes them: { offset,
// limit } for a section, by its @id or its title slug; null for the
// document's own id, which names the whole file; { unknown: true, ids } when
// no section has it, ids being those the file has.
export function mentionRange(text, fragment) {
  const section = kb.readSectionText(text, fragment);
  if (section && section.whole) return null;
  if (section) return { offset: section.lineStart, limit: section.lineEnd - section.lineStart + 1 };
  return { unknown: true, ids: sectionIdsOf(kb.outlineText(text, "")) };
}

// What a mention of filePath#fragment reads: { offset, limit } for a section;
// {} for the whole file, with missing (what to tell the model) when the file
// has no such id; null when the file cannot be read, left to the engine.
export async function mentionRead(io, { filePath, fragment, cwd }) {
  const shown = kb.shownPath(filePath, cwd);
  const text = await readText(io, filePath);
  if (text === null) {
    note(io, `mention ${shown}#${fragment}: could not read it, left to the engine`);
    return null;
  }
  const range = mentionRange(text, fragment);
  if (!range) {
    note(io, `mention ${shown}#${fragment}: the document's own id, attached whole`);
    return {};
  }
  if (range.unknown) {
    note(io, `mention ${shown}#${fragment}: no such section, attached whole with its ids`);
    return { missing: unknownIdMessage(fragment, shown, range.ids) };
  }
  note(io, `mention ${shown}#${fragment}: attached L${range.offset}-${range.offset + range.limit - 1} only`);
  return range;
}

// The rows offered for a token ending in #prefix: the sections whose id
// starts with prefix, then those whose id or title holds it, in document
// order, at most MAX_SUGGESTIONS. base is the token's file part, @ included:
// taking a row writes base#id.
export function sectionSuggestions(outline, prefix, base) {
  const wanted = String(prefix || "").toLowerCase();
  const rows = outline.sections.map((s) => ({ id: s.id || s.derivedId, s })).filter((r) => r.id);
  const starts = rows.filter((r) => r.id.toLowerCase().startsWith(wanted));
  const holds = rows.filter((r) => !r.id.toLowerCase().startsWith(wanted) &&
    (r.id.toLowerCase().includes(wanted) || String(r.s.title || "").toLowerCase().includes(wanted)));
  return starts.concat(holds).slice(0, MAX_SUGGESTIONS).map(({ id, s }) => ({
    text: `${base}#${id}`,
    label: `#${id}`,
    description: `L${s.lineStart}-${s.lineEnd} ${s.title}`
  }));
}

// The section ids to offer for a prompt token such as @lexica/spec.sdoc#com,
// the file resolved from cwd and inside the project only; [] otherwise.
// cache, an object kept between calls, holds the last file's outline, so a
// keystroke parses nothing while the file is unchanged.
export async function mentionSuggestions(io, { token, cwd, cache }) {
  const m = /^(@[^\s#]+\.sdoc)#([\w-]*)$/i.exec(String(token));
  if (!m) return [];
  const filePath = kb.joinPath(cwd, m[1].slice(1));
  if (!await insideProject(io, filePath, cwd)) return [];
  const text = await readText(io, filePath);
  if (text === null) return [];
  let outline;
  if (cache && cache.path === filePath && cache.text === text) outline = cache.outline;
  else {
    outline = kb.outlineText(text, filePath);
    if (cache) Object.assign(cache, { path: filePath, text, outline });
  }
  const rows = sectionSuggestions(outline, m[2], m[1]);
  note(io, `autocomplete ${kb.shownPath(filePath, cwd)}#${m[2]}: ${plural(rows.length, "section")} offered`, { quiet: true });
  return rows;
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
        "too long to include, so not shown here; mcp__sdoc-lexica__read reads it.");
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

// Which edit a refusal is about, from the tool's input, so that among
// several sent at once the one refused is known: an Edit by the first line of
// what it replaces.
export function editNamed(input = {}) {
  if (typeof input.old_string === "string") {
    const line = input.old_string.split("\n").map((l) => l.trim()).find(Boolean) || "";
    return line ? `the edit replacing "${line.length > 80 ? line.slice(0, 79) + "…" : line}"` : "the edit";
  }
  if (Array.isArray(input.edits)) return plural(input.edits.length, "edit");
  return "the write";
}

// Before an edit of an .sdoc file: { deny } when the file has an
// @editing-guide this agent has not been shown yet (the edit is refused once,
// with the guide; the retry goes through), else { snapshot }, the file's
// findings now, so afterEdit reports only what the edit added. edit is the
// tool's input, for naming the refused edit.
export async function beforeEdit(io, state, { filePath, agentId, cwd, edit }) {
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
        deny: `Not applied: ${editNamed(edit)} in ${kb.shownPath(filePath, cwd)}. The file is unchanged, ` +
          `and that change is still to be made. The file has an editing guide, below, and this was the first ` +
          `edit to it: the same edit, made again in line with the guide, goes through.\n\n${guide.text}`
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
  const advice = !errors ? ""
    : errors === 1 ? " The error leaves the file failing its check until it is fixed."
    : " The errors leave the file failing its check until they are fixed.";
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
        parts.push(`This command changed ${shown}, which has an editing guide that was not shown before the change: ` +
          `the change has not been checked against it.\n\n${guide.text}`);
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

// --- Subagents ---
//
// A subagent starts with none of the conversation, so without the index its
// first prompt carried: its own prompt gets a shorter one. A fork has the
// conversation already, a resumed agent its own, and a workflow agent's
// prompt is its script's, so none of those is briefed.

// The most a brief adds to a subagent's prompt, in characters.
export const SUBAGENT_BRIEF_CHARS = 3000;

export const SUBAGENT_LEAD = "Added by the sdoc-lexica plugin, as context rather than part of the task: an index of the project's knowledge files.";

// Whether a spawn (agent.spawn's input) starts an agent with nothing of the
// conversation.
export function shouldBrief(e) {
  return Boolean(e) && !e.fork && !e.resume && !e.workflow;
}

// The brief for a subagent: the lead line and the knowledge index, in at most
// SUBAGENT_BRIEF_CHARS (titles only when the summaries do not fit); null when
// the project has no lexica/ directory. who names the agent in the note.
export async function subagentBriefing(io, cwd, { who = "subagent" } = {}) {
  const said = [];
  const quiet = { ...io, log: (text) => said.push(text) };
  const index = await knowledgeIndex(quiet, cwd, { maxChars: SUBAGENT_BRIEF_CHARS - SUBAGENT_LEAD.length - 1 });
  if (!index) {
    note(io, `${who}: not briefed, no lexica/ directory in this project`);
    return null;
  }
  for (const text of said) note(io, `${who}: ${text}`);
  return SUBAGENT_LEAD + "\n" + index;
}

// The research agent (sdoc-lexica:research): answers a question from the
// lexica/ files with citations, read-only. toolNames are the plugin's tools
// as registered (mcp__<plugin>__<name>); the prompt names them that way.
export function researchAgentSpec(toolNames) {
  const names = [...toolNames];
  const named = (short) => names.find((n) => n === short || n.endsWith("__" + short)) || `the ${short} tool`;
  const prompt = [
    "You answer questions about a project from its knowledge: the SDOC (.sdoc) files under its lexica/ directories (specifications, requirements, decisions, how-to skills). You are read-only: you change no file.",
    "",
    "How to look:",
    `1. Search first: ${named("search")} finds the sections that hold the question's key words. ${named("list")} lists the files with their summaries when the words are unclear.`,
    `2. Outline a file before reading from it: ${named("outline")} gives each section's @id and line range.`,
    `3. Read only the sections you need: ${named("read")} with their ids, or Read with offset and limit from the outline's ranges. Never read a large file whole.`,
    "4. Follow a link or an @id reference to another section when the answer depends on it. Grep and Glob find what those tools do not, such as the code a file names.",
    "",
    "How to answer:",
    "- At most 200 words, the answer first.",
    "- After each claim, cite where it comes from as path @id (Lx-y), the path relative to the project: lexica/specification.sdoc @blocks (L120-164).",
    "- Give exact values (numbers, names, defaults) as the file writes them.",
    "- Say plainly what the knowledge does not cover, or where its files disagree, rather than filling the gap from general knowledge."
  ].join("\n");
  return {
    name: "research",
    description: "Answers questions from the project's lexica/ knowledge (SDOC specifications, requirements, decisions and how-to skills) in at most 200 words, citing the file, section id and lines of each claim. Use for finding what the project's knowledge says about a feature, convention or design decision without reading whole files into the conversation. Read-only.",
    prompt,
    tools: [...names, "Read", "Grep", "Glob"]
  };
}

// --- Tools ---

const FILE = { type: "string", description: "Path of an .sdoc file, absolute or relative to the project." };
const DIRS = { type: "array", items: { type: "string" }, description: "Directories to look in, absolute or relative to the project. Default: every lexica/ directory." };

// What search's read: true adds after the list: at most this many sections,
// in at most this many characters.
export const SEARCH_READ_CHARS = 6000;
export const SEARCH_READ_SECTIONS = 5;

// The most files one outline call outlines.
export const OUTLINE_MAX_FILES = 20;

// The tools the model calls, as mcp__sdoc-lexica__<name>. All read-only.
export const TOOLS = [
  {
    name: "list",
    description: "List SDOC knowledge files: one line per .sdoc file with its type, size and @about summary. With no dirs, every lexica/ directory of the project. Start here to choose which file to open.",
    inputSchema: { type: "object", properties: { dirs: DIRS, detail: { type: "string", enum: ["summaries", "titles"], description: "summaries (the default): each file's @about, whole. titles: each file's title instead, for a shorter answer." } } }
  },
  {
    name: "outline",
    description: "Outline an .sdoc file: each section's @id, title, line range and first words, and which signposts the file has. Use it before reading a large file, then read only the sections you need. " +
      `files outlines several at once (up to ${OUTLINE_MAX_FILES}); depth: 1 shows the top-level sections only, 2 their children too; previews: false leaves out the first words.`,
    inputSchema: {
      type: "object",
      properties: {
        file: FILE,
        files: { type: "array", items: FILE, description: `Several files at once, up to ${OUTLINE_MAX_FILES}, in place of file or beside it.` },
        depth: { type: "integer", minimum: 1, description: "How many levels of sections to show: 1 is the top-level sections only. Default: all." },
        previews: { type: "boolean", description: "false leaves out each section's first words. Default: true." }
      }
    }
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
    description: "Search SDOC files for the sections that hold every word of the query, ignoring case; when none holds them all, the sections that hold the most, each line saying which words it lacks. Best matches first (rare words, a word in the title and a short section count for more), each with file:line, section id and a snippet. " +
      `read: true also returns the best sections whole, up to ${SEARCH_READ_SECTIONS} within ${SEARCH_READ_CHARS} characters, so one call can answer a question. With no dirs, every lexica/ directory of the project.`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        dirs: DIRS,
        read: { type: "boolean", description: "Also return the best sections' source, with line numbers, after the list." }
      },
      required: ["query"]
    }
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
  },
  {
    name: "backlinks",
    description: "Find what links to an .sdoc file or to one of its sections: the links in other files ([text](file.sdoc#id)) and, for a section, the @id references and #id links in the file itself, each with file:line and the section it sits in. A link by @id or by title slug counts alike. Use it before renaming, moving or removing a section or a file, to find the links to change. With no dirs, every lexica/ directory of the project; the file itself is always searched.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path of an .sdoc file, absolute or relative to the project; file.sdoc#id names a section." },
        id: { type: "string", description: "A section's id, as outline shows it. Without one, the links to the file as a whole." },
        dirs: DIRS
      },
      required: ["file"]
    }
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
  if (name === "outline") return (input.file ? [String(input.file)] : []).concat(asList(input.files)).map(resolve);
  if (name === "backlinks") return (input.file ? [fileAndId(input.file).file] : []).concat(asList(input.dirs)).map(resolve);
  return input.file ? [resolve(String(input.file))] : [];
}

// True when every path the call names lies under one of roots, as written.
// register.mjs also checks where each path leads, through links.
export function isWithin(name, input, cwd, roots) {
  return TOOL_NAMES.has(name) && toolPaths(name, input, cwd).every((p) => roots.some((r) => kb.isInside(r, p)));
}

// A path that may name a section after it: "a.sdoc#intro" → { file: "a.sdoc",
// id: "intro" }. A # anywhere but after .sdoc is part of the path.
function fileAndId(value) {
  const named = /^(.*\.sdoc)#([^/\\]*)$/i.exec(String(value));
  return named ? { file: named[1], id: named[2] || undefined } : { file: String(value), id: undefined };
}

// What read, backlinks and a mention answer for an id the file does not
// have: the ids it does have.
function unknownIdMessage(id, file, ids) {
  return `No section "${id}" in ${file}. Its ids: ${ids.join(", ")}.`;
}

// The sections a search found, whole and in rank order, for read: true: at
// most SEARCH_READ_SECTIONS of them in SEARCH_READ_CHARS. One that does not
// fit is named with its range instead, never cut; a hit inside a section
// already shown is passed over; an @about hit shows the summary. "" when
// there is nothing to show.
async function searchReads(io, hits, cwd) {
  const parts = [];
  const pointers = [];
  const shown = [];
  const texts = new Map();
  let room = SEARCH_READ_CHARS;
  for (const hit of hits) {
    if (parts.length + pointers.length >= SEARCH_READ_SECTIONS) break;
    if (shown.some((s) => s.path === hit.path && hit.lineStart >= s.lineStart && hit.lineEnd <= s.lineEnd)) continue;
    let section;
    if (hit.about !== undefined) {
      section = { title: hit.title, lineStart: hit.lineStart, lineEnd: hit.lineEnd, content: hit.about };
    } else {
      if (!texts.has(hit.path)) texts.set(hit.path, await readText(io, hit.path));
      const text = texts.get(hit.path);
      if (text === null) continue;
      section = { title: hit.title, lineStart: hit.lineStart, lineEnd: hit.lineEnd, source: text.split("\n").slice(hit.lineStart - 1, hit.lineEnd).join("\n") };
    }
    const block = kb.formatSection(hit.path, section, { base: cwd });
    if (block.length <= room) {
      parts.push(block);
      room -= block.length;
      shown.push(hit);
    } else {
      pointers.push(`- ${kb.shownPath(hit.path, cwd)} ${hit.id ? "@" + hit.id : "(" + hit.derivedId + ")"} (L${hit.lineStart}-${hit.lineEnd}): ` +
        `not included, ${block.length} chars with ${room} of ${SEARCH_READ_CHARS} left; mcp__sdoc-lexica__read reads it.`);
    }
  }
  return parts.concat(pointers.length ? [pointers.join("\n")] : []).join("\n\n");
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
        const dirs = await dirsOf(input.dirs);
        // The cache holds the lexica/ directories' files: other dirs pass it by.
        const { files, now } = await describedFiles(io, cwd, dirs, { cached: !asList(input.dirs).length });
        const titles = input.detail === "titles";
        return { text: files.length ? kb.formatFileList(files, { base, titles, now }) : "No .sdoc files there." };
      }
      case "outline": {
        const files = [...new Set((input.file ? [String(input.file)] : []).concat(asList(input.files)))];
        if (!files.length) throw new Error("Missing file: pass file or files.");
        // depth counts levels from 1; formatOutline's maxDepth counts from 0.
        const depth = input.depth === undefined || input.depth === null || input.depth === "" ? NaN : Number(input.depth);
        const maxDepth = Number.isFinite(depth) ? Math.max(1, Math.floor(depth)) - 1 : Infinity;
        const previews = input.previews !== false && input.previews !== "false";
        const parts = [];
        const met = [];
        for (const file of files.slice(0, OUTLINE_MAX_FILES)) {
          const text = await fileText(file);
          const o = kb.outlineText(text, resolve(file));
          const hidden = o.sections.filter((s) => s.depth > maxDepth).length;
          const answer = kb.formatOutline(o, { base, maxDepth, previews }) +
            (hidden ? `\n(${plural(hidden, "deeper section")} not shown)` : "");
          const one = withSignposts(file, text, answer);
          parts.push(one.text);
          if (one.withSignposts) met.push(files.length > 1 ? `${one.withSignposts} (${kb.shownPath(resolve(file), cwd)})` : one.withSignposts);
        }
        const left = files.length - OUTLINE_MAX_FILES;
        if (left > 0) parts.push(`(${plural(left, "more file")} not outlined: at most ${OUTLINE_MAX_FILES} per call.)`);
        return { text: parts.join("\n\n"), withSignposts: met.length ? met.join("; ") : undefined };
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
          if (!section) return unknownIdMessage(id, input.file, sectionIdsOf(outlineOnce()));
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
        const found = await kb.rankFiles(String(input.query), await dirsOf(input.dirs), io);
        if (!found.hits.length) return { text: `Nothing matches "${input.query}".` };
        const list = kb.formatSearch(found.hits, { base, total: found.total, matched: found.matched, least: found.least, terms: found.terms });
        // The sections are not counted as met: the reading guide still comes
        // with the file's first Read, outline or read.
        const sections = input.read === true || input.read === "true" ? await searchReads(io, found.hits, cwd) : "";
        return { text: sections ? list + "\n\n" + sections : list };
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
      case "backlinks": {
        const { file, id: fragment } = fileAndId(input.file || "");
        const id = input.id ? String(input.id) : fragment;
        const text = await fileText(file);
        const dirs = await dirsOf(input.dirs);
        const found = await kb.backlinksFiles(resolve(file), dirs, io, { id });
        if (!found) throw new Error(id ? unknownIdMessage(id, file, sectionIdsOf(kb.outlineText(text, resolve(file)))) : `No such file: ${file}`);
        const where = asList(input.dirs).length ? dirs.map((d) => kb.shownPath(d, cwd).replace(/[\\/]?$/, "/")).join(", ") : "lexica/";
        return { text: kb.formatBacklinks(found, { base, where }) };
      }
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err.message };
  }
}

// --- Permissions ---
//
// A call the plugin answers itself skips the engine's permission check, so
// its tools put each path they name to that check, as written and where it
// leads: a Read of a file, a Glob of the .sdoc files under a directory. A
// deny stands, inside the project too. An ask inside the project or the
// plugin goes through, as reading there always has; elsewhere the person is
// asked, once for the paths of one call, and may allow a directory for the
// rest of the session. With no one to ask, the call is refused.

// The answers offered; anything typed under Other refuses.
export const CONSENT_OPTIONS = ["Allow once", "Allow for this session", "Deny"];

// The paths a tool call names, each { path, kind }: "dir" for a directory
// list, search or backlinks looks in, "file" for the rest.
export function toolRequests(name, input, cwd) {
  const dirs = new Set(["list", "search", "backlinks"].includes(name) ? asList(input.dirs).map((p) => kb.joinPath(cwd, p)) : []);
  return toolPaths(name, input, cwd).map((path) => ({ path, kind: dirs.has(path) ? "dir" : "file" }));
}

// The permission question for one path, as $.tool.check takes it.
export function checkRequest({ path, kind }) {
  return kind === "dir"
    ? { tool: "Glob", input: { pattern: "**/*.sdoc", path } }
    : { tool: "Read", input: { file_path: path } };
}

// The permission question for the call itself, under the tool's full name,
// with only its own arguments: a deny rule naming the tool
// (mcp__sdoc-lexica__search) holds as it would for any other.
export function ownToolRequest(name, input, tool) {
  const spec = TOOLS.find((t) => t.name === name);
  const keys = Object.keys((spec && spec.inputSchema.properties) || {});
  return { tool, input: Object.fromEntries(keys.filter((k) => input[k] !== undefined).map((k) => [k, input[k]])) };
}

// Whether a call may read the paths it names: { allow: true } or { deny }.
//
//   check(request)  → { decision, reason?, rule? }, as $.tool.check
//   ask(question, options)
//                   → the label chosen or the text typed under Other, as
//                     $.ui.ask; rejects when no one can be asked
//   allowed         the directories allowed for the session (a Set), each
//                   covering its subtree; "Allow for this session" adds to it
//   pending         the questions still open (a Map), so calls racing for the
//                   same paths ask once
//   roots           where an ask goes through unasked: the project, the plugin
//   io              realPath and log, as elsewhere in this file
//   tool, name      the call's full and short names, for the question and notes
//   cwd             the project, for the paths shown and the refusal
export async function consent(paths, { check, ask, allowed = new Set(), pending = new Map(), roots = [], io = {}, tool = "This tool", name = "tool", cwd = "" } = {}) {
  const shown = (p) => kb.shownPath(p, cwd);
  const what = (entries) => entries.map((e) => e.kind === "dir" ? `the .sdoc files under ${shown(e.path)}` : shown(e.path)).join(", ");
  const asking = [];
  for (const entry of paths) {
    const real = await realPath(io, entry.path);
    for (const path of real === entry.path ? [entry.path] : [entry.path, real]) {
      const request = checkRequest({ path, kind: entry.kind });
      let verdict;
      try {
        verdict = (await check(request)) || {};
      } catch (err) {
        note(io, `tool ${name}: the permission check failed (${err && err.message}), taken as an ask`);
        verdict = { decision: "ask" };
      }
      if (verdict.decision === "deny") {
        const why = verdict.reason || (verdict.rule ? `denied by ${verdict.rule}` : "denied by the permission settings");
        note(io, `tool ${name}: refused, the permission settings deny ${request.tool} of ${shown(path)}${verdict.rule ? ` (${verdict.rule})` : ""}`);
        return { deny: `${tool} may not read ${what([{ path, kind: entry.kind }])}: ${why}` };
      }
      if (verdict.decision === "allow" || roots.some((root) => kb.isInside(root, path))) continue;
      if ([...allowed].some((dir) => kb.isInside(dir, path))) {
        note(io, `tool ${name}: ${shown(path)} allowed earlier in this session`);
        continue;
      }
      if (!asking.some((a) => a.path === path)) asking.push({ path, kind: entry.kind });
    }
  }
  if (!asking.length) return { allow: true };

  const key = asking.map((a) => a.path).sort().join("\n");
  let answer;
  try {
    let question = pending.get(key);
    if (!question) {
      question = Promise.resolve().then(() =>
        ask(`Allow ${tool} to read ${what(asking)}, outside the project?`, { options: CONSENT_OPTIONS, header: "Permission" }));
      pending.set(key, question);
      const settled = () => { if (pending.get(key) === question) pending.delete(key); };
      question.then(settled, settled);
    }
    answer = await question;
  } catch {
    note(io, `tool ${name}: refused, it names a path outside the project`);
    return { deny: `${tool} reads only inside the project (${cwd}). Use Read for a file elsewhere.` };
  }
  if (answer === CONSENT_OPTIONS[0]) {
    note(io, `tool ${name}: ${what(asking)} allowed once`);
    return { allow: true };
  }
  if (answer === CONSENT_OPTIONS[1]) {
    const dirs = [...new Set(asking.map((a) => a.kind === "dir" ? a.path : kb.dirName(a.path)))];
    for (const dir of dirs) allowed.add(dir);
    note(io, `tool ${name}: ${dirs.map(shown).join(", ")} allowed for this session`);
    return { allow: true };
  }
  const said = answer && answer !== CONSENT_OPTIONS[2] ? ` They said: ${answer}` : "";
  note(io, `tool ${name}: refused by the user`);
  return { deny: `The user did not allow ${tool} to read ${what(asking)}.${said}` };
}
