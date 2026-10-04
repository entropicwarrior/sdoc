// SDOC — baking a background fade into the picture, for the formats that
// leave the browser.
//
// `background-fade` is a CSS `mask-image` with a transparent colour stop. In
// Chrome's PDF that becomes a graphics-state soft mask of type /S /Alpha, and
// Quartz — macOS Preview and Quick Look — renders it as a hard edge where the
// fade should be. Chrome, Ghostscript and Acrobat are all fine, but Preview is
// what opens when someone double-clicks an emailed deck, so the deck is wrong
// for the reader it was sent to.
//
// The fix is to stop asking the PDF to do the fade. For an export we paint the
// picture, its fade and the slide's own background colour into one canvas and
// hand the result over as a flat image. Two ways, in order of preference:
//
//   ground  — composite onto the slide's background colour and emit an opaque
//             JPEG. No alpha survives, so nothing can misrender, and Chrome
//             JPEG-encodes it: the PDF comes out *smaller* than the masked
//             original. This needs the ground to be an opaque flat colour.
//   alpha   — keep the fade in the image's own alpha channel and emit a PNG.
//             Correct over any ground, but Chrome refuses to JPEG-encode an
//             image carrying alpha, so it stores the colour channels losslessly
//             and the PDF grows several times over. The fallback, not the plan.
//
// Measured on one full-bleed photo slide at 1920x1080: CSS mask 505KB of PDF
// and two soft masks; ground 418KB and none; alpha 4.04MB and none.
//
// The HTML build does not come through here at all. A browser renders the CSS
// mask correctly, so the deck you present from keeps the real mask, stays small
// and needs no browser to build.

const { runHarvest, SENTINEL } = require("./slide-geometry");

// The browser half. Written as a real function and serialised with toString()
// rather than held in a template literal: a template literal eats any escape
// it does not recognise, so a `\s` in a regex here would arrive in the page as
// a bare `s` and silently change what the code matches. This way the backslashes
// are the parser's problem, not a string's.
function bakeInPage(sentinel) {
  var REPORT_ID = "sdoc-fade-bake";

  function report(payload) {
    var el = document.createElement("script");
    el.type = "application/json";
    el.id = REPORT_ID;
    el.textContent = JSON.stringify(payload) + "\n/*" + sentinel + "*/";
    document.body.appendChild(el);
  }

  // The computed background-color is "rgb(...)" when it is fully opaque and
  // "rgba(..., a)" otherwise, so the shorter form is itself the answer.
  function isOpaqueColour(colour) {
    if (/^rgb\(/.test(colour)) return true;
    var m = /^rgba\([^)]*,\s*([0-9.]+)\s*\)$/.exec(colour);
    return !!m && parseFloat(m[1]) >= 1;
  }

  // "matrix(a, b, c, d, e, f)", "matrix3d(...)" or "none". Only the 2D part
  // can matter here: the renderer emits scale() and translate(), nothing else.
  function transformMatrix(value) {
    if (!value || value === "none") return null;
    var nums = value.match(/-?[0-9.e+]+/gi);
    if (!nums) return null;
    nums = nums.map(parseFloat);
    if (/^matrix3d/.test(value) && nums.length >= 16) {
      return [nums[0], nums[1], nums[4], nums[5], nums[12], nums[13]];
    }
    return nums.length >= 6 ? nums.slice(0, 6) : null;
  }

  function originPx(value, w, h) {
    var parts = String(value || "").trim().split(/\s+/);
    return [lengthPx(parts[0], w), lengthPx(parts[1], h)];
  }

  function lengthPx(token, basis) {
    if (token === undefined) return basis / 2;
    var pct = /^(-?[0-9.]+)%$/.exec(token);
    if (pct) return (parseFloat(pct[1]) / 100) * basis;
    var px = parseFloat(token);
    return isFinite(px) ? px : basis / 2;
  }

  // Where the image's pixels land inside its own box, which is what object-fit
  // and object-position decide. The box itself is positioned by the caller.
  function fitRect(img, cs, bw, bh) {
    var nw = img.naturalWidth, nh = img.naturalHeight;
    var fit = cs.objectFit || "fill";
    var w, h, s;
    if (fit === "cover") {
      s = Math.max(bw / nw, bh / nh); w = nw * s; h = nh * s;
    } else if (fit === "contain") {
      s = Math.min(bw / nw, bh / nh); w = nw * s; h = nh * s;
    } else if (fit === "scale-down") {
      s = Math.min(1, Math.min(bw / nw, bh / nh)); w = nw * s; h = nh * s;
    } else if (fit === "none") {
      w = nw; h = nh;
    } else {
      w = bw; h = bh;
    }
    var pos = String(cs.objectPosition || "50% 50%").trim().split(/\s+/);
    return {
      x: offsetFor(pos[0], bw - w),
      y: offsetFor(pos[1] === undefined ? pos[0] : pos[1], bh - h),
      w: w,
      h: h
    };
  }

  // A percentage aligns the image in the free space; a length is the offset
  // itself. Both are what CSS means by object-position.
  function offsetFor(token, free) {
    var pct = /^(-?[0-9.]+)%$/.exec(String(token));
    if (pct) return (parseFloat(pct[1]) / 100) * free;
    var px = parseFloat(token);
    return isFinite(px) ? px : free / 2;
  }

  // The fade, rebuilt as a canvas gradient from the spec the renderer wrote
  // into data-fade — not parsed back out of the computed mask-image, which
  // Chrome normalises (an angle of 180deg disappears entirely, because it is
  // the default `to bottom`).
  //
  // CSS allows a colour stop outside 0%-100%; a canvas gradient does not. So
  // the gradient line is extended to cover whatever range the stops ask for
  // and the stops are renormalised onto it, which is exact rather than clamped.
  function buildGradient(ctx, spec, w, h) {
    var f = spec.from / 100;
    var t = spec.to / 100;
    var cMax = "rgba(0,0,0," + spec.max + ")";
    var cMin = "rgba(0,0,0," + spec.min + ")";

    if (spec.shape === "radial") {
      var cx = (spec.x / 100) * w;
      var cy = (spec.y / 100) * h;
      // `circle` with no size keyword is farthest-corner.
      var r = Math.max(
        Math.hypot(cx, cy), Math.hypot(w - cx, cy),
        Math.hypot(cx, h - cy), Math.hypot(w - cx, h - cy)
      );
      var hi = Math.max(1, f, t, 0.0001);
      var rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(r * hi, 0.0001));
      addStops(rg, f / hi, t / hi, cMax, cMin);
      return rg;
    }

    // CSS angles run clockwise from "to top", on a y-down canvas.
    var rad = ((spec.angle || 0) * Math.PI) / 180;
    var dx = Math.sin(rad);
    var dy = -Math.cos(rad);
    var len = Math.abs(w * dx) + Math.abs(h * dy);
    var cxl = w / 2, cyl = h / 2;
    var sx = cxl - (len / 2) * dx, sy = cyl - (len / 2) * dy;

    var lo = Math.min(0, f, t);
    var hiL = Math.max(1, f, t);
    var span = hiL - lo || 1;
    var p0x = sx + lo * len * dx, p0y = sy + lo * len * dy;
    var p1x = sx + hiL * len * dx, p1y = sy + hiL * len * dy;
    var lg = ctx.createLinearGradient(p0x, p0y, p1x, p1y);
    addStops(lg, (f - lo) / span, (t - lo) / span, cMax, cMin);
    return lg;
  }

  function addStops(gradient, a, b, colourA, colourB) {
    var lo = Math.min(Math.max(a, 0), 1);
    var hi = Math.min(Math.max(b, 0), 1);
    if (hi < lo) { var tmp = lo; lo = hi; hi = tmp; tmp = colourA; colourA = colourB; colourB = tmp; }
    gradient.addColorStop(lo, colourA);
    gradient.addColorStop(hi, colourB);
  }

  // An element's box in the wrapper's own coordinates, in layout pixels.
  //
  // getBoundingClientRect would be the obvious way and is the wrong one: this
  // runs in screen media, where the deck carries a fit-to-window scale on
  // .slide, so a rect comes back in scaled pixels while the canvas is the
  // unscaled design box. offsetLeft/offsetWidth are layout values that no
  // transform touches, which is also exactly the pre-transform box that
  // object-fit resolves against.
  function layoutBox(el, ancestor) {
    var x = 0, y = 0, node = el;
    while (node && node !== ancestor) {
      x += node.offsetLeft;
      y += node.offsetTop;
      node = node.offsetParent;
    }
    return { x: x, y: y, w: el.offsetWidth, h: el.offsetHeight };
  }

  // Paint the picture exactly where the browser has it: the layout box places
  // it, then the element's own transform is replayed onto the canvas on top.
  function drawPlaced(ctx, wrap, img) {
    var flip = img.parentElement &&
      img.parentElement.classList &&
      img.parentElement.classList.contains("slide-bg-flip")
      ? img.parentElement : null;

    var imgCs = getComputedStyle(img);
    var imgM = transformMatrix(imgCs.transform);
    var box = layoutBox(img, wrap);

    ctx.save();
    if (flip) {
      var flipCs = getComputedStyle(flip);
      var flipM = transformMatrix(flipCs.transform);
      var flipBox = layoutBox(flip, wrap);
      if (flipM) {
        applyMatrix(ctx, flipM, originPx(flipCs.transformOrigin, flipBox.w, flipBox.h), flipBox);
      }
    }
    if (imgM) {
      applyMatrix(ctx, imgM, originPx(imgCs.transformOrigin, box.w, box.h), box);
    }
    // object-fit clips to the content box, and so must this.
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.w, box.h);
    ctx.clip();
    var d = fitRect(img, imgCs, box.w, box.h);
    ctx.drawImage(img, box.x + d.x, box.y + d.y, d.w, d.h);
    ctx.restore();
  }

  function applyMatrix(ctx, m, origin, box) {
    var ox = box.x + origin[0];
    var oy = box.y + origin[1];
    ctx.translate(ox, oy);
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.translate(-ox, -oy);
  }

  function bakeOne(slide, wrap, img, spec, index, warnings) {
    var w = wrap.clientWidth;
    var h = wrap.clientHeight;
    if (!(w > 0 && h > 0)) {
      warnings.push("slide " + (index + 1) + ": background has no size, fade left as a CSS mask");
      return null;
    }

    var slideCs = getComputedStyle(slide);
    var ground = slideCs.backgroundColor;
    // A flat opaque colour is the only thing the picture can be composited
    // onto. A gradient or image behind it would show a visible rectangle where
    // the fade reached the ground, so that falls back to alpha instead.
    var groundIsFlat = (slideCs.backgroundImage || "none") === "none";
    var opaque = isOpaqueColour(ground) && groundIsFlat;

    var canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d");

    drawPlaced(ctx, wrap, img);

    ctx.globalCompositeOperation = "destination-in";
    ctx.fillStyle = buildGradient(ctx, spec, w, h);
    ctx.fillRect(0, 0, w, h);

    if (opaque) {
      ctx.globalCompositeOperation = "destination-over";
      ctx.fillStyle = ground;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.globalCompositeOperation = "source-over";

    if (!opaque) {
      warnings.push(
        "slide " + (index + 1) + ": the slide's background is " +
        (groundIsFlat ? "not opaque" : "not a flat colour") +
        ", so the fade is kept in the image's alpha channel. It will render " +
        "correctly, but the exported file will be substantially larger."
      );
    }

    return opaque
      ? canvas.toDataURL("image/jpeg", 0.92)
      : canvas.toDataURL("image/png");
  }

  function run() {
    var slides = Array.prototype.slice.call(document.querySelectorAll(".slide"));
    var baked = {};
    var warnings = [];

    slides.forEach(function (slide, index) {
      var wrap = slide.querySelector(".slide-bg[data-fade]");
      if (!wrap) return;
      var spec;
      try {
        spec = JSON.parse(wrap.getAttribute("data-fade"));
      } catch (err) {
        warnings.push("slide " + (index + 1) + ": unreadable fade, left as a CSS mask");
        return;
      }
      var img = wrap.querySelector("img");
      if (!img || !img.complete || !img.naturalWidth) {
        warnings.push("slide " + (index + 1) + ": background image did not load, fade left as a CSS mask");
        return;
      }

      // Only the active slide has a size; the rest are display:none.
      var wasActive = slide.classList.contains("active");
      if (!wasActive) slide.classList.add("active");
      try {
        var url = bakeOne(slide, wrap, img, spec, index, warnings);
        if (url) baked[index] = url;
      } catch (err) {
        warnings.push("slide " + (index + 1) + ": fade could not be baked (" + err + ")");
      }
      if (!wasActive) slide.classList.remove("active");
    });

    report({
      baked: baked,
      warnings: warnings,
      // What the page actually saw. Without these, a page that never rendered
      // reports exactly what a deck with no fades reports — an empty result —
      // and the export ships the unbaked mask without a word.
      slides: slides.length,
      found: document.querySelectorAll(".slide-bg[data-fade]").length
    });
  }

  function start() {
    // Every image is a data URI by this point, but decoding still has to finish
    // before a canvas can draw it.
    var pending = Array.prototype.slice
      .call(document.querySelectorAll(".slide-bg[data-fade] img"))
      .filter(function (img) { return !img.complete; });
    if (!pending.length) { run(); return; }
    var left = pending.length;
    var done = function () { if (--left <= 0) run(); };
    pending.forEach(function (img) {
      img.addEventListener("load", done);
      img.addEventListener("error", done);
    });
  }

  if (document.readyState === "complete") start();
  else window.addEventListener("load", start);
}

const BAKE_SCRIPT =
  "(" + bakeInPage.toString() + ")(" + JSON.stringify(SENTINEL) + ");";

// Runs the bake over a built deck and returns what the page produced:
// `baked` maps a slide's index to a data URI that already contains the fade,
// `warnings` is prose for the caller to print.
async function bakeFades(htmlPath, options = {}) {
  const fs = require("fs");
  const html = fs.readFileSync(htmlPath, "utf-8");
  const expected = (html.match(/ data-fade="/g) || []).length;

  const data = await runHarvest(htmlPath, BAKE_SCRIPT, "sdoc-fade-bake", options);
  const baked = (data && data.baked) || {};
  const warnings = ((data && data.warnings) || []).slice();

  // Reconcile against the file rather than trusting the page. A browser that
  // was still painting reports no fades at all, which is indistinguishable
  // from a deck that has none — and the export would then quietly keep the
  // mask that sent us here. Every fade is accounted for or said out loud.
  const done = Object.keys(baked).length;
  const seen = data && typeof data.found === "number" ? data.found : null;
  if (done < expected) {
    const missed = expected - done;
    warnings.push(
      `${missed} of ${expected} background fade(s) were not baked` +
      (seen !== null && seen < expected
        ? ` — the page reported only ${seen} of them, so it was probably still rendering`
        : "") +
      ". Those slides keep the CSS mask, which macOS Preview renders as a hard edge."
    );
  }

  return { baked, warnings, expected, baked_count: done };
}

// Cheap enough to ask before launching a browser: a deck with no fade has
// nothing to bake and should not pay for Chrome.
function hasFades(html) {
  return / data-fade="/.test(html);
}

module.exports = { bakeFades, hasFades, BAKE_SCRIPT };
