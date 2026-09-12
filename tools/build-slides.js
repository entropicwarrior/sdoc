#!/usr/bin/env node
// SDOC Slides — CLI tool
//
// Usage:
//   node tools/build-slides.js input.sdoc [-o output] [--theme path/to/theme]
//                              [--pdf] [--pptx] [--check] [--fit MODE] [--dark]
//                              [--with-optional | --no-optional]
//
// --fit controls what happens when the window is not the slide's shape:
// contain (default) letterboxes, cover crops, stretch distorts.
//
// Slides marked `optional: true` are kept by default in the HTML build, which
// is the one you present from, and left out of --pdf and --pptx, which are the
// formats a deck usually gets sent on in. Either default can be overridden in
// any format: --with-optional keeps them, --no-optional drops them. An HTML
// deck is also something you send someone, so the choice belongs to the
// invocation rather than to the format.
//
// If -o is omitted, writes to input.html (or input.pdf / input.pptx).
// --pptx produces a PowerPoint file that Drive imports as a Google Slides deck.
// If --theme is omitted, uses the built-in default theme.

const fs = require("fs");
const path = require("path");
const { parseSdoc, extractMeta } = require("../src/sdoc");
const { renderSlides } = require("../src/slide-renderer");
const { loadTheme } = require("../src/theme");

function usage() {
  console.error(
    "Usage: build-slides <input.sdoc> [-o output] [--theme path/to/theme]\n" +
    "                    [--pdf] [--pptx] [--check] [--fit contain|cover|stretch] [--dark]\n" +
    "                    [--with-optional | --no-optional]"
  );
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  let inputPath = null;
  let outputPath = null;
  let themePath = null;
  let pdfMode = false;
  let pptxMode = false;
  let checkMode = false;
  let darkMode = false;
  // null means "whatever this output format defaults to"; the flags force it.
  let optional = null;
  let fit = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-o" && i + 1 < args.length) {
      outputPath = args[++i];
    } else if (args[i] === "--theme" && i + 1 < args.length) {
      themePath = args[++i];
    } else if (args[i] === "--pdf") {
      pdfMode = true;
    } else if (args[i] === "--pptx" || args[i] === "--slides") {
      pptxMode = true;
    } else if (args[i] === "--check") {
      checkMode = true;
    } else if (args[i] === "--fit" && i + 1 < args.length) {
      fit = args[++i].toLowerCase();
      if (!["contain", "cover", "stretch"].includes(fit)) {
        console.error(`--fit must be contain, cover or stretch (got ${fit})`);
        process.exit(1);
      }
    } else if (args[i] === "--dark") {
      darkMode = true;
    } else if (args[i] === "--with-optional") {
      optional = true;
    } else if (args[i] === "--no-optional") {
      optional = false;
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

  // Read the theme, inlining any fonts or images its CSS refers to so the
  // built deck is one self-contained file. A theme that ships no theme.js
  // inherits the default runtime: keyboard nav, touch, fit-to-window scaling.
  const defaultThemeDir = path.join(__dirname, "..", "themes", "default");
  const { themeCss, themeJs, themeConfig, warnings } = loadTheme(resolvedTheme, defaultThemeDir);
  for (const warning of warnings) {
    console.error(`Warning: ${warning}`);
  }

  // Parse SDOC
  const text = fs.readFileSync(resolvedInput, "utf-8");
  const parsed = parseSdoc(text);

  if (parsed.errors.length > 0) {
    for (const error of parsed.errors) {
      console.error(`Warning: line ${error.line}: ${error.message}`);
    }
  }

  // Extract meta and render. Optional slides are kept in the HTML build and
  // dropped from the exports by default, because that is the common case for
  // each; --with-optional and --no-optional override the default in any
  // format. --check measures whatever was rendered, so it reports on the
  // optional slides exactly when they are in the build.
  const emitHtml = !pdfMode && !pptxMode;
  const includeOptional = optional === null ? emitHtml : optional;

  const { nodes, meta } = extractMeta(parsed.nodes);
  const html = renderSlides(nodes, {
    meta, themeCss, themeJs, darkMode, themeConfig, fit, includeOptional
  });

  // Every emitted slide carries data-spine, so this counts what the render
  // actually produced. A deck whose slides are all optional exports to nothing
  // — a blank PDF page, a PPTX with no slide parts — and neither Chrome nor
  // the PPTX writer treats that as an error, so say it here.
  if (!includeOptional && !/ data-spine="/.test(html)) {
    console.error(
      "Warning: every slide in this deck is optional, so the export has no slides.\n" +
      "         Pass --with-optional to include them."
    );
  }

  // --pdf and --pptx both start from the built HTML, so write it once and
  // hand the same file to each exporter.
  const htmlOutput = outputPath
    ? path.resolve(outputPath)
    : resolvedInput.replace(/\.sdoc$/i, "") + ".html";

  if (emitHtml) {
    fs.mkdirSync(path.dirname(htmlOutput), { recursive: true });
    fs.writeFileSync(htmlOutput, html, "utf-8");
    console.log(`Built: ${htmlOutput}`);
    if (checkMode) await reportOverflow(htmlOutput);
    return;
  }

  // Both exporters read the page through a browser, so the temp copy must sit
  // beside the input for relative asset references (images, diagrams) to
  // resolve the way they do in the built deck.
  const tmpHtml = path.join(
    path.dirname(resolvedInput),
    ".sdoc-slides-" + Date.now() + ".html"
  );
  fs.writeFileSync(tmpHtml, html, "utf-8");

  try {
    if (pdfMode) {
      const { exportSlidePdf } = require("../src/slide-pdf");
      const pdfOutput = outputPath
        ? path.resolve(outputPath)
        : resolvedInput.replace(/\.sdoc$/i, "") + ".pdf";
      // The page must match the theme's design box, or Chrome clips the slide.
      await exportSlidePdf(tmpHtml, pdfOutput, themeConfig.page);
      console.log(`PDF: ${pdfOutput}`);
    }

    if (pptxMode) {
      const { exportSlidePptx } = require("../src/slide-pptx");
      const pptxOutput = outputPath && !pdfMode
        ? path.resolve(outputPath)
        : resolvedInput.replace(/\.sdoc$/i, "") + ".pptx";
      const result = await exportSlidePptx(tmpHtml, pptxOutput, {
        title: meta.properties?.title || undefined,
        fonts: themeConfig.fonts,
      });
      console.log(`PPTX: ${result.path} (${result.slides} slides)`);
      // The geometry is already in hand, so the layout check is free here.
      printOverflow(require("../src/slide-geometry").overflowReport(result.geometry));
      for (const src of result.skippedImages) {
        console.error(`Warning: image could not be embedded in the PPTX: ${src}`);
      }
      console.log(
        "Import into Google Slides: upload to Drive, then File > Open with > Google Slides,\n" +
        "or drag the file into slides.google.com — Drive converts it to a native deck."
      );
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  } finally {
    try { fs.unlinkSync(tmpHtml); } catch {}
  }
}

// Reports slides whose content has run out of the space the theme reserved.
// Nothing is clipped until it leaves the design box, but content in the
// margin collides with the footer, so both are worth saying out loud.
function printOverflow(findings) {
  if (!findings.length) {
    console.log("Layout check: no slide overflows its margins.");
    return;
  }
  console.error(`Layout check: ${findings.length} slide(s) overflow:`);
  for (const finding of findings) {
    const name = finding.id ? `${finding.slide} (${finding.id})` : finding.slide;
    console.error(`  slide ${name} [${finding.layout || "default"}] — ${finding.over.join(", ")}`);
  }
}

async function reportOverflow(htmlPath) {
  const { harvestGeometry, overflowReport } = require("../src/slide-geometry");
  try {
    printOverflow(overflowReport(await harvestGeometry(htmlPath)));
  } catch (err) {
    console.error(`Layout check skipped: ${err.message}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
