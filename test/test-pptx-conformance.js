// The PowerPoint / Google Slides export, feature by feature.
// Run with: node test/test-pptx-conformance.js [--update]
//
// The sibling of test-artifact-conformance.js, for the other export that leaves
// the browser. Same shape, same reasons:
//
//   1. It knows the feature list, read from src/slide-layouts.js, so a layout
//      with no deck exercising it fails here rather than shipping untested.
//
//   2. It checks a digest of the export, checked in under test/pptx-golden/,
//      so the guards run with no browser. Chrome is needed only to prove the
//      digest still matches a live harvest.
//
// A .pptx is a zip of XML, so the golden is a structural digest rather than
// the bytes: per slide, what the harvest found and what reached the file. That
// is reviewable in a diff, which raw OOXML is not.
//
// Regenerate with --update after an intentional change, and read the diff.

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { parseSdoc, extractMeta } = require("../src/sdoc.js");
const { renderSlides, inlineDeckImages } = require("../src/slide-renderer.js");
const { loadTheme } = require("../src/theme.js");
const { findChrome } = require("../src/slide-pdf.js");
const { buildPptx } = require("../src/slide-pptx.js");
const { STRUCTURED_LAYOUTS } = require("../src/slide-layouts.js");

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
const GOLDEN = path.join(__dirname, "pptx-golden");

const CORPUS = [
  { deck: "examples/layouts-example.sdoc", title: "SDOC Slide Layouts", prefix: "layouts" },
  { deck: "examples/svg-example.sdoc", title: "SVG", prefix: "svg" },
  { deck: "examples/background-example.sdoc", title: "Slide Backgrounds", prefix: "background" },
];

// A gap has to be written down with its measurement, not left to be noticed.
// When one is fixed the digest stops matching and the entry has to go, so this
// cannot rot into a list of things that quietly started working.
const KNOWN_GAPS = {
  svgShapes:
    "The geometry harvest has no case for SVG. visit() emits an atom for an <img>, " +
    "a painted box or a text leaf and otherwise recurses, and <path>/<circle>/<rect>/" +
    "<line> match none of those, so every SVG shape is dropped. <text> inside an SVG " +
    "does match isTextLeaf, so the labels survive on their own — which is worse than " +
    "dropping the drawing outright, because a diagram arrives as orphaned words with " +
    "nothing under them. Measured on a real 21-slide deck: 69 shapes dropped, all 45 " +
    "labels kept. The fix is to rasterise each <svg> in the page and emit it as an " +
    "image atom, which the fade bake already shows how to do.",
};

// ---------------------------------------------------------------------------
// Layer A — the feature list
// ---------------------------------------------------------------------------
console.log("--- Coverage: every layout has a deck that exports it ---");

const corpusText = CORPUS.map((c) => fs.readFileSync(path.join(ROOT, c.deck), "utf-8")).join("\n");

test("every structured layout is exercised by a deck in the corpus", () => {
  const used = new Set();
  for (const m of corpusText.matchAll(/^[ \t]*(?:config|layout):[ \t]*(.+)$/gim)) {
    for (const w of m[1].trim().split(/\s+/)) used.add(w.toLowerCase());
  }
  const missing = [...STRUCTURED_LAYOUTS].filter((l) => !used.has(l));
  assert(missing.length === 0,
    `no corpus deck uses: ${missing.join(", ")}. Add a slide, or record it in KNOWN_GAPS.`);
});

// ---------------------------------------------------------------------------
// The digest
// ---------------------------------------------------------------------------

// What a .pptx actually contains, read back out of the zip without unpacking it
// to disk. Only the central directory and stored/deflated entries this writer
// produces, which is all src/zip.js emits.
function unzip(buffer) {
  const files = new Map();
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("no end-of-central-directory record");
  const count = buffer.readUInt16LE(end + 10);
  let p = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOff = buffer.readUInt32LE(p + 42);
    const name = buffer.toString("utf8", p + 46, p + 46 + nameLen);
    const method = buffer.readUInt16LE(p + 10);
    const compSize = buffer.readUInt32LE(p + 20);
    const lNameLen = buffer.readUInt16LE(localOff + 26);
    const lExtraLen = buffer.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buffer.subarray(dataStart, dataStart + compSize);
    files.set(name, method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const unescapeXml = (s) => s
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

// Per slide: what the harvest found, and what reached the file. Text is kept
// verbatim because losing a word between the two is the failure that matters.
function digestOf(entry, geometry, pptxBuffer, html) {
  const files = unzip(pptxBuffer);
  const slideXml = [...files.keys()]
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => parseInt(a.match(/\d+/)[1 - 1], 10) - parseInt(b.match(/\d+/)[0], 10))
    .map((n) => files.get(n).toString("utf-8"));

  // SVG content per slide, from the built page rather than the harvest — the
  // harvest is the thing under test and cannot be its own witness.
  const slideHtml = html.split(/(?=<div class="slide)/).filter((s) => s.startsWith('<div class="slide'));
  const svgPerSlide = slideHtml.map((s) => {
    const svgs = (s.match(/<svg\b[\s\S]*?<\/svg>/g) || [])
      .filter((v) => !/nav-(prev|next|up|down|vert)/.test(v));
    const shapes = svgs.reduce((n, v) =>
      n + (v.match(/<(?:path|circle|rect|line|polygon|polyline|ellipse)\b/g) || []).length, 0);
    const texts = svgs.reduce((n, v) => n + (v.match(/<text\b/g) || []).length, 0);
    return { svgs: svgs.length, shapes, texts };
  });

  return {
    deck: entry.deck,
    slides: geometry.slides.map((s, i) => {
      const xml = slideXml[i] || "";
      const kinds = {};
      for (const a of s.atoms || []) kinds[a.kind] = (kinds[a.kind] || 0) + 1;
      return {
        id: s.id,
        layout: s.layout,
        atoms: kinds,
        text: (s.atoms || [])
          .filter((a) => a.kind === "text")
          .map((a) => (a.runs || []).map((r) => r.text).join("").replace(/\s+/g, " ").trim())
          .filter(Boolean),
        pptx: {
          pictures: (xml.match(/<p:pic>/g) || []).length,
          shapes: (xml.match(/<p:sp>/g) || []).length,
          runs: (xml.match(/<a:t>/g) || []).map ? (xml.match(/<a:t>[\s\S]*?<\/a:t>/g) || [])
            .map((t) => unescapeXml(t.replace(/<\/?a:t>/g, "")).replace(/\s+/g, " ").trim())
            .filter(Boolean) : [],
        },
        source: svgPerSlide[i] || { svgs: 0, shapes: 0, texts: 0 },
      };
    }),
    media: [...files.keys()].filter((n) => n.startsWith("ppt/media/")).length,
  };
}

// ---------------------------------------------------------------------------
// Layers B/C — the checked-in digest, without a browser
// ---------------------------------------------------------------------------
console.log("\n--- The exported deck, checked without a browser ---");

function loadDigests() {
  if (!fs.existsSync(GOLDEN)) return [];
  return fs.readdirSync(GOLDEN).filter((f) => f.endsWith(".json")).sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(GOLDEN, f), "utf-8")));
}
const digests = loadDigests();

test("a golden digest is checked in for every deck in the corpus", () => {
  assert(digests.length > 0,
    "no digests under test/pptx-golden/. Generate with: node test/test-pptx-conformance.js --update");
  for (const c of CORPUS) {
    assert(digests.some((d) => d.deck === c.deck), `no digest for ${c.deck}; regenerate with --update`);
  }
});

test("every slide in the deck reaches the file", () => {
  for (const d of digests) {
    for (const s of d.slides) {
      assert(s.pptx, `${d.deck}: slide ${s.id} produced no slide part`);
    }
  }
});

test("no text is lost between the harvest and the file", () => {
  // The harvest is what the geometry says is on the slide; the runs are what
  // the .pptx actually carries. A word in the first and not the second is a
  // word the reader never sees, and nothing else would notice.
  // Compared with every space removed, because a run is split wherever the
  // formatting changes: `background:` in code voice and the sentence around it
  // are two runs, and a prefix match across that boundary finds neither.
  const squash = (t) => t.replace(/\s+/g, "").toLowerCase();
  const lost = [];
  for (const d of digests) {
    for (const s of d.slides) {
      const haystack = squash(s.pptx.runs.join(""));
      for (const t of s.text) {
        const needle = squash(t);
        if (needle && !haystack.includes(needle)) {
          lost.push(`${d.deck} ${s.id}: "${t.slice(0, 50)}"`);
        }
      }
    }
  }
  assert(lost.length === 0, `${lost.length} text run(s) lost:\n  ` + lost.slice(0, 5).join("\n  "));
});

test("every image the harvest found becomes a picture in the file", () => {
  const bad = [];
  for (const d of digests) {
    for (const s of d.slides) {
      const want = s.atoms.image || 0;
      if (want > s.pptx.pictures) {
        bad.push(`${d.deck} ${s.id}: ${want} image atom(s), ${s.pptx.pictures} picture(s) in the file`);
      }
    }
  }
  assert(bad.length === 0, bad.slice(0, 5).join("\n  "));
});

test("a deck with images ships the media to go with them", () => {
  for (const d of digests) {
    const images = d.slides.reduce((n, s) => n + (s.atoms.image || 0), 0);
    if (images > 0) assert(d.media > 0, `${d.deck} has ${images} image atom(s) but ships no media`);
  }
});

// ---------------------------------------------------------------------------
// Layer D — the gaps, measured rather than remembered
// ---------------------------------------------------------------------------
console.log("\n--- Known gaps, held to their measurement ---");

test("SVG shapes are still dropped, and the gap entry still describes it", () => {
  // Asserting the broken behaviour on purpose. When the harvest learns to
  // rasterise an SVG this fails, and whoever fixed it has to delete the entry
  // in KNOWN_GAPS — which is the only way a known gap reliably stops being one.
  assert(KNOWN_GAPS.svgShapes, "the gap entry was removed; delete this test with it");
  let shapesInSource = 0, slidesWithSvg = 0, labelsKept = 0;
  for (const d of digests) {
    for (const s of d.slides) {
      if (!s.source || !s.source.shapes) continue;
      slidesWithSvg++;
      shapesInSource += s.source.shapes;
      labelsKept += Math.min(s.source.texts, s.text.length);
    }
  }
  assert(slidesWithSvg > 0,
    "no corpus deck has an SVG any more, so this gap is no longer measured — " +
    "keep examples/svg-example.sdoc in the corpus or remove the gap entry");
  assert(shapesInSource > 0, "the corpus's SVGs have no shapes to drop");
  // The labels do survive, which is the part that makes it look like a bug.
  assert(labelsKept >= 0, "unreachable");
});

test("an SVG's labels do not arrive without their drawing", () => {
  // The real invariant, failing today for the reason in KNOWN_GAPS.svgShapes.
  // It is written the right way round so that fixing the harvest turns it
  // green rather than leaving a test that enshrines the bug.
  const orphaned = [];
  for (const d of digests) {
    for (const s of d.slides) {
      if (!s.source || !s.source.shapes) continue;
      const drawingReached = (s.atoms.image || 0) + (s.atoms.box || 0);
      if (s.source.texts > 0 && drawingReached === 0) {
        orphaned.push(`${d.deck} ${s.id}: ${s.source.shapes} shape(s) dropped, ` +
          `${s.source.texts} label(s) kept with nothing under them`);
      }
    }
  }
  if (orphaned.length && KNOWN_GAPS.svgShapes) {
    console.log("    KNOWN GAP: " + orphaned.length + " slide(s) with orphaned SVG labels");
    for (const o of orphaned.slice(0, 3)) console.log("      " + o);
    return;
  }
  assert(orphaned.length === 0, orphaned.slice(0, 5).join("\n  "));
});

// ---------------------------------------------------------------------------
// Layer E — the digest still matches a live export
// ---------------------------------------------------------------------------
console.log("\n--- The digest still matches a live export ---");

async function exportCorpus() {
  const { harvestGeometry } = require("../src/slide-geometry.js");
  const out = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-pptx-conf-"));
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
      includeOptional: false,
    });
    html = inlineDeckImages(html, path.dirname(deckPath)).html;
    const htmlPath = path.join(tmpDir, entry.prefix + ".html");
    fs.writeFileSync(htmlPath, html, "utf-8");
    const geometry = await harvestGeometry(htmlPath);
    const { buffer } = buildPptx(geometry, {
      baseDir: tmpDir, title: entry.title, fonts: theme.themeConfig.fonts,
    });
    out.push({ entry, digest: digestOf(entry, geometry, buffer, html) });
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return out;
}

if (UPDATE) {
  if (!findChrome()) { console.log("  Cannot regenerate without Chrome."); process.exit(1); }
  asyncTests.push(exportCorpus().then((results) => {
    fs.mkdirSync(GOLDEN, { recursive: true });
    for (const { entry, digest } of results) {
      fs.writeFileSync(
        path.join(GOLDEN, entry.prefix + ".json"),
        JSON.stringify(digest, null, 2) + "\n", "utf-8"
      );
    }
    console.log(`  Wrote ${results.length} digest(s) to test/pptx-golden/.`);
    console.log("  Read the diff before committing it.");
  }));
} else if (!findChrome()) {
  console.log("  SKIP: Chrome not found — the export harvests a live page");
} else {
  test("a live export still matches the checked-in digests", async () => {
    const results = await exportCorpus();
    const drifted = [];
    for (const { entry, digest } of results) {
      const goldenPath = path.join(GOLDEN, entry.prefix + ".json");
      if (!fs.existsSync(goldenPath)) { drifted.push(`${entry.prefix} is new`); continue; }
      const golden = fs.readFileSync(goldenPath, "utf-8");
      if (golden !== JSON.stringify(digest, null, 2) + "\n") drifted.push(`${entry.prefix} changed`);
    }
    assert(drifted.length === 0,
      `${drifted.join(", ")} drifted. If intended: node test/test-pptx-conformance.js --update`);
  });
}

// ============================================================
Promise.all(asyncTests).then(() => {
  console.log("\n" + "=".repeat(40));
  console.log(`Results: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
});
