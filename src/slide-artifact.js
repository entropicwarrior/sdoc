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
             "borderTopLeftRadius","opacity","flexGrow","flexShrink","flexBasis","boxShadow",
             // A child that places itself in its parent's cross axis. The
             // subset has it, and converting a margin-inline auto centring to
             // align-self center is the standard move for a theme being made
             // flow-ready — which did nothing at all while this went
             // unharvested, because the replacement was dropped as well.
             "alignSelf",
             "marginTop","marginRight","marginBottom","marginLeft","position",
             // Which edge the author anchored to. A box held at the bottom of
             // its parent and re-emitted at the top coordinate it happened to
             // measure at stops being held there the moment anything inside it
             // changes size — and the export removes chrome from inside it.
             "top","right","bottom","left"];
  var TYPE = ["fontFamily","fontSize","fontWeight","fontStyle","lineHeight",
              "letterSpacing","textAlign","textTransform","whiteSpace","color",
              // Paint on text, lost for the same reason a box-shadow was.
              "textShadow"];

  function px(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }

  // Which edge a positioned box was actually anchored to. getComputedStyle
  // resolves top and bottom to used values for any positioned element, so both
  // come back as lengths whatever the author wrote and neither says anything.
  // The rules that matched it do say: a footer written as "bottom: 30px"
  // declares bottom and never declares top.
  //
  // Specificity is not resolved — the last matching declaration wins, which is
  // the common case and, for a property nothing else sets, the only case. An
  // inline style beats all of it, as it does in the cascade.
  function anchorsOf(el) {
    var found = { top: false, bottom: false, left: false, right: false };
    var sheets = document.styleSheets;
    for (var i = 0; i < sheets.length; i++) {
      var rules;
      try { rules = sheets[i].cssRules; } catch (err) { continue; }
      if (!rules) continue;
      for (var j = 0; j < rules.length; j++) {
        var r = rules[j];
        if (!r || !r.selectorText || !r.style) continue;
        var hits = false;
        try { hits = el.matches(r.selectorText); } catch (err) { continue; }
        if (!hits) continue;
        for (var k in found) {
          if (r.style.getPropertyValue(k)) found[k] = true;
        }
      }
    }
    if (el.style) {
      for (var k2 in found) {
        if (el.style.getPropertyValue(k2)) found[k2] = true;
      }
    }
    return found;
  }

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

  // A drawing is carried across as markup and shown as an image, and nothing
  // on the other side has the stylesheet that defined a custom property — the
  // subset says so outright: no currentcolor, no var(). So each one is replaced
  // here, in the live page, with the literal the browser computed for it. A
  // stroke written as var(--accent) arrives painted rather than black.
  function resolveSvgVars(markup, probe) {
    return String(markup).replace(
      /var\\(\\s*(--[\\w-]+)\\s*(?:,\\s*([^)]*))?\\)/g,
      function (whole, name, fallback) {
        var value = "";
        try { value = getComputedStyle(probe).getPropertyValue(name).trim(); } catch (err) {}
        return value || String(fallback || "").trim() || "#000";
      }
    );
  }

  // A drawing is shown as an image, and the format is explicit that its width
  // and height are the viewBox's. So the size it was authored with — "100%",
  // "84%", or nothing at all — means nothing here: a percentage resolves
  // against a parent in a page, and there is no parent and no stylesheet on
  // the other side. Seven of one deck's eight drawings had no usable size and
  // every one of them arrived collapsed or in a default box, which reads as
  // "the drawings are broken" rather than as a missing attribute.
  //
  // So the size it actually occupies is measured here and written onto the
  // copy. The one drawing in that deck that did survive was the only one the
  // theme had sized in absolute units.
  function svgMarkup(el, rect) {
    var clone;
    try { clone = el.cloneNode(true); } catch (err) { return resolveSvgVars(el.outerHTML, el); }
    var w = Math.round(rect.width * 100) / 100;
    var h = Math.round(rect.height * 100) / 100;
    if (w > 0) clone.setAttribute("width", String(w));
    if (h > 0) clone.setAttribute("height", String(h));
    if (!clone.getAttribute("aria-label")) {
      clone.setAttribute("aria-label", el.getAttribute("aria-label") || "diagram");
    }
    return resolveSvgVars(clone.outerHTML, el);
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
      // A drawing is not an inline word, whatever its display says. An <svg> is
      // display:inline by default, and its own <text> labels count towards
      // textContent — so a block holding a labelled diagram looked like a run
      // of text, was emitted as a <p> of those labels, and the drawing was
      // never visited. Three of a real deck's technical diagrams vanished that
      // way, and the only ones that survived were the two a stylesheet had
      // made display:block for unrelated reasons.
      if (String(child.tagName).toLowerCase() === "svg") return false;
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
    var tops = [];
    try {
      var range = document.createRange();
      range.selectNodeContents(el);
      ink = range.getBoundingClientRect();
      // How many lines the words actually occupied. A Range reports one rect
      // per inline box, not per line, so a sentence holding a <b> gives
      // several on one line: they are clustered by top edge instead of
      // counted. Needed because a traced box is pinned at exactly the ink's
      // width, and the artifact's copy of a face is never bit-identical to
      // this one — a fraction of a pixel wider and a line that fitted wraps.
      var rects = range.getClientRects();
      for (var ri = 0; ri < rects.length; ri++) {
        var rr = rects[ri];
        if (!rr.width && !rr.height) continue;
        var seen = false;
        for (var ti = 0; ti < tops.length; ti++) {
          if (Math.abs(tops[ti] - rr.top) < Math.max(1, rr.height * 0.5)) { seen = true; break; }
        }
        if (!seen) tops.push(rr.top);
      }
    } catch (err) {
      return;
    }
    if (!ink || (!ink.width && !ink.height)) return;

    // Kept whole as well as applied, because the two emitters want different
    // things from it: flow adjusts only where it must, tracing copies the
    // answer outright.
    node.ink = {
      x: ink.left - origin.left,
      y: ink.top - origin.top,
      w: ink.width,
      h: ink.height,
      // A Range taller than the box means the inline box overhangs the line
      // box, which any line-height below the face's natural one does — and the
      // Range's top then sits above the real one, so it is not to be trusted
      // vertically even when tracing.
      trustY: ink.height > 0 && ink.height < rect.height - 0.5,
      lines: tops.length || 1
    };

    if (node.ink.trustY) {
      node.box.y = node.ink.y;
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
            // either way its own colour is worth keeping. And any mark at all
            // that the theme gave a colour of its own — keying this on the tag
            // meant a themed <strong> became a bare <b> and the word inherited
            // its heading's colour, which is one cyan word arriving grey.
            color: marks.color || tag === "span" || tag === "code" ||
              cs2.color !== getComputedStyle(node).color
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
      var inFlow = cs.position !== "absolute" && cs.position !== "fixed";
      var rec = {
        pseudo: names[i], words: !!words, painted: !!(fill || edge),
        inFlow: inFlow, lead: inFlow && names[i] === "::before" ? px(cs.width) || 0 : 0
      };

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

  // A drawing is one opaque graphic on the other side, and the format says
  // outright that fonts never load inside one: a <text> label arrives in
  // whatever face the viewer falls back to. So a labelled drawing is painted
  // here, where the deck's own faces are live, and carried across as a picture.
  //
  // Painting alone does not do it. An <svg> handed to an <img> is an isolated
  // document and cannot see this page's @font-face rules either, so the raster
  // falls back exactly as the viewer would. Measured: the PNG of a webfont
  // label came back byte-identical to the fallback rendering, and different
  // from the real face. So the faces the labels actually ask for are copied
  // into the clone first — by then their src is a data: URL, which travels.
  //
  // Only labelled drawings are painted. One without text renders correctly as
  // markup, and markup stays vector, stays small, and stays under the 52 KB
  // the format allows an <svg>.
  function faceRules() {
    var out = [];
    for (var i = 0; i < document.styleSheets.length; i++) {
      var rules;
      try { rules = document.styleSheets[i].cssRules; } catch (err) { continue; }
      if (!rules) continue;
      for (var j = 0; j < rules.length; j++) {
        var r = rules[j];
        if (!r || !r.constructor || r.constructor.name !== "CSSFontFaceRule") continue;
        var fam = String(r.style.getPropertyValue("font-family") || "");
        out.push({ family: fam.replace(/["']/g, "").trim().toLowerCase(), css: r.cssText });
      }
    }
    return out;
  }

  // Which faces this drawing's labels ask for. Inlining only those keeps the
  // transient data: URL small — a deck can declare four families and a given
  // diagram use one, and every byte here is spent again on decoding.
  function facesFor(svg) {
    var want = {};
    var texts = svg.querySelectorAll("text, tspan");
    for (var i = 0; i < texts.length; i++) {
      var ff = "";
      try { ff = getComputedStyle(texts[i]).fontFamily || ""; } catch (err) {}
      var parts = ff.split(",");
      for (var p = 0; p < parts.length; p++) {
        want[parts[p].replace(/["']/g, "").trim().toLowerCase()] = true;
      }
    }
    var all = faceRules();
    var css = [];
    for (var k = 0; k < all.length; k++) {
      if (want[all[k].family]) css.push(all[k].css);
    }
    return css.join("\\n");
  }

  function rasteriseLabelled(done) {
    document.documentElement.style.setProperty("--sdoc-slide-scale", "1");
    var slides = Array.prototype.slice.call(document.querySelectorAll(".slide"));
    var wasActive = slides.map(function (s) { return s.classList.contains("active"); });
    var priorStyle = slides.map(function (s) { return s.getAttribute("style") || ""; });
    // The same arrangement the measuring pass uses: a drawing in a slide that
    // is not showing has no size, and one sized against the viewport has a
    // different one unless the slide is parked.
    slides.forEach(function (s, i) {
      s.classList.add("active");
      s.setAttribute("style", priorStyle[i] + ";position:absolute;top:0;left:0;transform:none;");
    });

    var targets = [];
    var all = document.querySelectorAll(".slide svg");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.closest && el.closest(".nav-prev, .nav-next, .nav-vert, .notes")) continue;
      if (!el.querySelector("text")) continue;
      targets.push(el);
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

    targets.forEach(function (el) {
      try {
        var rect = el.getBoundingClientRect();
        var w = Math.max(1, Math.round(rect.width));
        var h = Math.max(1, Math.round(rect.height));
        var clone = el.cloneNode(true);
        clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
        clone.setAttribute("width", String(w));
        clone.setAttribute("height", String(h));
        var css = facesFor(el);
        if (css) {
          var st = document.createElementNS("http://www.w3.org/2000/svg", "style");
          st.textContent = css;
          clone.insertBefore(st, clone.firstChild);
        }
        var markup = new XMLSerializer().serializeToString(clone);
        var img = new Image();
        img.onload = function () {
          try {
            // Twice the measured size because the source is vector, capped by
            // total area so a full-bleed drawing is not an eight-megapixel PNG
            // to encode — the budget this harvest runs on is spent decoding.
            var budget = 4000000;
            var scale = Math.min(2, Math.sqrt(budget / Math.max(1, w * h)));
            if (!(scale > 0.5)) scale = 0.5;
            var c = document.createElement("canvas");
            c.width = Math.max(1, Math.round(w * scale));
            c.height = Math.max(1, Math.round(h * scale));
            c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
            el.__sdocRaster = c.toDataURL("image/png");
          } catch (err) {
            // A tainted canvas: something in the drawing came from a URL the
            // page may not read back. The markup path still carries it.
          }
          one();
        };
        img.onerror = function () { one(); };
        img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(markup);
      } catch (err) {
        one();
      }
    });
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
        anchors: (cs.position === "absolute" || cs.position === "fixed") ? anchorsOf(el) : null,
        box: { x: rect.left - origin.left, y: rect.top - origin.top, w: rect.width, h: rect.height },
        children: []
      };

      var ps = pseudoBoxes(el, rect, origin);
      for (var pi = 0; pi < ps.length; pi++) {
        ps[pi].cls = cls;
        ps[pi].tag = tag;
        // A ::before that was in flow held space open on its host's first
        // line, and pinning it hands that space back — so whatever shared the
        // line slides left by its width. The host is told what it is about to
        // lose. Tracing does not need this: there the host is pinned at its
        // ink, which already accounts for the shift.
        if (ps[pi].painted && ps[pi].lead > 0) {
          node.leadPad = Math.max(node.leadPad || 0, ps[pi].lead);
        }
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
        node.svg = svgMarkup(el, rect);
        // Painted in the pass before this one, when the drawing carries labels.
        if (el.__sdocRaster) node.svgRaster = el.__sdocRaster;
        node.svgLabel = el.getAttribute("aria-label") || "diagram";
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
  function run() {
    bakeImages(function () { rasteriseLabelled(measure); });
  }

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

// Split on commas that are not inside parentheses. A shadow list separates its
// shadows with commas and every colour in it holds commas of its own, so a
// plain split cuts `rgba(0, 0, 0, .5)` into four pieces.
function splitTop(value) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) { out.push(value.slice(start, i)); start = i + 1; }
  }
  out.push(value.slice(start));
  return out.map((p) => p.trim()).filter(Boolean);
}

// `box-shadow` is in the subset — `[inset] LEN LEN [LEN [LEN]] COLOR`, at most
// eight, x and y within ±64, blur ≤160, spread ±32 — and was neither harvested
// nor emitted, so every shadow in every deck was lost in silence. Nothing moves
// when a shadow goes: a card just stops being raised off the page.
//
// The browser serialises the colour FIRST ("rgba(0, 0, 0, 0.1) 0px 4px 8px 0px"
// and "… inset"), which is the one ordering the grammar refuses. So each shadow
// is taken apart and put back in the order the format asks for, with its
// lengths clamped rather than dropped: a shadow at the limit still reads as a
// shadow, and one rejected for being 2px too soft reads as a missing feature.
function shadowCss(value, scale, maxBlur) {
  if (!value || value === "none") return "";
  const parts = splitTop(value).slice(0, 8);
  const out = [];
  for (const part of parts) {
    let body = part;
    let inset = false;
    if (/(^|\s)inset(\s|$)/.test(body)) {
      inset = true;
      body = body.replace(/(^|\s)inset(\s|$)/, " ");
    }
    // `color(srgb …)` too: a shadow written with color-mix() computes to that,
    // and a colour pattern that only knew rgb()/hsl()/#hex skipped the whole
    // shadow rather than the colour — which is how the one shadow in this
    // repo's own theme stayed invisible after shadows started being exported.
    // colourOf converts it; the subset has no color() function.
    const colour = /(rgba?\([^)]*\)|hsla?\([^)]*\)|color\([^)]*\)|#[0-9a-f]{3,8})/i.exec(body);
    if (!colour) continue;
    const lengths = body.replace(colour[0], " ").trim().split(/\s+/).filter(Boolean);
    if (lengths.length < 2) continue;
    const n = lengths.map((l) => lenOf(l, scale));
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const bits = [
      clamp(n[0], -64, 64),
      clamp(n[1], -64, 64),
      n.length > 2 ? clamp(n[2], 0, maxBlur || 160) : null,
      n.length > 3 ? clamp(n[3], -32, 32) : null,
    ].filter((v) => v !== null);
    const px = bits.map((v) => `${v}px`).join(" ");
    out.push(`${inset ? "inset " : ""}${px} ${colourOf(colour[0]) || colour[0]}`);
  }
  return out.join(", ");
}

function r2(n) { return Math.round(n * 100) / 100; }
function isLen(v) { return v !== undefined && v !== "auto" && isFinite(parseFloat(v)); }

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
    // Tracing pins text where its glyphs are, not where its box is. The two
    // differ whenever something inside the box moved the ink — a leading
    // ::before, a negative text-indent, a cell that centres — and a box pinned
    // at its own left with the ink 646px further along lands the words on top
    // of whatever pushed them. Flow mode leaves this alone: there the text is
    // still laid out, so the box is the right thing to place.
    const ink = ctx.pinHere && node.runs && node.ink && node.ink.w > 0 ? node.ink : null;
    const at = {
      x: ink ? ink.x : node.box.x,
      y: ink && ink.trustY ? ink.y : node.box.y,
      w: ink ? ink.w : node.box.w,
    };
    push("position", "absolute");
    // Anchored on the edge the deck anchored on, where the deck chose one.
    // The slide footer is held at `bottom: 30px` and contains two navigation
    // chevrons set much larger than its text. The chevrons are chrome and do
    // not travel, so the row that arrives is shorter than the one measured —
    // and pinned by its top it floated 15px up, on every slide of every deck.
    // Pinned by the same bottom the deck used, it stays put however much the
    // contents shrink. Tracing is flat by design and keeps top/left.
    const a = node.anchors;
    const anchoredBottom = !ctx.pinHere && !!a && a.bottom && !a.top && isLen(s.bottom);
    const anchoredRight = !ctx.pinHere && !!a && a.right && !a.left && isLen(s.right);
    if (anchoredRight) push("right", `${lenOf(parseFloat(s.right), scale)}px`);
    else push("left", `${lenOf(at.x, scale)}px`);
    if (anchoredBottom) push("bottom", `${lenOf(parseFloat(s.bottom), scale)}px`);
    else push("top", `${lenOf(at.y, scale)}px`);
    push("width", `${lenOf(at.w, scale)}px`);
    // Pinned at the ink's width with no headroom, so text that took exactly
    // one line here is held to one line there rather than being allowed to
    // wrap on a sub-pixel difference between this browser's face and the
    // artifact's copy of it. Text that already wrapped keeps wrapping.
    if (ink && ink.lines === 1) push("white-space", "nowrap");
    // A pinned text box needs a width to wrap; a height would stop it growing
    // when someone edits it, so only painted boxes get one.
    //
    // And a box held at its bottom edge has to be free to grow upward from it,
    // or anchoring it there decided nothing: bottom plus a fixed height is the
    // same box as top plus that height. The height measured here describes
    // contents that do not all travel — the footer's is set by navigation
    // chevrons, which are chrome — so a box that paints nothing keeps only its
    // anchor. One that paints keeps its height, because that is its picture.
    const paints = colourOf(s.backgroundColor) ||
      ["Top", "Right", "Bottom", "Left"].some((k) => parseFloat(s[`border${k}Width`]) > 0);
    if (!node.runs && !(anchoredBottom && !paints)) {
      push("height", `${lenOf(node.box.h, scale)}px`);
    }
  }

  if (s.alignSelf && !["auto", "normal", "stretch"].includes(s.alignSelf)) {
    push("align-self", alignWord(s.alignSelf));
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
  // Plus the width of a leading pseudo-element that used to hold this line
  // open. Flow only: a traced box is pinned at its ink, which already has it.
  if (!ctx.pinHere && node.leadPad > 0) {
    const want = pad[3] + lenOf(node.leadPad, scale);
    pad[3] = Math.min(256, want);
    if (want > 256) {
      // The format caps padding at 256px, so a wider one cannot be given back
      // at all. Saying which slide, and that tracing does not have the
      // problem, is more use than a silently half-moved line.
      ctx.warnings.push({
        slide: ctx.slide,
        message: `a ::before holds ${Math.round(want)}px of this line open and padding stops at 256px, ` +
          `so the text after it sits about ${Math.round(want - 256)}px left of where the deck has it — ` +
          `--artifact-pinned places it where the deck has it`,
      });
    }
  }
  if (pad.some((p) => p > 0)) push("padding", pad.every((p) => p === pad[0]) ? `${pad[0]}px` : pad.map((p) => `${p}px`).join(" "));

  // margin is accepted by the page and then does nothing, so it is converted
  // where it can be and reported where it cannot.
  const margins = ["Top", "Right", "Bottom", "Left"].map((k) => parseFloat(s[`margin${k}`]) || 0);
  if (margins.some((m) => Math.abs(m) > 0.5) && !pinned) {
    ctx.warnings.push({
      slide: ctx.slide,
      // Tagged because this one is a metric, not just a note: the count of
      // dropped margins is how a theme's readiness for flow is judged, and it
      // had to be derived by subtracting a traced export's warnings from a
      // flow one's — tracing never drops a margin — for want of this field.
      kind: "margin-dropped",
      px: Math.round(margins.reduce((a, m) => a + Math.abs(m), 0)),
      message: `margin on <${node.tag}>${node.cls ? " ." + node.cls.split(/\s+/)[0] : ""} is dropped; the subset has no margin and the gap of its parent does the spacing`,
    });
  }

  const bg = colourOf(s.backgroundColor);
  if (bg) push("background", bg);
  const shadow = shadowCss(s.boxShadow, scale, 160);
  if (shadow) push("box-shadow", shadow);
  // The limits are asymmetric: a box blurs to 160, text to 64.
  const textShadow = shadowCss(s.textShadow, scale, 64);
  if (textShadow) push("text-shadow", textShadow);
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
      // The basis is part of the answer, not a detail to round off. `flex:1`
      // is `1 1 0%`: the item starts at nothing and takes its share of what is
      // left. `flex: 1 1 auto` starts at its content and grows from there. The
      // two agree while the content fits and part company when it does not —
      // with 0% the box stays at the available height and its content spills,
      // with auto the box grows. A basis of `auto` was being written as
      // `flex:1`, which is the one case where they differ, and it showed up as
      // a footnote 170px out of place under a body that had overflowed.
      //
      // The subset's grammar takes auto: `flex: none | auto | N [N] [LEN | 0% | auto]`.
      const sh = isFinite(shrink) ? shrink : 1;
      let basisPart;
      if (!basis || basis === "auto") basisPart = "auto";
      else if (basis === "0%" || basis === "0px") basisPart = "0%";
      else basisPart = `${lenOf(basis, scale)}px`;
      push(
        "flex",
        grow === 1 && sh === 1 && basisPart === "0%" ? "1" : `${grow} ${sh} ${basisPart}`
      );
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
    // And the size it occupies. Flow wrote none at all: the box an image had
    // in the deck came from rules the subset drops, so the picture arrived at
    // whatever size it happens to be — which is the deck's layout decided by
    // the photographer. Pinned boxes already carry one, so this only fills the
    // gap, and `object-fit` keeps the crop the deck chose.
    const sizing = [];
    if (!decls.some((d) => d.startsWith("width:")) && node.box.w > 0) {
      sizing.push(`width:${lenOf(node.box.w, ctx.scale)}px`);
    }
    if (!decls.some((d) => d.startsWith("height:")) && node.box.h > 0) {
      sizing.push(`height:${lenOf(node.box.h, ctx.scale)}px`);
    }
    return `<img src="${asset}" alt="${escapeHtml(node.alt)}"${styleFor("img", [...sizing, `object-fit:${fit}`].join(";"))}>`;
  }

  if (node.svg) {
    // A labelled drawing was painted during the harvest, with the faces its
    // labels ask for inlined into it, and travels as a picture: the format
    // treats a drawing as one opaque graphic and never loads a font inside
    // one, so <text> carried as markup arrives in a fallback face.
    const raster = node.svgRaster ? ctx.addAsset(node.svgRaster) : "";
    if (!raster && /<text[\s>]/i.test(node.svg)) {
      ctx.warnings.push({
        slide: ctx.slide,
        message: "an svg diagram uses <text> and could not be painted; fonts never load inside a drawing, so its labels will not render — lift them out",
      });
    }
    // An unlabelled drawing stays markup: that keeps it vector and small.
    const markup = raster
      ? `<img src="${raster}" alt="${escapeHtml(node.svgLabel || "diagram")}"${styleFor("img", `width:${lenOf(node.box.w, ctx.scale)}px;height:${lenOf(node.box.h, ctx.scale)}px;object-fit:contain`)}>`
      : node.svg.replace(/\sclass="[^"]*"/g, "");
    if (!ctx.pinHere) return markup;
    // Traced: a drawing needs placing like everything else, and the <svg>
    // element can itself be the framed box — a border and a radius on the svg
    // are the frame around a diagram, and emitting the markup alone loses it.
    const scale = ctx.scale;
    const box = [
      "position:absolute",
      `left:${lenOf(node.box.x, scale)}px`,
      `top:${lenOf(node.box.y, scale)}px`,
      `width:${lenOf(node.box.w, scale)}px`,
      `height:${lenOf(node.box.h, scale)}px`,
    ];
    const fill = colourOf(node.style.backgroundColor);
    if (fill) box.push(`background:${fill}`);
    const sides = ["Top", "Right", "Bottom", "Left"].map((side) => borderOf(node.style, side, scale));
    if (sides.every((b) => b && b === sides[0])) {
      box.push(`border:${sides[0]}`);
    } else {
      const names = ["border-top", "border-right", "border-bottom", "border-left"];
      sides.forEach((b, i) => { if (b) box.push(`${names[i]}:${b}`); });
    }
    const radius = lenOf(node.style.borderTopLeftRadius, scale);
    if (radius > 0) box.push(`border-radius:${radius}px`);
    return `<div style="${box.join(";")}">${markup}</div>`;
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
      // Where the build actually put it. These entries are pushed exactly when
      // a text element is emitted and only when it has something in it, so the
      // list runs in the same order as <h1>/<h2>/<h3>/<p> do in the slide that
      // comes out — which is what lets a render of that slide be compared
      // against the build element by element, with nothing to match on.
      // Cell and list-item text goes out inside <td>/<li>, never a <p>, so it
      // is absent from both sides alike.
      box: node.ink && node.ink.w > 0
        ? { x: r2(node.ink.x), y: r2(node.ink.y), w: r2(node.ink.w), h: r2(node.ink.h) }
        : { x: r2(node.box.x), y: r2(node.box.y), w: r2(node.box.w), h: r2(node.box.h) },
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
  // The type the whole table carries, to measure a cell's against.
  const tableFace = fontStack(node.style.fontFamily);
  const tableSize = lenOf(node.style.fontSize, ctx.scale);
  const tableWeight = parseInt(node.style.fontWeight, 10);
  const differing = new Set();

  // One padding for the whole table, which is all the format allows a cell
  // ("padding · td/th: one per table, ≤64"). Emitting none left every cell on
  // the subset's own default of 0.35em 0.6em, so a table with roomy rows came
  // out tighter than the deck's — and on a slide that centres its column, a
  // table that loses height pulls everything above it down and everything
  // below it up. That showed as the heading and the footnote moving in
  // opposite directions by the same amount, which reads as two defects.
  //
  // Taken from a body cell, because body rows outnumber the header and carry
  // the row rhythm. A header that pads differently cannot be expressed and is
  // reported with the rest.
  const body = node.rows.flatMap((r) => r.cells).find((c) => c.tag !== "th") ||
    node.rows.flatMap((r) => r.cells)[0];
  let cellPad = "";
  if (body && body.style) {
    const sides = ["Top", "Right", "Bottom", "Left"]
      .map((k) => Math.max(0, Math.min(64, lenOf(body.style[`padding${k}`], ctx.scale))));
    if (sides.some((v) => v > 0)) cellPad = sides.map((v) => `${v}px`).join(" ");
  }
  const rows = node.rows
    .map((row, r) => {
      const bg = colourOf(row.style.backgroundColor);
      const cells = row.cells
        .map((cell) => {
          const tag = cell.tag === "th" ? "th" : "td";
          const parts = [];
          // Column widths are set on the first row's cells, as a share.
          if (r === 0 && node.box.w) parts.push(`width:${Math.round((cell.box.w / node.box.w) * 1000) / 10}%`);
          if (cellPad) {
            parts.push(`padding:${cellPad}`);
            const own = ["Top", "Right", "Bottom", "Left"]
              .map((k) => Math.max(0, Math.min(64, lenOf(cell.style[`padding${k}`], ctx.scale))))
              .map((v) => `${v}px`)
              .join(" ");
            if (own !== cellPad) differing.add(`padding (${own})`);
          }
          const align = cell.style.textAlign;
          if (align && !["start", "left"].includes(align)) parts.push(`text-align:${align}`);
          const colour = colourOf(cell.style.color);
          if (colour) parts.push(`color:${colour}`);
          // A cell takes colour, alignment, a width and the table's one
          // padding — and not a face or a size. The reference lists
          // `font-family` and `font-size` against `text table`, and says in
          // prose to set them on the <table>. Writing them per cell produced
          // output that validated here and was dropped there: a header in the
          // deck's mono face came out in the body face anyway, which is the
          // very thing writing them was meant to prevent. So the difference is
          // reported instead of being emitted and lost in silence.
          const face = fontStack(cell.style.fontFamily);
          if (face && tableFace && face.css !== tableFace.css) {
            differing.add(`face (${face.css.split(",")[0]})`);
          }
          const cellSize = lenOf(cell.style.fontSize, ctx.scale);
          if (cellSize && tableSize && Math.abs(cellSize - tableSize) > 0.5) {
            differing.add(`size (${cellSize}px)`);
          }
          // Weight is allowed on a <th> and on nothing else in a table.
          const cellWeight = parseInt(cell.style.fontWeight, 10);
          if (cellWeight && tag === "th") {
            parts.push(`font-weight:${String(Math.round(cellWeight / 100) * 100)}`);
          } else if (cellWeight && tableWeight && cellWeight !== tableWeight) {
            differing.add(`weight (${cellWeight})`);
          }
          const cs = parts.length ? ` style="${parts.join(";")}"` : "";
          return `<${tag}${cs}>${runsToHtml(cell.runs, ctx)}</${tag}>`;
        })
        .join("");
      return `<tr${bg ? ` style="background:${bg}"` : ""}>${cells}</tr>`;
    })
    .join("\n");
  if (differing.size) {
    ctx.warnings.push({
      slide: ctx.slide,
      kind: "table-cell-type-dropped",
      message:
        `a table's cells differ from the table in ${[...differing].join(", ")}; a cell takes ` +
        "colour, alignment, a width and the table's one padding, so the rest is the table's for " +
        "every cell — put the distinction in the text or split the table",
    });
  }
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
    // Every warning, whole and machine-readable. The console stops at 25 and
    // says "and N more", which is no use as a measurement — and a manifest
    // that records none at all means the only way to count what an export
    // lost was to diff two exports against each other.
    fidelity: {
      mode: options.pinAll === true ? "traced" : "flow",
      total: warnings.length,
      byKind: warnings.reduce((acc, w) => {
        const k = w.kind || "other";
        acc[k] = (acc[k] || 0) + 1;
        return acc;
      }, {}),
      bySlide: warnings.reduce((acc, w) => {
        acc[w.slide] = (acc[w.slide] || 0) + 1;
        return acc;
      }, {}),
      // Spacing the flow export could not carry, in pixels, per slide. The
      // slides at the top of this are the ones to fix first.
      droppedSpacingBySlide: warnings.reduce((acc, w) => {
        if (w.kind !== "margin-dropped") return acc;
        acc[w.slide] = (acc[w.slide] || 0) + (w.px || 0);
        return acc;
      }, {}),
      warnings: warnings.map((w) => ({
        slide: w.slide, kind: w.kind || "other", px: w.px, message: w.message,
      })),
    },
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
