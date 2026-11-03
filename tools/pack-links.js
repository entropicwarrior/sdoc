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
// Every relative link to a file committed in the repo becomes a URL pinned to
// the commit being packaged, which in a release is the tagged one. A commit
// cannot move, needs no version to have been bumped, and is the tree the links
// were checked against. A link to a file that is not committed is left alone:
// it is an illustration in a guide, a local build output GitHub does not have,
// or a broken link that --check already reports. The files are restored
// when the command exits, whatever its outcome, unless one was edited while it
// ran.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { parseSdoc, collectInlineRefs, hasUrlScheme } = require("../src/sdoc");
const { hrefCandidates } = require("../src/href-path");

const ROOT = path.join(__dirname, "..");

// Whether the `](` at index p of a line closes an image's alt text rather than
// a link's label. As the parser reads them, the label runs from the first `[`
// after the previous `]`, and it is an image when that `[` follows a `!`. The
// parser reports only links, so an image to the same target would otherwise
// throw the count off. This reading ignores code and escapes; the count check
// after it reports a line it gets wrong rather than rewriting it.
function closesImage(line, p) {
  const open = line.indexOf("[", line.lastIndexOf("]", p - 1) + 1);
  return open !== -1 && open < p && line[open - 1] === "!";
}

// The parser says which links are real — a link inside code is not one — and
// on which lines. The source is then edited only on those lines, and only
// where the number of `](href)` closing a link there matches the number of
// links the parser found; anything else is reported rather than guessed at.
//
// docPath is the file's path from the repo root, with forward slashes.
// exists(repoPath) says whether a file is committed in the repo.
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
    const candidates = hrefCandidates(filePart);
    // An absolute path is no file of the repo: --check reads `/lexica/x.sdoc`
    // from the root of the disk, not of the repo. One that does name a repo
    // file from its root was meant as one, and is reported so that the source
    // and the package agree on it.
    if (path.win32.isAbsolute(filePart)) {
      if (filePart.startsWith("/") && candidates.some((c) => exists(path.posix.normalize(c.slice(1))))) {
        errors.push(`${docPath}:${link.lineStart}: ${href} is a path from the repo root; ` +
          "link the file by a path relative to this document");
      }
      continue;
    }
    const target = resolve(filePart);
    if (target === ".." || target.startsWith("../")) continue;
    if (!candidates.some((candidate) => exists(resolve(candidate)))) continue;
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
    const found = [];
    for (let i = group.lineStart - 1; i < group.lineEnd; i += 1) {
      for (let p = lines[i].indexOf(needle); p !== -1; p = lines[i].indexOf(needle, p + needle.length)) {
        if (!closesImage(lines[i], p)) found.push([i, p]);
      }
    }
    if (overlaps || found.length !== group.count) {
      errors.push(`${docPath}:${group.lineStart}: cannot place the link to ${group.href}: ` +
        `the parser found ${group.count}, the source has ${found.length} on those lines`);
      continue;
    }
    // Last first, so the positions before each one still hold.
    for (const [i, p] of found.reverse()) {
      lines[i] = lines[i].slice(0, p) + `](${group.url})` + lines[i].slice(p + needle.length);
    }
    rewritten.push({ href: group.href, url: group.url, lineStart: group.lineStart, lineEnd: group.lineEnd, count: group.count });
  }

  return { text: lines.join("\n"), rewritten, errors };
}

// https://github.com/<owner>/<repo>/blob/<commit>/
function blobBaseUrl(pkg, commit) {
  const repo = String((pkg.repository && pkg.repository.url) || pkg.repository || "")
    .replace(/^git\+/, "")
    .replace(/\.git$/, "");
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(repo)) {
    throw new Error(`package.json repository is not a GitHub URL: ${repo || "(none)"}`);
  }
  return `${repo}/blob/${commit}/`;
}

function git(root, args, what) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    throw new Error(`cannot ${what}: ${r.error ? r.error.message : r.stderr.trim()}`);
  }
  return r.stdout;
}

// HEAD's hash, at a fixed twelve characters. GitHub resolves an abbreviated
// hash, but only while no other commit shares it, and a published link cannot
// be changed: git's own --short picks the shortest prefix unique today, which
// leaves no margin for the commits after it.
function headCommit(root) {
  return git(root, ["rev-parse", "--short=12", "HEAD"], "read the commit at HEAD").trim();
}

// The files committed at HEAD, with forward slashes. That is what GitHub holds
// at the commit, where the working tree may also hold build outputs and other
// untracked or ignored files, which it would answer with a 404.
function committedFiles(root) {
  const out = git(root, ["ls-tree", "-r", "-z", "--name-only", "HEAD"], "list the files committed at HEAD");
  return new Set(out.split("\0").filter(Boolean));
}

// Puts back the text each file held before setup rewrote it. A file whose text
// is no longer what setup wrote was edited while the command ran, and writing
// the old text back would lose that edit, so it is left as it is and returned
// in `changed`. Each file is restored on its own, so one that cannot be written
// does not keep the others rewritten; it is returned in `failed`, with the
// reason. written holds { file, original, text }.
function restoreFiles(written) {
  const changed = [];
  const failed = [];
  for (const entry of written) {
    try {
      const current = fs.readFileSync(entry.file, "utf8");
      if (current === entry.original) continue;
      if (current !== entry.text) {
        changed.push(entry);
        continue;
      }
      fs.writeFileSync(entry.file, entry.original);
    } catch (err) {
      failed.push({ ...entry, message: err.message });
    }
  }
  return { changed, failed };
}

// Signals that stop a run. Ctrl-C reaches the command through the process
// group, but a cancelled CI job may send SIGTERM to this process alone.
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

// Runs the command between setup and teardown, and resolves with its exit
// status. From before setup until after teardown a signal is caught, so
// teardown always runs: it is passed on to the command, the run waits for the
// command to stop, and it resolves 128 plus the signal's number, as a shell
// reports it, never 0. A second signal kills the command, so one that ignores
// the first cannot keep teardown waiting. Teardown returns false when it could
// not undo setup, and the run then fails even if the command succeeded.
async function runCommand(argv, setup = () => {}, teardown = () => true) {
  let child = null;
  let received = null;
  let status = 1;
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
    status = await exitStatus(child);
    if (received) {
      console.error(`pack-links: stopped by ${received}`);
      status = 128 + os.constants.signals[received];
    }
  } finally {
    try {
      if (!teardown() && status === 0) status = 1;
    } finally {
      for (const s of SIGNALS) process.removeListener(s, onSignal);
    }
  }
  return status;
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
  const baseUrl = blobBaseUrl(pkg, headCommit(ROOT));
  const files = require("../knowledge.js").knowledgeFiles.map((f) => f.path);
  const committed = committedFiles(ROOT);
  const exists = (repoPath) => committed.has(repoPath);

  const errors = [];
  const outputs = [];
  let count = 0;
  for (const file of files) {
    const original = fs.readFileSync(file, "utf8");
    const docPath = path.relative(ROOT, file).split(path.sep).join("/");
    const result = rewriteLinks(original, docPath, baseUrl, exists);
    errors.push(...result.errors);
    outputs.push({ file, docPath, original, text: result.text });
    count += result.rewritten.reduce((n, r) => n + r.count, 0);
  }
  // Nothing is touched unless every file can be rewritten.
  if (errors.length) {
    for (const e of errors) console.error(`pack-links: ${e}`);
    return 1;
  }

  const written = [];
  return runCommand(argv, () => {
    for (const output of outputs) {
      fs.writeFileSync(output.file, output.text);
      written.push(output);
    }
    console.log(`pack-links: ${count} links in ${files.length} knowledge files point at ${baseUrl}`);
  }, () => {
    const { changed, failed } = restoreFiles(written);
    for (const { docPath } of changed) {
      console.warn(`pack-links: ${docPath} was edited while the command ran, so it was left as it is; ` +
        `its links still point at ${baseUrl}`);
    }
    for (const { docPath, message } of failed) {
      console.error(`pack-links: could not restore ${docPath}, whose links still point at ${baseUrl}: ${message}`);
    }
    return failed.length === 0;
  });
}

module.exports = { rewriteLinks, blobBaseUrl, headCommit, committedFiles, restoreFiles, runCommand };

if (require.main === module) {
  main(process.argv.slice(2)).then((status) => {
    process.exitCode = status;
  }, (err) => {
    console.error(`pack-links: ${err.message}`);
    process.exitCode = 1;
  });
}
