#!/usr/bin/env node
// SDOC Document — CLI tool for HTML and PDF export
//
// Usage:
//   node tools/build-doc.js input.sdoc [-o output] [--html] [--include-signposts]
//                           [--include-about] [--signposts LIST] [--check] [--fix]
//
// Default output is PDF (requires Chrome/Chromium).
// Use --html for HTML-only output (no Chrome needed).
// If -o is omitted, writes to input.pdf (or input.html with --html).
// Signposts other than @reading-guide are hidden by default.
// --include-signposts keeps them all; --include-about keeps @about as well;
// --signposts picks single sections on top of either: a comma-separated list of
// ids, each kept, or dropped when prefixed with "-" (--signposts related-resources,-reading-guide).
// --check validates the document (parse errors, signposts, references,
// citations), prints each finding as file:line: message (file:line: warning:
// message for a warning), and exits 1 when it found an error.
// --fix rewrites the .sdoc in place, putting @meta and the signposts in their
// conventional order (fixSignpostOrder); when it cannot, it says why and exits 1.
// With --check or --fix, nothing is exported unless -o or --html is given too.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { parseSdoc, extractMeta, resolveIncludes, renderHtmlDocumentFromParsed, validateRefs, validateCitations, validateSignposts, fixSignpostOrder, SIGNPOST_IDS } = require("../src/sdoc");
const { hrefPathExists } = require("../src/href-path");

const CONFIG_FILENAME = "sdoc.config.json";

// The validateSignposts findings that change what an export contains.
const EXPORT_WARNING_TYPES = new Set(["reserved-scope-placement", "signpost-root"]);

function usage() {
  console.error("Usage: build-doc <input.sdoc> [-o output] [--html] [--include-signposts] [--include-about] [--signposts LIST] [--check] [--fix]");
  process.exit(1);
}

function readJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function loadCss(filePath) {
  if (!filePath) return null;
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function resolvePath(baseDir, target) {
  if (!target) return "";
  if (path.isAbsolute(target)) return target;
  return path.join(baseDir, target);
}

function mergeConfig(target, config, baseDir) {
  if (!config || typeof config !== "object") return;
  if (typeof config.style === "string") {
    target.style = resolvePath(baseDir, config.style);
  }
  if (config.styleAppend) {
    const list = Array.isArray(config.styleAppend) ? config.styleAppend : [config.styleAppend];
    for (const item of list) {
      if (typeof item === "string") {
        target.styleAppend.push(resolvePath(baseDir, item));
      }
    }
  }
  if (typeof config.header === "string") target.header = config.header;
  if (typeof config.footer === "string") target.footer = config.footer;
}

function loadConfigForFile(filePath) {
  const startDir = path.dirname(path.resolve(filePath));
  const root = path.parse(startDir).root;
  const chain = [];
  let current = startDir;

  while (current) {
    const configPath = path.join(current, CONFIG_FILENAME);
    if (fs.existsSync(configPath)) {
      const parsed = readJson(configPath);
      if (parsed) chain.push({ dir: current, config: parsed });
    }
    if (current === root) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const merged = { style: null, styleAppend: [], header: "", footer: "" };
  for (const entry of chain.reverse()) {
    mergeConfig(merged, entry.config, entry.dir);
  }
  return merged;
}

function resolveMetaStyles(meta, documentPath) {
  const docDir = documentPath ? path.dirname(documentPath) : "";
  const result = { styleCss: null, styleAppendCss: null };
  if (meta && meta.stylePath) {
    result.styleCss = loadCss(resolvePath(docDir, meta.stylePath));
  }
  if (meta && meta.styleAppendPath) {
    result.styleAppendCss = loadCss(resolvePath(docDir, meta.styleAppendPath));
  }
  return result;
}

async function buildHtml(filePath, options = {}) {
  const resolvedPath = path.resolve(filePath);
  const text = fs.readFileSync(resolvedPath, "utf8");
  const parsed = parseSdoc(text);

  // `quiet` is set after --check, which has already printed all of these.
  if (!options.quiet) {
    for (const error of parsed.errors) {
      console.error(`Warning: line ${error.line}: ${error.message}`);
    }

    // A reserved scope below the top level is exported as an ordinary section,
    // content and all; say so instead of dropping it. A document whose only
    // scope is a signpost exports empty; say that too.
    for (const finding of validateSignposts(parsed.nodes)) {
      if (EXPORT_WARNING_TYPES.has(finding.type)) {
        console.error(`Warning: line ${finding.lineStart}: ${finding.message}`);
      }
    }
  }

  const metaResult = extractMeta(parsed.nodes);
  const config = loadConfigForFile(resolvedPath);
  const metaStyles = resolveMetaStyles(metaResult.meta, resolvedPath);

  const docDir = path.dirname(resolvedPath);
  await resolveIncludes(metaResult.nodes, (src) => {
    const resolved = resolvePath(docDir, src);
    return fs.readFileSync(resolved, "utf8");
  });

  const cssOverride = metaStyles.styleCss ?? loadCss(config.style);
  const cssAppendParts = [];
  if (config.styleAppend && config.styleAppend.length) {
    for (const stylePath of config.styleAppend) {
      const css = loadCss(stylePath);
      if (css) cssAppendParts.push(css);
    }
  }
  if (metaStyles.styleAppendCss) {
    cssAppendParts.push(metaStyles.styleAppendCss);
  }

  const title = path.basename(resolvedPath, ".sdoc");

  const html = renderHtmlDocumentFromParsed(
    { nodes: metaResult.nodes, errors: parsed.errors },
    title,
    {
      meta: metaResult.meta,
      config,
      cssOverride: cssOverride || undefined,
      cssAppend: cssAppendParts.join("\n") || undefined,
      includeSignposts: options.includeSignposts,
      includeAbout: options.includeAbout,
      signposts: options.signposts,
    }
  );

  // Inline local images as data URIs so output is self-contained. PDF export
  // renders from a temp directory, where relative image paths (e.g.
  // diagrams/foo.svg) no longer resolve; inlining also makes HTML portable.
  return inlineLocalImages(html, docDir);
}

const IMAGE_MIME = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function inlineLocalImages(html, docDir) {
  return html.replace(/(<img\b[^>]*?\bsrc=")([^"]*)(")/gi, (match, pre, src, post) => {
    // Leave remote URLs and already-inlined data URIs untouched.
    if (/^(https?:|data:|file:)/i.test(src)) return match;
    const decoded = src.replace(/&amp;/g, "&");
    const ext = path.extname(decoded).toLowerCase();
    const mime = IMAGE_MIME[ext];
    if (!mime) return match;
    const abs = path.isAbsolute(decoded) ? decoded : path.join(docDir, decoded);
    let data;
    try {
      data = fs.readFileSync(abs);
    } catch {
      console.error(`Warning: could not inline image (not found): ${decoded}`);
      return match;
    }
    const uri = `data:${mime};base64,${data.toString("base64")}`;
    return `${pre}${uri}${post}`;
  });
}

// Every finding for a file: the signposts checked on the full tree (so a
// misplaced @meta is caught too), references and citations on the body.
function checkDocument(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const parsed = parseSdoc(text);
  const body = extractMeta(parsed.nodes).nodes;
  const docDir = path.dirname(filePath);
  const resolveFilePath = (href) => hrefPathExists(href, docDir);
  return [
    ...parsed.errors.map((e) => ({ type: "parse-error", severity: "error", message: e.message, lineStart: e.line })),
    ...validateSignposts(parsed.nodes),
    ...validateRefs(body, { resolveFilePath }),
    ...validateCitations(body)
  ];
}

// "related-resources,-reading-guide" → { "related-resources": true, "reading-guide": false },
// merged into `into`. An unknown id is a usage error.
function parseSignpostList(list, into) {
  for (const raw of list.split(",")) {
    const item = raw.trim();
    if (!item) continue;
    const drop = item.startsWith("-");
    const id = (drop || item.startsWith("+") ? item.slice(1) : item).toLowerCase();
    if (!SIGNPOST_IDS.includes(id)) {
      console.error(`Unknown signpost: ${id} (expected one of ${SIGNPOST_IDS.join(", ")})`);
      process.exit(1);
    }
    into[id] = !drop;
  }
  return into;
}

async function main() {
  const args = process.argv.slice(2);
  let inputPath = null;
  let outputPath = null;
  let htmlMode = false;
  // Left undefined unless given: an explicit includeSignposts: false would
  // override --include-about.
  let includeSignposts;
  let includeAbout = false;
  const signposts = {};
  let checkMode = false;
  let fixMode = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-o" && i + 1 < args.length) {
      outputPath = args[++i];
    } else if (args[i] === "--html") {
      htmlMode = true;
    } else if (args[i] === "--include-signposts") {
      includeSignposts = true;
    } else if (args[i] === "--include-about") {
      includeAbout = true;
    } else if (args[i] === "--signposts") {
      if (i + 1 >= args.length) usage();
      parseSignpostList(args[++i], signposts);
    } else if (args[i] === "--check") {
      checkMode = true;
    } else if (args[i] === "--fix") {
      fixMode = true;
    } else if (args[i] === "--help" || args[i] === "-h") {
      usage();
    } else if (!inputPath) {
      inputPath = args[i];
    } else {
      console.error(`Unknown argument: ${args[i]}`);
      usage();
    }
  }

  if (!inputPath) usage();

  const resolvedInput = path.resolve(inputPath);
  if (!fs.existsSync(resolvedInput)) {
    console.error(`File not found: ${resolvedInput}`);
    process.exit(1);
  }

  const shown = path.relative(process.cwd(), resolvedInput) || resolvedInput;

  if (fixMode) {
    const fix = fixSignpostOrder(fs.readFileSync(resolvedInput, "utf8"));
    if (fix.changed) {
      fs.writeFileSync(resolvedInput, fix.text, "utf8");
      console.log(`Fixed: reordered the signposts in ${shown}`);
    } else if (fix.reason) {
      console.error(`${shown}: could not reorder the signposts: ${fix.reason}`);
      process.exitCode = 1;
    }
  }

  if (checkMode) {
    const findings = checkDocument(resolvedInput);
    for (const f of findings) {
      const label = f.severity === "warning" ? "warning: " : "";
      console.error(`${shown}:${f.lineStart || 1}: ${label}${f.message}`);
    }
    if (findings.some((f) => f.severity !== "warning")) process.exitCode = 1;
    if (!findings.length) console.log("Check: no findings.");
  }

  if ((checkMode || fixMode) && !outputPath && !htmlMode) return;

  const html = await buildHtml(resolvedInput, { includeSignposts, includeAbout, signposts, quiet: checkMode });

  if (htmlMode) {
    if (!outputPath) {
      outputPath = resolvedInput.replace(/\.sdoc$/i, "") + ".html";
    }
    const resolvedOutput = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
    fs.writeFileSync(resolvedOutput, html, "utf-8");
    console.log(`HTML: ${resolvedOutput}`);
  } else {
    const { exportDocPdf } = require("../src/slide-pdf");

    if (!outputPath) {
      outputPath = resolvedInput.replace(/\.sdoc$/i, "") + ".pdf";
    }
    const resolvedOutput = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });

    // Write HTML to temp file for Chrome
    const tmpHtml = path.join(os.tmpdir(), "sdoc-doc-" + Date.now() + ".html");
    fs.writeFileSync(tmpHtml, html, "utf-8");

    try {
      await exportDocPdf(tmpHtml, resolvedOutput);
      console.log(`PDF: ${resolvedOutput}`);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    } finally {
      try { fs.unlinkSync(tmpHtml); } catch {}
    }
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
