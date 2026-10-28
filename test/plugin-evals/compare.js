#!/usr/bin/env node
// Reads the result JSON of `claude plugin eval` (npm run eval:plugin -- --json
// <file>) and prints it per case, or compares two runs of the suite.
//
//   node test/plugin-evals/compare.js <result.json>
//       One run: per case WITH, W/OUT, Δ, then cost, seconds, turns and tool
//       calls per with-plugin run.
//   node test/plugin-evals/compare.js <before.json> <after.json>
//       Two runs: each column as before→after, and ΔWITH, the change in the
//       with-plugin score. An after run made with --ablation none has no W/OUT
//       of its own; its Δ is taken against the before run's W/OUT (marked *),
//       since that arm loads no plugin and so does not change.
//   node test/plugin-evals/compare.js --embed <result.json>...
//       Counts the tool calls in each run's trace and writes them into the
//       result (toolCalls, by tool name; toolCallsTotal; pluginToolCalls). Run
//       it straight after the suite: the traces live in the run's temp dir,
//       which survives only with --keep-temp, and not past a reboot.
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

// --- Tool calls -------------------------------------------------------------

function countToolCalls(tracePath) {
  const calls = {};
  const text = fs.readFileSync(tracePath, "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.type !== "assistant" || !message.message || !Array.isArray(message.message.content)) continue;
    // A subagent's calls are in the trace too, under its parent's tool use id.
    const who = message.parent_tool_use_id ? "subagent:" : "";
    for (const block of message.message.content) {
      if (block.type === "tool_use") calls[who + block.name] = (calls[who + block.name] || 0) + 1;
    }
  }
  return calls;
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
          const calls = countToolCalls(run.tracePath);
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
    console.log(`${file}: tool calls written for ${counted} runs${missing ? `, ${missing} traces missing` : ""}`);
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

function caseStats(c, skip) {
  const arm = (name) => (c.arms && c.arms[name]) || [];
  const withRuns = arm("with");
  const withoutRuns = arm("without");
  const all = [...withRuns, ...withoutRuns];
  const known = (key, runs = withRuns) => runs.filter((r) => typeof r[key] === "number").map((r) => r[key]);
  return {
    with: mean(withRuns.map((r) => runScore(r, skip))),
    without: withoutRuns.length ? mean(withoutRuns.map((r) => runScore(r, skip))) : null,
    cost: all.reduce((a, r) => a + (r.costUsd || 0) + (r.judgeCostUsd || 0), 0),
    costPerRun: mean(withRuns.map((r) => r.costUsd || 0)),
    costPerRunWithout: mean(withoutRuns.map((r) => r.costUsd || 0)),
    toolsWithout: mean(known("toolCallsTotal", withoutRuns)),
    seconds: mean(withRuns.map((r) => r.durationSeconds || 0)),
    turns: mean(known("turns")),
    tools: mean(known("toolCallsTotal")),
    pluginTools: mean(known("pluginToolCalls")),
    errors: all.filter((r) => r.error).map((r) => r.error)
  };
}

// --- Output -----------------------------------------------------------------

const num = (x, digits = 2) => (x === null || x === undefined ? "—" : x.toFixed(digits));
const signed = (x) => (x === null || x === undefined ? "—" : (x >= 0 ? "+" : "") + x.toFixed(2));
const usd = (x) => (x === null || x === undefined ? "—" : "$" + x.toFixed(2));
const pair = (a, b, f) => `${f(a)}→${f(b)}`;

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

function single(file) {
  const result = load(file);
  const rows = [["CASE", "WITH", "W/OUT", "Δ", "COST", "$/RUN w|w/o", "TOOLS w|w/o", "PLUGIN", "SECS", "TURNS", "NOTES"]];
  for (const c of result.cases) {
    const st = caseStats(c, unscored(c));
    const delta = st.without === null ? null : st.with - st.without;
    rows.push([c.name, num(st.with), num(st.without), signed(delta), usd(st.cost),
      `${usd(st.costPerRun)}|${usd(st.costPerRunWithout)}`, `${num(st.tools, 1)}|${num(st.toolsWithout, 1)}`,
      num(st.pluginTools, 1), num(st.seconds, 0), num(st.turns, 1), errorNote(st.errors)]);
  }
  console.log(`${file}\n  ${describe(result)}\n`);
  console.log(table(rows));
  console.log("\n$/RUN and TOOLS (all tool calls, subagents' included) are means per run, with the plugin | without it. " +
    "PLUGIN (mcp__sdoc-lexica__* calls), SECS and TURNS are means per with-plugin run. COST covers every run and judge call of the case.");
}

function compare(beforeFile, afterFile) {
  const before = load(beforeFile);
  const after = load(afterFile);
  const afterByName = new Map(after.cases.map((c) => [c.name, c]));
  const rows = [["CASE", "WITH", "W/OUT", "Δ", "ΔWITH", "$/RUN", "SECS", "TURNS", "TOOLS", "PLUGIN", "NOTES"]];
  const changes = [];
  let borrowed = false;
  for (const b of before.cases) {
    const a = afterByName.get(b.name);
    if (!a) { rows.push([b.name, "not in after", "", "", "", "", "", "", "", "", ""]); continue; }
    const skip = new Set([...unscored(b), ...unscored(a)]);
    const sb = caseStats(b, skip);
    const sa = caseStats(a, skip);
    let withoutAfter = sa.without;
    if (withoutAfter === null && sb.without !== null) { withoutAfter = sb.without; borrowed = true; }
    const db = sb.without === null ? null : sb.with - sb.without;
    const da = withoutAfter === null ? null : sa.with - withoutAfter;
    const change = sa.with - sb.with;
    changes.push(change);
    const notes = [errorNote(sb.errors) && `before: ${errorNote(sb.errors)}`, errorNote(sa.errors) && `after: ${errorNote(sa.errors)}`]
      .filter(Boolean).join(" | ");
    rows.push([b.name, pair(sb.with, sa.with, num),
      `${num(sb.without)}→${num(withoutAfter)}${sa.without === null && withoutAfter !== null ? "*" : ""}`,
      pair(db, da, signed), signed(change), pair(sb.costPerRun, sa.costPerRun, usd), pair(sb.seconds, sa.seconds, (x) => num(x, 0)),
      pair(sb.turns, sa.turns, (x) => num(x, 1)), pair(sb.tools, sa.tools, (x) => num(x, 1)),
      pair(sb.pluginTools, sa.pluginTools, (x) => num(x, 1)), notes]);
  }
  for (const a of after.cases) if (!before.cases.some((b) => b.name === a.name)) rows.push([a.name, "not in before", "", "", "", "", "", "", "", "", ""]);
  console.log(`before: ${beforeFile}\n  ${describe(before)}\nafter:  ${afterFile}\n  ${describe(after)}\n`);
  console.log(table(rows));
  const worse = changes.filter((x) => x < -1e-9).length;
  console.log(`\nmean ΔWITH ${signed(mean(changes))}, ${changes.filter((x) => x > 1e-9).length} better, ${worse} worse, ` +
    `${changes.length - worse - changes.filter((x) => x > 1e-9).length} unchanged; total cost ${usd(before.costUsd)}→${usd(after.costUsd)}`);
  if (borrowed) console.log("* the after run has no W/OUT arm; its Δ is taken against the before run's W/OUT.");
  console.log("Each column is before→after. $/RUN, SECS, TURNS, TOOLS and PLUGIN are means per with-plugin run.");
}

const args = process.argv.slice(2);
if (args[0] === "--embed" && args.length > 1) embed(args.slice(1));
else if (args.length === 1) single(args[0]);
else if (args.length === 2) compare(args[0], args[1]);
else {
  console.error("Usage: compare.js <result.json> | compare.js <before.json> <after.json> | compare.js --embed <result.json>...");
  process.exit(1);
}
