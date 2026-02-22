#!/usr/bin/env node
// SDOC Slides — CLI tool
//
// Usage:
//   node tools/build-slides.js input.sdoc [-o output] [--theme path/to/theme] [--pdf]
//
// If -o is omitted, writes to input.html (or input.pdf with --pdf).
// If --theme is omitted, uses the built-in default theme.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { parseSdoc, extractMeta } = require("../src/sdoc");
const { renderSlides } = require("../src/slide-renderer");

function usage() {
  console.error("Usage: build-slides <input.sdoc> [-o output] [--theme path/to/theme] [--pdf]");
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  let inputPath = null;
  let outputPath = null;
  let themePath = null;
  let pdfMode = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-o" && i + 1 < args.length) {
      outputPath = args[++i];
    } else if (args[i] === "--theme" && i + 1 < args.length) {
      themePath = args[++i];
    } else if (args[i] === "--pdf") {
      pdfMode = true;
    } else if (args[i] === "--help" || args[i] === "-h") {
      usage();
    } else if (!inputPath) {
      inputPath = args[i];
    } else {
      console.error(`Unknown argument: ${args[i]}`);
      usage();
    }
  }

  if (!inputPath) {
    usage();
  }

  // Resolve input
  const resolvedInput = path.resolve(inputPath);
  if (!fs.existsSync(resolvedInput)) {
    console.error(`File not found: ${resolvedInput}`);
    process.exit(1);
  }

  // Resolve theme
  if (!themePath) {
    themePath = path.join(__dirname, "..", "themes", "default");
  }
  const resolvedTheme = path.resolve(themePath);

  // Read theme files
  let themeCss = "";
  let themeJs = "";
  const cssPath = path.join(resolvedTheme, "theme.css");
  const jsPath = path.join(resolvedTheme, "theme.js");

  if (fs.existsSync(cssPath)) {
    themeCss = fs.readFileSync(cssPath, "utf-8");
  } else {
    console.error(`Warning: theme.css not found at ${cssPath}`);
  }
  if (fs.existsSync(jsPath)) {
    themeJs = fs.readFileSync(jsPath, "utf-8");
  } else {
    // Fall back to default theme JS (keyboard nav, touch, slide counter)
    const defaultJsPath = path.join(__dirname, "..", "themes", "default", "theme.js");
    if (fs.existsSync(defaultJsPath)) {
      themeJs = fs.readFileSync(defaultJsPath, "utf-8");
    }
  }

  // Parse SDOC
  const text = fs.readFileSync(resolvedInput, "utf-8");
  const parsed = parseSdoc(text);

  if (parsed.errors.length > 0) {
    for (const error of parsed.errors) {
      console.error(`Warning: line ${error.line}: ${error.message}`);
    }
  }

  // Extract meta and render
  const { nodes, meta } = extractMeta(parsed.nodes);
  const html = renderSlides(nodes, { meta, themeCss, themeJs });

  if (pdfMode) {
    const { exportPdf } = require("../src/slide-pdf");

    // Determine PDF output path
    let pdfOutput;
    if (outputPath) {
      pdfOutput = path.resolve(outputPath);
    } else {
      pdfOutput = resolvedInput.replace(/\.sdoc$/i, "") + ".pdf";
    }

    // Write HTML to temp file for Chrome to consume
    const tmpHtml = path.join(os.tmpdir(), "sdoc-slides-" + Date.now() + ".html");
    fs.writeFileSync(tmpHtml, html, "utf-8");

    try {
      await exportPdf(tmpHtml, pdfOutput);
      console.log(`PDF: ${pdfOutput}`);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    } finally {
      try { fs.unlinkSync(tmpHtml); } catch {}
    }
  } else {
    // Resolve HTML output
    if (!outputPath) {
      outputPath = resolvedInput.replace(/\.sdoc$/i, "") + ".html";
    }
    const resolvedOutput = path.resolve(outputPath);

    fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
    fs.writeFileSync(resolvedOutput, html, "utf-8");
    console.log(`Built: ${resolvedOutput}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
