// SDOC Slides — where a callout goes.
//
// Pure decisions over boxes, beside the snapping in src/slide-snap.js: the
// page measures the slide and the callout's text, and this says on which side
// of the thing it is about the callout sits, how wide it may run there, and
// where its box lands so that all of it is on the slide.
//
// Everything is in slide design pixels. design is the design box { w, h } and
// u its unit — one pixel of a slide 1280 wide, design.w / 1280 — which the
// margins are written in: a callout keeps MARGIN from the slide's edges and
// its leader is GAP long.
//
// createCalloutPlacement(overlap) -> the functions below
//   overlap  the shared area of two boxes: slide-snap's, so there is one
//
//   width(design)                 how wide a callout's text runs before it
//                                 wraps, unless it is dragged out or resized:
//                                 about a third of the slide, a sentence to a
//                                 line
//   beside(side, target, size, design, u)
//                                 the box { x, y, w, h } of that size on that
//                                 side of the target — right, left, below or
//                                 above — a leader's length away, and pushed
//                                 back inside the slide where it would leave it
//   at(point, size, design, u)    the top-left { x, y } for a box of that size
//                                 put at a point, pushed back inside the slide
//   draggedWidth(band, design, u) how wide the text runs in a box dragged out:
//                                 the box's width, within the slide, and no
//                                 narrower than a callout can usefully be
//   sideFor(target, design, u, candidates, callouts) -> { side, maxW }
//                                 which side of the target a callout goes: of
//                                 the sides with room for most of width(), the
//                                 one where a box that wide hides the fewest
//                                 of the slide's words and of the other
//                                 callouts, which count five words each — the
//                                 right first on a tie, as text is read, then
//                                 the left, below and above. Where none has
//                                 the room, the side with the most. maxW is
//                                 the width it may wrap at there.
//                                 candidates are the snapping's (only the
//                                 words count, and not those inside the
//                                 target); callouts the boxes of the ones
//                                 already on the slide
//
// SELF-CONTAINED ON PURPOSE: createCalloutPlacement is serialised into the
// deck with toString() (CALLOUT_JS), so it may not reference anything outside
// its own body, and nothing in it may spell the tag that closes a script
// element. It is ES5, as the page's other runtimes are.

function createCalloutPlacement(overlap) {
  var MARGIN = 16, GAP = 36, FONT = 22, NARROWEST = 120, SHARE = 0.35, ENOUGH = 0.6, CALLOUT_WEIGHT = 5;
  var SIDES = ["right", "left", "below", "above"];

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function width(design) { return Math.round(SHARE * design.w); }
  function at(point, size, design, u) {
    var M = MARGIN * u;
    return {
      x: clamp(point[0], M, Math.max(M, design.w - M - size.w)),
      y: clamp(point[1], M, Math.max(M, design.h - M - size.h))
    };
  }
  function beside(side, T, size, design, u) {
    var gap = GAP * u, x, y, cy = T.y + T.h / 2;
    if (side === "right") { x = T.x + T.w + gap; y = cy - size.h / 2; }
    else if (side === "left") { x = T.x - gap - size.w; y = cy - size.h / 2; }
    else if (side === "below") { x = T.x; y = T.y + T.h + gap; }
    else { x = T.x; y = T.y - gap - size.h; }
    var p = at([x, y], size, design, u);
    return { x: p.x, y: p.y, w: size.w, h: size.h };
  }
  function draggedWidth(band, design, u) {
    return Math.max(NARROWEST * u, Math.min(band.w, design.w - MARGIN * u - band.x));
  }
  function sideFor(T, design, u, candidates, callouts) {
    var W = design.w, H = design.h, M = MARGIN * u, gap = GAP * u, want = width(design);
    var room = { right: W - M - (T.x + T.w + gap), left: T.x - gap - M, below: W - 2 * M, above: W - 2 * M };
    var tall = { right: H - 2 * M, left: H - 2 * M, below: H - M - (T.y + T.h + gap), above: T.y - gap - M };
    // Two lines of text: what a callout usually comes to.
    var likely = { w: want, h: Math.ceil(2 * FONT * u) };
    function inTarget(b) {
      var cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      return cx >= T.x && cx <= T.x + T.w && cy >= T.y && cy <= T.y + T.h;
    }
    var words = (candidates || []).filter(function (c) { return c.kind === "word" && !inTarget(c); });
    var others = callouts || [];
    var best = null, roomiest = null;
    SIDES.forEach(function (side) {
      if (tall[side] < likely.h) return;
      if (!roomiest || room[side] > room[roomiest]) roomiest = side;
      if (room[side] < ENOUGH * want) return;
      var b = beside(side, T, { w: Math.min(likely.w, room[side]), h: likely.h }, design, u), covered = 0;
      words.forEach(function (w) { if (overlap(b, w) > 0) covered += 1; });
      others.forEach(function (c) { if (overlap(b, c) > 0) covered += CALLOUT_WEIGHT; });
      if (!best || covered < best.covered) best = { side: side, covered: covered };
    });
    var chosen = best ? best.side : roomiest || "below";
    return { side: chosen, maxW: Math.max(NARROWEST * u, Math.min(want, room[chosen])) };
  }

  return { MARGIN: MARGIN, GAP: GAP, FONT: FONT, width: width, at: at, beside: beside, draggedWidth: draggedWidth, sideFor: sideFor };
}

// For the deck, after SNAP_JS: evaluating this defines window.sdocCallout.
const CALLOUT_JS = "window.sdocCallout = (" + createCalloutPlacement.toString() + ")(window.sdocSnap.overlap);";

const placement = createCalloutPlacement(require("./slide-snap").overlap);
module.exports = { createCalloutPlacement, CALLOUT_JS, ...placement };
