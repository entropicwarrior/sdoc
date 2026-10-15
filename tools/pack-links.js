#!/usr/bin/env node
// Runs a packaging command with the knowledge files' links pointing at GitHub.
//
//   node tools/pack-links.js <command> [args...]
//   node tools/pack-links.js npx vsce package --out dist/
//
// The files knowledge.js lists are read outside the repo: from node_modules,
// from the VSIX through sdoc_reference, and by knowledge servers that store a
// file by its name rather than its place in the tree. A relative link in one
// of them names a file that is not there. In the repo the relative link is the
// right one — it opens the local file, works offline and `build-doc --check`
// verifies it — so the source keeps it, and only the packaged copy changes.
//
// Every relative link whose target exists in the repo becomes a URL pinned to
// this version's tag. A link to a file that does not exist is left alone: it is
// an illustration in a guide, or a broken link that --check already reports.
// The files are restored when the command exits, whatever its outcome.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { parseSdoc, collectInlineRefs } = require("../src/sdoc");
const { hrefCandidates } = require("../src/href-path");

const ROOT = path.join(__dirname, "..");

function hasUrlScheme(href) {
  return /^[a-z][a-z0-9+.-]*:/i.test(href);
}

// The parser says which links are real — a link inside code is not one — and
// on which lines. The source is then edited only on those lines, and only
// where the number of `](href)` there matches the number of links the parser
// found; anything else is reported rather than guessed at.
//
// docPath is the file's path from the repo root, with forward slashes.
// exists(repoPath) says whether a file is in the repo.
function rewriteLinks(text, docPath, baseUrl, exists) {
  const errors = [];
  const rewritten = [];
  const { links } = collectInlineRefs(parseSdoc(text).nodes);

  const groups = new Map();
  for (const link of links) {
    const href = link.href;
    if (!href || href.startsWith("#") || hasUrlScheme(href)) continue;
    const cut = href.search(/[#?]/);
    const filePart = cut === -1 ? href : href.slice(0, cut);
    const suffix = cut === -1 ? "" : href.slice(cut);
    const resolve = (p) => path.posix.normalize(path.posix.join(path.posix.dirname(docPath), p));
    // The URL keeps the path as written; the existence check also tries it
    // percent-decoded, as `build-doc --check` does.
    const target = resolve(filePart);
    if (target === ".." || target.startsWith("../")) continue;
    if (!hrefCandidates(filePart).some((candidate) => exists(resolve(candidate)))) continue;
    const key = `${link.lineStart}:${link.lineEnd}:${href}`;
    if (!groups.has(key)) {
      groups.set(key, { href, url: baseUrl + target + suffix, lineStart: link.lineStart, lineEnd: link.lineEnd, count: 0 });
    }
    groups.get(key).count += 1;
  }

  const lines = text.split("\n");
  const all = [...groups.values()];
  for (const group of all) {
    const overlaps = all.some((other) => other !== group && other.href === group.href &&
      other.lineStart <= group.lineEnd && group.lineStart <= other.lineEnd);
    const needle = `](${group.href})`;
    let found = 0;
    for (let i = group.lineStart - 1; i < group.lineEnd; i += 1) {
      found += lines[i].split(needle).length - 1;
    }
    if (overlaps || found !== group.count) {
      errors.push(`${docPath}:${group.lineStart}: cannot place the link to ${group.href}: ` +
        `the parser found ${group.count}, the source has ${found} on those lines`);
      continue;
    }
    for (let i = group.lineStart - 1; i < group.lineEnd; i += 1) {
      lines[i] = lines[i].split(needle).join(`](${group.url})`);
    }
    rewritten.push({ href: group.href, url: group.url, lineStart: group.lineStart, lineEnd: group.lineEnd, count: group.count });
  }

  return { text: lines.join("\n"), rewritten, errors };
}

// https://github.com/<owner>/<repo>/blob/v<version>/
function tagBaseUrl(pkg) {
  const repo = String((pkg.repository && pkg.repository.url) || pkg.repository || "")
    .replace(/^git\+/, "")
    .replace(/\.git$/, "");
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(repo)) {
    throw new Error(`package.json repository is not a GitHub URL: ${repo || "(none)"}`);
  }
  return `${repo}/blob/v${pkg.version}/`;
}

// Signals that stop a run. Ctrl-C reaches the command through the process
// group, but a cancelled CI job may send SIGTERM to this process alone.
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

// Runs the command between setup and teardown, and resolves with its exit
// status. From before setup until after teardown a signal is caught, so
// teardown always runs: it is passed on to the command, the run waits for the
// command to stop, and it resolves 128 plus the signal's number, as a shell
// reports it, never 0. A second signal kills the command, so one that ignores
// the first cannot keep teardown waiting.
async function runCommand(argv, setup = () => {}, teardown = () => {}) {
  let child = null;
  let received = null;
  const onSignal = (signal) => {
    const first = !received;
    received = received || signal;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill(first ? signal : "SIGKILL");
    }
  };
  for (const s of SIGNALS) process.on(s, onSignal);
  try {
    setup();
    child = spawn(argv[0], argv.slice(1), { stdio: "inherit", shell: process.platform === "win32" });
    const status = await exitStatus(child);
    if (received) {
      console.error(`pack-links: stopped by ${received}`);
      return 128 + os.constants.signals[received];
    }
    return status;
  } finally {
    try {
      teardown();
    } finally {
      for (const s of SIGNALS) process.removeListener(s, onSignal);
    }
  }
}

// The command's exit status: its code, or 128 plus the number of the signal
// that ended it. An 'error' with no pid means it never started, and may come
// without an 'exit'.
function exitStatus(child) {
  return new Promise((resolve) => {
    child.on("error", (err) => {
      console.error(`pack-links: ${err.message}`);
      if (child.pid === undefined) resolve(1);
    });
    child.on("exit", (code, signal) => {
      resolve(code !== null ? code : 128 + (os.constants.signals[signal] || 0));
    });
  });
}

async function main(argv) {
  if (argv.length === 0) {
    console.error("Usage: pack-links <command> [args...]");
    return 1;
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const baseUrl = tagBaseUrl(pkg);
  const files = require("../knowledge.js").knowledgeFiles.map((f) => f.path);
  const exists = (repoPath) => fs.existsSync(path.join(ROOT, repoPath));

  const originals = new Map();
  const errors = [];
  const outputs = [];
  let count = 0;
  for (const file of files) {
    const original = fs.readFileSync(file, "utf8");
    const docPath = path.relative(ROOT, file).split(path.sep).join("/");
    const result = rewriteLinks(original, docPath, baseUrl, exists);
    errors.push(...result.errors);
    originals.set(file, original);
    outputs.push([file, result.text]);
    count += result.rewritten.reduce((n, r) => n + r.count, 0);
  }
  // Nothing is touched unless every file can be rewritten.
  if (errors.length) {
    for (const e of errors) console.error(`pack-links: ${e}`);
    return 1;
  }

  return runCommand(argv, () => {
    for (const [file, text] of outputs) fs.writeFileSync(file, text);
    console.log(`pack-links: ${count} links in ${files.length} knowledge files point at ${baseUrl}`);
  }, () => {
    for (const [file, original] of originals) fs.writeFileSync(file, original);
  });
}

module.exports = { rewriteLinks, tagBaseUrl, runCommand };

if (require.main === module) {
  main(process.argv.slice(2)).then((status) => {
    process.exitCode = status;
  });
}
