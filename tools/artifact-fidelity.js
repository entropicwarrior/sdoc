#!/usr/bin/env node
// How far the flow export lands from the build it came from, as a number.
//
//   node tools/artifact-fidelity.js <deck.sdoc> [--json <file>] [--worst N]
//
// Flow describes a layout and the viewer rebuilds it. The subset has no
// `margin`, and a container gets one `gap` which can only say "space all my
// children equally", so a theme that spaces different children differently
// cannot be reproduced exactly. That gap is structural, not a defect list —
// the point of measuring it is to tell a change that helps from one that does
// not, and to say which slides are worth an author's time.
//
// The build is the reference. Its geometry is measured in the same browser, in
// design pixels, with the deck's own faces loaded.
//
// WHAT A CLEAN NUMBER FROM THIS DOES NOT MEAN
//
// Two whole classes of defect are outside it, and both have reached a
// published deck while this reported the slide as fine.
//
// 1. It renders the emitted HTML in Chrome, not in the Slides runtime. Where
//    the two disagree, Chrome wins here and the viewer wins in front of the
//    reader. An empty div at `width:646px` holds exactly as written in Chrome
//    and collapses in the viewer — so a spacer built that way measured
//    perfectly and shipped a cover with the words on top of the rule. Nothing
//    in this file can see that, and making it see it would mean measuring
//    inside the published page.
// 2. It measures geometry. A defect that moves nothing is invisible: a row
//    that goes grey because its wash was dropped, an accent bar that is not
//    drawn, a face that silently becomes the table's. The conformance suite
//    carries guards for the ones that are known; this reports 0px for all of
//    them.
//
// So a clean run means "nothing measurable moved", and a deck is correct when
// somebody has looked at it. Treat the number as a regression detector, not as
// a verdict.
//
// WHAT THIS MODELS, AND WHAT IT THEREFORE CANNOT TELL YOU
//
// The real viewer is not available here, so the page below stands in for it:
// a 1920x1080 frame per slide, no margin or padding of its own anywhere, and
// headings left to the subset's default weight of 600 unless the slide says
// otherwise (the exporter always writes a heading's weight, so it does). Error
// from that model is error in the number. Treat an absolute figure as
// indicative and a change in the figure as real.
//
// Two things are resolved before measuring, because getting them wrong buries
// the signal: every `sdoc-asset:` reference becomes the actual bytes, so no
// picture collapses and drags the slide up behind it; and the deck's @font-face
// rules are carried over, so text is measured in the face it was authored in.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseSdoc, extractMeta } = require("../src/sdoc.js");
const { renderSlides, inlineDeckImages } = require("../src/slide-renderer.js");
const { loadTheme, inlineCssAssets } = require("../src/theme.js");
const { runHarvest, SENTINEL } = require("../src/slide-geometry.js");
const { harvestArtifact, buildArtifact, ARTIFACT_SCRIPT } = require("../src/slide-artifact.js");

const CANVAS = { w: 1920, h: 1080 };

const MEASURE_SCRIPT = `
(function () {
  function inkOf(el) {
    var r = null;
    try {
      var range = document.createRange();
      range.selectNodeContents(el);
      r = range.getBoundingClientRect();
    } catch (err) {}
    if (!r || (!r.width && !r.height)) r = el.getBoundingClientRect();
    return r;
  }
  // The box an element would occupy unrotated. The exporter records the
  // upright box and writes a rotate() beside it, so measuring the rotated
  // bounding box here would compare two different rectangles and report every
  // rotated element as misplaced by tens of pixels. Same test and same trick
  // as the two harvests: a pure rotation only, measured with the transform
  // switched off and back.
  function uprightRect(el) {
    var t = String(getComputedStyle(el).transform || "none");
    if (t === "none") return el.getBoundingClientRect();
    var prior = el.style.transform;
    el.style.transform = "none";
    var r = el.getBoundingClientRect();
    el.style.transform = prior;
    return r;
  }
  function run() {
    var out = [];
    var frames = document.querySelectorAll(".fidelity-frame");
    for (var i = 0; i < frames.length; i++) {
      var frame = frames[i];
      var origin = frame.getBoundingClientRect();
      var els = frame.querySelectorAll("h1,h2,h3,p");
      var items = [];
      for (var j = 0; j < els.length; j++) {
        var el = els[j];
        var r = inkOf(el);
        items.push({
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 60),
          x: r.left - origin.left,
          y: r.top - origin.top,
          w: r.width,
          h: r.height
        });
      }
      // Every emitted element, not only the ones holding words. An image, a
      // drawing, a pinned caption and a painted box are what a reader notices
      // missing, and none of them can be paired on text.
      var probes = [];
      var tagged = frame.querySelectorAll("[data-sdoc-probe]");
      for (var k = 0; k < tagged.length; k++) {
        var pe = tagged[k];
        var pr = uprightRect(pe);
        probes.push({
          id: parseInt(pe.getAttribute("data-sdoc-probe"), 10),
          x: pr.left - origin.left,
          y: pr.top - origin.top,
          w: pr.width,
          h: pr.height
        });
      }
      out.push({ id: frame.getAttribute("data-slide"), items: items, probes: probes });
    }
    var holder = document.createElement("script");
    holder.type = "application/json";
    holder.id = "sdoc-fidelity";
    holder.textContent = JSON.stringify({ slides: out }) + "\\n/*${SENTINEL}*/";
    document.body.appendChild(holder);
  }
  function start() {
    var go = function () { requestAnimationFrame(run); };
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(go);
    } else {
      go();
    }
  }
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start);
})();
`;

// The @font-face rules the build inlined. Text measured in a fallback face is
// the wrong width, which would read as a layout error and is not one.
function faceCssFrom(html) {
  const out = [];
  const re = /@font-face\s*\{[^}]*\}/gi;
  let m;
  while ((m = re.exec(html))) out.push(m[0]);
  return out.join("\n");
}

// `baseDir` is the directory the deck was built in. A picture the deck did not
// embed is referenced the way the page referenced it — relative — and relative
// to the page, not to wherever this happens to be run from.
function resolveAssets(slideHtml, assets, baseDir) {
  return slideHtml.replace(/sdoc-asset:([^"')\s]+)/g, (whole, name) => {
    const src = assets.get(name);
    if (!src) return whole;
    if (/^data:/i.test(src)) return src;
    const plain = src.replace(/^file:\/\//, "").split(/[?#]/)[0];
    const decoded = (() => { try { return decodeURIComponent(plain); } catch (e) { return plain; } })();
    const candidates = [
      decoded,
      baseDir ? path.resolve(baseDir, decoded) : null,
      baseDir ? path.resolve(baseDir, path.basename(decoded)) : null,
    ].filter(Boolean);
    const found = candidates.find((c) => { try { return fs.statSync(c).isFile(); } catch (e) { return false; } });
    if (!found) return whole;
    try {
      const buf = fs.readFileSync(found);
      const ext = path.extname(found).slice(1).toLowerCase();
      const type = ext === "svg" ? "image/svg+xml" : ext === "jpg" ? "image/jpeg" : `image/${ext || "png"}`;
      return `data:${type};base64,${buf.toString("base64")}`;
    } catch (err) {
      return whole;
    }
  });
}

function measurePage(slides, faceCss) {
  const frames = slides
    .map(
      (s) =>
        `<div class="fidelity-frame" data-slide="${s.id}">\n${s.html}\n</div>`
    )
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
${faceCss}
/* The viewer, as modelled. Nothing here may introduce spacing of its own:
   every length that matters is written on the element by the exporter. */
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { background: #fff; }
.fidelity-frame {
  position: relative;
  width: ${CANVAS.w}px;
  height: ${CANVAS.h}px;
  overflow: hidden;
}
.fidelity-frame > section {
  position: relative;
  width: ${CANVAS.w}px;
  height: ${CANVAS.h}px;
}
/* The subset's headings default to 600. The exporter writes a weight on every
   heading, so this should never decide anything — it is here so that if it
   ever stops doing so, the model is still the format's. */
h1, h2, h3 { font-weight: 600; }
img { display: block; }
/* Speaker notes take no space in the viewer — the reference says so outright:
   "<aside> = speaker notes (one per slide, last; takes no space)". Left
   visible they are a flex child of the section like any other, and on a slide
   with long notes they squeezed the body by their whole height and pulled
   everything under it up. That was reported as a footnote 170px out of place
   on a real deck, and it was this page, not the export. */
.fidelity-frame aside { display: none; }
</style></head><body>
${frames}
</body></html>`;
}

// Keep only the named slides, before anything is rendered. Narrowing the
// measurement alone would save almost nothing: the cost is the build — a deck
// with its images inlined is twenty megabytes that Chrome has to parse, decode
// and rasterise, twice over. Cutting it to five scopes cuts both passes.
//
// An id nothing matches is refused, with the deck's own ids listed. A filter
// that silently matches nothing is the same empty-set trap as a guard that
// cannot fail, and it would report a flawless deck.
function narrowToSlides(nodes, wanted) {
  const RESERVED = new Set(["meta", "about"]);
  const slug = (v) =>
    String(v || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const wrapped = nodes.length === 1 && nodes[0].type === "scope" && nodes[0].children;
  const scopes = wrapped ? nodes[0].children : nodes;

  const available = [];
  const kept = [];
  const matched = new Set();
  for (const n of scopes) {
    const isSlide =
      n.type === "scope" &&
      n.scopeType !== "comment" &&
      !(n.id && RESERVED.has(n.id.toLowerCase()));
    if (!isSlide) { kept.push(n); continue; }
    const id = n.id || "";
    if (id) available.push(id);
    for (const w of wanted) {
      if (w === id || w === slug(id)) { kept.push(n); matched.add(w); break; }
    }
  }

  const unknown = [...wanted].filter((w) => !matched.has(w));
  if (unknown.length) {
    throw new Error(
      `no slide in this deck has the id ${unknown.map((u) => JSON.stringify(u)).join(", ")}.\n` +
        `This deck's slides are: ${available.join(", ") || "(none carry an @id)"}`
    );
  }
  return wrapped ? [{ ...nodes[0], children: kept }] : kept;
}

// The deck's own stylesheet, named by `@meta style-append:` and resolved
// against the .sdoc, exactly as tools/build-slides.js resolves it. Without it
// the harness builds and measures a deck nobody ships: both sides still agree,
// because both come from the same build, so the numbers look fine and describe
// something else. A deck's own sheet is where its per-slide rules live — the
// image heights, the shadows — so a defect in any of them was invisible here.
function loadDeckCss(deckPath, meta) {
  const rel = typeof meta.styleAppendPath === "string" ? meta.styleAppendPath.trim() : "";
  if (!rel) return { css: "", from: null };
  const at = path.resolve(path.dirname(deckPath), rel);
  if (!fs.existsSync(at)) {
    // Not a warning. The deck names a sheet and it is not there, so what would
    // be measured is not the deck.
    throw new Error(
      `the deck's @meta style-append names ${rel}, which is not at ${at}. ` +
        "Refusing to measure a build without the deck's own stylesheet."
    );
  }
  const { css } = inlineCssAssets(fs.readFileSync(at, "utf-8"), path.dirname(at));
  return { css, from: at };
}

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function main() {
  const args = process.argv.slice(2);
  const deckPath = args.find((a) => !a.startsWith("-"));
  if (!deckPath) {
    console.log(
      "Usage: artifact-fidelity <deck.sdoc> [--theme <dir>] [--slides a,b,c]\n" +
        "                        [--json <file>] [--worst N]\n\n" +
        "  Reports how far the flow export lands from the build, per slide.\n\n" +
        "  --slides narrows the BUILD as well as the measurement, which is where\n" +
        "  the time goes: a deck with its images inlined is tens of megabytes to\n" +
        "  parse, decode and rasterise, and both passes pay it. An id that matches\n" +
        "  no slide is refused rather than measured as nothing."
    );
    process.exit(deckPath ? 0 : 1);
  }
  // A deck built against the wrong theme still builds, and every number that
  // comes out of it is wrong in a way nothing announces. So the theme is named
  // explicitly or defaulted explicitly, it is reported in the output, and a
  // path that was asked for and is not there is a hard stop.
  const themeAt = args.indexOf("--theme");
  const themeArg = themeAt >= 0 ? args[themeAt + 1] : null;
  if (themeAt >= 0 && !themeArg) {
    console.error("--theme needs a directory");
    process.exit(1);
  }
  const themeDir = themeArg
    ? path.resolve(themeArg)
    : path.join(__dirname, "..", "themes", "default");
  if (!fs.existsSync(themeDir)) {
    console.error(`no theme at ${themeDir}`);
    process.exit(1);
  }

  const jsonAt = args.indexOf("--json");
  const jsonOut = jsonAt >= 0 ? args[jsonAt + 1] : null;
  const slidesAt = args.indexOf("--slides");
  if (slidesAt >= 0 && !args[slidesAt + 1]) {
    console.error("--slides needs a comma-separated list of slide ids");
    process.exit(1);
  }
  const wanted =
    slidesAt >= 0
      ? new Set(args[slidesAt + 1].split(",").map((x) => x.trim()).filter(Boolean))
      : null;

  const worstAt = args.indexOf("--worst");
  const worstN = worstAt >= 0 ? parseInt(args[worstAt + 1], 10) || 5 : 5;

  const resolved = path.resolve(deckPath);
  const parsed = parseSdoc(fs.readFileSync(resolved, "utf-8"));
  if (parsed.errors.length) {
    console.error("the deck does not parse:");
    for (const e of parsed.errors.slice(0, 5)) console.error("  " + JSON.stringify(e));
    process.exit(1);
  }
  let { nodes, meta } = extractMeta(parsed.nodes);
  if (wanted) nodes = narrowToSlides(nodes, wanted);
  const theme = loadTheme(themeDir);
  if (!theme || !theme.themeCss) {
    console.error(`the theme at ${themeDir} loaded nothing; refusing to report numbers for it`);
    process.exit(1);
  }

  // Beside the source, so relative images resolve exactly as they do in a build.
  // Both temp pages go to a private scratch directory, never beside the deck.
  // They used to live next to the .sdoc so relative images resolved, which
  // stopped being true once the pictures are embedded below — and meanwhile a
  // leftover from a crashed run sat in somebody else's working directory and
  // was picked up as if it were their build.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-fidelity-"));
  const buildPath = path.join(scratch, "build.html");
  const deck = loadDeckCss(resolved, meta);
  let buildHtml = renderSlides(nodes, {
    meta, themeCss: theme.themeCss, themeConfig: theme.themeConfig, deckCss: deck.css,
  });
  // Embed the pictures, exactly as tools/build-slides.js does. This is not an
  // optimisation: a picture left as a file:// reference taints the canvas it is
  // drawn into, so every bake fails silently and a drop-shadow is dropped
  // rather than painted. The harness then measures a pipeline nobody runs —
  // one where shadowed images behave differently from the real build.
  const embedded = inlineDeckImages(buildHtml, path.dirname(resolved));
  buildHtml = embedded.html;
  if (embedded.missing && embedded.missing.length) {
    const names = embedded.missing.map((m) => m.src || m.path || JSON.stringify(m));
    throw new Error(
      `${embedded.missing.length} image(s) in this deck could not be embedded: ${names.slice(0, 4).join(", ")}. ` +
        "Every bake behind one fails silently, so the measurement would not be of this deck."
    );
  }
  fs.writeFileSync(buildPath, buildHtml, "utf-8");

  // Two measurements of the same build, for two different questions.
  //
  // The baked one is what the exporter works from: a picture with a shadow is
  // painted into its pixels, so the element grows by the bleed and the export
  // is emitted at that size. The unbaked one is the deck as a reader sees it,
  // where a filter paints outside the box and costs no layout at all.
  //
  // Comparing the export against the BAKED build hides exactly the defect that
  // matters here — both sides carry the growth and agree — so the reference is
  // the unbaked one. Where the two disagree the export has invented layout the
  // deck never had, and that is reported rather than measured away.
  let harvest;
  let reference;
  try {
    harvest = await harvestArtifact(buildPath);
    reference = await harvestArtifact(buildPath, {
      script: "window.__sdocNoBake = true;\n" + ARTIFACT_SCRIPT,
    });
  } finally {
    // buildPath is removed with the whole scratch directory at the end.
  }

  const opts = { title: meta.title || "deck", theme: theme.themeConfig, now: new Date().toISOString() };
  // Tagged for measurement. `data-*` is ignored by the page, and a real export
  // never carries these — but the geometry each one records is what the
  // exporter believed it was placing, which is the only way to pair an element
  // that holds no text.
  const built = buildArtifact(harvest, { ...opts, probe: true });
  // Same slides, same text, measured before the bake: the boxes to judge against.
  const truth = buildArtifact(reference, opts);
  const truthBySlide = new Map(truth.manifest.slides.map((x) => [x.id, x.texts || []]));

  // A picture that does not load collapses to nothing and drags everything
  // below and beside it, which reads as a large layout error and is not one.
  // Both ways that happens are counted here rather than discovered in the
  // numbers: a reference that resolved to no bytes, and an image the export
  // gave no size, which has nothing to hold its box open until it decodes.
  //
  // An image whose box is written on it holds that box open whether or not it
  // ever decodes, so its bytes decide nothing about where text lands and are
  // replaced with a transparent pixel. That is not a shortcut: a deck with its
  // pictures embedded is tens of megabytes, and a measuring page that large
  // spends its whole budget decoding images to find out what it already knows.
  // An image with no size does need its bytes, because without them its box is
  // empty and everything near it moves — so those are inlined, and counted.
  const PIXEL =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  let unresolved = 0;
  let unsizedImages = 0;
  let images = 0;
  const slides = built.manifest.slides.map((s) => {
    const file = built.files[`project/slides/${s.id}.html`] || "";
    const html = file.replace(/<img\b[^>]*>/g, (tag) => {
      images++;
      const sized = /width:\s*[0-9.]+px/.test(tag) && /height:\s*[0-9.]+px/.test(tag);
      if (sized) return tag.replace(/src="[^"]*"/, `src="${PIXEL}"`);
      unsizedImages++;
      const withBytes = resolveAssets(tag, built.assets, path.dirname(resolved));
      unresolved += (withBytes.match(/sdoc-asset:/g) || []).length;
      return withBytes;
    });
    return { id: s.id, html, texts: truthBySlide.get(s.id) || s.texts || [], probes: s.probes || [] };
  });
  if (unresolved) {
    console.error(
      `${unresolved} unsized image(s) resolved to no bytes. An unsized picture that ` +
        "does not load has an empty box, and everything near it moves — which would " +
        "be reported as layout error. Refusing to report a number that cannot mean anything."
    );
    process.exit(1);
  }

  const pagePath = path.join(scratch, "measure.html");
  fs.writeFileSync(pagePath, measurePage(slides, faceCssFrom(buildHtml)), "utf-8");

  let measured;
  try {
    measured = await runHarvest(pagePath, MEASURE_SCRIPT, "sdoc-fidelity");
  } finally {
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
  }

  // Matched on text, never zipped by index. The two sides do not always hold
  // the same number of elements — a box that paints nothing is not emitted —
  // and one extra entry on either side shifts every pair after it, which
  // reports the whole slide as moved. Repeated strings are paired in the order
  // they occur, and anything left over is counted rather than quietly dropped.
  let loose = 0;
  function pairByText(want, got) {
    const norm = (t) => String(t || "").replace(/\s+/g, " ").trim().slice(0, 60);
    const pending = new Map();
    got.forEach((g, i) => {
      const k = norm(g.text);
      if (!pending.has(k)) pending.set(k, []);
      pending.get(k).push(i);
    });
    const pairs = [];
    const missed = [];
    for (const w of want) {
      const k = norm(w.text);
      const queue = pending.get(k);
      if (queue && queue.length) pairs.push({ want: w, got: got[queue.shift()] });
      else missed.push(w);
    }

    // A second pass on a shorter key. The two sides can differ in a character
    // that is nothing to do with layout — a typographic apostrophe against a
    // straight one, a non-breaking space — and on the full key that reads as an
    // element the export lost. It is not lost; it is the same paragraph spelled
    // a hair differently. Matching the opening of the string recovers it, and
    // anything still unpaired after this really is on one side only.
    if (missed.length) {
      const short = (t) => norm(t).slice(0, 24);
      const left = new Map();
      for (const [k, q] of pending.entries()) {
        if (!q.length) continue;
        const sk = short(k);
        if (!left.has(sk)) left.set(sk, []);
        for (const i of q) left.get(sk).push(i);
      }
      for (let n = missed.length - 1; n >= 0; n--) {
        const q = left.get(short(missed[n].text));
        if (!q || !q.length) continue;
        const i = q.shift();
        pairs.push({ want: missed[n], got: got[i] });
        for (const [, pq] of pending.entries()) {
          const at = pq.indexOf(i);
          if (at >= 0) pq.splice(at, 1);
        }
        missed.splice(n, 1);
        loose++;
      }
    }
    const spare = [];
    for (const [k, q] of pending.entries()) for (let i = 0; i < q.length; i++) spare.push(k);
    return { pairs, missed, spare };
  }

  // The whole measured record, not just its text items. Keyed to `s.items`,
  // the probe pass below asked a list of text for its `.probes`, got undefined
  // every time, and iterated nothing — so "every emitted element landed where
  // the exporter placed it" was printed by a loop with no body. A guard that
  // cannot fail is worse than no guard: it is the one in this file that was
  // supposed to catch the defects the text comparison cannot see.
  const bySlide = new Map(measured.slides.map((s) => [s.id, s]));
  const report = { canvas: CANVAS, deck: resolved, theme: themeDir, slides: [], totals: {} };
  const allDy = [];
  const allDx = [];
  let unmatched = 0;

  for (const slide of slides) {
    const got = (bySlide.get(slide.id) || {}).items || [];
    const want = slide.texts;
    const { pairs, missed, spare } = pairByText(want, got);
    unmatched += missed.length + spare.length;

    const items = [];
    for (const { want: w, got: g } of pairs) {
      const dy = g.y - w.box.y;
      const dx = g.x - w.box.x;
      allDy.push(Math.abs(dy));
      allDx.push(Math.abs(dx));
      items.push({
        role: w.role, tag: w.tag,
        text: w.text.slice(0, 60),
        dy: Math.round(dy * 10) / 10, dx: Math.round(dx * 10) / 10,
      });
    }
    const dys = items.map((i) => Math.abs(i.dy));
    report.slides.push({
      id: slide.id,
      elements: pairs.length,
      unpaired: missed.length + spare.length,
      // Named, not just counted: an unpaired element is either something the
      // build has and the export dropped, or something the export invented.
      // Both are findings; a bare count is a shrug.
      onlyInBuild: missed.map((w) => `${w.tag}.${w.role}: ${w.text.slice(0, 50)}`),
      onlyInExport: spare.map((t) => t.slice(0, 50)),
      medianDy: Math.round(median(dys) * 10) / 10,
      maxDy: Math.round(Math.max(0, ...dys) * 10) / 10,
      worst: items.sort((a, b) => Math.abs(b.dy) - Math.abs(a.dy)).slice(0, worstN),
    });
  }

  // Second question, and the one the text comparison cannot ask: did every
  // emitted element land where the exporter put it?
  const misplaced = misplacedElements(slides, measured.slides);
  report.misplaced = misplaced;
  report.compared = misplaced.compared;
  const probed = slides.reduce((n, sl) => n + (sl.probes || []).length, 0);
  if (probed > 0 && !misplaced.compared) {
    console.error(
      `${probed} element(s) carry a probe and not one was compared. The placement ` +
        "check is not running, so a clean result from it would mean nothing."
    );
    process.exit(1);
  }

  report.totals = {
    elements: allDy.length,
    unmatched,
    images,
    unsizedImages,
    pairedOnPrefix: loose,
    medianDy: Math.round(median(allDy) * 10) / 10,
    maxDy: Math.round(Math.max(0, ...allDy) * 10) / 10,
    medianDx: Math.round(median(allDx) * 10) / 10,
    maxDx: Math.round(Math.max(0, ...allDx) * 10) / 10,
    droppedMargins: (built.manifest.fidelity && built.manifest.fidelity.byKind["margin-dropped"]) || 0,
  };

  const t = report.totals;
  // A result nothing could have disagreed with is not a result. These are the
  // ways this harness can report a clean number over nothing at all.
  if (!report.slides.length) {
    console.error("the deck produced no slides; nothing was measured");
    process.exit(1);
  }
  if (!t.elements) {
    console.error(
      `no text element on any of ${report.slides.length} slides could be paired with the build. ` +
        "That is a broken comparison, not a perfect one."
    );
    process.exit(1);
  }
  const empty = report.slides.filter((x) => !x.elements).map((x) => x.id);

  console.log(`\n  deck   ${path.basename(resolved)}${wanted ? ` (${report.slides.length} of its slides)` : ""}`);
  console.log(`  theme  ${themeDir}`);
  console.log(`  css    ${deck.from || "(the deck names none)"}`);
  console.log(
    `\nflow vs build — ${report.slides.length} slides, ${t.elements} text elements\n` +
      `  vertical   median ${t.medianDy}px   max ${t.maxDy}px\n` +
      `  horizontal median ${t.medianDx}px   max ${t.maxDx}px\n` +
      `  margins the subset could not carry: ${t.droppedMargins}` +
      (t.unmatched ? `\n  UNMATCHED ELEMENTS: ${t.unmatched} — the comparison is not element-for-element` : "") +
      (empty.length ? `\n  SLIDES WITH NOTHING PAIRED: ${empty.length} (${empty.slice(0, 5).join(", ")}) — not measured, not perfect` : "") +
      (unsizedImages ? `\n  ${unsizedImages} of ${images} images carry no pixel size; until one decodes its box is empty, so error near a picture may be the measurement` : "")
  );
  if (misplaced.length) {
    console.log(`\n  ${misplaced.length} element(s) did not land where the exporter placed them:`);
    for (const m of misplaced.slice(0, worstN)) {
      console.log(
        `    ${m.slide}  ${m.tag}.${m.role}  dx=${m.dx} dy=${m.dy} dw=${m.dw} dh=${m.dh}`
      );
    }
  } else {
    // The count is part of the sentence on purpose. "Every element landed
    // correctly" reads exactly the same whether it checked them all or none,
    // and for every run before this one it was the latter.
    console.log(`\n  all ${misplaced.compared} emitted elements landed where the exporter placed them`);
  }

  const ranked = [...report.slides].sort((a, b) => b.medianDy - a.medianDy);
  console.log("\n  worst slides by median vertical error:");
  for (const s of ranked.slice(0, worstN)) {
    console.log(`    ${String(s.medianDy).padStart(7)}px  ${s.id}  (max ${s.maxDy}px, ${s.elements} elements)`);
  }
  if (ranked.length && ranked[0].worst.length) {
    console.log(`\n  worst elements on ${ranked[0].id}:`);
    for (const e of ranked[0].worst) {
      console.log(`    ${String(e.dy).padStart(8)}px  ${e.tag} .${e.role}  "${e.text.slice(0, 44)}"`);
    }
  }

  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2), "utf-8");
    console.log(`\n  wrote ${jsonOut}`);
  }
  console.log("");
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

// Did every emitted element land where the exporter put it? A box pinned with
// slide coordinates inside a position:relative ancestor renders somewhere else
// entirely, and nothing about that involves text — so this is the half of the
// measurement that can see an image, a drawing or a painted box at all.
//
// `built` is the exporter's own record per slide (`probes`), `measured` is what
// the modelled viewer rendered (`items` and `probes`). Pulled out of the report
// function and exported so it can be tested: keyed on a slide's TEXT ITEMS by
// mistake, this loop asked a list of text for its `.probes`, got undefined and
// iterated nothing — and the report then printed "every emitted element landed
// where the exporter placed it" from a loop with no body, on every run anyone
// has ever made. A guard that cannot fail is worse than no guard, and the only
// way to know this one can is to make it fail on purpose.
const PLACEMENT_TOLERANCE = 2;

// Returns the elements that moved, and HOW MANY IT LOOKED AT — the count is
// the point. See the note on `bySlide` above for what went wrong without it.
function misplacedElements(built, measured) {
  const bySlide = new Map((measured || []).map((s) => [s.id, s]));
  const out = [];
  out.compared = 0;
  for (const slide of built) {
    const got = bySlide.get(slide.id);
    const want = new Map((slide.probes || []).map((p) => [p.id, p]));
    for (const g of (got && got.probes) || []) {
      const w = want.get(g.id);
      if (!w) continue;
      const dx = Math.round((g.x - w.box.x) * 10) / 10;
      const dy = Math.round((g.y - w.box.y) * 10) / 10;
      const dw = Math.round((g.w - w.box.w) * 10) / 10;
      const dh = Math.round((g.h - w.box.h) * 10) / 10;
      out.compared++;
      const t = PLACEMENT_TOLERANCE;
      if (Math.abs(dx) <= t && Math.abs(dy) <= t && Math.abs(dw) <= t && Math.abs(dh) <= t) continue;
      out.push({ slide: slide.id, tag: w.tag, role: w.role, dx, dy, dw, dh });
    }
  }
  out.sort((a, b) => Math.max(Math.abs(b.dx), Math.abs(b.dy)) - Math.max(Math.abs(a.dx), Math.abs(a.dy)));
  return out;
}

module.exports = {
  measurePage, resolveAssets, faceCssFrom, median, narrowToSlides, MEASURE_SCRIPT,
  misplacedElements, PLACEMENT_TOLERANCE,
};
