// The sdoc plugin's hooks module. Claude Code runs it in its own runtime, with
// no Node: everything outside the module goes through the engine interface,
// `$`. This file only binds the engine's events to handlers.mjs, which holds
// the behaviour and is tested under Node.
//
//   session.start    registers the tools (mcp__sdoc-lexica__list, outline,
//                    read, search, guides, check, backlinks) and, where the
//                    project has lexica/, the research agent
//                    (sdoc-lexica:research: answers from the knowledge, with
//                    citations, read-only)
//   agent.spawn      appends a short index to a new subagent's prompt; not to
//                    a fork, a resumed agent or a workflow agent
//   tool.call any    dormant: should the engine pass over the spawn hook, a
//                    subagent's first answered call carries the index instead
//   prompt.submit    attaches the lexica/ index to the conversation's first prompt
//   tool.call Read   adds the file's reading guide and related resources
//   tool.call Edit   refuses the first edit once with the editing guide, then
//                    reports the findings an edit adds
//   tool.call Bash   the same for an .sdoc file a command names and changes,
//                    the guide coming after the change
//   tool.call own    answers the plugin's tools, behind a permission guard, as
//                    the engine's own check does not run for them: a deny
//                    rule on the tool's name refuses it; then each path the
//                    call names is put to the check a Read (a Glob, for a
//                    directory) of it would get, as written and through
//                    links. A deny refuses, inside the project too; an ask
//                    goes through inside the project and the plugin, and
//                    elsewhere asks the person (once, or for the session)
//   prompt.mention   @file.sdoc#id attaches the section the id names, and a
//                    mentioned file's reading guide, as a Read does
//   prompt.autocomplete
//                    offers a file's section ids after @file.sdoc#
//   session.end      forgets what was shown and the directories allowed
//
// A compaction or a /clear is seen at the next prompt, by the conversation's
// opening message changing: what was shown is then shown again.
//
// Every action is noted in one line: in the debug log always (claude
// --debug-file), and in the session too with the verbose option
// (userConfig in plugin.json; /config, or claude plugin configure).

import {
  createState,
  resetState,
  openingOf,
  lostOpening,
  knowledgeDirs,
  indexForPrompt,
  afterRead,
  beforeEdit,
  afterEdit,
  beforeBash,
  afterBash,
  TOOLS,
  indexBudget,
  runTool,
  shouldBrief,
  subagentBriefing,
  researchAgentSpec,
  insideProject,
  mentionRead,
  mentionSuggestions,
  toolRequests,
  ownToolRequest,
  consent
} from "./handlers.mjs";

const SDOC_FILE = /\.sdoc$/i;
const NAMES_SDOC = /\.sdoc/i;
const FILE_EDIT = /^(Edit|Write|MultiEdit)$/;
const OWN_TOOL = new RegExp(`__(${TOOLS.map((t) => t.name).join("|")})$`);

// The plugin's options, set by register. Changing one reloads the module, so
// they are read once.
let verbose = false;
let indexChars = indexBudget();

// A note goes to the debug log; with verbose, to the transcript too, as a dim
// line the model is not sent, unless it is quiet: the session shows that
// already. Both lead it with the plugin's name already.
function logger($) {
  return (text, { quiet = false } = {}) => {
    try {
      if (verbose && !quiet) $.ui.log(text);
      else $.ui.log(text, { to: "debug" });
    } catch { /* a log line must never break a hook */ }
  };
}

function note($, text) {
  logger($)(text);
}

// Where a path leads through any link; the path itself when it leads nowhere.
async function realPathOf($, path) {
  const stat = await $.fs.stat(path, { resolve: true }).catch(() => undefined);
  return stat && stat.realPath ? stat.realPath : path;
}

async function nowOf($) {
  try { return await $.clock.now(); } catch { return Date.now(); }
}

// A command's answer, kept a minute by command and directory: the index and a
// subagent's brief ask git log the same thing moments apart. A failure is kept
// too, so a git that timed out is not waited on again within the minute.
const RUN_KEPT_MS = 60 * 1000;
const runs = new Map();

async function runKept($, argv, init = {}) {
  const now = await nowOf($);
  for (const [key, held] of runs) {
    if (now - held.at >= RUN_KEPT_MS) runs.delete(key);
  }
  const key = JSON.stringify([init.cwd || "", ...argv]);
  if (!runs.has(key)) runs.set(key, { at: now, answer: Promise.resolve().then(() => $.process.run(argv, init)) });
  return runs.get(key).answer;
}

// $.fs.list gives each entry's size and mtimeMs too, which key the cache of
// file descriptions kept in $.store. Each $ call is spelled out where it is
// made: the engine accepts no other form (claude plugin validate says so).
function ioOf($) {
  return {
    read: (path) => $.fs.read(path),
    list: (dir) => $.fs.list(dir),
    exists: (path) => $.fs.exists(path),
    realPath: (path) => realPathOf($, path),
    run: (argv, init) => runKept($, argv, init),
    now: () => nowOf($),
    storage: {
      get: (key) => $.store.get(key),
      set: (key, value) => $.store.set(key, value),
      delete: (key) => $.store.delete(key),
      keys: () => $.store.keys()
    },
    log: logger($)
  };
}

// Where the plugin's tools read without asking, as Read does in the project:
// the project and the plugin (its bundled guide), as written and where they
// lead. A path is judged as written and where it leads too (consent), so a
// link cannot reach out unasked.
async function rootsOf($, cwd) {
  const roots = [cwd, $.plugin.root];
  roots.push(...await Promise.all(roots.map((root) => realPathOf($, root))));
  return roots.filter((root, i) => root && roots.indexOf(root) === i);
}

function withContext(result, text) {
  return text ? { ...result, context: [...(result.context || []), text] } : result;
}

// A refused or failed call is left as it is.
function ran(result) {
  return result.deny === undefined && !result.isError;
}

export const register = (on, options = {}) => {
  verbose = options.verbose === true;
  indexChars = indexBudget(options.indexSize);
  const state = createState();
  // Full tool name (mcp__<plugin>__<name>) → short name, as registered.
  const tools = new Map();

  on("session.start", async ($, e, next) => {
    const started = await next(e);
    // A new conversation (a /clear starts one) has been shown nothing.
    resetState(state);
    // The tools sit in the model's list where the project has lexica/, and
    // behind ToolSearch elsewhere, where they cost nothing until wanted.
    const hasKnowledge = (await knowledgeDirs(ioOf($), e.cwd)).length > 0;
    for (const spec of TOOLS) {
      const { tool } = await $.tool.register({ ...spec, isDeferred: !hasKnowledge });
      tools.set(tool, spec.name);
    }
    note($, `${tools.size} tools registered, ${hasKnowledge
      ? "listed for the model (this project has lexica/)"
      : "behind tool search (no lexica/ here)"}`);
    subagents.hasKnowledge = hasKnowledge;
    // The research agent answers from lexica/, so only a project with one
    // has it. Its tools are the plugin's, as registered, and readers.
    if (hasKnowledge) {
      try {
        const { agent } = await $.agent.register(researchAgentSpec([...tools.keys()]));
        note($, `research agent registered as ${agent}`);
      } catch (err) {
        note($, `research agent not registered: ${(err && err.message) || err}`);
      }
    }
    return started;
  });

  // --- Subagents ---
  //
  // hasKnowledge is set at session.start, above; spawnHookRan by the spawn
  // hook; briefed holds the agents the fallback has dealt with.
  const subagents = { hasKnowledge: false, spawnHookRan: false, briefed: new Set() };

  // A subagent starts without the conversation, so without the index its
  // first prompt carried: its prompt gets a brief. A failure never blocks a
  // spawn: the catch lets it start as it was asked.
  on("agent.spawn", async ($, e, next) => {
    subagents.spawnHookRan = true;
    if (!subagents.hasKnowledge) return next(e);
    const who = `subagent ${e.subagentType || "(no type)"}`;
    if (!shouldBrief(e)) {
      note($, `${who}: not briefed (${e.fork ? "a fork, it has the conversation" : e.resume ? "resumed, it has its own" : "a workflow agent"})`);
      return next(e);
    }
    const brief = await subagentBriefing(ioOf($), await $.session.cwd(), { who });
    return next(brief ? { ...e, prompt: e.prompt + "\n\n" + brief } : e);
  }).catch(($, e, next) => next(e));

  // Should the engine pass over the spawn hook for a user plugin, as it does
  // a few others (see prompt.submit), a subagent's first answered tool call
  // carries the brief instead. Only until the spawn hook is seen to run; only
  // for an agent $.agent.list() names, and not a fork; a refused call leaves
  // it to the next one.
  on("tool.call", async ($, e, next) => {
    if (subagents.spawnHookRan || !subagents.hasKnowledge || !e.agentId ||
        subagents.briefed.has(e.agentId) || e.tool === "AskUserQuestion") return next(e);
    const result = await next(e);
    if (!ran(result) || subagents.spawnHookRan || subagents.briefed.has(e.agentId)) return result;
    subagents.briefed.add(e.agentId);
    const agent = (await $.agent.list()).find((a) => a.id === e.agentId);
    if (!agent || agent.type === "fork") {
      note($, `agent ${e.agentId}: not briefed (${agent ? "a fork, it has the conversation" : "not a listed subagent"})`);
      return result;
    }
    const who = `subagent ${agent.type} (agent ${e.agentId}, at its first tool call: the spawn hook did not run)`;
    return withContext(result, await subagentBriefing(ioOf($), await $.session.cwd(), { who }));
  }).catch(($, e, next) => next(e));

  // Not prompt.context: the built-in security plugin passes over a user
  // plugin's hook there. Context attached to a prompt reaches the model.
  // Nor session.compact or session.append for a compaction, passed over too:
  // the conversation's opening message tells instead.
  on("prompt.submit", async ($, e, next) => {
    const messages = await $.session.messages({ as: "api" }).catch(() => undefined);
    if (messages && lostOpening(state, openingOf(messages))) {
      resetState(state);
      note($, "conversation compacted or cleared: the index and the guides will be shown again");
    }
    const index = await indexForPrompt(ioOf($), state, await $.session.cwd(), { maxChars: indexChars });
    return next(index ? { ...e, context: [...(e.context || []), index] } : e);
  }).catch(($, e, next) => next(e));

  on("tool.call", { tool: "Read", file_path: SDOC_FILE }, async ($, e, next) => {
    const result = await next(e);
    if (!ran(result)) return result;
    const cwd = await $.session.cwd();
    return withContext(result, await afterRead(ioOf($), state, {
      filePath: e.file_path, offset: e.offset, limit: e.limit, agentId: e.agentId, cwd
    }));
  }).catch(($, e, next) => next(e));

  // A failure here never blocks an edit: the catch lets it run.
  on("tool.call", { tool: FILE_EDIT, file_path: SDOC_FILE }, async ($, e, next) => {
    const files = ioOf($);
    const cwd = await $.session.cwd();
    const before = await beforeEdit(files, state, { filePath: e.file_path, agentId: e.agentId, cwd, edit: e });
    if (before.deny) return { deny: before.deny };
    const result = await next(e);
    if (!ran(result)) return result;
    return withContext(result, await afterEdit(files, { filePath: e.file_path, snapshot: before.snapshot, cwd }));
  }).catch(($, e, next) => next(e));

  // A command that fails may still have changed a file (sed ran, the next
  // step failed), so only a refused one is passed over.
  on("tool.call", { tool: "Bash", command: NAMES_SDOC }, async ($, e, next) => {
    const files = ioOf($);
    const cwd = await $.session.cwd();
    const snapshot = await beforeBash(files, { command: e.command, cwd });
    const result = await next(e);
    if (result.deny !== undefined || !snapshot.size) return result;
    return withContext(result, await afterBash(files, state, { snapshot, agentId: e.agentId, cwd }));
  }).catch(($, e, next) => next(e));

  // The directories the person let the tools read for this session, and the
  // questions still open, so calls racing for the same paths ask once.
  const allowed = new Set();
  const asked = new Map();

  // Answering a call here skips the engine's permission check, which runs
  // beneath next(e): the guard is this hook's own. Each path the call names
  // is put to the check a Read of it would get (a Glob, for a directory), as
  // written and where it leads. A deny refuses the call, inside the project
  // too. An ask goes through in the project and the plugin (its bundled
  // guide), as Read goes without a prompt there; elsewhere the person is
  // asked, and may allow the directory for the session. With no one to ask
  // (claude -p, or the question dismissed), the call is refused.
  on("tool.call", { tool: OWN_TOOL }, async ($, e, next) => {
    const name = tools.get(e.tool);
    if (!name) return next(e);
    const cwd = await $.session.cwd();
    const io = ioOf($);
    // A settings rule denying the tool by name holds first. Only a rule: the
    // mode's own verdict on a tool it cannot see is read-only is not ours.
    const own = await $.tool.check(ownToolRequest(name, e, e.tool)).catch(() => undefined);
    if (own && own.decision === "deny" && own.rule) {
      note($, `tool ${name}: refused, the permission settings deny the tool (${own.rule})`);
      return { deny: own.reason || `${e.tool} is denied by ${own.rule}.` };
    }
    const verdict = await consent(toolRequests(name, e, cwd), {
      check: (request) => $.tool.check(request),
      ask: (question, options) => $.ui.ask(question, options),
      allowed,
      pending: asked,
      roots: await rootsOf($, cwd),
      io,
      tool: e.tool,
      name,
      cwd
    });
    if (verdict.deny !== undefined) return { deny: verdict.deny };
    const { text, error } = await runTool(io, name, e, { cwd, state, agentId: e.agentId });
    return error ? { deny: error } : { result: text };
  }).catch(($, e, next) => next.called ? next(e) : { deny: `${e.tool} failed.` });

  // @file.sdoc#id in a prompt: the lines of the section the id names are read
  // in place of the whole file (an unknown id reads it whole and says which
  // ids it has); #L10-20 is the engine's. A mentioned file inside the project
  // brings its reading guide, and a large one read whole its outline, as a
  // Read does: the engine raises no tool.call for a mention.
  const MENTIONED = /^(.*\.sdoc)#([^/]*)$/i;
  const LINES = /^L\d+(-\d+)?$/i;
  on("prompt.mention", { path: /\.sdoc(#[^/]*)?$/i }, async ($, e, next) => {
    const cwd = await $.session.cwd();
    const io = ioOf($);
    const named = MENTIONED.exec(e.mention || "");
    const fragment = named ? named[2] : "";
    const path = fragment && e.path.endsWith("#" + fragment) ? e.path.slice(0, -fragment.length - 1) : e.path;
    let request = path === e.path ? e : { ...e, path };
    if (!await insideProject(io, path, cwd)) return next(request);
    let missing = null;
    if (fragment && !LINES.test(fragment)) {
      const plan = await mentionRead(io, { filePath: path, fragment, cwd });
      if (plan) {
        const { offset, limit, ...whole } = request;
        request = plan.offset ? { ...whole, offset: plan.offset, limit: plan.limit } : whole;
        missing = plan.missing || null;
      }
    }
    const result = await next(request);
    if (result.deny !== undefined) return result;
    const guide = await afterRead(io, state, { filePath: path, offset: request.offset, limit: request.limit, agentId: e.agentId, cwd });
    return withContext(withContext(result, missing), guide);
  }).catch(($, e, next) => next(e));

  // Typing @file.sdoc# offers the file's section ids, beneath the engine's
  // own rows. The last file's outline is kept, so a keystroke parses nothing.
  const outlines = {};
  on("prompt.autocomplete", { token: /^@[^\s#]+\.sdoc#[\w-]*$/i }, async ($, e, next) => {
    const given = await next(e);
    const mine = await mentionSuggestions(ioOf($), { token: e.token, cwd: await $.session.cwd(), cache: outlines });
    return mine.length ? { ...given, suggestions: [...given.suggestions, ...mine] } : given;
  }).catch(($, e, next) => next(e));

  on("session.end", async ($, e, next) => {
    resetState(state);
    note($, `conversation ended (${e.reason}): the index and the guides will be shown again`);
    if (allowed.size) note($, `the directories allowed for the session are forgotten: ${[...allowed].join(", ")}`);
    allowed.clear();
    asked.clear();
    return next(e);
  });
};
