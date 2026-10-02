#!/usr/bin/env node
// SDOC Slides — CLI tool
//
// Usage:
//   node tools/build-slides.js input.sdoc [-o output] [--theme path/to/theme]
//                              [--css path/to/deck.css]
//                              [--pdf] [--pptx] [--artifact] [--check] [--fit MODE] [--dark]
//                              [--with-optional | --no-optional]
//
// A theme is shared by every deck built from it. --css, and the existing
// `style-append:` key in a deck's @meta, add a stylesheet scoped to the one
// deck, emitted after the theme so it settles a tie without raising
// specificity. Both may be given; the command line comes last.
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
const { renderSlides, inlineDeckImages } = require("../src/slide-renderer");
const { loadTheme, inlineCssAssets } = require("../src/theme");

// Deck-scoped CSS. A theme is shared by every deck built from it, so a deck
// that wants one slide to behave differently has nowhere to put that rule
// without changing every other deck. `css:` in @meta names a stylesheet
// beside the deck; --css adds one from the command line. Each is read with
// its own `url(...)` references inlined relative to its own directory, the
// way a theme's are, so the built file stays self-contained.
function loadDeckCss(sources) {
  const parts = [];
  const warnings = [];
  for (const source of sources) {
    if (!fs.existsSync(source.path)) {
      warnings.push(`stylesheet not found, skipped: ${source.path} (from ${source.from})`);
      continue;
    }
    const raw = fs.readFileSync(source.path, "utf-8");
    const { css, missing } = inlineCssAssets(raw, path.dirname(source.path));
    for (const ref of missing) {
      warnings.push(`stylesheet asset not found, left as a plain reference: ${ref} (in ${source.path})`);
    }
    parts.push(`/* ${path.basename(source.path)} */\n${css}`);
  }
  return { deckCss: parts.join("\n"), warnings };
}

function usage() {
  console.error(
    "Usage: build-slides <input.sdoc> [-o output] [--theme path/to/theme]\n" +
    "                    [--css path/to/deck.css]\n" +
    "                    [--pdf] [--pptx] [--artifact] [--artifact-keep-small-text]\n" +
    "                    [--check]\n" +
    "                    [--fit contain|cover|stretch] [--dark]\n" +
    "                    [--with-optional | --no-optional]"
  );
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  let inputPath = null;
  let outputPath = null;
  let themePath = null;
  const cssPaths = [];
  let pdfMode = false;
  let pptxMode = false;
  let artifactMode = false;
  let keepSmallText = false;
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
    } else if (args[i] === "--css" && i + 1 < args.length) {
      cssPaths.push(args[++i]);
    } else if (args[i] === "--pdf") {
      pdfMode = true;
    } else if (args[i] === "--pptx" || args[i] === "--slides") {
      pptxMode = true;
    } else if (args[i] === "--artifact") {
      artifactMode = true;
    } else if (args[i] === "--artifact-keep-small-text") {
      keepSmallText = true;
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
  const emitHtml = !pdfMode && !pptxMode && !artifactMode;
  const includeOptional = optional === null ? emitHtml : optional;

  const { nodes, meta } = extractMeta(parsed.nodes);

  // `style-append:` is the key documents have always used for "a stylesheet
  // after the main one" — src/sdoc.js parses it and the VS Code preview has
  // honoured it for documents all along. Slides simply never read it, so this
  // adopts the existing convention rather than adding a second key that means
  // the same thing. `style:` is deliberately not read here: for a deck,
  // replacing the stylesheet is what --theme does.
  //
  // It resolves against the deck, because that is where the author wrote it
  // and where the file sits; --css resolves against the working directory,
  // because that is where the command was typed. The command line comes
  // second, so an ad-hoc sheet can override the deck's own.
  const cssSources = [];
  if (typeof meta.styleAppendPath === "string" && meta.styleAppendPath.trim()) {
    cssSources.push({
      path: path.resolve(path.dirname(resolvedInput), meta.styleAppendPath.trim()),
      from: "@meta style-append:"
    });
  }
  if (meta.stylePath) {
    console.error(
      "Warning: `style:` replaces a document's stylesheet and is not read for a deck — " +
      "use --theme to change the theme, or `style-append:` to add to it."
    );
  }
  for (const p of cssPaths) {
    cssSources.push({ path: path.resolve(p), from: "--css" });
  }
  const { deckCss, warnings: cssWarnings } = loadDeckCss(cssSources);
  for (const warning of cssWarnings) {
    console.error(`Warning: ${warning}`);
  }

  let html = renderSlides(nodes, {
    meta, themeCss, deckCss, themeJs, darkMode, themeConfig, fit, includeOptional
  });

  // Image paths in a .sdoc are relative to the .sdoc, which stops being true
  // the moment the built file is written somewhere else. Resolve them here,
  // against the input, and every format gets the same answer wherever -o
  // points. Previously only --pdf and --pptx did, and only because their temp
  // page happened to sit beside the input; the HTML build shipped broken
  // images and said nothing.
  const imageBase = path.dirname(resolvedInput);
  const images = inlineDeckImages(html, imageBase);
  html = images.html;
  for (const miss of images.missing) {
    const why = miss.reason === "unsupported-type"
      ? "not an image type this build can embed"
      : "no such file";
    // Name the path that was actually tried. A deck written against a
    // different convention sees a file it believes exists reported as
    // missing, and only the resolved path shows why.
    console.error(`Warning: image ${miss.src} — ${why}: ${miss.resolved}`);
  }
  if (images.missing.length) {
    console.error(
      `Warning: ${images.missing.length} image(s) left as plain references. Image paths\n` +
      `         resolve relative to the .sdoc file (${imageBase}), in every\n` +
      `         output format. A deck that keeps its images beside the built output\n` +
      `         instead will render in HTML opened from there, but export without them.`
    );
  }

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

  // Both exporters read the page through a browser. Images are already
  // embedded by this point, so the temp copy's location no longer decides
  // whether they resolve; it stays beside the input so that anything else a
  // deck reaches for relatively still resolves from where the deck was written.
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
    if (artifactMode) {
      const { harvestArtifact, buildArtifact, writeArtifact, readPreviousManifest } =
        require("../src/slide-artifact");
      const outDir = outputPath && !pdfMode && !pptxMode
        ? path.resolve(outputPath)
        : resolvedInput.replace(/\.sdoc$/i, "") + ".artifact";

      const harvest = await harvestArtifact(tmpHtml);
      const built = buildArtifact(harvest, {
        title: meta.properties?.title || path.basename(resolvedInput, ".sdoc"),
        theme: themeConfig,
        baseDir: path.dirname(resolvedInput),
        sdocVersion: require("../package.json").version,
        source: { path: path.basename(resolvedInput), theme: themePath || "default" },
        previousManifest: readPreviousManifest(outDir),
        minFontSize: !keepSmallText,
      });

      // Nothing checks these files once they are published: the page drops
      // what it cannot read and heals the rest in silence. So an error here
      // stops the export rather than shipping a deck that arrives wrong.
      if (built.errors.length) {
        console.error(`Artifact export: ${built.errors.length} error(s), nothing written.`);
        for (const e of built.errors.slice(0, 40)) {
          console.error(`  ${e.slide || ""}${e.element ? " <" + e.element + ">" : ""}: ${e.message}`);
        }
        if (built.errors.length > 40) console.error(`  … and ${built.errors.length - 40} more`);
        process.exit(1);
      }

      const { missing } = writeArtifact(outDir, built, { baseDir: path.dirname(resolvedInput) });
      console.log(`Artifact: ${outDir} (${built.manifest.slides.length} slides)`);
      if (built.manifest.scale !== 1) {
        console.log(
          `  scaled ${built.manifest.scale}x from the theme's ` +
          `${built.manifest.designBox.w}x${built.manifest.designBox.h} box onto the fixed 1920x1080 canvas`
        );
      }
      for (const w of dedupe(built.warnings).slice(0, 25)) {
        console.error(`  warning: ${w.slide ? w.slide + ": " : ""}${w.message}`);
      }
      const extra = dedupe(built.warnings).length - 25;
      if (extra > 0) console.error(`  … and ${extra} more warnings`);
      for (const m of missing) {
        console.error(`  warning: asset ${m.name} could not be copied (${m.reason})`);
      }
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  } finally {
    try { fs.unlinkSync(tmpHtml); } catch {}
  }
}

// The same complaint about forty elements is one complaint.
function dedupe(warnings) {
  const seen = new Map();
  for (const w of warnings) {
    const key = `${w.slide}|${w.message}`;
    if (!seen.has(key)) seen.set(key, { ...w, count: 1 });
    else seen.get(key).count++;
  }
  return [...seen.values()].map((w) =>
    w.count > 1 ? { ...w, message: `${w.message} (x${w.count})` } : w
  );
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
