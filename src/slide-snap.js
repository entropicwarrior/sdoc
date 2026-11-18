// SDOC Slides — snapping the presenter's annotations to what is on the slide.
//
// Pure decision logic. The page measures the slide in slide design pixels
// (word boxes from a text Range, element boxes, table columns and rows) and
// hands the boxes over as candidates; this decides what an annotation meant.
//
// candidates  [{ x, y, w, h, kind, level, line?, group? }, ...]
//   kind   "word"    a word's box, from a text Range
//          "inline"  span, strong, em, code, a, mark
//          "block"   p, li, h1-h6, blockquote, pre, img, svg, figure, a card
//          "cell"    td or th
//          "column"  the union box of one table column's cells
//          "row"     the union box of one table row's cells
//   level  nesting depth: deeper is smaller and more specific
//   line   words only: the visual line a word sits on, shared by the words of
//          that line. Words without one are put on lines by vertical overlap,
//          which merges two columns of text that share a baseline: pass it.
//   group  candidates sharing a group are ONE target in parts — the fragments
//          of an inline that wraps, say. They are covered, chosen and drawn
//          together, as the kind and level of their shallowest member.
// A candidate with a non-finite or negative size is ignored; one of zero area
// is never covered or claimed. Nothing is thrown and the input is not changed.
//
// snapHighlight(points, candidates, options) -> { snapped: false }
//                                             | { snapped: true, rects: [{x, y, w, h}, ...] }
//   points is the highlighter's centre line, [[x, y], ...]. The band is
//   `width` wide. It snaps only when the stroke OBVIOUSLY highlights text:
//     - The forward direction is the way it travels furthest horizontally;
//       only forward travel counts as highlighting (a return sweep to the next
//       line, or a re-pass, travels backwards). At least `minLength` of it.
//     - The forward runs together are at most `maxSlope` as tall (each run's
//       vertical extent) as they are long. Steep, vertical and diagonal
//       strokes fail, and so does a tick mark across a word.
//     - The band is ON a line where it overlaps the line's vertical extent by
//       `lineOverlap` of the smaller of the line's height and the band width.
//     - A word is claimed when the band, on its line, covers `wordCover` of the
//       word's width. Each run's round end reaches `capShare` of the radius
//       past its last sample, so a stroke ending a few px into a word does not
//       claim it, and one ending at a word's edge still covers that word.
//     - `onText` of the forward travel must be over text: over a line, within
//       a word or the space between words (each word widened by 0.2 of its
//       line's height on each side). A stroke mostly over empty space fails.
//     - It may turn round (back-travel beyond `reversalSlack` px) at most
//       `reversalsPerLine` times per claimed line, plus one: a scribble fails.
//     - Moving forward from one line onto a different line with no turn in
//       between is crossing lines diagonally, and fails.
//   The rectangle for a line spans its claimed words, first word's left to
//   last word's right, at the line's own top and bottom. An inline or block
//   whose words are `elementCover` claimed (by width) and whose box those
//   words fill to `elementFill` (so a full-width paragraph with a short line
//   does not qualify) is drawn as its own box instead, merged with the rest of
//   its lines. Everything is padded by `pad`, and sorted top to bottom.
//
// snapRect(band, candidates, options) -> { snapped, rect, target? }
//   band is the rubber band {x, y, w, h} (a negative size is normalised).
//     - A target is COVERED when the band covers `cover` of its area.
//     - If any are covered, the answer is the set of covered targets whose
//       union best matches the band (intersection over union), from: each
//       covered target alone; each depth cut of the covered ones (by how many
//       other covered targets contain each); and, per kind, the outermost
//       covered targets of that kind. Sets within `refineGain` of the best
//       are as good, and the one with the fewest members wins: a band over a
//       table column covers the column, its cells and their words, and the
//       answer is the column. If the best match is under `minMatch` (a big
//       band round one small word) nothing snaps.
//     - If nothing is covered, the target the band covers the largest share
//       of wins, deeper and then smaller on a tie, joined by the others of its
//       kind covered at least `joinShare` as much: part of a word gives that
//       word, part of two gives both. A word counts on any overlap; anything
//       else must be covered `partCover`, so a band in the empty part of a
//       paragraph's box is not that paragraph. At least `touchShare` of the
//       band must be over what it snaps to.
//     - If the band touches nothing, or snaps to nothing, it comes back as
//       given (normalised), with snapped false.
//   rect is the union of the chosen targets padded by `pad`; target is
//   { kind, level, count }, kind "mixed" when the chosen kinds differ and
//   level the shallowest.
//
// Containment allows `tolerance` px. Of two candidates with the same box the
// shallower (then the earlier) is the container. Every decision is
// deterministic: ties fall back to input order.
//
// SELF-CONTAINED ON PURPOSE: createSnap is serialised into the deck with
// toString() (SNAP_JS), so it may not reference anything outside its own body,
// and nothing in it may spell the tag that closes a script element. It is
// ES5, as the page's other runtimes are.

function createSnap() {
  var DEFAULTS = {
    width: 24,             // the highlighter band's width, px
    lineOverlap: 0.5,      // share of min(line height, width) the band must overlap
    wordCover: 0.5,        // share of a word's width covered to claim it
    capShare: 0.5,         // a run's end reaches this share of the radius
    minLength: 10,         // px of forward travel; less is a tap
    maxSlope: 0.2,         // the forward runs' height over their length
    onText: 0.6,           // share of the forward travel over text
    reversalSlack: 8,      // px of back-travel that is a turn
    reversalsPerLine: 2,   // turns allowed per claimed line, plus one
    elementCover: 0.9,     // share of an element's words (by width) claimed
    elementFill: 0.6,      // share of the element's box its words fill
    cover: 0.5,            // share of a target's area the band covers
    refineGain: 0.1,       // match within this of the best is as good
    minMatch: 0.2,         // least match between the answer and the band
    partCover: 0.25,       // nothing covered: share a non-word needs
    joinShare: 0.5,        // nothing covered: share of the best's cover to join it
    touchShare: 0.2,       // nothing covered: share of the band over the answer
    pad: 2,                // px added round every rectangle returned
    tolerance: 1           // px of slack in containment
  };
  var SHARES = ["lineOverlap", "wordCover", "capShare", "onText", "elementCover", "elementFill",
    "cover", "minMatch", "partCover", "joinShare", "touchShare"];

  function fin(v) { return typeof v === "number" && isFinite(v); }

  function settings(options) {
    var o = options || {}, s = {};
    for (var k in DEFAULTS) s[k] = fin(o[k]) && o[k] >= 0 ? o[k] : DEFAULTS[k];
    for (var i = 0; i < SHARES.length; i++) if (s[SHARES[i]] > 1) s[SHARES[i]] = 1;
    if (!(s.width > 0)) s.width = DEFAULTS.width;
    return s;
  }

  function boxOf(c) {
    if (!c || !fin(c.x) || !fin(c.y) || !fin(c.w) || !fin(c.h) || c.w < 0 || c.h < 0) return null;
    return { x: c.x, y: c.y, w: c.w, h: c.h };
  }
  function overlap(a, b) {
    var w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    var h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
  }
  function inside(a, b, tol) {
    return a.x >= b.x - tol && a.y >= b.y - tol && a.x + a.w <= b.x + b.w + tol && a.y + a.h <= b.y + b.h + tol;
  }
  function union(boxes) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      if (b.x < x0) x0 = b.x;
      if (b.y < y0) y0 = b.y;
      if (b.x + b.w > x1) x1 = b.x + b.w;
      if (b.y + b.h > y1) y1 = b.y + b.h;
    }
    return boxes.length ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 0, h: 0 };
  }
  function iou(a, b) {
    var i = overlap(a, b), u = a.w * a.h + b.w * b.h - i;
    return u > 0 ? i / u : 0;
  }
  function padded(b, p) { return { x: b.x - p, y: b.y - p, w: b.w + 2 * p, h: b.h + 2 * p }; }

  // Candidates as targets: one each, or one per group in parts.
  function targetsOf(candidates, kinds) {
    var out = [], groups = {};
    for (var i = 0; candidates && i < candidates.length; i++) {
      var c = candidates[i], b = boxOf(c);
      if (!b) continue;
      var kind = typeof c.kind === "string" ? c.kind : "block";
      if (kinds && kinds.indexOf(kind) < 0) continue;
      var level = fin(c.level) ? c.level : 0;
      var key = c.group === undefined || c.group === null || c.group === "" ? null : "g:" + String(c.group);
      var t = key !== null && Object.prototype.hasOwnProperty.call(groups, key) ? groups[key] : null;
      if (!t) {
        t = { index: out.length, kind: kind, level: level, parts: [], area: 0 };
        out.push(t);
        if (key !== null) groups[key] = t;
      } else if (level < t.level) { t.kind = kind; t.level = level; }
      t.parts.push(b);
      t.area += b.w * b.h;
    }
    for (var i = 0; i < out.length; i++) out[i].box = union(out[i].parts);
    return out;
  }

  // Every part of a lies inside some part of b.
  function within(a, b, tol) {
    for (var i = 0; i < a.parts.length; i++) {
      var ok = false;
      for (var j = 0; j < b.parts.length && !ok; j++) ok = inside(a.parts[i], b.parts[j], tol);
      if (!ok) return false;
    }
    return true;
  }
  // b strictly contains a; of two with the same box the shallower, then the earlier.
  function contains(b, a, tol) {
    if (a === b || !within(a, b, tol)) return false;
    if (!within(b, a, tol)) return true;
    return b.level < a.level || (b.level === a.level && b.index < a.index);
  }

  function describe(set) {
    var kind = set[0].kind, level = set[0].level;
    for (var i = 1; i < set.length; i++) {
      if (set[i].kind !== kind) kind = "mixed";
      if (set[i].level < level) level = set[i].level;
    }
    return { kind: kind, level: level, count: set.length };
  }
  function boxesOf(set) {
    var out = [];
    for (var i = 0; i < set.length; i++) out.push(set[i].box);
    return out;
  }

  // ---- snapRect ----------------------------------------------------------

  function bestCovered(covered, band, o) {
    var n = covered.length;
    var deepest = 0;
    for (var i = 0; i < n; i++) { covered[i].depth = 0; covered[i].leaf = true; covered[i].top = true; }
    for (var i = 0; i < n; i++) {
      for (var j = 0; j < n; j++) {
        if (!contains(covered[j], covered[i], o.tolerance)) continue;
        covered[i].depth++;
        covered[j].leaf = false;
        if (covered[j].kind === covered[i].kind) covered[i].top = false;
      }
      if (covered[i].depth > deepest) deepest = covered[i].depth;
    }
    var sets = [];
    for (var i = 0; i < n; i++) sets.push([covered[i]]);
    for (var d = 0; d <= deepest; d++) {
      var cut = [];
      for (var i = 0; i < n; i++) {
        var t = covered[i];
        if (t.depth === d || (t.depth < d && t.leaf)) cut.push(t);
      }
      if (cut.length) sets.push(cut);
    }
    var kinds = [];
    for (var i = 0; i < n; i++) if (kinds.indexOf(covered[i].kind) < 0) kinds.push(covered[i].kind);
    for (var k = 0; k < kinds.length; k++) {
      var top = [];
      for (var i = 0; i < n; i++) if (covered[i].kind === kinds[k] && covered[i].top) top.push(covered[i]);
      sets.push(top);
    }
    var best = 0;
    var scores = [];
    for (var s = 0; s < sets.length; s++) {
      scores.push(iou(union(boxesOf(sets[s])), band));
      if (scores[s] > best) best = scores[s];
    }
    if (best < o.minMatch || !(best > 0)) return null;
    var pick = -1;
    for (var s = 0; s < sets.length; s++) {
      if (scores[s] < best - o.refineGain) continue;
      if (pick < 0 || sets[s].length < sets[pick].length ||
        (sets[s].length === sets[pick].length && scores[s] > scores[pick])) pick = s;
    }
    return sets[pick];
  }

  function nearest(touched, band, o) {
    var eligible = [];
    for (var i = 0; i < touched.length; i++) {
      var t = touched[i];
      if (t.kind === "word" || t.cover >= o.partCover) eligible.push(t);
    }
    if (!eligible.length) return null;
    eligible.sort(function (a, b) {
      return b.cover - a.cover || b.level - a.level || a.area - b.area || a.index - b.index;
    });
    var top = eligible[0], set = [];
    var over = 0;
    for (var i = 0; i < eligible.length; i++) {
      var t = eligible[i];
      if (t.kind !== top.kind || t.cover < top.cover * o.joinShare) continue;
      set.push(t);
      over += t.overlap;
    }
    set.sort(function (a, b) { return a.index - b.index; });
    return over / (band.w * band.h) >= o.touchShare ? set : null;
  }

  function snapRect(band, candidates, options) {
    var o = settings(options);
    var b = band || {};
    var x = fin(b.x) ? b.x : 0, y = fin(b.y) ? b.y : 0, w = fin(b.w) ? b.w : 0, h = fin(b.h) ? b.h : 0;
    if (w < 0) { x += w; w = -w; }
    if (h < 0) { y += h; h = -h; }
    var rect = { x: x, y: y, w: w, h: h };
    var unchanged = { snapped: false, rect: rect };
    if (!(w > 0 && h > 0)) return unchanged;
    var targets = targetsOf(candidates, null), touched = [], covered = [];
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      var over = 0;
      for (var j = 0; j < t.parts.length; j++) over += overlap(t.parts[j], rect);
      if (!(over > 0 && t.area > 0)) continue;
      t.overlap = over;
      t.cover = Math.min(1, over / t.area);
      touched.push(t);
      if (t.cover >= o.cover) covered.push(t);
    }
    if (!touched.length) return unchanged;
    var set = covered.length ? bestCovered(covered, rect, o) : nearest(touched, rect, o);
    if (!set || !set.length) return unchanged;
    return { snapped: true, rect: padded(union(boxesOf(set)), o.pad), target: describe(set) };
  }

  // ---- snapHighlight -----------------------------------------------------

  function newLine(lines, id) {
    var L = { k: lines.length, id: id, words: [], top: Infinity, bottom: -Infinity, left: Infinity, right: -Infinity };
    lines.push(L);
    return L;
  }

  // The words, on their lines: by line id, or by vertical overlap without one.
  function linesOf(candidates) {
    var lines = [], byId = {};
    for (var i = 0; candidates && i < candidates.length; i++) {
      var c = candidates[i], b = c && c.kind === "word" ? boxOf(c) : null;
      if (!b || !(b.w > 0 && b.h > 0)) continue;
      var L = null;
      if (c.line !== undefined && c.line !== null) {
        var key = "l:" + String(c.line);
        L = Object.prototype.hasOwnProperty.call(byId, key) ? byId[key] : (byId[key] = newLine(lines, true));
      } else {
        for (var k = 0; k < lines.length && !L; k++) {
          var M = lines[k];
          if (M.id) continue;
          var v = Math.min(M.bottom, b.y + b.h) - Math.max(M.top, b.y);
          if (v >= 0.5 * Math.min(M.bottom - M.top, b.h)) L = M;
        }
        if (!L) L = newLine(lines, false);
      }
      L.words.push({ index: i, x: b.x, y: b.y, w: b.w, h: b.h, cx: b.x + b.w / 2, cy: b.y + b.h / 2, line: L });
      if (b.y < L.top) L.top = b.y;
      if (b.y + b.h > L.bottom) L.bottom = b.y + b.h;
      if (b.x < L.left) L.left = b.x;
      if (b.x + b.w > L.right) L.right = b.x + b.w;
    }
    for (var k = 0; k < lines.length; k++) {
      var L = lines[k], spans = [];
      L.words.sort(function (a, b) { return a.x - b.x || a.index - b.index; });
      L.h = L.bottom - L.top;
      L.mid = (L.top + L.bottom) / 2;
      L.gap = 0.2 * L.h;
      for (var j = 0; j < L.words.length; j++) spans.push([L.words[j].x - L.gap, L.words[j].x + L.words[j].w + L.gap]);
      L.text = merge(spans);
    }
    return lines;
  }

  function merge(spans) {
    spans.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    var out = [];
    for (var i = 0; i < spans.length; i++) {
      var s = spans[i], last = out[out.length - 1];
      if (last && s[0] <= last[1]) { if (s[1] > last[1]) last[1] = s[1]; }
      else out.push([s[0], s[1]]);
    }
    return out;
  }
  function measure(spans, lo, hi) {
    var sum = 0;
    for (var i = 0; i < spans.length; i++) {
      var a = Math.max(lo, spans[i][0]), b = Math.min(hi, spans[i][1]);
      if (b > a) sum += b - a;
    }
    return sum;
  }

  // The part of segment a-b whose y lies in [lo, hi]: its x at entry and at
  // exit, in the order travelled, and whether a and b themselves are inside.
  function clip(a, b, lo, hi) {
    var t0 = 0, t1 = 1;
    var dy = b[1] - a[1];
    if (dy === 0) {
      if (a[1] < lo || a[1] > hi) return null;
    } else {
      var u = (lo - a[1]) / dy, v = (hi - a[1]) / dy;
      t0 = Math.max(0, Math.min(u, v));
      t1 = Math.min(1, Math.max(u, v));
      if (t0 > t1) return null;
    }
    return [a[0] + (b[0] - a[0]) * t0, a[0] + (b[0] - a[0]) * t1, t0 === 0, t1 === 1];
  }

  function holds(t, x, y, tol) {
    for (var i = 0; i < t.parts.length; i++) {
      var p = t.parts[i];
      if (x >= p.x - tol && x <= p.x + p.w + tol && y >= p.y - tol && y <= p.y + p.h + tol) return true;
    }
    return false;
  }

  function snapHighlight(points, candidates, options) {
    var o = settings(options), no = { snapped: false }, pts = [];
    for (var i = 0; points && i < points.length; i++) {
      var q = points[i];
      if (q && fin(q[0]) && fin(q[1])) pts.push([q[0], q[1]]);
    }
    var n = pts.length;
    if (n < 2) return no;
    var lines = linesOf(candidates);
    if (!lines.length) return no;
    var r = o.width / 2, cap = r * o.capShare;
    for (var k = 0; k < lines.length; k++) {
      var L = lines[k], need = o.lineOverlap * Math.min(L.h, o.width);
      L.lo = L.top + need - r;
      L.hi = L.bottom - need + r;
      L.cov = [];
    }

    // Forward is the way it travels furthest; a repeated sample keeps the run.
    var pos = 0, neg = 0;
    for (var i = 1; i < n; i++) {
      var dx = pts[i][0] - pts[i - 1][0];
      if (dx > 0) pos += dx; else neg -= dx;
    }
    var dir = pos >= neg ? 1 : -1, travel = Math.max(pos, neg);
    if (travel < o.minLength) return no;
    var fwd = [false];
    for (var i = 1; i < n; i++) {
      var dx = (pts[i][0] - pts[i - 1][0]) * dir;
      fwd.push(dx > 0 || (dx === 0 && pts[i][1] === pts[i - 1][1] && fwd[i - 1]));
    }

    // Each forward run's height over its length: a slope, a tick or a zig
    // across the line rises; a steady hand's jitter is a pixel or two.
    var rise = 0, run = 0, cdx = 0, y0 = 0, y1 = 0;
    for (var i = 1; i <= n; i++) {
      if (i < n && fwd[i]) {
        if (!cdx) { y0 = y1 = pts[i - 1][1]; }
        cdx += (pts[i][0] - pts[i - 1][0]) * dir;
        y0 = Math.min(y0, pts[i][1]);
        y1 = Math.max(y1, pts[i][1]);
        continue;
      }
      if (cdx > 0) { rise += y1 - y0; run += cdx; }
      cdx = 0;
    }
    if (!(run > 0) || rise > o.maxSlope * run) return no;

    // Where the band is on each line, and how much of the travel is over text.
    var onText = 0;
    for (var i = 1; i < n; i++) {
      if (!fwd[i]) continue;
      var a = pts[i - 1], b = pts[i], starts = !fwd[i - 1], ends = i === n - 1 || !fwd[i + 1], over = [];
      for (var k = 0; k < lines.length; k++) {
        var L = lines[k], c = clip(a, b, L.lo, L.hi);
        if (!c) continue;
        var s = c[0], e = c[1];
        for (var j = 0; j < L.text.length; j++) {
          var lo = Math.max(Math.min(s, e), L.text[j][0]), hi = Math.min(Math.max(s, e), L.text[j][1]);
          if (hi > lo) over.push([lo, hi]);
        }
        if (starts && c[2]) s -= cap * dir;
        if (ends && c[3]) e += cap * dir;
        L.cov.push(s < e ? [s, e] : [e, s]);
      }
      onText += measure(merge(over), -Infinity, Infinity);
    }
    if (onText < o.onText * travel) return no;

    var claimed = [];
    for (var k = 0; k < lines.length; k++) {
      var L = lines[k], cov = merge(L.cov);
      L.claimed = [];
      for (var j = 0; j < L.words.length; j++) {
        var wd = L.words[j];
        wd.claimed = measure(cov, wd.x, wd.x + wd.w) >= o.wordCover * wd.w;
        if (wd.claimed) L.claimed.push(wd);
      }
      if (L.claimed.length) claimed.push(L);
    }
    if (!claimed.length) return no;

    // Turns, and the claimed line under each forward sample: moving forward
    // onto another line with no turn since the last one is a diagonal.
    var turns = 0, heading = 0, extreme = pts[0][0], last = null, turnsThen = 0;
    for (var i = 0; i < n; i++) {
      var x = pts[i][0], y = pts[i][1];
      if (heading === 0) {
        if (Math.abs(x - extreme) > o.reversalSlack) { heading = x > extreme ? 1 : -1; extreme = x; }
      } else if ((x - extreme) * heading > 0) extreme = x;
      else if ((extreme - x) * heading > o.reversalSlack) { turns++; heading = -heading; extreme = x; }
      if (!fwd[i]) continue;
      var on = null;
      for (var k = 0; k < claimed.length; k++) {
        var L = claimed[k];
        if (y < L.lo || y > L.hi || x < L.left - L.gap - cap || x > L.right + L.gap + cap) continue;
        if (!on || Math.abs(y - L.mid) < Math.abs(y - on.mid)) on = L;
      }
      if (!on) continue;
      if (last && on !== last && turns === turnsThen && Math.abs(on.mid - last.mid) > Math.min(on.h, last.h) / 2) return no;
      last = on;
      turnsThen = turns;
    }
    if (turns > o.reversalsPerLine * claimed.length + 1) return no;

    // Elements whose words are (nearly) all claimed and which they fill.
    var elements = targetsOf(candidates, ["inline", "block"]), absorbing = [];
    for (var e = 0; e < elements.length; e++) {
      var E = elements[e], mine = [];
      if (!(E.area > 0)) continue;
      var all = 0, got = 0, fill = 0;
      for (var k = 0; k < lines.length; k++) {
        var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (var j = 0; j < lines[k].words.length; j++) {
          var wd = lines[k].words[j];
          if (!holds(E, wd.cx, wd.cy, o.tolerance)) continue;
          mine.push(wd);
          all += wd.w;
          if (wd.claimed) got += wd.w;
          x0 = Math.min(x0, wd.x); x1 = Math.max(x1, wd.x + wd.w);
          y0 = Math.min(y0, wd.y); y1 = Math.max(y1, wd.y + wd.h);
        }
        if (x1 > x0) fill += (x1 - x0) * (y1 - y0);
      }
      if (!(got > 0) || got < o.elementCover * all || fill < o.elementFill * E.area) continue;
      E.words = mine;
      absorbing.push(E);
    }

    // The outermost of those as their own boxes, the rest of the claimed
    // words as one span per line; pieces that share a line become one.
    var pieces = [];
    for (var e = 0; e < absorbing.length; e++) {
      var E = absorbing[e];
      var outer = true;
      for (var f = 0; f < absorbing.length && outer; f++) if (contains(absorbing[f], E, o.tolerance)) outer = false;
      if (!outer) continue;
      for (var j = 0; j < E.words.length; j++) E.words[j].absorbed = true;
      for (var p = 0; p < E.parts.length; p++) {
        var on = [];
        for (var j = 0; j < E.words.length; j++) {
          var wd = E.words[j];
          if (holds({ parts: [E.parts[p]] }, wd.cx, wd.cy, o.tolerance) && on.indexOf(wd.line.k) < 0) on.push(wd.line.k);
        }
        pieces.push({ box: E.parts[p], lines: on });
      }
    }
    for (var k = 0; k < claimed.length; k++) {
      var L = claimed[k], rest = [];
      for (var j = 0; j < L.claimed.length; j++) if (!L.claimed[j].absorbed) rest.push(L.claimed[j]);
      if (!rest.length) continue;
      var first = rest[0], end = rest[rest.length - 1];
      pieces.push({ box: { x: first.x, y: L.top, w: end.x + end.w - first.x, h: L.h }, lines: [L.k] });
    }
    var parent = [], owner = {};
    for (var i = 0; i < pieces.length; i++) parent.push(i);
    function root(i) { while (parent[i] !== i) i = parent[i]; return i; }
    for (var i = 0; i < pieces.length; i++) {
      for (var j = 0; j < pieces[i].lines.length; j++) {
        var key = "k" + pieces[i].lines[j];
        if (Object.prototype.hasOwnProperty.call(owner, key)) parent[root(i)] = root(owner[key]);
        else owner[key] = i;
      }
    }
    var groups = [], at = {};
    for (var i = 0; i < pieces.length; i++) {
      var g = "r" + root(i);
      if (!Object.prototype.hasOwnProperty.call(at, g)) { at[g] = groups.length; groups.push([]); }
      groups[at[g]].push(pieces[i].box);
    }
    var rects = [];
    for (var g = 0; g < groups.length; g++) rects.push(padded(union(groups[g]), o.pad));
    rects.sort(function (a, b) { return a.y - b.y || a.x - b.x; });
    return { snapped: true, rects: rects };
  }

  return { DEFAULTS: DEFAULTS, snapHighlight: snapHighlight, snapRect: snapRect, overlap: overlap };
}

// For the deck: evaluating this defines window.sdocSnap.
const SNAP_JS = "window.sdocSnap = (" + createSnap.toString() + ")();";

const snap = createSnap();
module.exports = { createSnap, SNAP_JS, ...snap };
