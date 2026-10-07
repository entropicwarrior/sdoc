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
const { renderSlides } = require("../src/slide-renderer.js");
const { loadTheme } = require("../src/theme.js");
const { runHarvest, SENTINEL } = require("../src/slide-geometry.js");
const { harvestArtifact, buildArtifact } = require("../src/slide-artifact.js");

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
      out.push({ id: frame.getAttribute("data-slide"), items: items });
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
</style></head><body>
${frames}
</body></html>`;
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
      "Usage: artifact-fidelity <deck.sdoc> [--json <file>] [--worst N]\n\n" +
        "  Reports how far the flow export lands from the build, per slide."
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
  const worstAt = args.indexOf("--worst");
  const worstN = worstAt >= 0 ? parseInt(args[worstAt + 1], 10) || 5 : 5;

  const resolved = path.resolve(deckPath);
  const parsed = parseSdoc(fs.readFileSync(resolved, "utf-8"));
  if (parsed.errors.length) {
    console.error("the deck does not parse:");
    for (const e of parsed.errors.slice(0, 5)) console.error("  " + JSON.stringify(e));
    process.exit(1);
  }
  const { nodes, meta } = extractMeta(parsed.nodes);
  const theme = loadTheme(themeDir);
  if (!theme || !theme.themeCss) {
    console.error(`the theme at ${themeDir} loaded nothing; refusing to report numbers for it`);
    process.exit(1);
  }

  // Beside the source, so relative images resolve exactly as they do in a build.
  const buildPath = path.join(path.dirname(resolved), `.fidelity-build-${Date.now()}.html`);
  const buildHtml = renderSlides(nodes, {
    meta, themeCss: theme.themeCss, themeConfig: theme.themeConfig,
  });
  fs.writeFileSync(buildPath, buildHtml, "utf-8");

  let harvest;
  try {
    harvest = await harvestArtifact(buildPath);
  } finally {
    try { fs.unlinkSync(buildPath); } catch {}
  }

  const built = buildArtifact(harvest, {
    title: meta.title || "deck", theme: theme.themeConfig, now: new Date().toISOString(),
  });

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
    return { id: s.id, html, texts: s.texts || [] };
  });
  if (unresolved) {
    console.error(
      `${unresolved} unsized image(s) resolved to no bytes. An unsized picture that ` +
        "does not load has an empty box, and everything near it moves — which would " +
        "be reported as layout error. Refusing to report a number that cannot mean anything."
    );
    process.exit(1);
  }

  const pagePath = path.join(path.dirname(resolved), `.fidelity-measure-${Date.now()}.html`);
  fs.writeFileSync(pagePath, measurePage(slides, faceCssFrom(buildHtml)), "utf-8");

  let measured;
  try {
    measured = await runHarvest(pagePath, MEASURE_SCRIPT, "sdoc-fidelity");
  } finally {
    try { fs.unlinkSync(pagePath); } catch {}
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

  const bySlide = new Map(measured.slides.map((s) => [s.id, s.items]));
  const report = { canvas: CANVAS, deck: resolved, theme: themeDir, slides: [], totals: {} };
  const allDy = [];
  const allDx = [];
  let unmatched = 0;

  for (const slide of slides) {
    const got = bySlide.get(slide.id) || [];
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

  console.log(`\n  deck   ${path.basename(resolved)}`);
  console.log(`  theme  ${themeDir}`);
  console.log(
    `\nflow vs build — ${report.slides.length} slides, ${t.elements} text elements\n` +
      `  vertical   median ${t.medianDy}px   max ${t.maxDy}px\n` +
      `  horizontal median ${t.medianDx}px   max ${t.maxDx}px\n` +
      `  margins the subset could not carry: ${t.droppedMargins}` +
      (t.unmatched ? `\n  UNMATCHED ELEMENTS: ${t.unmatched} — the comparison is not element-for-element` : "") +
      (empty.length ? `\n  SLIDES WITH NOTHING PAIRED: ${empty.length} (${empty.slice(0, 5).join(", ")}) — not measured, not perfect` : "") +
      (unsizedImages ? `\n  ${unsizedImages} of ${images} images carry no pixel size; until one decodes its box is empty, so error near a picture may be the measurement` : "")
  );
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

module.exports = { measurePage, resolveAssets, faceCssFrom, median, MEASURE_SCRIPT };
