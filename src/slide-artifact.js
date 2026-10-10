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
  var BOX = ["display","flexDirection","flexWrap","gap","rowGap","columnGap","alignItems","justifyContent",
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
             "top","right","bottom","left",
             // A rotation. The subset has rotate(), and without this a rotated
             // box was emitted as the axis-aligned rectangle it happened to
             // occupy, with the rotation gone and the paint still on. The
             // origin travels too, because the subset has no transform-origin
             // and reproduces a rotation about the centre only.
             "transform","transformOrigin"];
  var TYPE = ["fontFamily","fontSize","fontWeight","fontStyle","lineHeight",
              "letterSpacing","textAlign","textTransform","whiteSpace","color",
              // Optical alignment. Not in the subset, and not emitted as
              // anything else either, so a theme that nudges a title's glyphs
              // off their box lost the nudge in silence — the one property
              // whose whole job is to move ink away from where the box says
              // it is.
              "textIndent",
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
  // Also which of its own size the deck wrote. A box that paints and is sized
  // by CSS has no content to fall back on: emit nothing and it is a zero-high
  // track and a zero-wide fill, so a bar chart is simply not there. A box sized
  // by its content must NOT be pinned to a measured size, or nothing reflows —
  // so the two are told apart the only way they can be, by whether a rule
  // actually declared it.
  var AUTHORED = ["top", "right", "bottom", "left", "width", "height"];
  var authoredRules = null;
  function sizingRules() {
    if (authoredRules) return authoredRules;
    authoredRules = [];
    var sheets = document.styleSheets;
    for (var i = 0; i < sheets.length; i++) {
      var rules;
      try { rules = sheets[i].cssRules; } catch (err) { continue; }
      if (!rules) continue;
      for (var j = 0; j < rules.length; j++) {
        var r = rules[j];
        if (!r || !r.selectorText || !r.style) continue;
        var props = [];
        for (var k = 0; k < AUTHORED.length; k++) {
          if (r.style.getPropertyValue(AUTHORED[k])) props.push(AUTHORED[k]);
        }
        // Only the rules that say anything about size or placement are kept,
        // so the walk below is over a handful rather than every rule in the
        // deck for every element on the slide.
        if (props.length) authoredRules.push({ sel: r.selectorText, props: props });
      }
    }
    return authoredRules;
  }

  // A pure rotation, in degrees, or null for a transform that is anything
  // else. getBoundingClientRect reports the AXIS-ALIGNED box a rotated element
  // occupies — for a thin bar at 45 degrees that is a square as wide as the
  // bar is long — so a rotated box measured naively is exported as that square,
  // painted, with the rotation gone. A connector drawn straight between two
  // corners arrived as a block covering most of the slide.
  //
  // matrix(a,b,c,d,e,f) is a rotation when it is orthonormal, has no
  // translation, and a === d with b === -c. Anything else (a scale, a skew, a
  // mirror, a translate) is left alone and measured as it always was.
  function rotationOf(cs) {
    var text = String(cs.transform || "none");
    if (text === "none") return 0;
    if (text.indexOf("matrix(") !== 0) return null;
    var m = text.slice(7, -1).split(",");
    if (m.length !== 6) return null;
    var a = parseFloat(m[0]), b = parseFloat(m[1]), c = parseFloat(m[2]);
    var d = parseFloat(m[3]), e = parseFloat(m[4]), f = parseFloat(m[5]);
    if (!isFinite(a) || !isFinite(b) || !isFinite(c) || !isFinite(d)) return null;
    if (Math.abs(e) > 0.01 || Math.abs(f) > 0.01) return null;
    if (Math.abs(a * a + b * b - 1) > 0.001) return null;
    if (Math.abs(c * c + d * d - 1) > 0.001) return null;
    if (Math.abs(a - d) > 0.001 || Math.abs(b + c) > 0.001) return null;
    return Math.round((Math.atan2(b, a) * 180) / Math.PI * 100) / 100;
  }

  // The box the element would occupy unrotated, which is the one a rotation
  // has to be applied to. Measured by switching the transform off and back —
  // the element is out of flow in every case this fires on, so nothing else
  // moves while it is off.
  function uprightRect(el) {
    var prior = el.style.transform;
    el.style.transform = "none";
    var rect = el.getBoundingClientRect();
    el.style.transform = prior;
    return rect;
  }

  function anchorsOf(el) {
    var found = { top: false, bottom: false, left: false, right: false, width: false, height: false };
    var rules = sizingRules();
    for (var i = 0; i < rules.length; i++) {
      var hits = false;
      try { hits = el.matches(rules[i].sel); } catch (err) { continue; }
      if (!hits) continue;
      for (var j = 0; j < rules[i].props.length; j++) found[rules[i].props[j]] = true;
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
      // The box is replaced by the ink so TRACING can pin the glyphs where
      // they are. The real border box is kept, because a CSS height has to be
      // the border box or the element is shorter than its own type: an h2 with
      // 20px of padding over a 72px line is a 92px box, and emitting the 86px
      // of ink clipped the descenders off every title that had padding.
      node.borderBox = { h: rect.height, w: rect.width };
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

  // The "only" argument walks a subset of el's children rather than all of them, so a cell
  // split into lines can read each stretch of inline content with the same
  // mark logic instead of a second copy of it. Everything else passes nothing
  // and gets exactly the old behaviour.
  function runsOf(el, baseWeight, only) {
    var runs = [];
    var base = baseWeight || parseInt(getComputedStyle(el).fontWeight, 10) || 400;
    function walk(node, marks, subset) {
      var kids = subset || node.childNodes;
      for (var i = 0; i < kids.length; i++) {
        var child = kids[i];
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
            // Not seeded from the tag. A theme that de-italicises <em> or
            // sets <strong> to 400 means it: the text node below reads the
            // computed weight and style of its own parent, which already
            // accounts for both the tag's default and anything overriding it.
            // Seeding here made the tag win — marks.bold short-circuits the
            // computed check — so a de-italicised <em> arrived in italics and
            // a 400-weight <strong> arrived bold, in every export.
            //
            // Underline is still seeded, because nothing below reads
            // text-decoration: dropping it here would lose underlines
            // altogether rather than fix anything.
            bold: marks.bold,
            italic: marks.italic,
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
    walk(el, { bold: false, italic: false, underline: false, href: null, color: false }, only);
    return runs.filter(function (r) { return r.br || r.text.trim().length || r.text === " "; });
  }

  // A cell's content as the lines it actually lays out as, for the boxes path.
  //
  // runsOf flattens a cell to inline runs. That is right for a real <td>, whose
  // cell properties are nearly all the subset allows, and wrong for a cell
  // drawn as a box: a theme that gives a <strong> display:block puts it on a
  // line of its own, and one that gives it inline-block draws a pill, with
  // padding, a border and a radius. A run carries none of that, so both
  // arrived as bare words — the pill losing the background its own text colour
  // depended on, which is how a near-black label ended up on a transparent
  // cell and could not be read at all.
  //
  // Returns null when every child is ordinary inline content, which is every
  // deck that was exporting correctly before: the caller then takes the old
  // path unchanged. Only emitTableAsBoxes reads this. The run list is untouched, so
  // no other emitter can see it and no text outside a table can move because
  // of it.
  function cellLines(td) {
    var base = parseInt(getComputedStyle(td).fontWeight, 10) || 400;
    var lines = [];
    var pending = null;
    var sawBox = false;
    for (var i = 0; i < td.childNodes.length; i++) {
      var child = td.childNodes[i];
      if (child.nodeType === 1) {
        var cs = getComputedStyle(child);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        if (cs.display === "block" || cs.display === "inline-block") {
          var r = child.getBoundingClientRect();
          lines.push({
            kind: "box",
            display: cs.display,
            style: styleOf(cs),
            runs: runsOf(child, base),
            box: { w: r.width, h: r.height }
          });
          pending = null;
          sawBox = true;
          continue;
        }
      } else if (child.nodeType !== 3) {
        continue;
      } else if (!child.nodeValue.replace(/\\s+/g, " ").trim()) {
        continue;
      }
      if (!pending) { pending = { kind: "runs", nodes: [] }; lines.push(pending); }
      pending.nodes.push(child);
    }
    if (!sawBox) return null;
    for (var j = 0; j < lines.length; j++) {
      if (lines[j].kind !== "runs") continue;
      lines[j].runs = runsOf(td, base, lines[j].nodes);
      delete lines[j].nodes;
    }
    return lines;
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

  // Does the picture have any transparency? It decides how its shadow travels.
  // A filter follows the alpha channel, so a cut-out casts a shadow in its own
  // shape and only a bake reproduces that. A rectangle with no transparency
  // casts exactly the rectangle a box-shadow casts — and a box-shadow paints
  // outside the box and costs no layout, which is what the deck had.
  //
  // Sampled small: a 48px thumbnail is enough to find transparency and costs
  // nothing. A canvas that cannot be read back is treated as transparent, so
  // the safe path (baking) is the fallback.
  function imageIsOpaque(el) {
    try {
      var c = document.createElement("canvas");
      c.width = 48; c.height = 48;
      var g = c.getContext("2d");
      g.drawImage(el, 0, 0, 48, 48);
      var data = g.getImageData(0, 0, 48, 48).data;
      for (var i = 3; i < data.length; i += 4) {
        if (data[i] < 250) return false;
      }
      return true;
    } catch (err) {
      return false;
    }
  }

  function imageNeedsBake(el, cs) {
    var fit = cs.objectFit || "fill";
    if (fit !== "cover" && fit !== "contain") return true;
    var m = mirrorOf(el, el.closest(".slide"));
    if (m.x < 0 || m.y < 0) return true;
    if (String(cs.filter || "").indexOf("drop-shadow") >= 0) {
      // Baking a shadow grows the element by the bleed, and the deck never had
      // that size: on one real slide each picture took 220px more layout than
      // it was given, and everything below and beside it sat low. An opaque
      // rectangle does not need the bake at all — its shadow is expressible.
      if (!imageIsOpaque(el)) return true;
      var shadows = parseDropShadows(cs.filter);
      var parts = [];
      for (var i = 0; i < shadows.length; i++) {
        var sh = shadows[i];
        parts.push(sh.colour + " " + sh.dx + "px " + sh.dy + "px " + sh.blur + "px");
      }
      // Handed to the walk as a box-shadow, in the order the browser would
      // have serialised one, so the emitter's own converter does the rest.
      if (parts.length) el.__sdocShadowCss = parts.join(", ");
      return false;
    }
    return false;
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
      // The shadow is painted inside the picture's own box, and nowhere else.
      //
      // A drop-shadow filter paints outside the element and costs no layout,
      // so growing the baked picture by the bleed gives it a size the deck
      // never gave it. Traced mode hid that — the box is pinned at the offset
      // origin and the growth cancels exactly — but flow has no offset to
      // cancel it, so each picture took 220px more than it was given and
      // everything below and beside it sat low. Measured on a real slide:
      // 150px of displaced text from two images.
      //
      // What is lost instead is shadow that would have fallen outside the box.
      // For the pictures this path is for, that is a small loss: an opaque
      // rectangle never reaches here, because its shadow is a box-shadow and
      // is emitted as one, and a cut-out sits inset in a transparent box with
      // most of its shadow inside that box too. The same trade the clamp above
      // already made at a slide's edge, now made everywhere.
      var spilled = pad.l + pad.t + pad.r + pad.b;
      pad.l = 0; pad.t = 0; pad.r = 0; pad.b = 0;
      if (spilled > 0) el.__sdocShadowClipped = true;

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

      var spin = rotationOf(cs);
      var rect = spin ? uprightRect(el) : el.getBoundingClientRect();
      var node = {
        tag: tag,
        // The angle, and whether the transform was one the subset can say at
        // all — a scale, a skew or a mirror is neither carried nor silently
        // flattened, it is reported.
        rotate: spin || 0,
        spins: spin !== null,
        cls: cls,
        roleCls: cls || inheritedCls || "",
        style: styleOf(cs),
        anchors: anchorsOf(el),
        // Does this box hold less than it contains? A flex parent set to
        // shrink can end up shorter than its own content, which then overflows
        // it visibly — and whatever follows is laid out after the SHRUNK box,
        // not after the content. Re-derived from content in the export the
        // parent grows instead, and everything after it drops by the overflow.
        // scrollHeight against clientHeight says so directly rather than being
        // inferred from the children.
        overflows: el.scrollHeight > el.clientHeight + 1,
        // An image laid out as inline content sits on a line box, and the line
        // box reserves room under the baseline for descenders — so the block
        // holding it is a few pixels taller than the picture. The export emits
        // the picture as a flex child, where there is no line box and no such
        // room, so everything below it rises by that much.
        // A drawing counts as well as a picture: an inline <svg> sits on a
        // line box exactly as an <img> does, and the one this was found on is
        // a drawing that the export rasterises.
        inlineImage: (function () {
          for (var ci = 0; ci < el.children.length; ci++) {
            var kid = el.children[ci];
            var kt = kid.tagName.toLowerCase();
            if (kt !== "img" && kt !== "svg") continue;
            var kd = getComputedStyle(kid).display;
            if (kd === "inline" || kd === "inline-block") return true;
          }
          return false;
        })(),
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
        if (ps[pi].painted && ps[pi].box) {
          node.pseudos = node.pseudos || [];
          node.pseudos.push(ps[pi]);
          // Marked so the slide-level pass does not emit it a second time.
          ps[pi].attached = true;
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
          // A drop-shadow that was not baked travels as the box-shadow it is
          // equivalent to, costing no layout, as it cost none in the deck.
          if (el.__sdocShadowCss) node.style.boxShadow = el.__sdocShadowCss;
          if (el.__sdocShadowClipped) node.shadowClipped = true;
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
              // Not in the captured set, and the one property that says where
              // a cell's content sits in a row taller than it is. A cell drawn
              // as a box is a flex item, so this becomes its align-self; left
              // unharvested, every centred cell arrived at the top.
              valign: getComputedStyle(tds[c]).verticalAlign,
              lines: cellLines(tds[c]),
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
          var kid = el.children[li];
          if (kid.tagName.toLowerCase() !== "li") continue;
          node.items.push({
            runs: runsOf(kid),
            // Kept for the artifact-lists boxes mode: a plain <li> carries none
            // this, and on one deck the flex share is what spaces eight stages
            // evenly down a 501px spine so each meets its own spur.
            style: styleOf(getComputedStyle(kid)),
            box: { w: kid.getBoundingClientRect().width, h: kid.getBoundingClientRect().height }
          });
          // An <li> never reaches visit(), because a list is taken whole and
          // turned into runs — so anything it paints with a pseudo-element was
          // lost with it. One real deck draws its pipeline that way: a spur
          // and a dot per stage, sixteen painted marks, and the slide arrived
          // as a plain bulleted list. The subset allows only a plain <li>, so
          // they cannot ride on the item; they become pinned boxes of their
          // own, which is what every other painted pseudo-element does.
          var lps = pseudoBoxes(kid, kid.getBoundingClientRect(), origin);
          for (var lp = 0; lp < lps.length; lp++) {
            lps[lp].cls = kid.className && kid.className.baseVal === undefined
              ? String(kid.className) : "";
            lps[lp].tag = "li";
            if (lps[lp].painted && lps[lp].box) {
              node.pseudos = node.pseudos || [];
              node.pseudos.push(lps[lp]);
              lps[lp].attached = true;
            }
            pseudos.push(lps[lp]);
          }
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
      // A connector is drawn by the deck's own runtime against the boxes the
      // browser laid out, and a slide that is display:none has no boxes. So it
      // is asked for here, once the slide is up and parked at the origin, and
      // the painted rectangles it adds are harvested like any others. The same
      // call is in the other harvest, for the same reason.
      if (window.sdocConnectors) window.sdocConnectors.resolve(slide);
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
  //
  // Except when the caller wants the page as a reader sees it. A baked picture
  // carries its drop-shadow in its pixels, so the element grows by the bleed —
  // and a filter paints outside the box and takes no layout space, so the deck
  // never had that size. Measuring after the bake makes the growth invisible:
  // the reference and the export both have it and agree. A measurement meant
  // to judge the export against the deck has to be taken before.
  function run() {
    if (window.__sdocNoBake) { rasteriseLabelled(measure); return; }
    bakeImages(function () { rasteriseLabelled(measure); });
  }

  if (document.readyState === "complete") start();
  else window.addEventListener("load", start);
})();
`;

function harvestArtifact(htmlPath, options = {}) {
  // `script` lets a caller measure the same page a different way — the
  // fidelity harness prepends a flag to take the page before its pictures are
  // baked, which is the geometry a reader sees.
  return runHarvest(htmlPath, options.script || ARTIFACT_SCRIPT, "sdoc-artifact", options);
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

// Does anything inside this box read? A box with words in it gets its height
// from them; one without has only what CSS gives it.
function hasText(node) {
  if (node.runs && node.runs.some((r) => r.text && r.text.trim())) return true;
  if (node.rows || node.items || node.svg || node.tag === "img") return true;
  // A pinned child is out of flow and gives its parent no height, so it does
  // not count towards content — the scatter axes hold every plotted point and
  // are still an empty box. This is the same mistake the conformance guard
  // made, and it is why those axes went unrendered for so long.
  return (node.children || []).some((c) => {
    const pos = (c.style || {}).position;
    if (pos === "absolute" || pos === "fixed") return false;
    return hasText(c);
  });
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

  // A size the deck wrote, on a box that is not pinned. Flow sizes almost
  // everything by content or by flex share, and pinning a measured size to all
  // of it would stop the deck reflowing — which is the whole point of flow. But
  // a painted box sized only by CSS has nothing to fall back on: `.bar-track`
  // is `height: 8px` and holds nothing, so with the height gone it is invisible
  // and so is the chart it is part of. Authored is the line between the two.
  if (!pinned && node.anchors) {
    // A painted box that holds nothing readable has no content to take a size
    // from, so if the deck did not write one it needs the one it was measured
    // at — a flex child that stretches in the build collapses to nothing here.
    // The scatter layout's axes are two borders on such a box and had never
    // rendered in any export; a pinned child inside it gives it no height, so
    // nothing about the markup said so.
    const paints =
      colourOf(s.backgroundColor) ||
      ["Top", "Right", "Bottom", "Left"].some((k) => parseFloat(s[`border${k}Width`]) > 0);
    // A box its content overflows has to keep the height it was measured at.
    // Let the export re-derive it and it grows to fit, which is a different
    // slide: on one deck the footnote under an overflowing stack sat 58px
    // lower, and nothing had collided in the build because the overflow was
    // empty space.
    const needsOwnBox = paints && !hasText(node);
    // Height only, these two: the box is the right width already, and pinning
    // a width it did not ask for would stop it stretching.
    //
    //   overflows   — a box its content overflows has to keep the height it
    //                 was measured at; re-derived it grows to fit, which is a
    //                 different slide. One deck's footnote under an
    //                 overflowing stack sat 58px lower, and nothing collided
    //                 in the build because the overflow was empty space.
    //   inlineImage — a picture on a line box leaves room under the baseline
    //                 for descenders, and a flex child has no line box, so
    //                 everything under it rose about 5px.
    const needsOwnHeight = needsOwnBox || node.overflows || node.inlineImage;
    if ((node.anchors.width || needsOwnBox) && node.box.w > 0) {
      push("width", `${lenOf(node.box.w, scale)}px`);
    }
    // The border box, never the ink: the ink is what tracing pins, and a CSS
    // height taken from it makes the element shorter than its own type.
    const ownH = (node.borderBox && node.borderBox.h) || node.box.h;
    if ((node.anchors.height || needsOwnHeight) && ownH > 0) {
      push("height", `${lenOf(ownH, scale)}px`);
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
    // The subset has `gap` and neither longhand, and a deck that writes only
    // one of them computes `gap` as "normal 32px" — which parses to NaN, so the
    // spacing vanished without a word. Four slides of a real deck had every row
    // body sitting 32px left of where it belonged.
    //
    // One value is all the format takes, so the axis that actually spaces this
    // box decides: a row is spaced by its column gap, a column by its row gap.
    // A grid using both differently cannot be expressed and says so.
    const rowGap = parseFloat(s.rowGap);
    const colGap = parseFloat(s.columnGap);
    const column = (s.flexDirection || "").startsWith("column");
    let gap = parseFloat(s.gap);
    if (!isFinite(gap)) {
      // Whichever axis this box actually spaces along — but only when there is
      // a choice to make. A row that wraps is spaced down the page by its ROW
      // gap, so picking by direction alone would drop a `row-gap: 54px` on a
      // wrapping row and leave its lines touching. So: if only one longhand is
      // a length, that is the answer whatever the direction.
      const haveRow = isFinite(rowGap) && rowGap > 0;
      const haveCol = isFinite(colGap) && colGap > 0;
      if (haveRow && !haveCol) gap = rowGap;
      else if (haveCol && !haveRow) gap = colGap;
      else if (haveRow && haveCol) {
        gap = s.display === "grid" || s.flexWrap === "wrap"
          ? Math.max(rowGap, colGap)
          : column ? rowGap : colGap;
      }
    }
    if (
      (s.display === "grid" || s.flexWrap === "wrap") &&
      isFinite(rowGap) && isFinite(colGap) && rowGap > 0 && colGap > 0 &&
      Math.abs(rowGap - colGap) > 0.5
    ) {
      ctx.warnings.push({
        slide: ctx.slide,
        kind: "gap-axes-differ",
        message:
          `a grid spaces its rows by ${Math.round(rowGap)}px and its columns by ${Math.round(colGap)}px, ` +
          "and the subset takes one gap for both; the larger is used",
      });
    }
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
    if (want > 256) {
      // Padding stops at 256px, so a wider gap cannot be given back that way —
      // on a real cover a 646px mark left the words 408px adrift, the largest
      // error in that deck. A gap this size is expressible, just not as
      // padding: a flex row holding a sized spacer and then the text puts the
      // words exactly where the deck has them, and still reflows. The wrapper
      // is built at emit time; here the padding is simply left alone.
      node.leadSpacer = Math.round(want);
      // The row needs its own width for the spacer to have slack to take, and
      // the host's gap travels with it: the host is a flex row in the deck and
      // is emitted as a text tag, which the subset gives no display, so its
      // gap would otherwise be dropped along with its flex-ness.
      node.leadRow = Math.round(lenOf(node.box.w, scale));
      const g = parseFloat(s.columnGap);
      const g2 = parseFloat(s.gap);
      node.leadGap = Math.round(isFinite(g) && g > 0 ? g : isFinite(g2) && g2 > 0 ? g2 : 0);
    } else {
      pad[3] = Math.min(256, want);
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
  // A percentage radius stays a percentage. Chrome serialises `border-radius:
  // 50%` as "50%", and running that through lenOf() gives the NUMBER 50, which
  // was then emitted as 50px — the right picture only while the box happens to
  // be under 100px across, and a barely-rounded corner on anything larger. The
  // subset takes a percentage here, so there is nothing to convert.
  const radiusRaw = String(s.borderTopLeftRadius || "").trim();
  if (/%$/.test(radiusRaw)) {
    const pct = parseFloat(radiusRaw);
    if (isFinite(pct) && pct > 0) push("border-radius", `${r2(pct)}%`);
  } else {
    const radius = lenOf(s.borderTopLeftRadius, scale);
    if (radius > 0) push("border-radius", `${radius}px`);
  }

  const opacity = parseFloat(s.opacity);
  if (isFinite(opacity) && opacity < 1) push("opacity", String(opacity));

  // Two things become a `transform` here, and the grammar takes them in one
  // order, each at most once — so they are collected and written together.
  //
  // A relative offset moves the paint and not the layout, which is exactly
  // what a translate does — and the subset has translate. The format says
  // `left top right bottom · pinned only (relative does not offset)`, so the
  // offset cannot travel as written, and emitting the flow box put a deck's
  // two pictures 36.67px low because their rule lifts them by that much.
  //
  // Pinning them would also place them correctly and would stop them
  // reflowing. A translate does not: the element keeps its place in the flow
  // and only its paint moves, which is what `position: relative` means and
  // what the author chose it for.
  const offs = [];
  if (!pinned && s.position === "relative") {
    const axis = (near, far) => {
      const a = parseFloat(s[near]);
      if (isFinite(a) && Math.abs(a) > 0.5) return a;
      const b = parseFloat(s[far]);
      if (isFinite(b) && Math.abs(b) > 0.5) return -b;
      return 0;
    };
    const dx = lenOf(axis("left", "right"), scale);
    const dy = lenOf(axis("top", "bottom"), scale);
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      offs.push(dy && !dx ? `translateY(${dy}px)` : dx && !dy ? `translateX(${dx}px)` : `translate(${dx}px, ${dy}px)`);
    }
  }

  // A text-indent, as the same kind of translate.
  //
  // The subset has no text-indent, and nothing stood in for it, so a theme
  // using it to optically align a title lost the alignment with no warning —
  // the one property whose entire purpose is to put ink somewhere the box
  // does not say. Measured on a real cover: a -0.0817em indent on a 133px
  // wordmark is -10.87px, and without it the glyphs sat that far right of the
  // rule drawn under them, which is what a reader notices.
  //
  // Flow only, like the leading-pseudo padding above and for the same reason:
  // a traced box is pinned at its ink, and the ink already has the indent in
  // it. Folding it again there would move the glyphs twice.
  //
  // An indent applies to the FIRST line; a translate moves the whole box. On
  // one line those are the same thing and on more than one they are not, so a
  // wrapped element is warned about rather than quietly shifted — every use
  // of this in the theme that prompted it is a single line, and the case that
  // is not should be visible rather than approximated.
  if (!ctx.pinHere) {
    const indent = lenOf(s.textIndent, scale);
    // Only where this element declares it. Inherited, the same offset would
    // be applied again at every level beneath the one that set it.
    const own = indent - (inherited.indent || 0);
    if (Math.abs(indent) > 0.5 && Math.abs(own) > 0.5) {
      if (node.ink && node.ink.lines > 1) {
        ctx.warnings.push({
          slide: ctx.slide,
          kind: "text-indent-wrapped",
          message:
            `<${node.tag}>${node.cls ? " ." + node.cls.split(/\s+/)[0] : ""} has a ` +
            `${Math.round(indent * 10) / 10}px text-indent over ${node.ink.lines} lines. The ` +
            "subset has no text-indent and a transform moves every line, not the first, so it " +
            "is not carried; the first line will start where the others do",
        });
      } else {
        offs.push(`translateX(${own}px)`);
      }
    }
  }
  // And a rotation, which the subset also has. The box this is applied to is
  // the UPRIGHT one — the harvest measured it with the transform off — so this
  // reproduces exactly what the deck draws, about the same centre.
  if (node.rotate) offs.push(`rotate(${node.rotate}deg)`);
  // translate before rotate: the grammar takes them in that order, each once.
  if (offs.length) push("transform", offs.join(" "));
  // The subset has no transform-origin, so a deck that moved the origin gets a
  // rotation about the centre instead, which is a different picture. Said out
  // loud rather than quietly done.
  if (node.rotate) {
    const origin = String(s.transformOrigin || "").trim();
    const parts = origin.split(/\s+/).map((v) => parseFloat(v));
    const centred =
      !origin ||
      (parts.length >= 2 &&
        Math.abs(parts[0] - node.box.w / 2) < 1 &&
        Math.abs(parts[1] - node.box.h / 2) < 1);
    if (!centred) {
      ctx.warnings.push({
        slide: ctx.slide,
        kind: "transform-origin-dropped",
        message:
          `<${node.tag}>${node.cls ? " ." + node.cls.split(/\s+/)[0] : ""} rotates about ` +
          `${origin}, and the subset rotates about the centre only; it will sit elsewhere`,
      });
    }
  } else if (node.spins === false) {
    ctx.warnings.push({
      slide: ctx.slide,
      kind: "transform-dropped",
      message:
        `<${node.tag}>${node.cls ? " ." + node.cls.split(/\s+/)[0] : ""} carries ` +
        `${s.transform}, which is not a plain rotation — a scale, a skew or a mirror cannot be ` +
        "reconstructed from the matrix, so the transform is not carried and the box is emitted " +
        "at the size and place it was measured",
    });
  }

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

// Measurement only. Every element the export emits is tagged with the box the
// exporter believed it was placing, so a render of the slide can be compared
// element for element — not just the ones with words in them.
//
// Text could be paired on its own content; an image, a drawing, a pinned
// caption or a painted box cannot, and those are exactly what a reader notices
// missing. Every defect found by eye on one morning's review was one of them,
// and all three measured clean.
//
// `data-*` is ignored by the page (a NOTE heal, never an error), and this is
// never on for a real export.
function emitNode(node, ctx, inherited, depth) {
  const html = probed(emitNodeInner(node, ctx, inherited, depth), node, ctx);
  // A pinned box is lifted to be a direct child of the section.
  //
  // The page does not place a pinned box the way CSS does. Measured on a live
  // artifact, one variable at a time: a pinned box directly under the section
  // lands where its coordinates say, and the same box buried in two flow divs
  // lands near the bottom of the slide — the page adds the offset its flow
  // parent would have had. Its coordinates are already the slide's, so the
  // nesting is the whole error, and removing it makes them mean what they say.
  //
  // It is also what made a nested pinned box change its parent's size and stop
  // a sibling centring. One cause, two symptoms, and the format says as much:
  // a pinned div inside a host is flattened and its children re-pin to the
  // host. Tracing already emits flat, so this is for flow.
  //
  // Not one nested in another pinned box, though. Its coordinates are its
  // parent's, not the slide's — a scatter point is placed, and its dot sits at
  // `bottom: 0` of that point — so lifting it out resolves those against the
  // slide and scatters the dots along its bottom edge. Only a box whose
  // containing block is already the section has slide coordinates to keep.
  const pinnedHere =
    !ctx.pinHere && (node.style.position === "absolute" || node.style.position === "fixed");
  if (pinnedHere && depth > 1 && !ctx.insidePinned && html && ctx.hoisted) {
    ctx.hoisted.push(html);
    return "";
  }

  // Where a leading pseudo-element held more space open than padding can carry,
  // the space is given back as a sized spacer in a flex row. An empty div and
  // a width are both in the subset, and unlike a pinned box this still reflows
  // when the words change.
  let out = html;
  if (out && node.leadSpacer && node.leadRow && !ctx.pinHere) {
    // The spacer GROWS into a bounded row; it is not given a width.
    //
    // Measured on the live page, three forms, one variable each: an empty div
    // at `width:646px` collapses, the same div at `flex:0 0 646px` collapses,
    // and one at `flex:1 1 auto` inside a row with an explicit width holds.
    // The format says as much by only ever offering `flex:1` as the spacer
    // idiom and never a fixed-width one. So the row carries the measured
    // width, and the spacer takes whatever the words leave — which is the gap,
    // and which still comes out right when the words change.
    //
    // This cost a published cover: the fixed-width form validated, rendered
    // correctly in a browser, and collapsed in the viewer, putting the words
    // on top of the rule rather than after it.
    const gap = node.leadGap ? `;gap:${node.leadGap}px` : "";
    // The row owns the width now, so the host must not: left on, it fills the
    // row and the spacer is left with nothing to grow into, which puts the
    // words back on top of the rule by a different route.
    const inner = out.replace(/^(<[a-z0-9-]+[^>]*?style=")width:[0-9.]+px;?/i, "$1");
    out =
      `<div style="width:${node.leadRow}px;display:flex;align-items:baseline${gap}">\n` +
      `<div style="flex:1 1 auto"></div>\n` +
      `${inner}\n</div>`;
  }

  // A painted pseudo-element belongs with its host, not at the top of the
  // slide. Every one used to be emitted before all the content so it sat
  // behind it — which is right for a band drawn behind its own text, and wrong
  // the moment a full-bleed backdrop is listed later and paints over the lot.
  // Paint order is source order and there is no z-index, so the only way a
  // pseudo lands in the right layer is to be emitted where its host is.
  if (!ctx.pinHere && node.pseudos && node.pseudos.length && ctx.hoisted) {
    for (const ps of node.pseudos) {
      const box = pseudoHtml(ps, ctx);
      if (box) ctx.hoisted.push(box);
    }
  }
  return out;
}

// Tagged with the box the exporter believed it was placing, for measurement.
function probed(html, node, ctx) {
  if (!ctx.probes || !html || node.transparent) return html;
  // Only when the result is one element: a flattened container returns its
  // children, and tagging the first would attribute the parent's box to it.
  const m = /^<([a-z0-9-]+)(?=[\s>])/i.exec(html);
  if (!m) return html;
  const id = ctx.probes.length;
  ctx.probes.push({
    id,
    tag: node.tag,
    role: (node.roleCls || node.cls || "").split(/\s+/).filter(Boolean).join(" ") || node.tag,
    box: { x: r2(node.box.x), y: r2(node.box.y), w: r2(node.box.w), h: r2(node.box.h) },
  });
  return html.slice(0, m[0].length) + ` data-sdoc-probe="${id}"` + html.slice(m[0].length);
}

function emitNodeInner(node, ctx, inherited, depth) {
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
    // Most of what a tag refuses is spacing, and the count above is enough.
    // `display` is not: the subset allows it on a section and a div and
    // nowhere else, so a <p> told to centre its text with flex loses the
    // instruction and the words sit at the top of the box instead. That moves
    // text rather than the space around it, and it is worth a sentence.
    if (allowed && !allowed.has("display") && decls.some((d) => d.startsWith("display:"))) {
      ctx.warnings.push({
        slide: ctx.slide,
        kind: "display-dropped",
        message:
          `<${tag}>${node.cls ? " ." + node.cls.split(/\s+/)[0] : ""} is a flex or grid box in the deck, ` +
          "and the subset allows display only on a section or a div — its contents fall back to the top " +
          "left of it; wrap them in a div, or arrange from the parent",
      });
    }
    if (extra) kept.push(extra);
    return kept.length ? ` style="${kept.join(";")}"` : "";
  };
  const style = styleFor(node.tag === "img" ? "img" : "div");
  const next = {
    font: fontStack(node.style.fontFamily) ? fontStack(node.style.fontFamily).css : inherited.font,
    size: lenOf(node.style.fontSize, ctx.scale) || inherited.size,
    weight: parseInt(node.style.fontWeight, 10) || inherited.weight,
    colour: colourOf(node.style.color) || inherited.colour,
    // text-indent inherits, so a container that sets one hands it to every
    // text element beneath it. The offset is carried as a transform, and a
    // transform does not inherit — it composes. Tracking what came down
    // means only the element that actually declares an indent is moved,
    // rather than it and each of its descendants in turn.
    indent: lenOf(node.style.textIndent, ctx.scale) || 0,
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
    // A drawing the deck pinned keeps its pin. The flow path used to return the
    // bare markup, which has no position on it at all, so a pinned arrow fell
    // to the end of the section and landed bottom left. It reached the output
    // and was still in the wrong place, which is worse than being dropped.
    if (!ctx.pinHere) {
      const own = node.style.position;
      if (own !== "absolute" && own !== "fixed") return markup;
      return `<div${styleFor("div")}>${markup}</div>`;
    }
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
  if (node.rows) {
    return ctx.tablesAsBoxes
      ? emitTableAsBoxes(node, ctx, styleFor("div"))
      : emitTable(node, ctx, styleFor("table"));
  }

  if (node.items && ctx.listsAsBoxes) {
    // A list the deck spaced deliberately, where a plain <li> would lose it.
    const colStyle = styleFor("div", "display:flex;flex-direction:column");
    return emitListAsBoxes(node, ctx, colStyle);
  }

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

  // Children of a pinned box are measured against it, so they stay inside it.
  const childCtx =
    node.style.position === "absolute" || node.style.position === "fixed"
      ? { ...ctx, insidePinned: true }
      : ctx;
  const inner = node.children.map((c) => emitNode(c, childCtx, next, depth + 1)).join("\n");
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

// A list as a column of plain boxes, for a deck that asks for it with
// `artifact-lists: boxes` in its @meta.
//
// The format allows a plain <li> and nothing else — no style at all — so every
// list is a stack of items at their natural height. A deck that spaces its
// items deliberately loses that: one real deck gives each stage `flex: 1 1 0`
// so eight of them divide a 501px spine evenly and each meets its own spur,
// and as plain items they pack to the top and stop meeting anything.
//
// Same trade as the table: this is no longer a list to a screen reader, which
// is why it is opt-in.
function emitListAsBoxes(node, ctx, style) {
  const scale = ctx.scale;
  const items = (node.items || [])
    .map((item) => {
      const st = item.style || {};
      const parts = [];
      if (st.display === "flex" || st.display === "grid") {
        parts.push(`display:${st.display}`);
        if (st.display === "flex" && st.flexDirection && st.flexDirection !== "row") {
          parts.push(`flex-direction:${st.flexDirection}`);
        }
        if (st.alignItems && !["normal", "stretch"].includes(st.alignItems)) {
          parts.push(`align-items:${alignWord(st.alignItems)}`);
        }
      }
      const grow = parseFloat(st.flexGrow);
      if (isFinite(grow) && grow > 0) {
        const shrink = isFinite(parseFloat(st.flexShrink)) ? parseFloat(st.flexShrink) : 1;
        const basis = !st.flexBasis || st.flexBasis === "auto" ? "auto"
          : st.flexBasis === "0%" || st.flexBasis === "0px" ? "0%"
            : `${lenOf(st.flexBasis, scale)}px`;
        parts.push(grow === 1 && shrink === 1 && basis === "0%" ? "flex:1" : `flex:${grow} ${shrink} ${basis}`);
      }
      const pads = ["Top", "Right", "Bottom", "Left"].map((k) =>
        Math.max(0, Math.min(256, lenOf(st[`padding${k}`], scale)))
      );
      if (pads.some((v) => v > 0)) parts.push(`padding:${pads.map((v) => `${v}px`).join(" ")}`);
      const fill = colourOf(st.backgroundColor);
      if (fill) parts.push(`background:${fill}`);
      const colour = colourOf(st.color);
      if (colour) parts.push(`color:${colour}`);
      const attr = parts.length ? ` style="${parts.join(";")}"` : "";
      // The words in a text element, as everywhere: a div holding them is not
      // in the subset and an inline mark inside one is rejected outright.
      return `<div${attr}><p>${runsToHtml(item.runs, ctx)}</p></div>`;
    })
    .join("\n");
  return `<div${style}>\n${items}\n</div>`;
}

// A table as a grid of plain boxes, for a deck that asks for it with
// `artifact-tables: boxes` in its @meta.
//
// The viewer styles a real table its own way and will not be talked out of it:
// it rules every cell and puts its own background behind a header row, and a
// colour on a mark inside a cell is lost. None of that is reachable from the
// deck, because the format gives a cell only colour, alignment, a width and
// the table's one padding.
//
// The same data as boxes has none of those limits — a div is unruled until the
// deck rules it, takes a background so banding comes back, and holds an
// ordinary coloured span. What it costs is real and the reason this is opt-in:
// a grid of boxes is not a table to a screen reader, and the columns no longer
// size themselves, so each cell is given the share it was measured at.
// One line of a cell drawn as a box.
//
// An inline stretch is a plain <p> and inherits the cell's type, which is what
// it did before. A child the theme made block or inline-block carries its own
// box and type instead, because that is what it had in the build and a run
// cannot hold any of it: the padding, the rule, the radius and the fill that
// turn a <strong> into a pill, and the size and weight that make a stacked
// label read as a heading above its caption.
//
// An inline-block shrinks to its content rather than being given a width.
// A measured width cannot be emitted safely here: the subset accepts
// `box-sizing` as a no-op, so whether a width means the border box or the
// content box is the runtime's choice and not ours, and the two differ by the
// padding and rule that make a pill a pill — 110px measured against 140px
// rendered, a pill drawn as a bar. `align-self:start` says the same thing
// without a number, and it is what the format's own note describes: a pill is
// a <p> with a background, padding and a radius.
//
// Only the inline-block gets it. A block child is a full-width line, and
// shrinking it to its content would re-wrap its text at a different word;
// left to stretch it keeps the line breaks the build chose.
function emitCellLine(line, cell, ctx, scale) {
  if (line.kind !== "box") return `<p>${runsToHtml(line.runs, ctx)}</p>`;
  const s = line.style || {};
  const out = [];

  if (line.display === "inline-block") out.push("align-self:start");
  const pads = ["Top", "Right", "Bottom", "Left"].map((k) =>
    Math.max(0, Math.min(256, lenOf(s[`padding${k}`], scale)))
  );
  if (pads.some((v) => v > 0)) out.push(`padding:${pads.map((v) => `${v}px`).join(" ")}`);

  const sides = ["Top", "Right", "Bottom", "Left"].map((k) => borderOf(s, k, scale));
  const names = ["border-top", "border-right", "border-bottom", "border-left"];
  if (sides.every((b) => b && b === sides[0])) out.push(`border:${sides[0]}`);
  else sides.forEach((b, i) => { if (b) out.push(`${names[i]}:${b}`); });

  const radiusRaw = String(s.borderTopLeftRadius || "").trim();
  if (radiusRaw.endsWith("%")) {
    const pct = parseFloat(radiusRaw);
    if (isFinite(pct) && pct > 0) out.push(`border-radius:${pct}%`);
  } else {
    const radius = lenOf(s.borderTopLeftRadius, scale);
    if (radius > 0) out.push(`border-radius:${radius}px`);
  }

  const fill = colourOf(s.backgroundColor);
  if (fill) out.push(`background:${fill}`);

  // Type only where it differs from the cell, which keeps the common line a
  // bare <p> and says what a pill or a stacked label actually asked for.
  const colour = colourOf(s.color);
  if (colour && colour !== colourOf(cell.style.color)) out.push(`color:${colour}`);
  const face = fontStack(s.fontFamily);
  const cellFace = fontStack(cell.style.fontFamily);
  if (face && (!cellFace || face.css !== cellFace.css)) {
    out.push(`font-family:${face.css}`);
    if (face.declared) ctx.faces.add(face.declared);
  }
  const size = lenOf(s.fontSize, scale);
  if (size && size !== lenOf(cell.style.fontSize, scale)) out.push(`font-size:${size}px`);
  const weight = parseInt(s.fontWeight, 10);
  const cellWeight = parseInt(cell.style.fontWeight, 10);
  if (weight && weight !== cellWeight) {
    out.push(`font-weight:${String(Math.round(weight / 100) * 100)}`);
  }
  // Tracking is part of the type treatment wherever a label is set in caps,
  // and a line that does not carry it renders tighter than the build by the
  // character count times the tracking — 4.2px to 7.2px on a pill, which
  // reads as the text sitting loose in its box rather than as a missing
  // property. The exporter emits it everywhere else; this path did not.
  // Leading, because the runtime's default is not this deck's. The format's
  // reference gives a <p> a default line-height of 1.4; a theme on 1.25 that
  // says nothing therefore renders every line ~0.15 of its font-size taller
  // than the build — about 2.9px on a 19px line, doubled per two-line cell
  // and multiplied by the rows, which grows the table rather than only
  // loosening it. The failure is a table pushing into whatever sits beneath
  // it, which is why this is carried on a documented difference rather than
  // waiting for a deck to look wrong.
  const leading = lenOf(s.lineHeight, scale);
  if (leading > 0) out.push(`line-height:${leading}px`);
  const track = lenOf(s.letterSpacing, scale);
  const cellTrack = lenOf(cell.style.letterSpacing, scale);
  if (s.letterSpacing && s.letterSpacing !== "normal" && track !== cellTrack) {
    out.push(`letter-spacing:${track}px`);
  }
  if (s.whiteSpace === "nowrap") out.push("white-space:nowrap");

  return out.length
    ? `<p style="${out.join(";")}">${runsToHtml(line.runs, ctx)}</p>`
    : `<p>${runsToHtml(line.runs, ctx)}</p>`;
}

function emitTableAsBoxes(node, ctx, style) {
  const scale = ctx.scale;
  const rows = node.rows
    .map((row) => {
      const cells = row.cells
        .map((cell) => {
          const parts = [];
          if (node.box.w) {
            parts.push(`width:${Math.round((cell.box.w / node.box.w) * 1000) / 10}%`);
          }
          const pads = ["Top", "Right", "Bottom", "Left"].map((k) =>
            Math.max(0, Math.min(256, lenOf(cell.style[`padding${k}`], scale)))
          );
          if (pads.some((v) => v > 0)) parts.push(`padding:${pads.map((v) => `${v}px`).join(" ")}`);
          // A cell may carry its own rule now, and its own fill.
          const sides = ["Top", "Right", "Bottom", "Left"].map((k) => borderOf(cell.style, k, scale));
          const names = ["border-top", "border-right", "border-bottom", "border-left"];
          if (sides.every((b) => b && b === sides[0])) parts.push(`border:${sides[0]}`);
          else sides.forEach((b, i) => { if (b) parts.push(`${names[i]}:${b}`); });
          const fill = colourOf(cell.style.backgroundColor);
          if (fill) parts.push(`background:${fill}`);
          const align = cell.style.textAlign;
          if (align && !["start", "left"].includes(align)) parts.push(`text-align:${align}`);
          const colour = colourOf(cell.style.color);
          if (colour) parts.push(`color:${colour}`);
          // And its own type, which a real cell could not take either.
          const face = fontStack(cell.style.fontFamily);
          if (face) {
            parts.push(`font-family:${face.css}`);
            if (face.declared) ctx.faces.add(face.declared);
          }
          const size = lenOf(cell.style.fontSize, scale);
          if (size) parts.push(`font-size:${size}px`);
          const weight = parseInt(cell.style.fontWeight, 10);
          if (weight) parts.push(`font-weight:${String(Math.round(weight / 100) * 100)}`);
          // Where the content sits when the row is taller than this cell, and
          // how its lines stack.
          //
          // The cell is laid out as a column rather than aligned as an item:
          // align-self would shrink the cell to its content, which takes the
          // row's banding with it wherever the fill is on a cell rather than
          // the row. Stretched cell, justified content, so a centred column
          // keeps its background.
          //
          // Both are emitted only when the deck asks for something — a cell
          // that is top-aligned with no block children is left exactly as it
          // was, so a deck already exporting correctly does not move.
          const vmid = cell.valign === "middle";
          const vend = cell.valign === "bottom";
          if (cell.lines || vmid || vend) {
            parts.push("display:flex", "flex-direction:column");
            if (vmid) parts.push("justify-content:center");
            else if (vend) parts.push("justify-content:flex-end");
          }
          // The words go in a <p>, not straight into the div. An inline mark
          // needs a text element around it — a <td> is one and a <div> is not,
          // so a bold inside a cell div is rejected outright by the editor:
          // "<b> is not a tag in this format" at that position. The format
          // says the same in general terms: text must sit in a text element.
          // A cell with no block children carries its leading too, and for a
          // reason the line path alone does not cover: a row is as tall as
          // its tallest cell, so a plain cell left at the runtime's default
          // sets the row's height whatever its neighbours do. Carrying it on
          // the lines and not here would leave the table exactly as tall as
          // it was and only change which cell decided.
          const lead = lenOf(cell.style.lineHeight, scale);
          const plain = lead > 0
            ? `<p style="line-height:${lead}px">${runsToHtml(cell.runs, ctx)}</p>`
            : `<p>${runsToHtml(cell.runs, ctx)}</p>`;
          const body = cell.lines
            ? cell.lines.map((line) => emitCellLine(line, cell, ctx, scale)).join("")
            : plain;
          return `<div style="${parts.join(";")}">${body}</div>`;
        })
        .join("\n");
      const rowParts = ["display:flex"];
      const bg = colourOf(row.style.backgroundColor);
      if (bg) rowParts.push(`background:${bg}`);
      const rs = ["Top", "Right", "Bottom", "Left"].map((k) => borderOf(row.style, k, scale));
      const rn = ["border-top", "border-right", "border-bottom", "border-left"];
      rs.forEach((b, i) => { if (b) rowParts.push(`${rn[i]}:${b}`); });
      return `<div style="${rowParts.join(";")}">\n${cells}\n</div>`;
    })
    .join("\n");
  return `<div${style}>\n${rows}\n</div>`;
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
          // A colour on a mark inside a cell does not survive. Tested on the
          // live page, both nestings, one variable: <b><span style="color">
          // and <span style="color"><b> both come out in the CELL's colour.
          // So the override is lost and the cell wins, whichever way round it
          // is written — a format limit, not something to emit differently.
          //
          // It moves nothing, so no measurement finds it: the figure is simply
          // the wrong colour. Worth telling the author, because the fix is in
          // their stylesheet — put the colour on the cell and drop the
          // override — and nothing else would tell them.
          const cellColour = colourOf(cell.style.color);
          for (const r of cell.runs || []) {
            if (r.color && cellColour && colourOf(r.color) !== cellColour) {
              differing.add(`a mark coloured ${colourOf(r.color)} inside a cell coloured ${cellColour}`);
              break;
            }
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
    : slide.children
        .map((c) => {
          const piece = emitNode(c, ctx, inherited, 1);
          // Paint order is source order, so a box lifted out of this subtree is
          // placed straight after it rather than at the end of the slide: a
          // backdrop pinned before the text stays behind it, an overlay pinned
          // after it stays in front.
          const lifted = ctx.hoisted.splice(0).join("\n");
          return [piece, lifted].filter(Boolean).join("\n");
        })
        .filter(Boolean)
        .join("\n");

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
    // In flow, a host emits its own pseudo in its own place, so paint order
    // follows the deck's. Tracing arranges nothing and emits every box here,
    // and anything no host claimed still falls back to this pass.
    if (p.box && p.style && (ctx.pinAll || !p.attached)) {
      painted.push(pseudoHtml(p, ctx));
    } else if (p.painted && !p.box) {
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
      probes: options.probe === true ? [] : null,
      hoisted: [],
      // `artifact-tables: boxes` in a deck's @meta: send a table as a grid of
      // plain boxes, because the viewer styles a real table its own way.
      tablesAsBoxes: options.tablesAsBoxes === true,
      // `artifact-lists: boxes`: the same, for a list whose items are spaced
      // by the deck rather than by their own height.
      listsAsBoxes: options.listsAsBoxes === true,
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
      probes: ctx.probes || undefined,
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
