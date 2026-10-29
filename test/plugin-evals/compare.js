#!/usr/bin/env node
// Reads the result JSON of `claude plugin eval` (npm run eval:plugin -- --json
// <file>) and reports it against the plugin's three goals, with the plugin and
// without it: accuracy (the graders' score), speed (seconds per run) and
// tokens (per run, subagents' included), with the price per run beside them.
// Tokens come in three kinds that cost very differently, so each is shown on
// its own: NEW (input sent at full price, cache writes included), CACHED (the
// conversation re-read from the prompt cache at about a tenth of the price,
// which is most of a long task's tokens) and OUT (what the model writes).
// Nothing else is a goal; how many tools a run called is a clue for finding
// out why, shown with --detail.
//
//   node test/plugin-evals/compare.js <result.json> [--detail]
//       One run, per case and in total, each figure with the plugin | without
//       it and the change the plugin makes: ACCURACY, SECS and $/RUN, then the
//       three kinds of tokens.
//   node test/plugin-evals/compare.js <before.json> <after.json>
//       Two runs: the with-plugin figures as before→after. An after run made
//       with --ablation none has no without-plugin arm of its own; its Δ is
//       taken against the before run's (marked *), since that arm loads no
//       plugin and so does not change.
//   node test/plugin-evals/compare.js --embed <result.json>...
//       Reads each run's trace and writes into the result what the result
//       itself lacks: tokens ({ input, cacheWrite, cacheRead, output }) and
//       the tool calls (toolCalls, by tool name;
//       toolCallsTotal; pluginToolCalls). Run it straight after the suite: the
//       traces live in the run's temp dir, which survives only with
//       --keep-temp, and not past a reboot. Without it, TOKENS reads —.
//
// Scores are recomputed from the grader verdicts, leaving out every grader that
// either file did not score (a with-only indicator is scored under --ablation
// none and not under with-without), so the two files are compared like for
// like. A run that ended on an API error has no verdicts and counts as 0.
//
// Costs are list-price estimates from the result: the agent's runs plus the
// judge's calls, summed over both arms.
"use strict";

const fs = require("fs");

const PLUGIN_TOOL = /^mcp__sdoc-lexica__/;

function load(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// --- What a trace holds -----------------------------------------------------

function traceLines(tracePath) {
  const lines = [];
  for (const line of fs.readFileSync(tracePath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { lines.push(JSON.parse(line)); } catch { /* a cut line */ }
  }
  return lines;
}

function countToolCalls(lines) {
  const calls = {};
  for (const message of lines) {
    if (message.type !== "assistant" || !message.message || !Array.isArray(message.message.content)) continue;
    // A subagent's calls are in the trace too, under its parent's tool use id.
    const who = message.parent_tool_use_id ? "subagent:" : "";
    for (const block of message.message.content) {
      if (block.type === "tool_use") calls[who + block.name] = (calls[who + block.name] || 0) + 1;
    }
  }
  return calls;
}

// The tokens a run used, every model and subagent included, by kind: input
// sent uncached, input written to the cache, input read from it, output. From
// the result line's modelUsage; for a run that ended without one (a timeout),
// from each model response's usage, counted once per response.
function countTokens(lines) {
  const tokens = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  const add = (input, cacheWrite, cacheRead, output) => {
    tokens.input += input || 0;
    tokens.cacheWrite += cacheWrite || 0;
    tokens.cacheRead += cacheRead || 0;
    tokens.output += output || 0;
  };
  const result = lines.filter((l) => l.type === "result" && l.modelUsage).pop();
  if (result) {
    for (const u of Object.values(result.modelUsage)) add(u.inputTokens, u.cacheCreationInputTokens, u.cacheReadInputTokens, u.outputTokens);
  } else {
    const byResponse = new Map();
    for (const l of lines) {
      if (l.type === "assistant" && l.message && l.message.usage) byResponse.set(l.message.id || byResponse.size, l.message.usage);
    }
    for (const u of byResponse.values()) add(u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens, u.output_tokens);
  }
  return tokens;
}

function embed(files) {
  for (const file of files) {
    const result = load(file);
    let counted = 0;
    let missing = 0;
    for (const c of result.cases) {
      for (const runs of Object.values(c.arms || {})) {
        for (const run of runs) {
          if (!run.tracePath || !fs.existsSync(run.tracePath)) { missing++; continue; }
          const lines = traceLines(run.tracePath);
          const calls = countToolCalls(lines);
          run.tokens = countTokens(lines);
          run.toolCalls = calls;
          run.toolCallsTotal = Object.values(calls).reduce((a, b) => a + b, 0);
          run.pluginToolCalls = Object.entries(calls)
            .filter(([name]) => PLUGIN_TOOL.test(name.replace(/^subagent:/, "")))
            .reduce((a, [, n]) => a + n, 0);
          counted++;
        }
      }
    }
    fs.writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
    console.log(`${file}: tokens and tool calls written for ${counted} runs${missing ? `, ${missing} traces missing` : ""}`);
  }
}

// --- Scores -----------------------------------------------------------------

// Names of the graders a file left unscored in any run of a case.
function unscored(c) {
  const names = new Set();
  for (const runs of Object.values(c.arms || {})) {
    for (const run of runs) for (const g of run.graders || []) if (g.scored === false) names.add(g.name);
  }
  return names;
}

function runScore(run, skip) {
  const graders = (run.graders || []).filter((g) => !skip.has(g.name));
  const total = graders.reduce((a, g) => a + (g.weight || 1), 0);
  if (!total) return 0;
  return graders.reduce((a, g) => a + (g.passed ? g.weight || 1 : 0), 0) / total;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// A case's figures for one arm's runs: the three goals and the price, then
// the clues.
function armStats(runs, skip) {
  if (!runs.length) return null;
  const known = (pick) => runs.map(pick).filter((x) => typeof x === "number");
  // A token figure only when every run's is known: a mean of some runs misleads.
  const tokens = (pick) => {
    const xs = known((r) => (r.tokens && typeof r.tokens.cacheRead === "number" ? pick(r.tokens) : undefined));
    return xs.length === runs.length ? mean(xs) : null;
  };
  return {
    accuracy: mean(runs.map((r) => runScore(r, skip))),
    seconds: mean(known((r) => r.durationSeconds)),
    newTokens: tokens((t) => t.input + t.cacheWrite),
    cachedTokens: tokens((t) => t.cacheRead),
    outTokens: tokens((t) => t.output),
    costPerRun: mean(runs.map((r) => r.costUsd || 0)),
    turns: mean(known((r) => r.turns)),
    tools: mean(known((r) => r.toolCallsTotal)),
    pluginTools: mean(known((r) => r.pluginToolCalls))
  };
}

function caseStats(c, skip) {
  const runs = (name) => (c.arms && c.arms[name]) || [];
  const all = [...runs("with"), ...runs("without")];
  return {
    with: armStats(runs("with"), skip),
    without: armStats(runs("without"), skip),
    cost: all.reduce((a, r) => a + (r.costUsd || 0) + (r.judgeCostUsd || 0), 0),
    errors: all.filter((r) => r.error).map((r) => r.error)
  };
}

// The suite's figures for one arm: mean accuracy over the cases; seconds,
// price and tokens summed over them, a pass of the suite. Null where a case
// lacks one.
function totals(stats, arm) {
  const arms = stats.map((s) => s[arm]);
  if (arms.some((a) => !a)) return null;
  const sum = (key) => (arms.every((a) => a[key] !== null) ? arms.reduce((n, a) => n + a[key], 0) : null);
  return {
    accuracy: mean(arms.map((a) => a.accuracy)), seconds: sum("seconds"), costPerRun: sum("costPerRun"),
    newTokens: sum("newTokens"), cachedTokens: sum("cachedTokens"), outTokens: sum("outTokens")
  };
}

// --- Output -----------------------------------------------------------------

const known = (x) => x !== null && x !== undefined;
const num = (x, digits = 2) => (known(x) ? x.toFixed(digits) : "—");
const signed = (x) => (known(x) ? (x >= 0 ? "+" : "") + x.toFixed(2) : "—");
const usd = (x) => (known(x) ? "$" + x.toFixed(2) : "—");
const kilo = (x) => (known(x) ? (x < 10000 ? (x / 1000).toFixed(1) : (x / 1000).toFixed(0)) + "k" : "—");
// How much the plugin changes a figure, as a share of the figure without it:
// −20% is a fifth less time or fewer tokens.
const change = (w, wo) => (known(w) && known(wo) && wo ? `${w >= wo ? "+" : "−"}${Math.abs((w - wo) / wo * 100).toFixed(0)}%` : "—");
const pair = (a, b, f) => `${f(a)}→${f(b)}`;
const get = (s, key) => (s ? s[key] : null);

function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => r.map((cell, i) => String(cell).padEnd(widths[i])).join("  ").trimEnd()).join("\n");
}

function describe(result) {
  const s = result.suite || {};
  const model = s.modelOverride || "case default";
  return `model ${model}, judge ${s.judgeModel || "default"}, ablation ${s.ablation || "?"}, ` +
    `${result.cases.length} cases, ${num(result.durationSeconds, 0)}s, ${usd(result.costUsd)}` +
    (result.partial ? `, PARTIAL (${result.partialReason})` : "");
}

function errorNote(errors) {
  if (!errors.length) return "";
  const kinds = [...new Set(errors.map((e) => String(e).slice(0, 40)))];
  return `${errors.length} run error(s): ${kinds.join("; ")}`;
}

// A figure with | without the plugin, and what the plugin changes: for the
// score, the difference; for the rest, the change as a share.
function goalCell(w, wo, key, f) {
  return [`${f(get(w, key))}|${f(get(wo, key))}`, key === "accuracy" ? (wo ? signed(w.accuracy - wo.accuracy) : "—") : change(get(w, key), get(wo, key))];
}

const GOALS = [["ACCURACY", "accuracy", num], ["SECS", "seconds", (x) => num(x, 0)], ["$/RUN", "costPerRun", usd]];
const TOKENS = [["NEW", "newTokens", kilo], ["CACHED", "cachedTokens", kilo], ["OUT", "outTokens", kilo]];

function single(file, { detail = false } = {}) {
  const result = load(file);
  const goals = [["CASE", ...GOALS.flatMap(([h]) => [h + " w|w/o", "Δ"]), ...(detail ? ["TOOLS w|w/o", "PLUGIN", "TURNS"] : []), "NOTES"]];
  const tokens = [["CASE", ...TOKENS.flatMap(([h]) => [h + " w|w/o", "Δ"])]];
  const stats = [];
  for (const c of result.cases) {
    const st = caseStats(c, unscored(c));
    stats.push(st);
    const clues = detail ? [`${num(get(st.with, "tools"), 1)}|${num(get(st.without, "tools"), 1)}`,
      num(get(st.with, "pluginTools"), 1), num(get(st.with, "turns"), 1)] : [];
    goals.push([c.name, ...GOALS.flatMap(([, key, f]) => goalCell(st.with, st.without, key, f)), ...clues, errorNote(st.errors)]);
    tokens.push([c.name, ...TOKENS.flatMap(([, key, f]) => goalCell(st.with, st.without, key, f))]);
  }
  const w = totals(stats, "with");
  const wo = totals(stats, "without");
  goals.push(["SUITE", ...GOALS.flatMap(([, key, f]) => goalCell(w, wo, key, f)), ...(detail ? ["", "", ""] : []), ""]);
  tokens.push(["SUITE", ...TOKENS.flatMap(([, key, f]) => goalCell(w, wo, key, f))]);
  console.log(`${file}\n  ${describe(result)}\n`);
  console.log(table(goals));
  console.log("\n" + table(tokens));
  console.log("\nEach figure is with the plugin | without it, a mean per run; Δ is what the plugin changes. ACCURACY is the " +
    "graders' score (1.00: every check passed), SECS the wall time, $/RUN the run's list price (the judge's calls left out). " +
    "Tokens count every model and subagent of the run: NEW is input at full price (cache writes included), CACHED the " +
    "conversation re-read from the prompt cache at about a tenth of the price, OUT what the model wrote. SUITE: mean " +
    "ACCURACY, the rest summed over the cases, one pass of the suite. The whole run, judge included, cost " + usd(result.costUsd) + "." +
    (stats.some((s) => s.with && s.with.cachedTokens === null) ? " Tokens read — until `compare.js --embed` has read the traces." : "") +
    (detail ? " TOOLS (all tool calls), PLUGIN (mcp__sdoc-lexica__* calls) and TURNS are clues, not goals." : ""));
}

function compare(beforeFile, afterFile) {
  const before = load(beforeFile);
  const after = load(afterFile);
  const afterByName = new Map(after.cases.map((c) => [c.name, c]));
  const rows = [["CASE", "ACCURACY", "Δ vs w/o", "SECS", "$/RUN", "NEW", "CACHED", "OUT", "NOTES"]];
  const changes = [];
  const pairs = [];
  let borrowed = false;
  for (const b of before.cases) {
    const a = afterByName.get(b.name);
    if (!a) { rows.push([b.name, "not in after", "", "", "", "", "", "", ""]); continue; }
    const skip = new Set([...unscored(b), ...unscored(a)]);
    const sb = caseStats(b, skip);
    const sa = caseStats(a, skip);
    let withoutAfter = sa.without;
    if (!withoutAfter && sb.without) { withoutAfter = sb.without; borrowed = true; }
    const db = sb.without ? sb.with.accuracy - sb.without.accuracy : null;
    const da = withoutAfter ? sa.with.accuracy - withoutAfter.accuracy : null;
    changes.push(sa.with.accuracy - sb.with.accuracy);
    pairs.push([sb, sa]);
    const notes = [errorNote(sb.errors) && `before: ${errorNote(sb.errors)}`, errorNote(sa.errors) && `after: ${errorNote(sa.errors)}`]
      .filter(Boolean).join(" | ");
    rows.push([b.name, pair(sb.with.accuracy, sa.with.accuracy, num),
      pair(db, da, signed) + (!sa.without && withoutAfter ? "*" : ""),
      pair(sb.with.seconds, sa.with.seconds, (x) => num(x, 0)), pair(sb.with.costPerRun, sa.with.costPerRun, usd),
      pair(sb.with.newTokens, sa.with.newTokens, kilo), pair(sb.with.cachedTokens, sa.with.cachedTokens, kilo),
      pair(sb.with.outTokens, sa.with.outTokens, kilo), notes]);
  }
  for (const a of after.cases) if (!before.cases.some((b) => b.name === a.name)) rows.push([a.name, "not in before", "", "", "", "", "", "", ""]);
  const tb = totals(pairs.map(([b]) => b), "with");
  const ta = totals(pairs.map(([, a]) => a), "with");
  rows.push(["SUITE", pair(get(tb, "accuracy"), get(ta, "accuracy"), num), "", pair(get(tb, "seconds"), get(ta, "seconds"), (x) => num(x, 0)),
    pair(get(tb, "costPerRun"), get(ta, "costPerRun"), usd), pair(get(tb, "newTokens"), get(ta, "newTokens"), kilo),
    pair(get(tb, "cachedTokens"), get(ta, "cachedTokens"), kilo), pair(get(tb, "outTokens"), get(ta, "outTokens"), kilo), ""]);
  console.log(`before: ${beforeFile}\n  ${describe(before)}\nafter:  ${afterFile}\n  ${describe(after)}\n`);
  console.log(table(rows));
  const better = changes.filter((x) => x > 1e-9).length;
  const worse = changes.filter((x) => x < -1e-9).length;
  console.log(`\nwith the plugin, accuracy ${better} better, ${worse} worse, ${changes.length - better - worse} unchanged; ` +
    `time ${change(get(ta, "seconds"), get(tb, "seconds"))}, price ${change(get(ta, "costPerRun"), get(tb, "costPerRun"))}, ` +
    `new tokens ${change(get(ta, "newTokens"), get(tb, "newTokens"))}, cached ${change(get(ta, "cachedTokens"), get(tb, "cachedTokens"))}, ` +
    `output ${change(get(ta, "outTokens"), get(tb, "outTokens"))} over the suite; ` +
    `total cost ${usd(before.costUsd)}→${usd(after.costUsd)}`);
  if (borrowed) console.log("* the after run has no W/OUT arm; its Δ is taken against the before run's W/OUT.");
  console.log("Each column is before→after, a mean per with-plugin run; SUITE sums all but ACCURACY over the cases.");
}

const args = process.argv.slice(2);
const detail = args.includes("--detail");
const files = args.filter((a) => a !== "--detail");
if (files[0] === "--embed" && files.length > 1) embed(files.slice(1));
else if (files.length === 1) single(files[0], { detail });
else if (files.length === 2) compare(files[0], files[1]);
else {
  console.error("Usage: compare.js <result.json> [--detail] | compare.js <before.json> <after.json> | compare.js --embed <result.json>...");
  process.exit(1);
}
