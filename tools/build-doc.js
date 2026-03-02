#!/usr/bin/env node
// SDOC Document — CLI tool for HTML and PDF export
//
// Usage:
//   node tools/build-doc.js input.sdoc [-o output] [--html]
//
// Default output is PDF (requires Chrome/Chromium).
// Use --html for HTML-only output (no Chrome needed).
// If -o is omitted, writes to input.pdf (or input.html with --html).

const fs = require("fs");
const path = require("path");
const os = require("os");
const { parseSdoc, extractMeta, resolveIncludes, renderHtmlDocumentFromParsed } = require("../src/sdoc");

const CONFIG_FILENAME = "sdoc.config.json";

function usage() {
  console.error("Usage: build-doc <input.sdoc> [-o output] [--html]");
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

async function buildHtml(filePath) {
  const resolvedPath = path.resolve(filePath);
  const text = fs.readFileSync(resolvedPath, "utf8");
  const parsed = parseSdoc(text);

  if (parsed.errors.length > 0) {
    for (const error of parsed.errors) {
      console.error(`Warning: line ${error.line}: ${error.message}`);
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

  return renderHtmlDocumentFromParsed(
    { nodes: metaResult.nodes, errors: parsed.errors },
    title,
    {
      meta: metaResult.meta,
      config,
      cssOverride: cssOverride || undefined,
      cssAppend: cssAppendParts.join("\n") || undefined,
    }
  );
}

async function main() {
  const args = process.argv.slice(2);
  let inputPath = null;
  let outputPath = null;
  let htmlMode = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-o" && i + 1 < args.length) {
      outputPath = args[++i];
    } else if (args[i] === "--html") {
      htmlMode = true;
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

  const html = await buildHtml(resolvedInput);

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
