// SDOC Slides — freehand ink for the presenter's pen and highlighter.
//
// Pure geometry: raw pointer samples in, a filled outline out, as an SVG path.
// A stroke is drawn as a shape rather than as a stroked line so that its width
// can vary along its length, the way ink does. The two windows of a talk send
// each other a stroke's points, not its path: each turns the same points into
// the same outline with this, so both show the same ink.
//
// Also here, because it is the same kind of arithmetic over the same points:
// what a stroke covers as boxes, and which strokes an eraser touches.
//
// The method, in the spirit of perfect-freehand (none of its code is used):
//
//   1. Streamline. Each sample is pulled only part of the way towards the new
//      input (an exponential moving average), which irons out hand and sensor
//      jitter. The stroke still ends where the pen lifted: the last raw sample
//      is appended after the smoothed ones.
//   2. Width. A real pressure (a stylus) sets the width; without one, speed
//      stands in for it when `simulatePressure` is on — a slow pen pools ink, a
//      fast one thins — measured as distance per sample, since there are no
//      timestamps. `thinning` is how far either can move the width from `size`.
//   3. Spacing. Centre points closer than `smoothing` × the radius are dropped,
//      so the outline has fewer, softer vertices (and the tip of a sharp
//      reversal can lose up to that much length).
//   4. Outline. Each centre point is offset to both sides along the normal of
//      the bisected direction. A turn sharper than 60° gets a round join on its
//      outer side; both ends get round caps; `taperStart` / `taperEnd` narrow
//      the ends over that many pixels of length.
//   5. Path. The closed outline is drawn with quadratic curves through the
//      midpoints of its edges, which is smooth wherever the outline is not.
//
// Fill the path with the nonzero rule, SVG's default. Every part of the band
// circulates the same way, so where a stroke crosses itself the overlap counts
// twice and stays filled; evenodd would punch a hole there.
//
// Coordinates are slide design pixels (1280×720 or whatever the deck uses).
//
// API (all on the object createInk() returns, and on window.sdocInk):
//
//   stroke(points, options)    the SVG path `d` for a stroke; "" for no points
//   outline(points, options)   the closed outline as [[x, y], ...]; [] for none
//   toPath(outline)            the `d` for an outline, rounded to 2 decimals
//   streamline(points, amount) the smoothing of step 1 on its own: the same
//                              number of valid points, [x, y] or [x, y, p]. It is
//                              causal, so a live stroke can be smoothed one
//                              sample at a time: streamline([lastSmoothed, raw])
//   DEFAULTS                   the options below
//   band(a, b)                 the box { x, y, w, h } between two corners
//   boxesOf(stroke)            the boxes a stroke is drawn as, or null for a
//                              freehand one: its rects (a snapped highlight, a
//                              settled rectangle, a callout), or for a
//                              rectangle still being dragged the band from its
//                              first point to its last
//   hit(strokes, a, b, r)      the ids of the strokes an eraser of radius r
//                              touches as it moves from a to b: within r of a
//                              freehand stroke's widest edge anywhere along
//                              it; anywhere on a box, except a rectangle,
//                              which is touched only on its outline, so the
//                              eraser can work inside one without taking it.
//                              A stroke still being drawn (live) is never hit
//
//   stroke   { id, tool, size, points, rects?, live? }, tool one of pen,
//            highlighter, rect, callout
//
//   points   [[x, y, pressure?], ...], pressure 0..1. Leave pressure out for a
//            mouse or trackpad (a mouse reports a fixed 0.5, which is not
//            pressure). Points with a non-finite x or y are ignored.
//   options  size              5     nominal diameter in px
//            thinning          0.5   0..1, how far pressure or speed moves the
//                                    width: at 1 it spans 0 to 2 × size
//            smoothing         0.5   0..1, min centre spacing as a share of the
//                                    radius
//            streamline        0.5   0..0.95, share of each new sample's offset
//                                    that is held back
//            simulatePressure  true  use speed when there is no real pressure
//            taperStart        0     px of length over which the start narrows
//            taperEnd          0     the same for the end
//
// A highlighter is the same call with a large size and thinning 0. A tap is a
// dot of the width its pressure gives: `size` for a mouse.
//
// SELF-CONTAINED ON PURPOSE: createInk is serialised into the deck with
// toString() (INK_JS), so it may not reference anything outside its own body,
// and nothing in it may spell the tag that closes a script element. It is
// ES5, as the page's other runtimes are.

function createInk() {
  var DEFAULTS = {
    size: 5,
    thinning: 0.5,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: true,
    taperStart: 0,
    taperEnd: 0
  };
  var EPS = 0.01;              // closer than this, two points are one point
  var CORNER = Math.PI / 3;    // a turn sharper than this gets a round join
  var STEP = Math.PI / 8;      // the angle between points on a cap or a join
  var DOT = 16;                // points around a tap's dot

  function num(v, fallback) { return typeof v === "number" && isFinite(v) ? v : fallback; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function valid(q) { return !!q && num(q[0], null) !== null && num(q[1], null) !== null; }
  function dist(a, b) { return Math.sqrt((b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1])); }
  function unit(a, b) { var l = dist(a, b); return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; }

  function settings(options) {
    var o = options || {};
    var size = num(o.size, DEFAULTS.size);
    return {
      size: size > 0 ? size : DEFAULTS.size,
      thinning: clamp(num(o.thinning, DEFAULTS.thinning), -1, 1),
      smoothing: clamp(num(o.smoothing, DEFAULTS.smoothing), 0, 1),
      streamline: num(o.streamline, DEFAULTS.streamline),
      simulatePressure: o.simulatePressure === undefined ? DEFAULTS.simulatePressure : !!o.simulatePressure,
      taperStart: Math.max(0, num(o.taperStart, DEFAULTS.taperStart)),
      taperEnd: Math.max(0, num(o.taperEnd, DEFAULTS.taperEnd))
    };
  }

  function streamline(points, amount) {
    var keep = 1 - clamp(num(amount, DEFAULTS.streamline), 0, 0.95);
    var out = [], x = 0, y = 0, p, i, q, qp;
    for (i = 0; points && i < points.length; i++) {
      q = points[i];
      if (!valid(q)) continue;
      qp = num(q[2], undefined);
      if (!out.length) { x = q[0]; y = q[1]; p = qp; }
      else {
        x += (q[0] - x) * keep;
        y += (q[1] - y) * keep;
        if (qp !== undefined) p = p === undefined ? qp : p + (qp - p) * keep;
      }
      out.push(p === undefined ? [x, y] : [x, y, p]);
    }
    return out;
  }

  // Pushes the points strictly between v and v turned by angle, at radius r
  // around (cx, cy). The ends are the caller's, since they are already offsets.
  function arc(out, cx, cy, vx, vy, r, angle, steps) {
    for (var k = 1; k < steps; k++) {
      var a = angle * k / steps, cos = Math.cos(a), sin = Math.sin(a);
      out.push([cx + (vx * cos - vy * sin) * r, cy + (vx * sin + vy * cos) * r]);
    }
  }

  function outline(points, options) {
    var o = settings(options);
    var pts = streamline(points, o.streamline);
    if (!pts.length) return [];
    var i, end;
    for (i = points.length - 1; !valid(points[i]); i--);
    end = points[i];
    if (dist(pts[pts.length - 1], end) > EPS) pts.push([end[0], end[1], num(end[2], undefined)]);

    // Width from real pressure, or from speed, or neither.
    var real = false;
    for (i = 0; i < pts.length; i++) if (pts[i][2] !== undefined) real = true;
    var p = 0.5, radii = [];
    for (i = 0; i < pts.length; i++) {
      if (real) { if (pts[i][2] !== undefined) p = clamp(pts[i][2], 0, 1); }
      else if (o.simulatePressure && i > 0) p += (1 / (1 + dist(pts[i - 1], pts[i]) / o.size) - p) * 0.35;
      radii.push(o.size / 2 * Math.max(0, 1 + o.thinning * (2 * p - 1)));
    }

    // Centre points at least gap apart; the last one always stays.
    var gap = Math.max(EPS, o.smoothing * o.size / 2), c = [[pts[0][0], pts[0][1], radii[0]]], q;
    for (i = 1; i < pts.length; i++) {
      q = [pts[i][0], pts[i][1], radii[i]];
      if (i < pts.length - 1) { if (dist(c[c.length - 1], q) >= gap) c.push(q); continue; }
      if (c.length > 1 && dist(c[c.length - 1], q) < gap) c.pop();
      if (dist(c[c.length - 1], q) > EPS) c.push(q);
    }

    var n = c.length, out = [], k;
    if (n === 1) {
      for (k = 0; k < DOT; k++) {
        var t = 2 * Math.PI * k / DOT;
        out.push([c[0][0] + Math.cos(t) * c[0][2], c[0][1] + Math.sin(t) * c[0][2]]);
      }
      return out;
    }

    // Taper. A stroke shorter than both tapers together gets shorter, shallower
    // ones, so a quick dash stays visible and a growing stroke never jumps.
    var len = [0];
    for (i = 1; i < n; i++) len.push(len[i - 1] + dist(c[i - 1], c[i]));
    var total = len[n - 1], ts = o.taperStart, te = o.taperEnd;
    if (ts + te > 0) {
      var depth = Math.min(1, total / (ts + te));
      var ease = function (v) { v = Math.min(1, v); return v * (2 - v); };
      for (i = 0; i < n; i++) {
        if (ts > 0) c[i][2] *= 1 - depth * (1 - ease(len[i] / (ts * depth)));
        if (te > 0) c[i][2] *= 1 - depth * (1 - ease((total - len[i]) / (te * depth)));
      }
    }

    // Both sides, start to end. The left offset of a direction d is (-dy, dx).
    var left = [], right = [], d1, d2, r, cx, cy;
    for (i = 0; i < n; i++) {
      cx = c[i][0]; cy = c[i][1]; r = c[i][2];
      d1 = i > 0 ? unit(c[i - 1], c[i]) : null;
      d2 = i < n - 1 ? unit(c[i], c[i + 1]) : null;
      var turn = d1 && d2 ? Math.atan2(d1[0] * d2[1] - d1[1] * d2[0], d1[0] * d2[0] + d1[1] * d2[1]) : 0;
      if (Math.abs(turn) <= CORNER) {
        var tx = (d1 ? d1[0] : 0) + (d2 ? d2[0] : 0), ty = (d1 ? d1[1] : 0) + (d2 ? d2[1] : 0);
        var tl = Math.sqrt(tx * tx + ty * ty);
        left.push([cx - ty / tl * r, cy + tx / tl * r]);
        right.push([cx + ty / tl * r, cy - tx / tl * r]);
        continue;
      }
      // A corner: the outer side sweeps round it, the inner side takes both
      // offsets and crosses itself inside the band, which nonzero fills.
      var outer = turn > 0 ? right : left, inner = turn > 0 ? left : right, s = turn > 0 ? -1 : 1;
      outer.push([cx - s * d1[1] * r, cy + s * d1[0] * r]);
      arc(outer, cx, cy, -s * d1[1], s * d1[0], r, turn, Math.ceil(Math.abs(turn) / STEP));
      outer.push([cx - s * d2[1] * r, cy + s * d2[0] * r]);
      inner.push([cx + s * d1[1] * r, cy - s * d1[0] * r], [cx + s * d2[1] * r, cy - s * d2[0] * r]);
    }

    // Left forward, round the end, right backward, round the start.
    var dEnd = unit(c[n - 2], c[n - 1]), dStart = unit(c[0], c[1]);
    out = left.slice();
    arc(out, c[n - 1][0], c[n - 1][1], -dEnd[1], dEnd[0], c[n - 1][2], -Math.PI, 8);
    for (i = right.length - 1; i >= 0; i--) out.push(right[i]);
    arc(out, c[0][0], c[0][1], dStart[1], -dStart[0], c[0][2], -Math.PI, 8);
    return out;
  }

  function toPath(outline) {
    var n = outline ? outline.length : 0, parts = [], i, a, b;
    if (!n) return "";
    function f(v) { return String(Math.round(v * 100) / 100); }
    function xy(x, y) { return f(x) + "," + f(y); }
    if (n < 3) {
      for (i = 0; i < n; i++) parts.push((i ? "L" : "M") + xy(outline[i][0], outline[i][1]));
      return parts.join("") + "Z";
    }
    a = outline[n - 1]; b = outline[0];
    parts.push("M" + xy((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) + "Q");
    for (i = 0; i < n; i++) {
      a = outline[i]; b = outline[(i + 1) % n];
      parts.push(xy(a[0], a[1]) + " " + xy((a[0] + b[0]) / 2, (a[1] + b[1]) / 2));
    }
    return parts[0] + parts.slice(1).join(" ") + "Z";
  }

  function stroke(points, options) { return toPath(outline(points, options)); }

  // ---- What a stroke covers, and what an eraser touches ----

  function band(a, b) {
    return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) };
  }
  function boxesOf(s) {
    if (s.rects) return s.rects;
    if (s.tool !== "rect" || !s.points.length) return null;
    return [band(s.points[0], s.points[s.points.length - 1])];
  }
  // How far p is from the segment a-b.
  function pointSeg(p, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy, t = 0;
    if (l > 0) t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l, 0, 1);
    var x = a[0] + t * dx - p[0], y = a[1] + t * dy - p[1];
    return Math.sqrt(x * x + y * y);
  }
  function cross(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }
  // How far apart the segments a-b and c-d are: nothing if they cross.
  function segSeg(a, b, c, d) {
    var d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
    if (d1 * d2 < 0 && d3 * d4 < 0) return 0;
    return Math.min(pointSeg(a, c, d), pointSeg(b, c, d), pointSeg(c, a, b), pointSeg(d, a, b));
  }
  function pointIn(p, b) { return p[0] >= b.x && p[0] <= b.x + b.w && p[1] >= b.y && p[1] <= b.y + b.h; }
  function edgesOf(b) {
    var x1 = b.x + b.w, y1 = b.y + b.h;
    return [[[b.x, b.y], [x1, b.y]], [[x1, b.y], [x1, y1]], [[x1, y1], [b.x, y1]], [[b.x, y1], [b.x, b.y]]];
  }
  function segBox(a, b, box) {
    if (pointIn(a, box) || pointIn(b, box)) return 0;
    return Math.min.apply(null, edgesOf(box).map(function (e) { return segSeg(a, b, e[0], e[1]); }));
  }
  function touches(s, a, b, r) {
    if (s.live) return false;
    var boxes = boxesOf(s);
    if (boxes) {
      return boxes.some(function (box) {
        if (s.tool !== "rect") return segBox(a, b, box) <= r;
        return edgesOf(box).some(function (e) { return segSeg(a, b, e[0], e[1]) <= r + s.size / 2; });
      });
    }
    if (!s.points.length) return false;
    // A pen's width varies up to half as wide again; a highlighter's does not.
    var reach = r + s.size * (s.tool === "highlighter" ? 0.5 : 0.75), pts = s.points;
    if (pts.length === 1) return pointSeg(pts[0], a, b) <= reach;
    for (var i = 1; i < pts.length; i++) if (segSeg(a, b, pts[i - 1], pts[i]) <= reach) return true;
    return false;
  }
  function hit(strokes, a, b, r) {
    var ids = [];
    for (var i = 0; strokes && i < strokes.length; i++) if (touches(strokes[i], a, b, r)) ids.push(strokes[i].id);
    return ids;
  }

  return {
    DEFAULTS: DEFAULTS, streamline: streamline, outline: outline, toPath: toPath, stroke: stroke,
    band: band, boxesOf: boxesOf, hit: hit
  };
}

// For the deck: evaluating this defines window.sdocInk.
const INK_JS = "window.sdocInk = (" + createInk.toString() + ")();";

const ink = createInk();
module.exports = { createInk, INK_JS, ...ink };
