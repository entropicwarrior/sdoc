// SDOC Slides — export to a Claude Slides artifact.
//
// A fourth target beside HTML, PDF and PPTX. The artifact is an *editing*
// surface: a teammate opens the deck, rewrites a line, and the column it sits
// in grows to fit. That is the whole point, and it is why this exporter does
// not reuse the PPTX route.
//
// PPTX is built from slide-geometry.js's flat list of atoms, each an
// absolutely positioned box. That is right for PowerPoint, where every shape
// is loose by design, and wrong here twice over: edited text would overlap its
// neighbours because nothing reflows, and the subset caps a container at 24
// positioned children and a slide at 200 elements, which a harvested slide
// passes routinely.
//
// So this harvests the DOM *tree* rather than a list of boxes. The renderer
// already emits semantic HTML — nested flex containers, headings, paragraphs —
// and the subset allows display:flex, gap, padding and flex, so the structure
// maps across almost one to one. The browser resolves the theme's cascade and
// hands back computed values; this file turns those into inline styles. Every
// layout the renderer can emit therefore exports, including ones added later,
// without a per-layout template here to drift out of step.
//
// Zero dependencies. The subset itself lives in slide-artifact-validate.js.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { runHarvest, SENTINEL } = require("./slide-geometry");
const {
  CANVAS,
  BASIC_FACES,
  GENERIC_FACES,
  RE_ID,
  MIN_FONT_SIZE,
  MAX_NOTES,
  MAX_PINNED_PER_HOST,
  validateSlideHtml,
  validateDeckJson,
  PROPS_FOR_TAG,
  srgbToRgba,
} = require("./slide-artifact-validate");

// ---------------------------------------------------------------------------
// The browser half
//
// Walks each slide and returns a tree of the elements that carry meaning, with
// the computed value of every property the subset understands. Runs in the
// page, so it is ES5 and self-contained.
// ---------------------------------------------------------------------------

const ARTIFACT_SCRIPT = `
(function () {
  // Only what the subset can express. Anything else is resolved by the browser
  // and then deliberately thrown away.
  var BOX = ["display","flexDirection","flexWrap","gap","alignItems","justifyContent",
             "gridTemplateColumns","gridTemplateRows","paddingTop","paddingRight",
             "paddingBottom","paddingLeft","backgroundColor","backgroundImage",
             "borderTopWidth","borderRightWidth","borderBottomWidth","borderLeftWidth",
             "borderTopStyle","borderRightStyle","borderBottomStyle","borderLeftStyle",
             "borderTopColor","borderRightColor","borderBottomColor","borderLeftColor",
             "borderTopLeftRadius","opacity","flexGrow","flexShrink","flexBasis",
             "marginTop","marginRight","marginBottom","marginLeft","position"];
  var TYPE = ["fontFamily","fontSize","fontWeight","fontStyle","lineHeight",
              "letterSpacing","textAlign","textTransform","whiteSpace","color"];

  function px(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }

  function styleOf(cs) {
    var out = {};
    var i;
    for (i = 0; i < BOX.length; i++) out[BOX[i]] = cs[BOX[i]];
    for (i = 0; i < TYPE.length; i++) out[TYPE[i]] = cs[TYPE[i]];
    return out;
  }

  function transformText(text, mode) {
    if (mode === "uppercase") return text.toUpperCase();
    if (mode === "lowercase") return text.toLowerCase();
    if (mode === "capitalize") return text.replace(/\\b\\w/g, function (c) { return c.toUpperCase(); });
    return text;
  }

  // A text leaf holds text and no block-level child, the same test the
  // geometry harvest uses — including its recursion through display:contents.
  // Without that recursion the wrappers the renderer makes transparent
  // (.slide-content-scale, .slide-head, .slide-body) look like leaves, and a
  // whole slide collapses into one paragraph.
  // The first family in a stack, which is what actually gets used.
  function firstFace(stack) {
    return String(stack || "").split(",")[0].trim().replace(/^["']|["']$/g, "").toLowerCase();
  }

  // A non-whitespace text node sitting directly inside the element.
  function hasLooseText(el) {
    for (var i = 0; i < el.childNodes.length; i++) {
      var k = el.childNodes[i];
      if (k.nodeType === 3 && k.nodeValue && k.nodeValue.trim()) return true;
    }
    return false;
  }

  function isTextLeaf(el) {
    if (!el.textContent || !el.textContent.trim()) return false;
    var own = getComputedStyle(el);
    // A box that arranges its children is not a run of text, whatever those
    // children are. Treating a flex row of marks as a text leaf emits it as a
    // <p>, and the subset allows display/gap/align-items on a section or a div
    // and nowhere else — so the row arrives stacked. It has to be a div.
    if (own.display === "flex" || own.display === "grid" ||
        own.display === "inline-flex" || own.display === "inline-grid") {
      if (el.children.length > 0) return false;
    }
    for (var i = 0; i < el.children.length; i++) {
      var child = el.children[i];
      var cs = getComputedStyle(child);
      var d = cs.display;
      if (d === "contents") { if (!isTextLeaf(child)) return false; continue; }
      if (d !== "inline" && d !== "inline-block") return false;
      // The subset has no font-size or font-family on a span — "no sizes or
      // fonts on spans (use two blocks)" — so an inline mark set larger, or in
      // another face, is flattened to its parent's type: a 44px figure
      // rendering as 28px body text.
      //
      // The remedy is to let it be its own block, and that is only safe when
      // the mark IS the whole of its parent. This export emits flow, not pinned
      // boxes, so splitting a mark out of the middle of a sentence would stack
      // the words around it as separate paragraphs and break the line. A
      // standalone figure in its own paragraph becomes a block and looks
      // identical; a code span inside prose keeps its place and loses its size,
      // which is said out loud rather than silently done.
      var differs =
        Math.abs((parseFloat(cs.fontSize) || 0) - (parseFloat(own.fontSize) || 0)) > 0.5 ||
        firstFace(cs.fontFamily) !== firstFace(own.fontFamily);
      if (differs && el.children.length === 1 && !hasLooseText(el)) return false;
    }
    return true;
  }

  // Runs of text with their inline marks. The case is applied HERE, from each
  // run's own computed style, which is what keeps a unit correct: the renderer
  // wraps a unit in a span that opts out of text-transform, so that span is its
  // own run and comes back lower-case while the words around it are folded.
  // The subset has no text-transform on a span, so the case must be baked in.
  // The box is not the ink. A pinned text box positions the element, and what a
  // reader sees is the glyphs inside it — which a table cell's vertical
  // centring, or a negative text-indent, puts somewhere else. A Range over the
  // contents reports where the ink actually is.
  //
  // Both directions need a guard, and the second exists because the first
  // introduced a defect:
  //
  //   Vertically, a Range SHORTER than the box means the text really is centred
  //   inside it, so follow the ink. TALLER means the inline box overhangs the
  //   line box — which any line-height below the face's natural one does — and
  //   the Range's top then sits above the real one. Pinning a tight-leaded
  //   heading from its Range opens a visible gap beneath it.
  //
  //   Horizontally, only when the ink escapes the content box to the LEFT: a
  //   negative text-indent, or something hanging outside. Ink to the right of
  //   the content start is ordinary centring or alignment, and following it
  //   would re-pin centred text at its glyphs and shift it. Touches x and w
  //   only — assigning y here would quietly undo the decision above.
  function pinToInk(node, el, cs, rect, origin) {
    var ink;
    try {
      var range = document.createRange();
      range.selectNodeContents(el);
      ink = range.getBoundingClientRect();
    } catch (err) {
      return;
    }
    if (!ink || (!ink.width && !ink.height)) return;

    if (ink.height > 0 && ink.height < rect.height - 0.5) {
      node.box.y = ink.top - origin.top;
      node.box.h = ink.height;
    }

    var contentLeft = rect.left +
      (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.borderLeftWidth) || 0);
    if (ink.width > 0 && ink.left < contentLeft - 0.5) {
      node.box.x = ink.left - origin.left;
      node.box.w = ink.width;
    }
  }

  function runsOf(el, baseWeight) {
    var runs = [];
    var base = baseWeight || parseInt(getComputedStyle(el).fontWeight, 10) || 400;
    function walk(node, marks) {
      for (var i = 0; i < node.childNodes.length; i++) {
        var child = node.childNodes[i];
        if (child.nodeType === 3) {
          var cs = getComputedStyle(node);
          var raw = child.nodeValue.replace(/\\s+/g, " ");
          if (!raw) continue;
          runs.push({
            text: transformText(raw, cs.textTransform),
            bold: marks.bold || parseInt(cs.fontWeight, 10) > base,
            italic: marks.italic || cs.fontStyle === "italic",
            underline: marks.underline,
            href: marks.href,
            color: marks.color ? cs.color : null
          });
        } else if (child.nodeType === 1) {
          var cs2 = getComputedStyle(child);
          if (cs2.display === "none" || cs2.visibility === "hidden") continue;
          var tag = child.tagName.toLowerCase();
          if (tag === "br") { runs.push({ text: "\\n", br: true }); continue; }
          walk(child, {
            bold: marks.bold || tag === "b" || tag === "strong",
            italic: marks.italic || tag === "i" || tag === "em",
            underline: marks.underline || tag === "u",
            href: marks.href || (tag === "a" ? child.getAttribute("href") : null),
            // A span the renderer coloured, or one it used to protect a unit:
            // either way its own colour is worth keeping.
            color: marks.color || tag === "span" || tag === "code"
          });
        }
      }
    }
    walk(el, { bold: false, italic: false, underline: false, href: null, color: false });
    return runs.filter(function (r) { return r.br || r.text.trim().length || r.text === " "; });
  }

  // A pseudo-element that paints has no node to harvest. The built-in theme
  // uses none, but a theme in the wild might, so say so rather than silently
  // dropping a rule or a numeral.
  // A pseudo-element has no node, so a walk cannot see it — and a theme that
  // paints a rule, a spur or a disk with one has drawn something the reader
  // sees. Worse than a missing mark: a pseudo-element occupies space, so
  // dropping it also *displaces* whatever shared its box.
  //
  // There is no element to measure, so the box is reconstructed from the
  // computed style. An absolutely positioned one is placed from left/top
  // against its containing block; an in-flow one sits at the start of the
  // host's content box, centred on the line. Its own transform is then
  // applied, because a translate(-50%,-50%) is what puts a disk *on* a line
  // rather than beside it.
  function pseudoBoxes(el, hostRect, origin) {
    var out = [];
    var names = ["::before", "::after"];
    for (var i = 0; i < names.length; i++) {
      var cs = getComputedStyle(el, names[i]);
      if (!cs || cs.content === "none" || cs.content === "normal") continue;

      var fill = cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)";
      var edge = px(cs.borderTopWidth) > 0 || px(cs.borderBottomWidth) > 0 ||
                 px(cs.borderLeftWidth) > 0 || px(cs.borderRightWidth) > 0;
      var words = cs.content && cs.content !== '""' && cs.content !== "''";
      if (!fill && !edge && !words) continue;

      var w = px(cs.width), h = px(cs.height);
      var rec = { pseudo: names[i], words: !!words, painted: !!(fill || edge) };

      if (w > 0 && h > 0 && (fill || edge)) {
        var x, y;
        if (cs.position === "absolute" || cs.position === "fixed") {
          var cb = el;
          while (cb && cb.parentElement && getComputedStyle(cb).position === "static") {
            cb = cb.parentElement;
          }
          var cbRect = (cb || el).getBoundingClientRect();
          x = cbRect.left + (px(cs.left) || 0);
          y = cbRect.top + (px(cs.top) || 0);
        } else {
          x = hostRect.left + (px(getComputedStyle(el).paddingLeft) || 0);
          y = hostRect.top + (hostRect.height - h) / 2;
        }
        var m = (cs.transform || "none").match(/-?[0-9.e+]+/gi);
        if (m && m.length >= 6 && cs.transform.indexOf("matrix") === 0) {
          x += parseFloat(m[m.length === 16 ? 12 : 4]) || 0;
          y += parseFloat(m[m.length === 16 ? 13 : 5]) || 0;
        }
        rec.box = { x: x - origin.left, y: y - origin.top, w: w, h: h };
        rec.style = styleOf(cs);
      }
      out.push(rec);
    }
    return out;
  }

  // A run of text with no element of its own. It still has a position — a Range
  // over it reports one — so it can be carried as a text node like any other.
  function looseText(textNode, host, origin) {
    if (!textNode.nodeValue || !textNode.nodeValue.trim()) return null;
    var rect;
    try {
      var range = document.createRange();
      range.selectNode(textNode);
      rect = range.getBoundingClientRect();
    } catch (err) {
      return null;
    }
    if (!rect || (!rect.width && !rect.height)) return null;
    var cs = getComputedStyle(host);
    return {
      tag: "p",
      cls: "",
      roleCls: "",
      style: styleOf(cs),
      box: { x: rect.left - origin.left, y: rect.top - origin.top, w: rect.width, h: rect.height },
      children: [],
      runs: [{
        text: transformText(textNode.nodeValue.replace(/\\s+/g, " "), cs.textTransform),
        bold: parseInt(cs.fontWeight, 10) > 400,
        italic: cs.fontStyle === "italic",
        underline: false,
        href: null,
        color: null
      }]
    };
  }

  // Three things the subset cannot say about a picture, all fixed the same way:
  // by painting it rather than describing it.
  //
  //   object-fit is only cover or contain here, so fill, none and
  //   scale-down have to be approximated — and approximating fill as cover
  //   crops and zooms a picture that was meant to be squashed.
  //
  //   filter: drop-shadow follows the alpha channel; box-shadow follows the
  //   element's rectangle. Translating one into the other draws a hard box
  //   around a cut-out that has not got one.
  //
  //   transform allows only scale(N) with N between 0.5 and 2, so a mirror
  //   cannot be expressed at all.
  //
  // A canvas does all three exactly: drawn at the box's own size it *is* fill,
  // its shadows follow alpha as the filter does, and it can be flipped.

  // "drop-shadow(rgba(0, 0, 0, 0.55) 0px 1px 3px) drop-shadow(...)" — scanned by
  // paren depth, because a value with rgba() inside it has parentheses of its
  // own and a flat pattern stops at the first one it meets.
  function parseDropShadows(filter) {
    var specs = [];
    var text = String(filter || "");
    var head = "drop-shadow(";
    var i = 0;
    while (true) {
      var at = text.indexOf(head, i);
      if (at < 0) break;
      var start = at + head.length;
      var depth = 1;
      var j = start;
      while (j < text.length && depth > 0) {
        var ch = text.charAt(j);
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        j++;
      }
      specs.push(text.slice(start, j - 1));
      i = j;
    }
    var out = [];
    for (var k = 0; k < specs.length; k++) {
      var one = parseOneShadow(specs[k]);
      if (one) out.push(one);
    }
    return out;
  }

  function parseOneShadow(spec) {
    var colour = null;
    var text = spec;
    var ci = text.indexOf("rgb");
    if (ci >= 0) {
      var open = text.indexOf("(", ci);
      if (open > 0) {
        var depth = 1;
        var k = open + 1;
        while (k < text.length && depth > 0) {
          var ch = text.charAt(k);
          if (ch === "(") depth++;
          else if (ch === ")") depth--;
          k++;
        }
        colour = text.slice(ci, k);
        text = text.slice(0, ci) + " " + text.slice(k);
      }
    }
    var nums = [];
    var parts = text.split(" ");
    for (var p = 0; p < parts.length; p++) {
      var tok = parts[p].trim();
      if (!tok) continue;
      var v = parseFloat(tok);
      if (isFinite(v)) nums.push(v);
      else if (!colour && tok.charAt(0) === "#") colour = tok;
    }
    if (nums.length < 2) return null;
    return {
      dx: nums[0], dy: nums[1], blur: nums[2] || 0,
      colour: colour || "rgba(0, 0, 0, 0.5)"
    };
  }

  // Does anything between this element and the slide mirror it? The subset has
  // no way to say so, so the pixels have to carry it.
  function mirrorOf(el, stopAt) {
    var sx = 1, sy = 1;
    var node = el;
    while (node && node !== stopAt) {
      var t = getComputedStyle(node).transform;
      if (t && t !== "none") {
        var n = t.match(/-?[0-9.e+]+/gi);
        if (n && n.length >= 6) {
          var threeD = t.indexOf("matrix3d") === 0;
          var a = parseFloat(n[0]);
          var d = parseFloat(n[threeD ? 5 : 3]);
          if (a < 0) sx = -sx;
          if (d < 0) sy = -sy;
        }
      }
      node = node.parentElement;
    }
    return { x: sx, y: sy };
  }

  // Where the pixels land inside the element's own box, which is what
  // object-fit and object-position decide. Done here rather than described,
  // because the subset knows only cover and contain.
  function drawFitted(ctx, el, cs, w, h) {
    var nw = el.naturalWidth, nh = el.naturalHeight;
    var fit = cs.objectFit || "fill";
    var dw, dh, sc;
    if (fit === "cover") { sc = Math.max(w / nw, h / nh); dw = nw * sc; dh = nh * sc; }
    else if (fit === "contain") { sc = Math.min(w / nw, h / nh); dw = nw * sc; dh = nh * sc; }
    else if (fit === "none") { dw = nw; dh = nh; }
    else if (fit === "scale-down") { sc = Math.min(1, Math.min(w / nw, h / nh)); dw = nw * sc; dh = nh * sc; }
    else { dw = w; dh = h; }
    var pos = String(cs.objectPosition || "50% 50%").trim().split(" ");
    var px = fitOffset(pos[0], w - dw);
    var py = fitOffset(pos[1] === undefined ? pos[0] : pos[1], h - dh);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
    ctx.drawImage(el, px, py, dw, dh);
    ctx.restore();
  }

  function fitOffset(token, free) {
    var t = String(token).trim();
    if (t.charAt(t.length - 1) === "%") return (parseFloat(t) / 100) * free;
    var v = parseFloat(t);
    return isFinite(v) ? v : free / 2;
  }

  function imageNeedsBake(el, cs) {
    var fit = cs.objectFit || "fill";
    if (fit !== "cover" && fit !== "contain") return true;
    if (String(cs.filter || "").indexOf("drop-shadow") >= 0) return true;
    var m = mirrorOf(el, el.closest(".slide"));
    return m.x < 0 || m.y < 0;
  }

  function bakeOne(el, cs, done) {
    try {
      if (!el.complete || !el.naturalWidth) { done(); return; }
      var slide = el.closest(".slide");
      var rect = el.getBoundingClientRect();
      var sRect = slide.getBoundingClientRect();
      var w = Math.max(1, Math.round(rect.width));
      var h = Math.max(1, Math.round(rect.height));

      var shadows = parseDropShadows(cs.filter);
      var pad = { l: 0, t: 0, r: 0, b: 0 };
      for (var i = 0; i < shadows.length; i++) {
        var sh = shadows[i];
        pad.l = Math.max(pad.l, Math.ceil(Math.max(0, sh.blur - sh.dx)));
        pad.t = Math.max(pad.t, Math.ceil(Math.max(0, sh.blur - sh.dy)));
        pad.r = Math.max(pad.r, Math.ceil(Math.max(0, sh.blur + sh.dx)));
        pad.b = Math.max(pad.b, Math.ceil(Math.max(0, sh.blur + sh.dy)));
      }
      // The padded picture becomes its own box, and the page clamps a negative
      // offset to 0 — which would slide the picture inwards rather than place
      // the shadow. Lose shadow at an edge instead of moving what casts it.
      pad.l = Math.min(pad.l, Math.max(0, Math.floor(rect.left - sRect.left)));
      pad.t = Math.min(pad.t, Math.max(0, Math.floor(rect.top - sRect.top)));
      pad.r = Math.min(pad.r, Math.max(0, Math.floor(sRect.right - rect.right)));
      pad.b = Math.min(pad.b, Math.max(0, Math.floor(sRect.bottom - rect.bottom)));

      var cw = w + pad.l + pad.r;
      var chh = h + pad.t + pad.b;
      var canvas = document.createElement("canvas");
      canvas.width = cw;
      canvas.height = chh;
      var ctx = canvas.getContext("2d");
      var mirror = mirrorOf(el, slide);

      var draw = function () {
        ctx.save();
        ctx.translate(pad.l + (mirror.x < 0 ? w : 0), pad.t + (mirror.y < 0 ? h : 0));
        ctx.scale(mirror.x, mirror.y);
        drawFitted(ctx, el, cs, w, h);
        ctx.restore();
      };

      // Each shadow is painted on its own, with the picture pushed clear of the
      // canvas so that only the shadow lands. That is what lets more than one
      // of them stack, and a canvas shadow follows the alpha channel exactly as
      // the filter does — which a box-shadow, following the rectangle, does not.
      var far = cw + 100;
      for (var k = 0; k < shadows.length; k++) {
        ctx.save();
        ctx.shadowColor = shadows[k].colour;
        ctx.shadowBlur = shadows[k].blur;
        ctx.shadowOffsetX = shadows[k].dx + far;
        ctx.shadowOffsetY = shadows[k].dy;
        ctx.translate(-far, 0);
        draw();
        ctx.restore();
      }
      draw();

      el.__sdocBaked = { src: canvas.toDataURL("image/png"), pad: pad, w: cw, h: chh };
    } catch (err) {
      // A tainted canvas, usually. Leave the picture as it was.
    }
    done();
  }

  function bakeImages(done) {
    document.documentElement.style.setProperty("--sdoc-slide-scale", "1");
    var slides = Array.prototype.slice.call(document.querySelectorAll(".slide"));
    var wasActive = slides.map(function (s) { return s.classList.contains("active"); });
    var priorStyle = slides.map(function (s) { return s.getAttribute("style") || ""; });
    // Exactly the arrangement the measuring pass uses. Switching the slides on
    // without also parking them at the origin leaves them stacked in normal
    // flow, where a slide sized against the viewport is a different height —
    // and a picture baked at that height is then placed at another one.
    slides.forEach(function (s, i) {
      s.classList.add("active");
      s.setAttribute("style", priorStyle[i] + ";position:absolute;top:0;left:0;transform:none;");
    });

    var targets = [];
    var imgs = document.querySelectorAll(".slide img");
    for (var i = 0; i < imgs.length; i++) {
      var el = imgs[i];
      if (el.closest && el.closest(".nav-prev, .nav-next, .nav-vert, .notes")) continue;
      var cs = getComputedStyle(el);
      if (imageNeedsBake(el, cs)) targets.push({ el: el, cs: cs });
    }

    var restore = function () {
      slides.forEach(function (s, i) {
        s.setAttribute("style", priorStyle[i]);
        if (!wasActive[i]) s.classList.remove("active");
      });
      done();
    };
    if (!targets.length) { restore(); return; }
    var left = targets.length;
    var one = function () { if (--left <= 0) restore(); };
    for (var t = 0; t < targets.length; t++) bakeOne(targets[t].el, targets[t].cs, one);
  }

  function slideTree(slide) {
    var origin = slide.getBoundingClientRect();
    var pseudos = [];

    function visit(el, inheritedCls) {
      var tag = el.tagName.toLowerCase();
      var cls = el.className && el.className.baseVal === undefined ? String(el.className) : "";
      // Screen furniture: nothing clicks a chevron in a published deck, and
      // notes are carried separately as the section's <aside>.
      if (/\\b(nav-prev|nav-next|nav-vert|notes)\\b/.test(cls)) return null;
      var cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return null;

      var rect = el.getBoundingClientRect();
      var node = {
        tag: tag,
        cls: cls,
        roleCls: cls || inheritedCls || "",
        style: styleOf(cs),
        box: { x: rect.left - origin.left, y: rect.top - origin.top, w: rect.width, h: rect.height },
        children: []
      };

      var ps = pseudoBoxes(el, rect, origin);
      for (var pi = 0; pi < ps.length; pi++) {
        ps[pi].cls = cls;
        ps[pi].tag = tag;
        pseudos.push(ps[pi]);
      }

      if (tag === "img") {
        node.alt = el.getAttribute("alt") || "";
        var baked = el.__sdocBaked;
        if (baked) {
          // The painted version: its fit, its mirror and its shadows are in the
          // pixels. The box grows by whatever room the shadows needed, and
          // moves back by the same amount so the picture itself stays put.
          node.src = baked.src;
          node.natural = { w: baked.w, h: baked.h };
          node.box = {
            x: node.box.x - baked.pad.l,
            y: node.box.y - baked.pad.t,
            w: baked.w,
            h: baked.h
          };
          node.exactFit = true;
        } else {
          node.src = el.getAttribute("src") || "";
          node.natural = { w: el.naturalWidth, h: el.naturalHeight };
          // The value CSS actually resolved, rather than a guess from the
          // aspect ratios — which crops a picture the theme asked to fill.
          node.fit = cs.objectFit || "";
        }
        return node;
      }
      if (tag === "svg") {
        node.svg = el.outerHTML;
        return node;
      }
      if (tag === "table") {
        node.rows = [];
        var trs = el.querySelectorAll("tr");
        for (var r = 0; r < trs.length; r++) {
          var cells = [];
          var tds = trs[r].children;
          for (var c = 0; c < tds.length; c++) {
            cells.push({
              tag: tds[c].tagName.toLowerCase(),
              runs: runsOf(tds[c]),
              style: styleOf(getComputedStyle(tds[c])),
              box: { w: tds[c].getBoundingClientRect().width }
            });
          }
          node.rows.push({ cells: cells, style: styleOf(getComputedStyle(trs[r])) });
        }
        return node;
      }
      if (tag === "ul" || tag === "ol") {
        node.items = [];
        for (var li = 0; li < el.children.length; li++) {
          if (el.children[li].tagName.toLowerCase() !== "li") continue;
          node.items.push({ runs: runsOf(el.children[li]) });
        }
        return node;
      }
      // display:contents removes the box but not the element, so a wrapper the
      // theme made transparent must not become a div here. Checked before the
      // leaf test: such a wrapper has no box of its own to style, whatever it
      // happens to contain.
      if (cs.display === "contents") {
        node.transparent = true;
      } else if (isTextLeaf(el)) {
        node.runs = runsOf(el);
        pinToInk(node, el, cs, rect, origin);
        return node;
      }

      // childNodes, not children: an element that is not a text leaf can still
      // hold bare text beside its element children — prose next to a figure,
      // or the words either side of a mark that had to be split out. The
      // walking only the element children skips every one of those, and the
      // only visible sign is that the slide got shorter.
      for (var i = 0; i < el.childNodes.length; i++) {
        var kid = el.childNodes[i];
        if (kid.nodeType === 3) {
          var loose = looseText(kid, el, origin);
          if (loose) node.children.push(loose);
        } else if (kid.nodeType === 1) {
          var child = visit(kid, cls || inheritedCls || "");
          if (child) node.children.push(child);
        }
      }
      return node;
    }

    var children = [];
    for (var i = 0; i < slide.children.length; i++) {
      var c = visit(slide.children[i], "");
      if (c) children.push(c);
    }

    var aside = slide.querySelector(".notes");
    var scs = getComputedStyle(slide);
    return {
      id: slide.id || null,
      classes: slide.className,
      layout: (slide.className.match(/layout-([a-z0-9-]+)/) || [null, null])[1],
      spine: parseInt(slide.getAttribute("data-spine") || "0", 10),
      detail: parseInt(slide.getAttribute("data-detail") || "0", 10),
      design: { w: slide.offsetWidth, h: slide.offsetHeight },
      style: styleOf(scs),
      notes: aside ? aside.textContent.replace(/\\s+/g, " ").trim() : "",
      pseudos: pseudos,
      children: children
    };
  }

  function measure() {
    document.documentElement.style.setProperty("--sdoc-slide-scale", "1");
    var slides = Array.prototype.slice.call(document.querySelectorAll(".slide"));
    var out = [];
    slides.forEach(function (slide) {
      var wasActive = slide.classList.contains("active");
      slide.classList.add("active");
      var prior = slide.getAttribute("style") || "";
      slide.setAttribute("style", prior + ";position:absolute;top:0;left:0;transform:none;");
      out.push(slideTree(slide));
      slide.setAttribute("style", prior);
      if (!wasActive) slide.classList.remove("active");
    });
    var el = document.createElement("script");
    el.type = "application/json";
    el.id = "sdoc-artifact";
    el.textContent = JSON.stringify({ slides: out }) + "\\n/*${SENTINEL}*/";
    document.body.appendChild(el);
  }

  function start() {
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(function () { requestAnimationFrame(run); });
    } else {
      requestAnimationFrame(run);
    }
  }
  // Pictures are painted before anything is measured, because a bake replaces
  // the source and changes the box.
  function run() { bakeImages(measure); }

  if (document.readyState === "complete") start();
  else window.addEventListener("load", start);
})();
`;

function harvestArtifact(htmlPath, options = {}) {
  return runHarvest(htmlPath, ARTIFACT_SCRIPT, "sdoc-artifact", options);
}

// ---------------------------------------------------------------------------
// Translating a harvested tree into the subset
// ---------------------------------------------------------------------------

const TEXT_TAGS = new Set(["h1", "h2", "h3", "p"]);
// The tags the subset refuses to let type inherit into, so everything they use
// has to be written on them.
const HEADING_TAGS = new Set(["h1", "h2", "h3"]);

// Not typefaces: each resolves to whatever the reader's machine supplies, so
// naming one as a deck face would declare a font that does not exist.
const SYSTEM_KEYWORDS = new Set([
  "-apple-system", "BlinkMacSystemFont", "system-ui", "ui-sans-serif",
  "ui-serif", "ui-monospace", "ui-rounded", "Segoe UI", "Roboto",
  "Helvetica Neue", "Helvetica", "Noto Sans", "Apple Color Emoji",
  "Segoe UI Emoji", "Segoe UI Symbol",
]);

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// A length, scaled from the theme's design box onto the fixed canvas and
// rounded. Themes are rarely 1920 wide — the built-in one is 1280 — so every
// number crossing this boundary is scaled, or the deck arrives two-thirds size.
function lenOf(value, scale) {
  const n = parseFloat(value);
  if (!isFinite(n) || n === 0) return 0;
  return Math.round(n * scale * 100) / 100;
}

// rgb()/rgba() are in the subset, so computed colours pass through unchanged.
// Fully transparent is dropped rather than written out.
function colourOf(value) {
  if (!value) return null;
  const t = String(value).trim();
  if (t === "rgba(0, 0, 0, 0)" || t === "transparent") return null;
  // A theme written with `color-mix(in srgb, …)` — increasingly ordinary CSS —
  // computes to `color(srgb r g b / a)`, which the subset has no function for.
  // Converting it here keeps the theme's colour instead of refusing the deck.
  const srgb = srgbToRgba(t);
  if (srgb) return srgb;
  return t.replace(/\s+/g, " ");
}

// A stack reduced to what the subset will resolve: the declared face, a basic
// face if the theme named one, then a generic. Anything else heals to the
// generic on the page, so carrying it would be noise.
function fontStack(value) {
  if (!value) return null;
  const parts = String(value).split(",").map((p) => p.trim().replace(/^['"]|['"]$/g, ""));
  const declared = parts.find(
    (p) => p && !BASIC_FACES.has(p) && !GENERIC_FACES.has(p) && !SYSTEM_KEYWORDS.has(p)
  );
  const basic = parts.find((p) => BASIC_FACES.has(p));
  const generic = parts.find((p) => GENERIC_FACES.has(p)) || "sans-serif";
  const out = [];
  if (declared) out.push(/\s/.test(declared) ? `'${declared}'` : declared);
  if (basic) out.push(basic);
  out.push(generic);
  return { css: out.join(", "), declared: declared || null };
}

function borderOf(style, side, scale) {
  const w = parseFloat(style[`border${side}Width`]) || 0;
  const s = style[`border${side}Style`];
  if (!w || !s || s === "none") return null;
  const colour = colourOf(style[`border${side}Color`]) || "#000";
  // A border the theme asked for has to be visible. A hairline computes to
  // something like 0.666667px: the browser antialiases that into a real line,
  // and a renderer that rounds it away leaves the frame the author drew simply
  // missing — 26 of them across 8 slides of one deck. Anything that exists at
  // all is worth at least a pixel; the alternative is not a thinner line, it is
  // no line.
  const width = Math.max(1, lenOf(w, scale));
  return `${width}px ${s} ${colour}`;
}

// The declarations for one node, in the subset, with everything the theme
// resolved but the subset cannot express left behind.
function declarationsFor(node, ctx, inherited) {
  const d = [];
  const s = node.style;
  const scale = ctx.scale;
  const push = (prop, value) => { if (value !== null && value !== undefined && value !== "") d.push(`${prop}:${value}`); };

  const pinned = ctx.pinHere === true || s.position === "absolute" || s.position === "fixed";
  if (pinned) {
    push("position", "absolute");
    push("left", `${lenOf(node.box.x, scale)}px`);
    push("top", `${lenOf(node.box.y, scale)}px`);
    push("width", `${lenOf(node.box.w, scale)}px`);
    // A pinned text box needs a width to wrap; a height would stop it growing
    // when someone edits it, so only painted boxes get one.
    if (!node.runs) push("height", `${lenOf(node.box.h, scale)}px`);
  }

  if (s.display === "flex" || s.display === "grid") {
    push("display", s.display);
    if (s.display === "flex" && s.flexDirection && s.flexDirection !== "row") push("flex-direction", s.flexDirection);
    if (s.flexWrap === "wrap") push("flex-wrap", "wrap");
    if (s.display === "grid") {
      const cols = gridTracks(s.gridTemplateColumns, scale);
      if (cols) push("grid-template-columns", cols);
    }
    const gap = parseFloat(s.gap);
    if (isFinite(gap) && gap > 0) push("gap", `${Math.min(512, lenOf(gap, scale))}px`);
    if (s.alignItems && s.alignItems !== "normal" && s.alignItems !== "stretch") push("align-items", alignWord(s.alignItems));
    if (s.justifyContent && s.justifyContent !== "normal" && s.justifyContent !== "flex-start") {
      push("justify-content", justifyWord(s.justifyContent));
    }
  }

  const pad = ["Top", "Right", "Bottom", "Left"].map((k) => Math.min(256, lenOf(s[`padding${k}`], scale)));
  if (pad.some((p) => p > 0)) push("padding", pad.every((p) => p === pad[0]) ? `${pad[0]}px` : pad.map((p) => `${p}px`).join(" "));

  // margin is accepted by the page and then does nothing, so it is converted
  // where it can be and reported where it cannot.
  const margins = ["Top", "Right", "Bottom", "Left"].map((k) => parseFloat(s[`margin${k}`]) || 0);
  if (margins.some((m) => Math.abs(m) > 0.5) && !pinned) {
    ctx.warnings.push({
      slide: ctx.slide,
      message: `margin on <${node.tag}>${node.cls ? " ." + node.cls.split(/\s+/)[0] : ""} is dropped; the subset has no margin and the gap of its parent does the spacing`,
    });
  }

  const bg = colourOf(s.backgroundColor);
  if (bg) push("background", bg);
  if (s.backgroundImage && s.backgroundImage !== "none" && !/^url\(/.test(s.backgroundImage)) {
    // A theme gradient survives: the subset takes linear and radial gradients.
    push("background", s.backgroundImage.replace(/\s+/g, " "));
  }

  const sides = ["Top", "Right", "Bottom", "Left"].map((side) => borderOf(s, side, scale));
  if (sides.every((b) => b && b === sides[0])) {
    push("border", sides[0]);
  } else {
    const names = ["border-top", "border-right", "border-bottom", "border-left"];
    sides.forEach((b, i) => { if (b) push(names[i], b); });
  }
  const radius = lenOf(s.borderTopLeftRadius, scale);
  if (radius > 0) push("border-radius", `${radius}px`);

  const opacity = parseFloat(s.opacity);
  if (isFinite(opacity) && opacity < 1) push("opacity", String(opacity));

  if (!pinned) {
    const grow = parseFloat(s.flexGrow) || 0;
    const shrink = parseFloat(s.flexShrink);
    const basis = s.flexBasis;
    if (grow > 0) {
      // `flex:1` is the share the subset documents; anything else is spelled out.
      const basisPart = basis && basis !== "auto" && basis !== "0%" ? ` ${lenOf(basis, scale)}px` : "";
      push("flex", grow === 1 && (shrink === 1 || !isFinite(shrink)) && !basisPart ? "1" : `${grow} ${isFinite(shrink) ? shrink : 1}${basisPart || " 0%"}`);
    }
  }

  // Type. Only what differs from what this node inherits, so the output stays
  // readable and a reader can see which element actually decided a value.
  const stack = fontStack(s.fontFamily);
  if (stack && stack.css !== inherited.font) {
    push("font-family", stack.css);
    if (stack.declared) ctx.faces.add(stack.declared);
  }
  let size = lenOf(s.fontSize, scale);
  if (size && size < MIN_FONT_SIZE) {
    if (ctx.minFont) {
      ctx.raised.push({ slide: ctx.slide, tag: node.tag, cls: node.cls, from: size });
      size = MIN_FONT_SIZE;
    } else {
      ctx.smallText.push({ slide: ctx.slide, tag: node.tag, cls: node.cls, size });
    }
  }
  // Emitting a value only when it differs from the inherited one is the usual
  // harmless economy, and on a heading it is wrong. The Slides format is
  // explicit that font-size and font-weight "flow into <p> and <li>, but never
  // into <h1> through <h3>. Headings keep their tag defaults until you set them
  // directly" — and the subset's headings default to 600. So a 400-weight
  // heading under a 400-weight parent emitted nothing and arrived bold, on
  // every heading of every deck. It reads as "the type looks a bit off" rather
  // than as a bug, and no validator can see it: the output is perfectly
  // admissible, just not the same picture.
  const heading = HEADING_TAGS.has(node.tag);
  if (size && (heading || size !== inherited.size)) push("font-size", `${size}px`);
  const weight = parseInt(s.fontWeight, 10);
  if (weight && (heading || weight !== inherited.weight)) {
    push("font-weight", String(Math.round(weight / 100) * 100));
  }
  if (s.fontStyle === "italic") push("font-style", "italic");
  const lh = parseFloat(s.lineHeight);
  if (isFinite(lh) && size) {
    const ratio = Math.round((lh / parseFloat(s.fontSize)) * 100) / 100;
    if (ratio >= 0.5 && ratio <= 4) push("line-height", String(ratio));
  }
  const ls = parseFloat(s.letterSpacing);
  if (isFinite(ls) && Math.abs(ls) > 0.01) push("letter-spacing", `${lenOf(ls, scale)}px`);
  if (s.textAlign && !["start", "left"].includes(s.textAlign)) push("text-align", s.textAlign);
  if (s.whiteSpace === "nowrap") push("white-space", "nowrap");
  const colour = colourOf(s.color);
  if (colour && colour !== inherited.colour) push("color", colour);

  return d;
}

function alignWord(v) {
  return ({ "flex-start": "start", "flex-end": "end" })[v] || v;
}
function justifyWord(v) {
  return ({ "flex-start": "start", "flex-end": "end" })[v] || v;
}

function gridTracks(value, scale) {
  if (!value || value === "none") return null;
  const parts = String(value).trim().split(/\s+/).slice(0, 24);
  if (!parts.length) return null;
  return parts.map((p) => (/px$/.test(p) ? `${lenOf(p, scale)}px` : p)).join(" ");
}

// Inline marks, with the case already applied by the harvest.
function runsToHtml(runs, ctx) {
  return (runs || [])
    .map((r) => {
      if (r.br) return "<br>";
      let text = escapeHtml(r.text);
      if (r.color) text = `<span style="color:${r.color}">${text}</span>`;
      if (r.bold) text = `<b>${text}</b>`;
      if (r.italic) text = `<i>${text}</i>`;
      if (r.underline) text = `<u>${text}</u>`;
      if (r.href && /^https?:/i.test(r.href)) {
        text = `<a href="${escapeHtml(r.href)}">${text}</a>`;
      } else if (r.href) {
        // Only https links are in the subset, so an in-deck link keeps its
        // look and loses its behaviour rather than failing the export.
        ctx.warnings.push({ slide: ctx.slide, message: `link to "${r.href}" is not https; it renders as plain text` });
      }
      return text;
    })
    .join("");
}

// ---------------------------------------------------------------------------
// Emitting a slide
// ---------------------------------------------------------------------------

function emitNode(node, ctx, inherited, depth) {
  if (node.transparent) {
    // display:contents — the element has no box, so its children belong to the
    // parent. Emitting a div here would add a box the theme deliberately removed.
    return node.children.map((c) => emitNode(c, ctx, inherited, depth)).join("\n");
  }

  const decls = declarationsFor(node, ctx, inherited);
  // Filtered per emitted tag, from the validator's own table. A declaration this
  // drops is one the subset would have rejected: an <img> takes box properties
  // and object-fit, and nothing about type, however much it inherited.
  const styleFor = (tag, extra) => {
    const allowed = PROPS_FOR_TAG[tag];
    const kept = allowed
      ? decls.filter((d) => allowed.has(d.slice(0, d.indexOf(":"))))
      : decls.slice();
    const dropped = decls.length - kept.length;
    if (dropped > 0) ctx.droppedProps = (ctx.droppedProps || 0) + dropped;
    if (extra) kept.push(extra);
    return kept.length ? ` style="${kept.join(";")}"` : "";
  };
  const style = styleFor(node.tag === "img" ? "img" : "div");
  const next = {
    font: fontStack(node.style.fontFamily) ? fontStack(node.style.fontFamily).css : inherited.font,
    size: lenOf(node.style.fontSize, ctx.scale) || inherited.size,
    weight: parseInt(node.style.fontWeight, 10) || inherited.weight,
    colour: colourOf(node.style.color) || inherited.colour,
  };

  if (node.tag === "img") {
    const asset = ctx.addAsset(node.src);
    if (!asset) return "";
    // A baked picture is drawn at exactly its box, so cover and contain are the
    // same thing. Otherwise use what CSS actually resolved, and fall back to
    // the old guess from the aspect ratios only when the harvest recorded none.
    const fit = node.exactFit
      ? "cover"
      : (node.fit === "cover" || node.fit === "contain")
        ? node.fit
        : (node.box.w / node.box.h > (node.natural.w || 1) / (node.natural.h || 1) ? "cover" : "contain");
    return `<img src="${asset}" alt="${escapeHtml(node.alt)}"${styleFor("img", `object-fit:${fit}`)}>`;
  }

  if (node.svg) {
    if (/<text[\s>]/i.test(node.svg)) {
      ctx.warnings.push({
        slide: ctx.slide,
        message: "an svg diagram uses <text>; fonts never load inside a drawing, so its labels will not render — lift them out or rasterise",
      });
    }
    return node.svg.replace(/\sclass="[^"]*"/g, "");
  }

  // Each of these filters against the tag it actually emits. `style` is built
  // for a div, and a <ul> or a <table> handed a div's allowances carries the
  // flow properties a div may have and they may not — which the page drops, so
  // a list meant to be a flex column arrives stacked by accident rather than
  // by arrangement.
  if (node.rows) return emitTable(node, ctx, styleFor("table"));

  if (node.items) {
    const tag = node.tag;
    const items = node.items.map((i) => `<li>${runsToHtml(i.runs, ctx)}</li>`).join("");
    return `<${tag}${styleFor(tag)}>${items}</${tag}>`;
  }

  if (node.runs) {
    // Text must sit in a text element: a bare div holding words is not in the
    // subset, and the renderer uses divs for labels and figures.
    const tag = TEXT_TAGS.has(node.tag) ? node.tag : "p";
    const textStyle = styleFor(tag);
    const html = runsToHtml(node.runs, ctx);
    if (!html.trim()) return "";
    ctx.texts.push({
      role: (node.roleCls || node.cls || "").split(/\s+/).filter(Boolean).join(" ") || node.tag,
      tag,
      text: node.runs.map((r) => (r.br ? "\n" : r.text)).join("").replace(/\s+/g, " ").trim(),
    });
    return `<${tag}${textStyle}>${html}</${tag}>`;
  }

  if (ctx.pinHere) {
    // The pinned walker emits this container's children as its siblings, so
    // nesting them here would place each one against this box instead of the
    // slide. All that is left is whatever this box itself paints.
    const paints = decls.some((d) => /^(background|border)/.test(d));
    return paints ? `<div${style}></div>` : "";
  }

  const inner = node.children.map((c) => emitNode(c, ctx, next, depth + 1)).join("\n");
  if (!inner.trim() && !decls.some((d) => /^(background|border|flex)/.test(d))) return "";
  if (depth >= 14) {
    ctx.warnings.push({ slide: ctx.slide, message: "container nesting reached the 15-deep limit; some wrappers were flattened" });
    return inner;
  }
  return `<div${style}>\n${inner}\n</div>`;
}

// One pinned box for a pseudo-element the theme paints. Only what a box can
// carry: a fill, an edge, a radius. Whatever the pseudo-element *said* is gone,
// and that is warned about separately.
function pseudoHtml(p, ctx) {
  const scale = ctx.scale;
  const d = [
    "position:absolute",
    `left:${lenOf(p.box.x, scale)}px`,
    `top:${lenOf(p.box.y, scale)}px`,
    `width:${lenOf(p.box.w, scale)}px`,
    `height:${lenOf(p.box.h, scale)}px`,
  ];
  const fill = colourOf(p.style.backgroundColor);
  if (fill) d.push(`background:${fill}`);
  const sides = ["Top", "Right", "Bottom", "Left"].map((side) => borderOf(p.style, side, scale));
  if (sides.every((b) => b && b === sides[0])) {
    d.push(`border:${sides[0]}`);
  } else {
    const names = ["border-top", "border-right", "border-bottom", "border-left"];
    sides.forEach((b, i) => { if (b) d.push(`${names[i]}:${b}`); });
  }
  const radius = lenOf(p.style.borderTopLeftRadius, scale);
  if (radius > 0) d.push(`border-radius:${radius}px`);
  const opacity = parseFloat(p.style.opacity);
  if (isFinite(opacity) && opacity < 1) d.push(`opacity:${Math.round(opacity * 100) / 100}`);
  return `<div style="${d.join(";")}"></div>`;
}

// The traced alternative to the flow emitter above.
//
// Every element is pinned where the browser put it, as a flat list of siblings
// under the section. Flat is not a detail: a position:absolute element nested
// inside another is placed against *that* one, so a tree of pinned boxes
// offsets every child by its parent and the deck slides apart. Each box has to
// be a direct child of the slide, holding slide coordinates.
//
// What this buys is exactness — nothing is re-derived, so nothing can drift.
// What it costs is the thing the format is for: a flat sheet of pinned boxes
// is not a deck anyone can edit, and a table traced this way stops being a
// table. That is why it is the opt-in and flow is the default.
function emitPinnedSlide(slide, ctx, inherited) {
  const out = [];
  const walk = (node, inh) => {
    if (node.transparent) {
      for (const kid of node.children || []) walk(kid, inh);
      return;
    }
    const next = {
      font: fontStack(node.style.fontFamily) ? fontStack(node.style.fontFamily).css : inh.font,
      size: lenOf(node.style.fontSize, ctx.scale) || inh.size,
      weight: parseInt(node.style.fontWeight, 10) || inh.weight,
      colour: colourOf(node.style.color) || inh.colour,
    };
    const html = emitNode(node, { ...ctx, pinAll: false, pinHere: true }, inh, 1);
    if (html && html.trim()) out.push(html);
    // A leaf has already emitted everything it holds. Anything else is a
    // container whose own paint is now pinned, so only its children are left.
    if (!node.runs && !node.rows && !node.items && node.tag !== "img" && !node.svg) {
      for (const kid of node.children || []) walk(kid, next);
    }
  };
  for (const kid of slide.children || []) walk(kid, inherited);
  const boxes = out.filter(Boolean);

  // The format allows a host only so many positioned children, and a traced
  // slide passes that easily. A plain div is transparent to absolute
  // positioning — a child still resolves against the nearest *positioned*
  // ancestor, which is the section — so the list can be grouped without any
  // of the coordinates moving.
  if (boxes.length <= MAX_PINNED_PER_HOST) return boxes.join("\n");
  const groups = [];
  for (let i = 0; i < boxes.length; i += MAX_PINNED_PER_HOST) {
    // Only a position:relative element starts a new host — a plain div shares
    // its parent's count — and that same rule makes it the containing block
    // for the boxes inside it. Given no height and no offset it sits at the
    // section's own origin, which a traced slide leaves unpadded, so every
    // coordinate still means what it says.
    groups.push(
      `<div style="position:relative;height:0">\n` +
      boxes.slice(i, i + MAX_PINNED_PER_HOST).join("\n") +
      `\n</div>`
    );
  }
  return groups.join("\n");
}

function emitTable(node, ctx, style) {
  const rows = node.rows
    .map((row, r) => {
      const bg = colourOf(row.style.backgroundColor);
      const cells = row.cells
        .map((cell) => {
          const tag = cell.tag === "th" ? "th" : "td";
          const parts = [];
          // Column widths are set on the first row's cells, as a share.
          if (r === 0 && node.box.w) parts.push(`width:${Math.round((cell.box.w / node.box.w) * 1000) / 10}%`);
          const align = cell.style.textAlign;
          if (align && !["start", "left"].includes(align)) parts.push(`text-align:${align}`);
          const colour = colourOf(cell.style.color);
          if (colour) parts.push(`color:${colour}`);
          // A cell carries its own type. Without this a header set in the
          // deck's mono face inherits the table's instead, and the face is
          // never declared because nothing asked for it — the column headings
          // come out in the body face and look like a different table.
          const face = fontStack(cell.style.fontFamily);
          if (face) {
            parts.push(`font-family:${face.css}`);
            if (face.declared) ctx.faces.add(face.declared);
          }
          const cellSize = lenOf(cell.style.fontSize, ctx.scale);
          if (cellSize) parts.push(`font-size:${cellSize}px`);
          const cellWeight = parseInt(cell.style.fontWeight, 10);
          if (cellWeight) parts.push(`font-weight:${String(Math.round(cellWeight / 100) * 100)}`);
          const cs = parts.length ? ` style="${parts.join(";")}"` : "";
          return `<${tag}${cs}>${runsToHtml(cell.runs, ctx)}</${tag}>`;
        })
        .join("");
      return `<tr${bg ? ` style="background:${bg}"` : ""}>${cells}</tr>`;
    })
    .join("\n");
  return `<table${style}>\n${rows}\n</table>`;
}

function emitSlide(slide, ctx) {
  const s = slide.style;
  const scale = ctx.scale;
  const decls = [];
  const bg = colourOf(s.backgroundColor) || "#ffffff";
  decls.push(`background:${bg}`);

  const stack = fontStack(s.fontFamily);
  if (stack) { decls.push(`font-family:${stack.css}`); if (stack.declared) ctx.faces.add(stack.declared); }
  const colour = colourOf(s.color);
  if (colour) decls.push(`color:${colour}`);
  const size = lenOf(s.fontSize, scale);
  if (size) decls.push(`font-size:${size}px`);

  const pad = ["Top", "Right", "Bottom", "Left"].map((k) => Math.min(256, lenOf(s[`padding${k}`], scale)));
  if (ctx.pinAll) {
    // A traced slide arranges nothing: every box carries its own slide
    // coordinates. Padding would move the origin those are measured from, and
    // a flex column would lay out the hosts holding them — so the section
    // keeps its paint and drops the rest.
  } else {
    decls.push(`padding:${pad.map((p) => `${p}px`).join(" ")}`);
    decls.push("display:flex", "flex-direction:column");
    const gap = parseFloat(s.gap);
    if (isFinite(gap) && gap > 0) decls.push(`gap:${lenOf(gap, scale)}px`);
  }
  if (s.justifyContent === "center") decls.push("justify-content:center");

  const inherited = {
    font: stack ? stack.css : null,
    size: size || 16 * scale,
    weight: parseInt(s.fontWeight, 10) || 400,
    colour,
  };

  const body = ctx.pinAll
    ? emitPinnedSlide(slide, ctx, inherited)
    : slide.children.map((c) => emitNode(c, ctx, inherited, 1)).filter(Boolean).join("\n");

  let notes = "";
  if (slide.notes) {
    let text = slide.notes;
    if (text.length > MAX_NOTES) {
      ctx.warnings.push({ slide: ctx.slide, message: `speaker notes were ${text.length} characters and were cut to ${MAX_NOTES}` });
      text = text.slice(0, MAX_NOTES - 1) + "…";
    }
    notes = `\n<aside>${escapeHtml(text)}</aside>`;
  }

  // A painting pseudo-element becomes a pinned box of its own. It is emitted
  // before the body so it sits behind the content: a rule beside a wordmark
  // does not care either way, and a band drawn behind text would be wrong on
  // top of it.
  const painted = [];
  for (const p of slide.pseudos || []) {
    const where = `<${p.tag}>${p.cls ? " ." + p.cls.split(/\s+/)[0] : ""}`;
    if (p.box && p.style) {
      painted.push(pseudoHtml(p, ctx));
    } else if (p.painted) {
      ctx.warnings.push({
        slide: ctx.slide,
        message: `the theme paints ${p.pseudo} on ${where}, and its box could not be reconstructed, so it is dropped`,
      });
    }
    if (p.words) {
      ctx.warnings.push({
        slide: ctx.slide,
        message: `${p.pseudo} on ${where} carries text, which has no element to live in and is dropped`,
      });
    }
  }
  const pseudoBody = painted.filter(Boolean).join("\n");

  return `<section id="${ctx.slide}" style="${decls.join(";")}">\n` +
    `${pseudoBody ? pseudoBody + "\n" : ""}${body}${notes}\n</section>\n`;
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

// The sdoc scope id is the slide id wherever it can be, because comments,
// links and the diff all key on it. A scope with no id still exports, but its
// edits cannot be traced back with confidence, so it is reported.
function slideIds(slides, warnings) {
  const used = new Set();
  return slides.map((slide, i) => {
    const sdocId = slide.id || null;
    let id = sdocId || "";
    let slugged = false;
    if (!RE_ID.test(id)) {
      if (!sdocId) {
        warnings.push({ slide: `slide-${i + 1}`, message: "the scope has no @id, so edits to this slide cannot be traced back to the source reliably" });
      }
      id = (sdocId || `slide-${i + 1}`).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
      slugged = true;
    }
    if (!id) id = `slide-${i + 1}`;
    let unique = id;
    let n = 2;
    while (used.has(unique)) unique = `${id}-${n++}`;
    used.add(unique);
    if (slugged && sdocId) {
      warnings.push({ slide: unique, message: `scope id "${sdocId}" is not a valid artifact id and was slugged to "${unique}"` });
    }
    return { id: unique, sdocId, slugged };
  });
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// ---------------------------------------------------------------------------
// The export
// ---------------------------------------------------------------------------

// `harvest` is what harvestArtifact returned; `options.baseDir` is the folder
// the .sdoc sits in, so image paths resolve the way they do everywhere else.
function buildArtifact(harvest, options = {}) {
  const warnings = [];
  const errors = [];
  const slides = harvest.slides || [];
  if (!slides.length) return { errors: [{ message: "the deck has no slides" }], warnings, files: {}, manifest: null };

  const design = slides[0].design || { w: 1280, h: 720 };
  const scale = CANVAS.w / (design.w || 1280);

  const ids = slideIds(slides, warnings);
  const faces = new Set();
  const assets = new Map();
  const files = {};
  const manifestSlides = [];
  const previous = options.previousManifest || null;

  slides.forEach((slide, i) => {
    const { id, sdocId, slugged } = ids[i];
    const ctx = {
      slide: id,
      scale,
      faces,
      warnings,
      smallText: [],
      texts: [],
      raised: [],
      // Off unless asked for. The format's 24px floor is advisory — it says so
      // itself, "(not build-checked)" — and a published deck with 169 elements
      // down to 8.67px renders every one at its authored size. Raising them
      // changed the design for a rule nothing enforces.
      minFont: options.minFontSize === true,
      // Trace the layout instead of rebuilding it. Exact, and not editable.
      pinAll: options.pinAll === true,
      addAsset(src) {
        if (!src) return null;
        // The artifact takes an uploaded asset, never a data: URI, so an
        // embedded image is written back out as a file for the publish step.
        const name = assetName(src, assets.size);
        if (!assets.has(name)) assets.set(name, src);
        return `sdoc-asset:${name}`;
      },
    };
    const html = emitSlide(slide, ctx);
    for (const t of ctx.smallText) {
      warnings.push({ slide: id, message: `${t.tag}${t.cls ? " ." + t.cls.split(/\s+/)[0] : ""} is ${t.size}px, under the ${MIN_FONT_SIZE}px the type asks for` });
    }
    if (ctx.raised.length) {
      const roles = [...new Set(ctx.raised.map((r) => r.cls ? "." + r.cls.split(/\s+/)[0] : r.tag))];
      warnings.push({
        slide: id,
        message: `raised ${ctx.raised.length} text size(s) to the ${MIN_FONT_SIZE}px minimum (${roles.join(", ")})`,
      });
    }
    files[`project/slides/${id}.html`] = html;
    manifestSlides.push({
      id,
      sdocId,
      slugged,
      layout: slide.layout || null,
      spine: slide.spine,
      detail: slide.detail,
      optional: /\bslide-optional\b/.test(slide.classes || ""),
      htmlSha256: sha256(html),
      notes: slide.notes || "",
      texts: ctx.texts,
    });
  });

  // sections: an sdoc `section` slide is a divider, which is exactly what an
  // outline entry marks. The first run starts at the cover whatever happens.
  const sections = {};
  let n = 1;
  manifestSlides.forEach((s, i) => {
    if (i === 0 || s.layout === "section") {
      sections[`s${n++}`] = { description: s.notes.slice(0, 140) || `Slides from ${s.id}`, start: s.id };
    }
  });

  const deck = {
    v: 4,
    createdOnFiles: {
      v: 1,
      at: (previous && previous.deck && previous.deck.createdOnFiles && previous.deck.createdOnFiles.at) ||
        options.now || new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    },
    lists: "css",
    title: options.title || "Deck",
    cover: manifestSlides[0].id,
    order: manifestSlides.map((s) => s.id),
    sections,
    faces: facesFor(faces, options.theme, warnings),
    designSystems: [],
  };
  files["project/deck.json"] = JSON.stringify(deck, null, 2) + "\n";

  const declaredFaces = new Set(Object.values(deck.faces).map((f) => f.family));
  for (const [file, html] of Object.entries(files)) {
    if (!file.endsWith(".html")) continue;
    const slide = file.replace(/^project\/slides\/|\.html$/g, "");
    // The export's own assets are still placeholders at this point: they get
    // their blob ids only once the publish step has uploaded the files.
    const r = validateSlideHtml(html, { slide, declaredFaces, assetPlaceholders: true });
    errors.push(...r.errors);
    warnings.push(...r.warnings);
  }
  const d = validateDeckJson(deck, { assetPlaceholders: true });
  errors.push(...d.errors);
  warnings.push(...d.warnings);

  const manifest = {
    sdocArtifact: 1,
    exportedAt: options.now || new Date().toISOString(),
    sdocVersion: options.sdocVersion || null,
    canvas: CANVAS,
    designBox: design,
    scale: Math.round(scale * 1000) / 1000,
    source: options.source || null,
    artifact: (previous && previous.artifact) || { url: null, lastPublishedVersion: null },
    deck: { createdOnFiles: deck.createdOnFiles },
    assets: Object.fromEntries(
      [...assets.entries()].map(([name, src]) => [
        name,
        { src, blob: (previous && previous.assets && previous.assets[name] && previous.assets[name].blob) || null },
      ])
    ),
    slides: manifestSlides,
  };

  return { errors, warnings, files, deck, manifest, assets };
}

// A face entry per declared family. Only a family the theme names in
// `theme.json` under `googleFonts` can carry an href, because nothing here can
// know what Google hosts; the rest are reported so the author can add the file
// or accept the fallback.
function facesFor(families, theme, warnings) {
  const out = {};
  const google = (theme && theme.googleFonts) || {};
  let count = 0;
  for (const family of families) {
    if (count >= 4) {
      warnings.push({ slide: "deck.json", message: `more than 4 typefaces are used; "${family}" was left out and falls back to a basic face` });
      continue;
    }
    const key = family.toLowerCase().replace(/\s+/g, "-");
    if (google[family]) {
      out[key] = { family, href: `https://fonts.googleapis.com/css2?family=${google[family]}&display=swap` };
      count++;
    } else {
      warnings.push({
        slide: "deck.json",
        message: `"${family}" is not declared in the theme's googleFonts, so the deck falls back to a basic face; add it to theme.json to carry the real typeface`,
      });
    }
  }
  return out;
}

function assetName(src, index) {
  if (/^data:/i.test(src)) {
    const m = /^data:image\/([a-z0-9+]+);/i.exec(src);
    const ext = m ? m[1].replace("svg+xml", "svg").replace("jpeg", "jpg") : "png";
    return `embedded-${index + 1}.${ext}`;
  }
  return path.basename(src.split(/[?#]/)[0]) || `asset-${index + 1}`;
}

// Writes an export folder: project/ as the artifact expects it, assets/ for
// the publish step to upload, and the manifest that makes a later diff possible.
function writeArtifact(outDir, built, options = {}) {
  fs.mkdirSync(path.join(outDir, "project", "slides"), { recursive: true });
  for (const [rel, body] of Object.entries(built.files)) {
    const dest = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body, "utf-8");
  }

  const written = [];
  const missing = [];
  if (built.assets && built.assets.size) {
    const assetDir = path.join(outDir, "assets");
    fs.mkdirSync(assetDir, { recursive: true });
    for (const [name, src] of built.assets) {
      const dest = path.join(assetDir, name);
      try {
        if (/^data:/i.test(src)) {
          const comma = src.indexOf(",");
          fs.writeFileSync(dest, Buffer.from(src.slice(comma + 1), "base64"));
        } else if (/^https?:/i.test(src)) {
          missing.push({ name, src, reason: "remote" });
          continue;
        } else {
          fs.copyFileSync(path.resolve(options.baseDir || ".", src), dest);
        }
        written.push(name);
        if (built.manifest.assets[name]) {
          built.manifest.assets[name].sha256 = sha256(fs.readFileSync(dest));
        }
      } catch (err) {
        missing.push({ name, src, reason: err.code === "ENOENT" ? "not-found" : err.message });
      }
    }
  }

  fs.writeFileSync(
    path.join(outDir, "sdoc-artifact.json"),
    JSON.stringify(built.manifest, null, 2) + "\n",
    "utf-8"
  );
  return { written, missing };
}

function readPreviousManifest(outDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(outDir, "sdoc-artifact.json"), "utf-8"));
  } catch {
    return null;
  }
}

module.exports = {
  ARTIFACT_SCRIPT,
  harvestArtifact,
  buildArtifact,
  writeArtifact,
  readPreviousManifest,
  fontStack,
  slideIds,
};
