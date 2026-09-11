// SDOC Slides — geometry harvest.
//
// Reads a built deck back out of the browser: every box, every run of text,
// every image, with its position and computed style in design-box pixels.
//
// This exists so the PowerPoint / Google Slides exporter does not need its own
// layout engine. The CSS is the layout engine; this module asks the browser
// what the CSS decided, and the exporter turns the answer into shapes. Any
// theme, any layout, any future layout, exports without the exporter knowing
// anything about it.
//
// Zero dependencies: the measuring script is injected into a copy of the deck
// and the result is read back through headless Chrome's --dump-dom.

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { findChrome } = require("./slide-pdf");

const SENTINEL = "__SDOC_GEOMETRY_END__";

// The measuring script, injected before </body>. It runs after layout, walks
// each slide in turn, and leaves its findings in a <script type="application/json">
// element that --dump-dom hands back.
const MEASURE_SCRIPT = `
(function () {
  function rgba(value) {
    if (!value) return null;
    var m = value.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    var parts = m[1].split(",").map(function (p) { return parseFloat(p.trim()); });
    var a = parts.length > 3 ? parts[3] : 1;
    if (!(a > 0)) return null;
    function hex(n) { return ("0" + Math.max(0, Math.min(255, Math.round(n))).toString(16)).slice(-2); }
    return { hex: (hex(parts[0]) + hex(parts[1]) + hex(parts[2])).toUpperCase(), alpha: a };
  }

  function firstFamily(stack) {
    if (!stack) return null;
    var first = stack.split(",")[0].trim();
    return first.replace(/^["']|["']$/g, "");
  }

  function transformText(text, mode) {
    if (mode === "uppercase") return text.toUpperCase();
    if (mode === "lowercase") return text.toLowerCase();
    return text;
  }

  // A run of text: one contiguous piece with one computed style.
  function runsOf(el) {
    var runs = [];
    function walk(node, style) {
      for (var i = 0; i < node.childNodes.length; i++) {
        var child = node.childNodes[i];
        if (child.nodeType === 3) {
          var raw = child.nodeValue.replace(/\\s+/g, " ");
          if (!raw.trim()) {
            // Keep a single separating space between runs, drop the rest.
            if (runs.length && !/ $/.test(runs[runs.length - 1].text)) {
              runs[runs.length - 1].text += " ";
            }
            continue;
          }
          var cs = style;
          var colour = rgba(cs.color);
          runs.push({
            text: transformText(raw, cs.textTransform),
            font: firstFamily(cs.fontFamily),
            size: parseFloat(cs.fontSize),
            weight: parseInt(cs.fontWeight, 10) || 400,
            italic: cs.fontStyle === "italic",
            color: colour ? colour.hex : "FFFFFF",
            spacing: cs.letterSpacing === "normal" ? 0 : parseFloat(cs.letterSpacing) || 0
          });
        } else if (child.nodeType === 1) {
          var cs2 = getComputedStyle(child);
          if (cs2.display === "none" || cs2.visibility === "hidden") continue;
          walk(child, cs2);
        }
      }
    }
    walk(el, getComputedStyle(el));
    return runs.filter(function (r) { return r.text.trim().length > 0 || r.text === " "; });
  }

  // An element is a text leaf when it holds text and no block-level child does.
  function isTextLeaf(el) {
    if (!el.textContent || !el.textContent.trim()) return false;
    for (var i = 0; i < el.children.length; i++) {
      var child = el.children[i];
      var display = getComputedStyle(child).display;
      if (display !== "inline" && display !== "inline-block" && display !== "contents") return false;
      if (display === "contents" && !isTextLeaf(child)) return false;
    }
    return true;
  }

  function borderOf(cs) {
    var sides = ["Top", "Right", "Bottom", "Left"];
    var widths = sides.map(function (s) { return parseFloat(cs["border" + s + "Width"]) || 0; });
    var maxWidth = Math.max.apply(null, widths);
    if (maxWidth <= 0) return null;
    var styles = sides.map(function (s) { return cs["border" + s + "Style"]; });
    if (styles.every(function (s) { return s === "none" || s === "hidden"; })) return null;
    // Read the colour from a side that actually has width: an element with
    // only a bottom border still reports border-top-color as currentColor.
    var colour = null;
    for (var i = 0; i < sides.length; i++) {
      if (widths[i] > 0 && styles[i] !== "none" && styles[i] !== "hidden") {
        colour = rgba(cs["border" + sides[i] + "Color"]);
        if (colour) break;
      }
    }
    var all = widths.every(function (w) { return Math.abs(w - widths[0]) < 0.01 && w > 0; });
    return {
      width: maxWidth,
      colour: colour ? colour.hex : "FFFFFF",
      alpha: colour ? colour.alpha : 1,
      sides: all ? "all" : widths.map(function (w, i) { return w > 0 ? sides[i].toLowerCase() : null; }).filter(Boolean)
    };
  }

  function measureSlide(slide) {
    var origin = slide.getBoundingClientRect();
    var scs = getComputedStyle(slide);
    var pad = {
      top: parseFloat(scs.paddingTop) || 0,
      right: parseFloat(scs.paddingRight) || 0,
      bottom: parseFloat(scs.paddingBottom) || 0,
      left: parseFloat(scs.paddingLeft) || 0
    };
    var atoms = [];

    // Chrome — the footer and its page indicator — sits in the slide's
    // margin on purpose. It is exported like anything else, but it must not
    // count towards the content extent or every slide reports an overflow.
    var inChrome = false;
    function push(atom) { atom.chrome = inChrome; atoms.push(atom); }

    function visit(el) {
      // The nav chevrons are a screen affordance, not deck content: nothing
      // clicks them in a PDF or a .pptx. (The theme runtime also hides one of
      // the pair at load time, so measuring them exported a lone arrow.)
      if (el.classList && (el.classList.contains("nav-prev") || el.classList.contains("nav-next"))) return;

      var cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return;

      var rect = el.getBoundingClientRect();
      var box = {
        x: rect.left - origin.left,
        y: rect.top - origin.top,
        w: rect.width,
        h: rect.height
      };

      if (el.tagName === "IMG") {
        push({ kind: "image", box: box, src: el.getAttribute("src"), alt: el.getAttribute("alt") || "" });
        return;
      }

      // A painted box: a background, a border, or both.
      var fill = rgba(cs.backgroundColor);
      var border = borderOf(cs);
      if ((fill || border) && box.w > 0 && box.h > 0 && !el.classList.contains("slide")) {
        push({
          kind: "box",
          box: box,
          fill: fill ? fill.hex : null,
          fillAlpha: fill ? fill.alpha : 0,
          border: border,
          radius: parseFloat(cs.borderTopLeftRadius) || 0,
          cls: el.className || ""
        });
      }

      if (isTextLeaf(el)) {
        var runs = runsOf(el);
        if (runs.length) {
          var lineHeight = cs.lineHeight === "normal"
            ? parseFloat(cs.fontSize) * 1.2
            : parseFloat(cs.lineHeight);
          push({
            kind: "text",
            box: box,
            runs: runs,
            align: cs.textAlign,
            lineHeight: lineHeight,
            fontSize: parseFloat(cs.fontSize),
            cls: el.className || "",
            tag: el.tagName.toLowerCase()
          });
        }
        return;
      }

      for (var i = 0; i < el.children.length; i++) visit(el.children[i]);
    }

    for (var i = 0; i < slide.children.length; i++) {
      var child = slide.children[i];
      if (child.classList && child.classList.contains("notes")) continue;
      inChrome = !!(child.classList && child.classList.contains("slide-footer"));
      visit(child);
    }
    inChrome = false;

    // Content extent, for the overflow report.
    var maxX = 0, maxY = 0, minX = 1e9, minY = 1e9;
    atoms.forEach(function (a) {
      if (a.chrome) return;
      maxX = Math.max(maxX, a.box.x + a.box.w);
      maxY = Math.max(maxY, a.box.y + a.box.h);
      minX = Math.min(minX, a.box.x);
      minY = Math.min(minY, a.box.y);
    });

    return {
      id: slide.id || null,
      spine: parseInt(slide.getAttribute("data-spine") || "0", 10),
      detail: parseInt(slide.getAttribute("data-detail") || "0", 10),
      layout: (slide.className.match(/layout-([a-z0-9-]+)/) || [null, null])[1],
      classes: slide.className,
      background: rgba(getComputedStyle(slide).backgroundColor),
      notes: (function () {
        var aside = slide.querySelector(".notes");
        return aside ? aside.textContent.replace(/\\s+/g, " ").trim() : "";
      })(),
      padding: pad,
      extent: { minX: minX === 1e9 ? 0 : minX, minY: minY === 1e9 ? 0 : minY, maxX: maxX, maxY: maxY },
      atoms: atoms
    };
  }

  function run() {
    var docEl = document.documentElement;
    // Measure at the design size, not at whatever the window happens to be.
    docEl.style.setProperty("--sdoc-slide-scale", "1");

    var slides = Array.prototype.slice.call(document.querySelectorAll(".slide"));
    var box = { w: 0, h: 0 };
    var out = [];

    slides.forEach(function (slide) {
      var wasActive = slide.classList.contains("active");
      slide.classList.add("active");
      // Park the slide at the origin, unscaled, so measurement is in design px.
      var prior = slide.getAttribute("style") || "";
      slide.setAttribute("style", prior + ";position:absolute;top:0;left:0;transform:none;");
      box.w = Math.max(box.w, slide.offsetWidth);
      box.h = Math.max(box.h, slide.offsetHeight);
      out.push(measureSlide(slide));
      slide.setAttribute("style", prior);
      if (!wasActive) slide.classList.remove("active");
    });

    var payload = { box: box, slides: out };
    var el = document.createElement("script");
    el.type = "application/json";
    el.id = "sdoc-geometry";
    el.textContent = JSON.stringify(payload) + "\\n/*${SENTINEL}*/";
    document.body.appendChild(el);
  }

  function start() {
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(function () { requestAnimationFrame(run); });
    } else {
      requestAnimationFrame(run);
    }
  }

  if (document.readyState === "complete") start();
  else window.addEventListener("load", start);
})();
`;

// Runs Chrome with --dump-dom, waiting for the sentinel rather than for the
// process to exit: Chrome flushes the DOM promptly but does not always exit on
// its own, so waiting on exit adds tens of seconds to every build.
function dumpDom(chrome, fileUrl, outPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-geom-"));
    const out = fs.openSync(outPath, "w");

    const child = spawn(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--hide-scrollbars",
        "--window-size=1920,1080",
        // --dump-dom serialises the page once and does not wait for async
        // work. The measurement waits for webfonts, because text measured in
        // a fallback face is the wrong size, so the page must be held open
        // past that: a virtual-time budget fast-forwards timers and delays
        // the dump until the budget is spent.
        "--virtual-time-budget=8000",
        "--user-data-dir=" + profile,
        "--dump-dom",
        fileUrl,
      ],
      { stdio: ["ignore", out, "ignore"] }
    );

    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(limit);
      try { fs.closeSync(out); } catch {}
      try { child.kill("SIGKILL"); } catch {}
      fs.rm(profile, { recursive: true, force: true }, () => {});
      err ? reject(err) : resolve(value);
    };

    const poll = setInterval(() => {
      let text = "";
      try { text = fs.readFileSync(outPath, "utf-8"); } catch { return; }
      if (text.includes(SENTINEL)) finish(null, text);
    }, 120);

    const limit = setTimeout(
      () => finish(new Error(`Chrome did not report slide geometry within ${timeoutMs} ms`)),
      timeoutMs
    );


    child.on("error", (err) => finish(err));
    child.on("exit", () => {
      // Chrome exited. Give the pipe a moment to drain before deciding it
      // never reported: under load the last write can land after the exit.
      setTimeout(() => {
        let text = "";
        try { text = fs.readFileSync(outPath, "utf-8"); } catch {}
        if (text.includes(SENTINEL)) finish(null, text);
        else finish(new Error("Chrome exited before reporting slide geometry"));
      }, 400);
    });
  });
}

// Measures a built deck. `htmlPath` must be a file the browser can open with
// its relative assets intact, so the caller writes the temp copy beside the
// original rather than in the system temp directory.
async function harvestGeometry(htmlPath, options = {}) {
  const chrome = findChrome();
  if (!chrome) {
    throw new Error(
      "Chrome/Chromium not found. Install Google Chrome or set CHROME_PATH environment variable."
    );
  }

  const resolved = path.resolve(htmlPath);
  const html = fs.readFileSync(resolved, "utf-8");
  const injected = html.replace(/<\/body>/i, `<script>${MEASURE_SCRIPT}</script>\n</body>`);

  const dir = path.dirname(resolved);
  const stamp = Date.now();
  const tmpHtml = path.join(dir, `.sdoc-geometry-${stamp}.html`);
  fs.writeFileSync(tmpHtml, injected, "utf-8");

  // A browser measuring a page is not a fast, reliable operation when the
  // machine is busy: another Chrome on the same box (a parallel test run, a
  // CI job doing something else) delays startup and the virtual-time budget
  // past a fixed deadline, and every attempt then fails identically. So the
  // window grows with each attempt rather than staying put — a contended run
  // gets the time it needs, and only a genuinely broken page spends the lot.
  const attempts = options.attempts || 3;
  const baseTimeout = options.timeoutMs || 30000;
  let lastError = null;

  try {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const tmpOut = path.join(os.tmpdir(), `sdoc-geometry-${stamp}-${attempt}.dom`);
      try {
        // Give the previous attempt's Chrome time to exit and release the
        // machine before competing with it.
        if (attempt > 1) await new Promise((r) => setTimeout(r, 500 * (attempt - 1)));
        const dom = await dumpDom(chrome, "file://" + tmpHtml, tmpOut, baseTimeout * attempt);
        const match = dom.match(
          new RegExp(
            '<script type="application/json" id="sdoc-geometry">([\\s\\S]*?)\\n/\\*' + SENTINEL + '\\*/'
          )
        );
        if (!match) {
          const tail = dom.slice(-160).replace(/\s+/g, " ");
          throw new Error(`the page was serialised before it reported its geometry; DOM ended: ...${tail}`);
        }
        // --dump-dom serialises the script body with HTML entities escaped.
        const json = match[1]
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"');
        return JSON.parse(json);
      } catch (err) {
        lastError = err;
      } finally {
        try { fs.unlinkSync(tmpOut); } catch {}
      }
    }
    throw new Error(
      `${lastError.message} (${attempts} attempts; another browser running on this ` +
        `machine can delay the measurement past the deadline)`
    );
  } finally {
    try { fs.unlinkSync(tmpHtml); } catch {}
  }
}

// Slides whose content runs outside where it belongs.
//
// Two thresholds. Content past the design box is *clipped* — it is not in the
// PDF or the export at all. Content merely past the slide's own padding has
// broken out of the margin the theme reserved: it still renders, but it
// collides with the footer or runs to the edge, which is a defect the author
// has to see. Pass { strict: false } to report only clipping.
function overflowReport(geometry, options = {}) {
  const tolerance = options.tolerance !== undefined ? options.tolerance : 1;
  const strict = options.strict !== false;
  const { box, slides } = geometry;
  const findings = [];

  for (const slide of slides) {
    // A slide with no content atoms has no extent to compare. Its extent
    // reads as all zeros, which would otherwise be reported as content
    // sitting outside the left and top margins.
    if (!slide.atoms.some((a) => !a.chrome)) continue;

    const pad = slide.padding || { top: 0, right: 0, bottom: 0, left: 0 };
    const limits = strict
      ? { left: pad.left, top: pad.top, right: box.w - pad.right, bottom: box.h - pad.bottom }
      : { left: 0, top: 0, right: box.w, bottom: box.h };

    const over = [];
    const check = (amount, edge) => {
      if (amount > tolerance) {
        const clipped =
          (edge === "right" && slide.extent.maxX > box.w + tolerance) ||
          (edge === "bottom" && slide.extent.maxY > box.h + tolerance) ||
          (edge === "left" && slide.extent.minX < -tolerance) ||
          (edge === "top" && slide.extent.minY < -tolerance);
        over.push(`${edge} by ${Math.round(amount)}px${clipped ? " (clipped)" : ""}`);
      }
    };

    check(slide.extent.maxX - limits.right, "right");
    check(slide.extent.maxY - limits.bottom, "bottom");
    check(limits.left - slide.extent.minX, "left");
    check(limits.top - slide.extent.minY, "top");

    if (over.length) {
      findings.push({
        slide: slide.detail ? `${slide.spine}.${slide.detail}` : String(slide.spine),
        id: slide.id,
        layout: slide.layout,
        over,
      });
    }
  }
  return findings;
}

module.exports = { harvestGeometry, overflowReport, MEASURE_SCRIPT };
