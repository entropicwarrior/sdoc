// SDOC Slides — the strokes drawn on a deck during a talk, kept per slide.
//
// Pure bookkeeping, with no page in it: what has been drawn, in the order it
// was drawn, and the messages by which one window's copy follows another's.
// The page draws what this holds (inkBook in src/slide-annotate.js).
//
// A stroke is
//
//   { id, slide, tool, color, size, points, rects, live, rev }
//
//   tool    pen, highlighter, rect or callout
//   slide   the slide's position as the hash writes it: "7", or "7.2"
//   points  [[x, y, pressure?], ...] in slide design pixels
//   rects   [{ x, y, w, h }, ...] or null. Boxes replace the freehand shape:
//           a highlight snapped to words, a settled rectangle's one box, a
//           callout's box. At most 200 are kept
//   live    still being drawn
//   rev     moves on each time the stroke is given a new shape, so a drawing
//           cached against it knows to redraw
//
// and a callout also holds { text, font, maxW, width, target, side }: its
// text (2000 characters at most) and that text's size, the width it wraps at
// or, once resized by hand, the width it is, the box of what it points at and
// the side of it the callout sits on.
//
// Whatever comes from outside — the other window — is copied field by field,
// and only what a stroke should hold is kept: an unknown tool is a pen, a
// colour that is not #rgb or #rrggbb is the default, a point or a box with a
// number missing is dropped. Nothing is thrown.
//
// createStrokes(defaults) -> the store
//   defaults  { unit(), pen, highlight }: the design pixel sizes are written
//             in (a slide 1280 wide has a unit of 1), asked for when needed,
//             and the colours of a pen and a highlighter that name none
//
//   add(stroke)          the stroke as kept, or null: no id, no slide, or an
//                        id already held
//   extend(id, points)   more points on the end; the stroke, or null
//   replace(stroke)      a held stroke given another shape — points, rects and
//                        a callout's fields; its tool, colour, size and place
//                        in the order stay. The stroke, or null
//   remove(ids)          returns the slides that changed
//   clear(slide?)        one slide, or with none every slide; returns the
//                        slides that changed
//   apply(message)       one of the messages below; returns the slides that
//                        changed
//   get(id), strokes(slide), count(slide?), labels()
//                        a stroke; a slide's strokes in order (a copy of the
//                        list); how many, on a slide or in all; the slides
//                        with any
//   wire(stroke)         the stroke as it goes into a message: a copy, so one
//                        still being drawn does not change under a message
//                        already sent
//   clean(points), cleanRects(rects), isColour(value)
//                        the checks above, for a caller with its own input
//
// The messages, by op:
//
//   begin   { stroke }          a stroke starts, and is live
//   add     { id, points }      more of it
//   end     { id, points? }     it is finished
//   replace { stroke }          its final shape
//   remove  { ids }
//   clear   { slide? }
//   slide   { slide, strokes }  all of one slide's ink, replacing what is held
//
// SELF-CONTAINED ON PURPOSE: createStrokes is serialised into the deck with
// toString() (STROKES_JS), so it may not reference anything outside its own
// body, and nothing in it may spell the tag that closes a script element. It
// is ES5, as the page's other runtimes are.

function createStrokes(defaults) {
  var COLOUR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
  var MOST_RECTS = 200, MOST_TEXT = 2000;
  // No prototype under either: a slide or a stroke may be named anything,
  // "constructor" included.
  var slides = Object.create(null), byId = Object.create(null);

  function unit() { return defaults && typeof defaults.unit === "function" ? defaults.unit() : 1; }
  function num(v) { return typeof v === "number" && isFinite(v); }
  function isColour(v) { return COLOUR.test(String(v)); }
  function clean(points) {
    var out = [];
    for (var i = 0; points && i < points.length; i++) {
      var q = points[i];
      if (!q || !num(q[0]) || !num(q[1])) continue;
      out.push(num(q[2]) ? [q[0], q[1], q[2]] : [q[0], q[1]]);
    }
    return out;
  }
  function cleanRects(list) {
    var out = [];
    for (var i = 0; list && i < list.length && out.length < MOST_RECTS; i++) {
      var b = list[i];
      if (!b || !num(b.x) || !num(b.y) || !num(b.w) || !num(b.h) || b.w < 0 || b.h < 0) continue;
      out.push({ x: b.x, y: b.y, w: b.w, h: b.h });
    }
    return out.length ? out : null;
  }
  function calloutFields(t, s) {
    t.text = typeof s.text === "string" ? s.text.slice(0, MOST_TEXT) : "";
    t.font = num(s.font) && s.font > 0 && s.font < 400 ? s.font : 22 * unit();
    t.maxW = num(s.maxW) && s.maxW > 0 ? s.maxW : 520 * unit();
    t.width = num(s.width) && s.width > 0 ? s.width : null;
    t.target = (cleanRects(s.target ? [s.target] : null) || [null])[0];
    t.side = /^(right|left|below|above)$/.test(s.side) ? s.side : null;
  }

  function add(s) {
    if (!s || s.id == null || s.slide == null || byId[s.id]) return null;
    var t = {
      id: String(s.id), slide: String(s.slide),
      tool: /^(highlighter|rect|callout)$/.test(s.tool) ? s.tool : "pen",
      color: isColour(s.color) ? String(s.color) : s.tool === "highlighter" ? defaults.highlight : defaults.pen,
      size: num(s.size) && s.size > 0 && s.size < 500 ? s.size : 5 * unit(),
      points: clean(s.points), rects: cleanRects(s.rects), live: !!s.live, rev: 0
    };
    if (t.tool === "callout") calloutFields(t, s);
    (slides[t.slide] = slides[t.slide] || []).push(t);
    byId[t.id] = t;
    return t;
  }
  function extend(id, points) {
    var s = byId[id];
    if (!s) return null;
    var more = clean(points);
    for (var i = 0; i < more.length; i++) s.points.push(more[i]);
    return s;
  }
  function get(id) { return byId[String(id)] || null; }
  function replace(w) {
    var s = w && w.id != null ? get(w.id) : null;
    if (!s) return null;
    s.points = clean(w.points);
    s.rects = cleanRects(w.rects);
    if (s.tool === "callout") calloutFields(s, w);
    s.live = false;
    s.rev = (s.rev || 0) + 1;
    return s;
  }
  function remove(ids) {
    var touched = Object.create(null);
    [].concat(ids || []).forEach(function (id) {
      var s = byId[id];
      if (!s) return;
      delete byId[id];
      slides[s.slide] = slides[s.slide].filter(function (x) { return x !== s; });
      touched[s.slide] = true;
    });
    return Object.keys(touched);
  }
  function labels() { return Object.keys(slides).filter(function (l) { return slides[l].length; }); }
  function clear(label) {
    if (label == null) {
      var had = labels();
      slides = Object.create(null);
      byId = Object.create(null);
      return had;
    }
    label = String(label);
    (slides[label] || []).forEach(function (s) { delete byId[s.id]; });
    delete slides[label];
    return [label];
  }
  function strokes(label) { return (slides[String(label)] || []).slice(); }
  function count(label) {
    if (label != null) return (slides[String(label)] || []).length;
    return Object.keys(slides).reduce(function (n, l) { return n + slides[l].length; }, 0);
  }
  function wire(s) {
    var w = { id: s.id, slide: s.slide, tool: s.tool, color: s.color, size: s.size, points: s.points.slice() };
    if (s.rects) w.rects = s.rects.map(function (b) { return { x: b.x, y: b.y, w: b.w, h: b.h }; });
    if (s.tool === "callout") {
      w.text = s.text;
      w.font = s.font;
      w.maxW = s.maxW;
      if (s.width) w.width = s.width;
      if (s.target) w.target = { x: s.target.x, y: s.target.y, w: s.target.w, h: s.target.h };
      if (s.side) w.side = s.side;
    }
    if (s.live) w.live = true;
    return w;
  }
  function apply(m) {
    var s;
    if (!m) return [];
    if (m.op === "begin" && m.stroke) {
      s = add(m.stroke);
      if (!s) return [];
      s.live = true;
      return [s.slide];
    }
    if (m.op === "add" || m.op === "end") {
      s = extend(m.id, m.points);
      if (!s) return [];
      if (m.op === "end") s.live = false;
      return [s.slide];
    }
    if (m.op === "replace" && m.stroke) {
      s = replace(m.stroke);
      return s ? [s.slide] : [];
    }
    if (m.op === "remove") return remove(m.ids);
    if (m.op === "clear") return clear(m.slide);
    if (m.op === "slide" && m.slide != null) {
      clear(m.slide);
      [].concat(m.strokes || []).forEach(add);
      return [String(m.slide)];
    }
    return [];
  }

  return {
    add: add, extend: extend, replace: replace, remove: remove, clear: clear, apply: apply,
    get: get, strokes: strokes, count: count, labels: labels, wire: wire,
    clean: clean, cleanRects: cleanRects, isColour: isColour
  };
}

// For the deck: evaluating this defines window.sdocStrokes, the factory.
const STROKES_JS = "window.sdocStrokes = " + createStrokes.toString() + ";";

module.exports = { createStrokes, STROKES_JS };
