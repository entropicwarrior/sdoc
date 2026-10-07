// The Claude Slides export, feature by feature.
// Run with: node test/test-artifact-conformance.js [--update]
//
// Nothing checks a deck once it is published. The Slides page drops what it
// does not understand and heals what it can, in silence, so a file outside the
// subset does not fail — it arrives wrong and the author finds out by looking.
// test-slide-artifact.js checks the machinery. This file checks the *output*,
// and does two things that one does not:
//
//   1. It knows the feature list. The layouts and config keys are read out of
//      src/slide-layouts.js, so a feature added without a deck exercising it
//      fails here rather than shipping untested. A gap has to be written down
//      in KNOWN_GAPS with a reason, not left to be noticed.
//
//   2. It checks the exported HTML with no browser. Harvesting needs Chrome,
//      so the export is checked in under test/artifact-golden/ and everything
//      below reads from there. Chrome is needed only to prove the goldens
//      still match what the exporter produces — which means the interesting
//      half of this suite runs anywhere, including a CI that has no browser.
//
// Regenerate the goldens with --update after an intentional change, and read
// the diff before committing it: a golden updated without being read is a
// regression with a tick beside it.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseSdoc, extractMeta } = require("../src/sdoc.js");
const { renderSlides, inlineDeckImages } = require("../src/slide-renderer.js");
const { loadTheme } = require("../src/theme.js");
const { findChrome } = require("../src/slide-pdf.js");
const { harvestArtifact, buildArtifact } = require("../src/slide-artifact.js");
const {
  validateSlideHtml,
  parseSubsetHtml,
  parseStyle,
  MAX_ELEMENTS,
  MAX_DIV_DEPTH,
} = require("../src/slide-artifact-validate.js");
const { CONFIG_KEYS, STRUCTURED_LAYOUTS } = require("../src/slide-layouts.js");

let pass = 0, fail = 0;
const asyncTests = [];
function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      asyncTests.push(result.then(
        () => { pass++; console.log("  PASS: " + name); },
        (e) => { fail++; console.log("  FAIL: " + name + " — " + e.message); }
      ));
    } else {
      pass++; console.log("  PASS: " + name);
    }
  } catch (e) {
    fail++; console.log("  FAIL: " + name + " — " + e.message);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

const UPDATE = process.argv.includes("--update");
const ROOT = path.join(__dirname, "..");
const GOLDEN = path.join(__dirname, "artifact-golden");
const NOW = "2026-01-01T00:00:00Z";

// The corpus is the two reference decks rather than a fixture of this suite's
// own. They are maintained, they are what a reader is pointed at, and tying the
// coverage check to them means neither can quietly stop covering the format.
const CORPUS = [
  { deck: "examples/layouts-example.sdoc", title: "SDOC Slide Layouts", prefix: "layouts" },
  { deck: "examples/background-example.sdoc", title: "Slide Backgrounds", prefix: "background" },
  // Carries the drawings, which have their own rules in this format.
  { deck: "examples/svg-example.sdoc", title: "SVG", prefix: "svg" },
];

// A feature the corpus does not exercise has to be written down here, with the
// reason, or the coverage test fails. The point is that a gap is a decision
// somebody made, not something nobody noticed.
const KNOWN_GAPS = {
  layout: "accepted as a spelling of `config:`; every example deck uses `config:`, " +
    "so the alias is parsed but never exported. Worth a slide if it is to stay supported.",
};

// ---------------------------------------------------------------------------
// Layer A — the feature list, read from source
// ---------------------------------------------------------------------------
console.log("--- Coverage: every exportable feature has a deck that uses it ---");

const corpusText = CORPUS.map((c) => fs.readFileSync(path.join(ROOT, c.deck), "utf-8")).join("\n");

function keysUsed(text) {
  const used = new Set();
  for (const m of text.matchAll(/^[ \t]*([a-z][a-z0-9-]*):/gim)) used.add(m[1].toLowerCase());
  return used;
}
function layoutsUsed(text) {
  const used = new Set();
  for (const m of text.matchAll(/^[ \t]*(?:config|layout):[ \t]*(.+)$/gim)) {
    for (const word of m[1].trim().split(/\s+/)) used.add(word.toLowerCase());
  }
  return used;
}

test("every structured layout is exercised by a deck in the corpus", () => {
  const used = layoutsUsed(corpusText);
  const missing = [...STRUCTURED_LAYOUTS].filter((l) => !used.has(l) && !KNOWN_GAPS[l]);
  assert(missing.length === 0,
    `no corpus deck uses: ${missing.join(", ")}. Add a slide, or record it in KNOWN_GAPS with a reason.`);
});

test("every slide config key is exercised by a deck in the corpus", () => {
  const used = keysUsed(corpusText);
  const missing = [...CONFIG_KEYS].filter((k) => !used.has(k) && !KNOWN_GAPS[k]);
  assert(missing.length === 0,
    `no corpus deck sets: ${missing.join(", ")}. Add it to a slide, or record it in KNOWN_GAPS with a reason.`);
});

test("every recorded gap is still a gap", () => {
  // A gap that got covered should lose its entry, so the list stays a list of
  // real holes rather than a graveyard nobody rereads.
  const used = new Set([...keysUsed(corpusText), ...layoutsUsed(corpusText)]);
  const stale = Object.keys(KNOWN_GAPS).filter((k) => used.has(k));
  assert(stale.length === 0, `covered now, so remove from KNOWN_GAPS: ${stale.join(", ")}`);
});

// ---------------------------------------------------------------------------
// Layer B/C — the checked-in export, validated without a browser
// ---------------------------------------------------------------------------
console.log("\n--- The exported deck, checked without a browser ---");

function goldenFiles() {
  if (!fs.existsSync(GOLDEN)) return [];
  return fs.readdirSync(GOLDEN).filter((f) => f.endsWith(".html")).sort();
}

const goldens = goldenFiles();

test("a golden export is checked in for the corpus", () => {
  assert(goldens.length > 0,
    "no goldens under test/artifact-golden/. Generate them with: node test/test-artifact-conformance.js --update");
  for (const c of CORPUS) {
    assert(goldens.some((g) => g.startsWith(c.prefix + "--")),
      `no golden slides for ${c.deck}; regenerate with --update`);
  }
});

test("every exported slide is inside the Slides subset", () => {
  // The export's own assets are still placeholders at this stage, as they are
  // between an export and its publish.
  const bad = [];
  for (const file of goldens) {
    const html = fs.readFileSync(path.join(GOLDEN, file), "utf-8");
    const r = validateSlideHtml(html, { slide: file, assetPlaceholders: true });
    if (r.errors.length) bad.push(`${file}: ${r.errors[0].message}`);
  }
  assert(bad.length === 0, `${bad.length} slide(s) outside the subset:\n  ` + bad.slice(0, 5).join("\n  "));
});

// ---------------------------------------------------------------------------
// Layer D — what the validator cannot see
//
// Everything below is legal subset HTML that is nonetheless wrong. These are
// the failure shapes found by publishing a real deck, written as invariants so
// they cannot come back quietly.
// ---------------------------------------------------------------------------
console.log("\n--- Fidelity: shapes that validate but still arrive wrong ---");

function eachElement(html, visit) {
  const { root } = parseSubsetHtml(html);
  const walk = (el, depth) => {
    if (el.tag && el.tag !== "#text") visit(el, depth);
    for (const kid of el.children || []) walk(kid, el.tag === "div" ? depth + 1 : depth);
  };
  for (const kid of root.children || []) walk(kid, 0);
}

function declarations(el) {
  const style = el.attrs && el.attrs.style;
  return style ? parseStyle(style) : [];
}

test("a flex or grid container keeps its children as elements", () => {
  // Found by publishing: a leaf test of "every child is an inline tag" treats a
  // flex row of <span>s as one text run, and the groups concatenate with no
  // spacing — a footer reading "CONFIDENTIAL — Acme Inc.Acme Inc.1 / 21". The
  // children have their own rects and must be recursed into.
  const offenders = [];
  for (const file of goldens) {
    const html = fs.readFileSync(path.join(GOLDEN, file), "utf-8");
    eachElement(html, (el) => {
      const display = declarations(el).find((d) => d.prop === "display");
      if (!display || !/^(flex|grid)$/.test(display.value)) return;
      const kids = (el.children || []).filter((k) => k.tag && k.tag !== "#text");
      // A text node carries its content on `value`, not `text`.
      const text = (el.children || []).filter(
        (k) => k.tag === "#text" && typeof k.value === "string" && k.value.trim()
      );
      if (kids.length === 0 && text.length > 0) {
        offenders.push(`${file}: <${el.tag}> is display:${display.value} but was flattened to text`);
      }
    });
  }
  assert(offenders.length === 0, offenders.slice(0, 4).join("\n  "));
});

test("every heading carries its own font-size and font-weight", () => {
  // The format is explicit that font-size and font-weight "flow into <p> and
  // <li>, but never into <h1> through <h3>" — and the subset's headings default
  // to 600. Emitting a value only when it differs from the inherited one, the
  // usual harmless economy, therefore sent every 400-weight heading out with no
  // weight at all, and it arrived bold. Deck-wide, invisible to a validator
  // because the output is perfectly admissible, and it reads as "the type looks
  // a bit off" rather than as a bug.
  const bare = [];
  for (const file of goldens) {
    const html = fs.readFileSync(path.join(GOLDEN, file), "utf-8");
    for (const m of html.matchAll(/<(h[123])\b([^>]*)>/g)) {
      const attrs = m[2];
      if (!/font-weight\s*:/.test(attrs)) bare.push(`${file}: <${m[1]}> has no font-weight`);
      else if (!/font-size\s*:/.test(attrs)) bare.push(`${file}: <${m[1]}> has no font-size`);
    }
  }
  assert(bare.length === 0, `${bare.length} heading(s) left to the subset's defaults:\n  ` + bare.slice(0, 4).join("\n  "));
});

test("a cut-out picture is not given a rectangular shadow", () => {
  // box-shadow follows the element's rectangle; a drop-shadow filter follows
  // the alpha channel. Translating one to the other draws a hard box around a
  // picture that hasn't got one. Nothing here should emit a box-shadow on an
  // <img> at all.
  const boxed = [];
  for (const file of goldens) {
    const html = fs.readFileSync(path.join(GOLDEN, file), "utf-8");
    for (const m of html.matchAll(/<img\b([^>]*)>/g)) {
      if (/box-shadow\s*:/.test(m[1])) boxed.push(`${file}: ${m[0].slice(0, 70)}`);
    }
  }
  assert(boxed.length === 0, boxed.join("\n  "));
});

test("a highlighted table row keeps its wash", () => {
  // The format allows a background on a <tr> and on nothing inside it: "A <tr>
  // may carry background:COLOR; no background on cells". A theme that paints
  // the highlight on `tr.is-highlight td` therefore renders correctly in the
  // deck and silently loses the paint on export — it is not a dropped
  // declaration anyone is told about, it is a colour that is simply absent.
  // This is positional tests' blind spot: nothing moves, it just goes grey.
  const matrix = goldens.filter((f) => /matrix/.test(f));
  assert(matrix.length > 0, "the corpus still has a matrix slide");
  for (const file of matrix) {
    const html = fs.readFileSync(path.join(GOLDEN, file), "utf-8");
    const rows = html.match(/<tr[^>]*>/g) || [];
    const washed = rows.filter((r) => /background/.test(r));
    assert(washed.length === 1,
      `${file}: expected exactly one row to carry the highlight wash, found ${washed.length}. ` +
        "A wash painted on the cells instead of the row is dropped on the way out.");
    // Not "no cell has a background" — emitTable never writes one, so that
    // asserts nothing. What can go wrong is a cell carrying type the format
    // gives only to the table, which validates against a wrong transcription
    // and is dropped by the page.
    for (const cell of html.match(/<t[dh][^>]*>/g) || []) {
      assert(!/font-family|font-size/.test(cell),
        `${file}: a cell carries a face or a size, which belong to the <table>: ${cell}`);
      assert(!/<td[^>]*font-weight/.test(cell),
        `${file}: a <td> carries a weight, which the format allows only on <th>: ${cell}`);
    }
  }
});

test("every drawing carries a size in pixels", () => {
  // The format is explicit that an <svg>'s width and height are its viewBox's,
  // and it is shown as an image. So whatever size it was authored with —
  // "100%", "84%", or nothing — means nothing here: a percentage resolves
  // against a parent in a page, and on the other side there is neither a
  // parent nor a stylesheet. Seven of one deck's eight drawings had no usable
  // size and every one arrived collapsed, which reads as "the drawings are
  // broken" rather than as a missing attribute.
  //
  // A drawing leaves by one of two doors: unlabelled it stays markup, and
  // labelled it is painted and leaves as a picture. Both are checked, and the
  // corpus is required to still hold one of each — when every example drawing
  // became a picture this test went on passing over nothing at all.
  const bad = [];
  let markup = 0;
  let painted = 0;
  for (const file of goldens) {
    const html = fs.readFileSync(path.join(GOLDEN, file), "utf-8");
    for (const m of html.matchAll(/<svg\b([^>]*)>/g)) {
      markup++;
      const w = /\swidth="([^"]*)"/.exec(m[1]);
      const h = /\sheight="([^"]*)"/.exec(m[1]);
      if (!w || !h) { bad.push(`${file}: a drawing has no ${w ? "height" : "width"}`); continue; }
      if (!/^[0-9.]+$/.test(w[1]) || !/^[0-9.]+$/.test(h[1])) {
        bad.push(`${file}: a drawing is sized "${w[1]}" x "${h[1]}", which needs a stylesheet to mean anything`);
      }
    }
    // A painted drawing is an <img> whose alt came from the drawing's
    // aria-label. It needs its size in the style, for the same reason.
    for (const m of html.matchAll(/<img\b([^>]*)>/g)) {
      if (!/alt="diagram"/.test(m[1])) continue;
      painted++;
      const style = /\sstyle="([^"]*)"/.exec(m[1]);
      const w = style && /(?:^|;)width:([0-9.]+)px/.exec(style[1]);
      const h = style && /(?:^|;)height:([0-9.]+)px/.exec(style[1]);
      if (!w || !h) bad.push(`${file}: a painted drawing has no ${w ? "height" : "width"} in pixels`);
    }
  }
  assert(bad.length === 0, bad.slice(0, 4).join("\n  "));
  assert(markup > 0, "no example leaves a drawing as markup any more, so the vector path is unchecked");
  assert(painted > 0, "no example has a painted drawing, so the picture path is unchecked");
});

test("every declaration value has balanced parentheses", () => {
  // Found by publishing: a regex with [^)]* scanning `drop-shadow(rgba(0,0,0,.5) 0 1px 3px)`
  // stops at the inner paren and emits an unbalanced value. The slide then
  // renders as a blank page — not a dropped property, a blank page.
  const offenders = [];
  for (const file of goldens) {
    const html = fs.readFileSync(path.join(GOLDEN, file), "utf-8");
    eachElement(html, (el) => {
      for (const d of declarations(el)) {
        let depth = 0;
        for (const ch of d.value) {
          if (ch === "(") depth++;
          else if (ch === ")") depth--;
          if (depth < 0) break;
        }
        if (depth !== 0) offenders.push(`${file}: ${d.prop}: ${d.value}`);
      }
    });
  }
  assert(offenders.length === 0, "unbalanced value(s):\n  " + offenders.slice(0, 4).join("\n  "));
});

// The subset's own grammar, from the type's format.md:
//   text-shadow: LEN LEN [LEN] COLOR, …   blur <= 64
//   box-shadow:  [inset] LEN LEN [LEN [LEN]] COLOR, …   blur <= 160
// The validator accepts any value for these without re-checking ranges, so
// this is the only thing standing between a malformed shadow and a publish.
const SHADOW_BLUR_MAX = { "text-shadow": 64, "box-shadow": 160 };
const COLOUR_FIRST = /^\s*(?:rgba?|hsla?|color)\(|^\s*#[0-9a-f]{3,8}\b/i;

function shadowLayers(value) {
  const layers = [];
  let depth = 0, current = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { layers.push(current); current = ""; continue; }
    current += ch;
  }
  if (current.trim()) layers.push(current);
  return layers;
}

test("a shadow puts its colour last, as the subset's grammar requires", () => {
  // Found by publishing: Chrome serialises `rgba(0,0,0,.55) 0px 1px 3px`,
  // colour first. The subset wants it last. Passing a computed value straight
  // through is out of subset even when it was captured correctly.
  const offenders = [];
  let seen = 0;
  for (const file of goldens) {
    const html = fs.readFileSync(path.join(GOLDEN, file), "utf-8");
    eachElement(html, (el) => {
      for (const d of declarations(el)) {
        if (!(d.prop in SHADOW_BLUR_MAX)) continue;
        if (/^\s*none\s*$/i.test(d.value)) continue;
        for (const layer of shadowLayers(d.value)) {
          seen++;
          if (COLOUR_FIRST.test(layer)) offenders.push(`${file}: ${d.prop}: ${layer.trim()}`);
        }
      }
    });
  }
  assert(offenders.length === 0, "colour-first shadow(s):\n  " + offenders.slice(0, 4).join("\n  "));
  // This ran over nothing for as long as box-shadow went unharvested: zero
  // shadows in the corpus, and a guard with nothing to guard passes forever.
  assert(seen > 0, "no exported shadow anywhere in the corpus, so neither this nor the blur limit is checking anything");
});

test("a shadow's blur is within the limit for the property it lands on", () => {
  // The limits are asymmetric — 64 for text, 160 for box — so a blur that is
  // fine as one is out of range as the other, and a translation between them
  // has to clamp per destination.
  const offenders = [];
  for (const file of goldens) {
    const html = fs.readFileSync(path.join(GOLDEN, file), "utf-8");
    eachElement(html, (el) => {
      for (const d of declarations(el)) {
        const max = SHADOW_BLUR_MAX[d.prop];
        if (max === undefined || /^\s*none\s*$/i.test(d.value)) continue;
        for (const layer of shadowLayers(d.value)) {
          const lengths = (layer.match(/-?[0-9.]+px/g) || []).map(parseFloat);
          const blur = lengths[2];
          if (blur !== undefined && blur > max) {
            offenders.push(`${file}: ${d.prop} blur ${blur}px over the ${max}px limit`);
          }
        }
      }
    });
  }
  assert(offenders.length === 0, offenders.slice(0, 4).join("\n  "));
});

test("no exported value needs the page to resolve a variable", () => {
  const offenders = [];
  for (const file of goldens) {
    const html = fs.readFileSync(path.join(GOLDEN, file), "utf-8");
    eachElement(html, (el) => {
      for (const d of declarations(el)) {
        if (/var\(/.test(d.value)) offenders.push(`${file}: ${d.prop}: ${d.value}`);
      }
    });
  }
  assert(offenders.length === 0, "a var() has no cascade to resolve against:\n  " + offenders.slice(0, 4).join("\n  "));
});

test("no image is still a data: URI", () => {
  // They have to be uploaded and referenced by blob id; a data: URI is refused
  // by the page, and an export that emits one cannot be published at all.
  const offenders = [];
  for (const file of goldens) {
    const html = fs.readFileSync(path.join(GOLDEN, file), "utf-8");
    for (const m of html.matchAll(/<img[^>]+src="([^"]*)"/g)) {
      if (/^data:/i.test(m[1])) offenders.push(`${file}: ${m[1].slice(0, 40)}…`);
    }
  }
  assert(offenders.length === 0, offenders.slice(0, 4).join("\n  "));
});

test("no slide exceeds the element or nesting limits", () => {
  const offenders = [];
  for (const file of goldens) {
    const html = fs.readFileSync(path.join(GOLDEN, file), "utf-8");
    let count = 0, deepest = 0;
    eachElement(html, (el, depth) => { count++; deepest = Math.max(deepest, depth); });
    if (count > MAX_ELEMENTS) offenders.push(`${file}: ${count} elements over the ${MAX_ELEMENTS} limit`);
    if (deepest > MAX_DIV_DEPTH) offenders.push(`${file}: div depth ${deepest} over the ${MAX_DIV_DEPTH} limit`);
  }
  assert(offenders.length === 0, offenders.join("\n  "));
});

// ---------------------------------------------------------------------------
// Layer E — the goldens still match what the exporter produces
// ---------------------------------------------------------------------------
console.log("\n--- The goldens still match a live export ---");

async function exportCorpus() {
  const out = new Map();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-conformance-"));
  const theme = loadTheme(path.join(ROOT, "themes", "default"));
  for (const entry of CORPUS) {
    const deckPath = path.join(ROOT, entry.deck);
    const parsed = parseSdoc(fs.readFileSync(deckPath, "utf-8"));
    if (parsed.errors.length) throw new Error(`${entry.deck} does not parse clean`);
    const { nodes, meta } = extractMeta(parsed.nodes);
    let html = renderSlides(nodes, {
      meta,
      themeCss: theme.themeCss,
      themeJs: theme.themeJs,
      themeConfig: theme.themeConfig,
    });
    // Images resolve against the .sdoc, and the harvest needs them embedded.
    html = inlineDeckImages(html, path.dirname(deckPath)).html;
    const htmlPath = path.join(tmpDir, entry.prefix + ".html");
    fs.writeFileSync(htmlPath, html, "utf-8");
    const harvest = await harvestArtifact(htmlPath);
    const built = buildArtifact(harvest, { title: entry.title, theme: theme.themeConfig, now: NOW });
    if (built.errors.length) {
      throw new Error(`${entry.deck} exported with errors: ${JSON.stringify(built.errors[0])}`);
    }
    for (const [file, body] of Object.entries(built.files)) {
      const m = /^project\/slides\/(.+)\.html$/.exec(file);
      if (m) out.set(`${entry.prefix}--${m[1]}.html`, body);
    }
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return out;
}

if (UPDATE) {
  if (!findChrome()) {
    console.log("  Cannot regenerate without Chrome.");
    process.exit(1);
  }
  asyncTests.push(exportCorpus().then((files) => {
    fs.mkdirSync(GOLDEN, { recursive: true });
    for (const stale of goldenFiles()) {
      if (!files.has(stale)) fs.unlinkSync(path.join(GOLDEN, stale));
    }
    for (const [name, body] of files) {
      fs.writeFileSync(path.join(GOLDEN, name), body, "utf-8");
    }
    console.log(`  Wrote ${files.size} golden slide(s) to test/artifact-golden/.`);
    console.log("  Read the diff before committing it.");
  }));
} else if (!findChrome()) {
  console.log("  SKIP: Chrome not found — the export harvests a live page");
} else {
  test("a live export still matches the checked-in goldens", async () => {
    const files = await exportCorpus();
    const drifted = [];
    for (const [name, body] of files) {
      const goldenPath = path.join(GOLDEN, name);
      if (!fs.existsSync(goldenPath)) { drifted.push(`${name} is new`); continue; }
      if (fs.readFileSync(goldenPath, "utf-8") !== body) drifted.push(`${name} changed`);
    }
    for (const name of goldenFiles()) {
      if (!files.has(name)) drifted.push(`${name} is no longer exported`);
    }
    assert(drifted.length === 0,
      `${drifted.length} slide(s) drifted from the goldens:\n  ` + drifted.slice(0, 6).join("\n  ") +
      "\n  If the change was intended: node test/test-artifact-conformance.js --update");
  });
}

// ============================================================
Promise.all(asyncTests).then(() => {
  console.log("\n" + "=".repeat(40));
  console.log(`Results: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
});
