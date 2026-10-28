// The sdoc plugin's hooks module. Claude Code runs it in its own runtime, with
// no Node: everything outside the module goes through the engine interface,
// `$`. This file only binds the engine's events to handlers.mjs, which holds
// the behaviour and is tested under Node.
//
//   session.start    registers the tools (mcp__sdoc-lexica__list, outline, read, ...)
//   prompt.submit    attaches the lexica/ index to the conversation's first prompt
//   tool.call Read   adds the file's reading guide and related resources
//   tool.call Edit   refuses the first edit once with the editing guide, then
//                    reports the findings an edit adds
//   tool.call own    answers the plugin's tools, inside the project only
//
// Every action is noted in one line: in the debug log always (claude
// --debug-file), and in the session too with the verbose option
// (userConfig in plugin.json; /config, or claude plugin configure).

import {
  createState,
  resetState,
  knowledgeDirs,
  indexForPrompt,
  afterRead,
  beforeEdit,
  afterEdit,
  TOOLS,
  indexBudget,
  runTool,
  toolPaths,
  isWithin
} from "./handlers.mjs";
import { isInside } from "../lib/knowledge-base.mjs";

const SDOC_FILE = /\.sdoc$/i;
const FILE_EDIT = /^(Edit|Write|MultiEdit)$/;
const OWN_TOOL = new RegExp(`__(${TOOLS.map((t) => t.name).join("|")})$`);

// The plugin's options, set by register. Changing one reloads the module, so
// they are read once.
let verbose = false;
let indexChars = indexBudget();

// A note goes to the debug log; with verbose, to the transcript too, as a dim
// line the model is not sent. Both lead it with the plugin's name already.
function logger($) {
  return (text) => {
    try {
      if (verbose) $.ui.log(text);
      else $.ui.log(text, { to: "debug" });
    } catch { /* a log line must never break a hook */ }
  };
}

function note($, text) {
  logger($)(text);
}

function ioOf($) {
  return {
    read: (path) => $.fs.read(path),
    list: (dir) => $.fs.list(dir),
    exists: (path) => $.fs.exists(path),
    log: logger($)
  };
}

// Where a path leads through any link; the path itself when it leads nowhere.
async function realPathOf($, path) {
  const stat = await $.fs.stat(path, { resolve: true }).catch(() => undefined);
  return stat && stat.realPath ? stat.realPath : path;
}

// True when every path a tool call names lies inside the project or the
// plugin, both as written and where it leads, so a link cannot reach out.
async function staysInside($, name, input, cwd) {
  const roots = [cwd, $.plugin.root];
  roots.push(...await Promise.all(roots.map((root) => realPathOf($, root))));
  if (!isWithin(name, input, cwd, roots)) return false;
  for (const path of toolPaths(name, input, cwd)) {
    const real = await realPathOf($, path);
    if (!roots.some((root) => isInside(root, real))) return false;
  }
  return true;
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
    return started;
  });

  // Not prompt.context: the built-in security plugin passes over a user
  // plugin's hook there. Context attached to a prompt reaches the model.
  on("prompt.submit", async ($, e, next) => {
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
    const before = await beforeEdit(files, state, { filePath: e.file_path, agentId: e.agentId, cwd });
    if (before.deny) return { deny: before.deny };
    const result = await next(e);
    if (!ran(result)) return result;
    return withContext(result, await afterEdit(files, { filePath: e.file_path, snapshot: before.snapshot, cwd }));
  }).catch(($, e, next) => next(e));

  // Answering a call here skips the engine's permission check, which runs
  // beneath next(e): the guard is this hook's own. The tools read inside the
  // project (and the plugin's bundled guide) and nowhere else, as Read goes
  // without a prompt there; a path elsewhere is refused, not asked about.
  on("tool.call", { tool: OWN_TOOL }, async ($, e, next) => {
    const name = tools.get(e.tool);
    if (!name) return next(e);
    const cwd = await $.session.cwd();
    if (!await staysInside($, name, e, cwd)) {
      note($, `tool ${name}: refused, it names a path outside the project`);
      return { deny: `${e.tool} reads only inside the project (${cwd}). Use Read for a file elsewhere.` };
    }
    const { text, error } = await runTool(ioOf($), name, e, { cwd, state, agentId: e.agentId });
    return error ? { deny: error } : { result: text };
  }).catch(($, e, next) => next.called ? next(e) : { deny: `${e.tool} failed.` });

  on("session.compact", async ($, e, next) => {
    const compacted = await next(e);
    resetState(state);
    note($, "conversation compacted: the index and the guides will be shown again");
    return compacted;
  }).catch(($, e, next) => next(e));

  on("session.end", async ($, e, next) => {
    resetState(state);
    note($, `conversation ended (${e.reason}): the index and the guides will be shown again`);
    return next(e);
  });
};
