// SDOC Slides — connectors between named elements.
//
// A deck that explains a system draws lines on it: an arrow from a card to the
// block it feeds, a spine with labelled branches. Before this, an author
// measured the two boxes by eye and wrote an inline <svg> with the numbers in
// it. Three such connectors drifted in a single day on one real deck, because
// every one of those numbers is invalidated by any layout change — a longer
// title, a different face, a theme — and nothing says so. The line simply ends
// in the wrong place and the slide still builds.
//
// So a connector names its ends instead of measuring them:
//
//   # @connectors
//   {
//       {
//           from: @ingest bottom-center
//           to: @card-core top-center
//           shape: vh
//           node: both
//       }
//   }
//
// and the numbers are produced by the browser that laid the slide out, every
// time it lays it out. There are no coordinates in the document, so there is
// nothing to go stale.
//
// WHERE THE RESOLUTION HAPPENS, AND WHY THERE
//
// In the page, once, in the deck's own runtime — not in this file and not in
// either exporter. The renderer emits the specification as a data attribute on
// the slide and `CONNECTOR_JS` turns it into absolutely positioned painted
// divs, children of the .slide element, in design pixels.
//
// That single site is what makes the HTML build and the exports agree by
// construction rather than by anyone re-measuring. Both harvests read a built
// deck out of a browser, so by the time either one looks, the connectors are
// ordinary painted boxes that have been through the same layout as everything
// else: the artifact exporter emits them as pinned painted rectangles because
// that is literally what they are, and the PPTX exporter sees box atoms. A
// second implementation of the routing, anywhere, would be a second thing to
// drift.
//
// The one thing the two harvests must do is ask for the resolution after they
// force a slide visible — a slide that is `display:none` measures as nothing —
// which is one line in each of them.
//
// WHY NOT <x-connector>
//
// The Slides subset has one. Tested on a live artifact, `route="elbow"` draws
// its own path rather than the authored one, so the shape hint an author wrote
// would not be the shape a reader sees. Painted rectangles are exact, and they
// are already a thing every exporter here carries.
//
// Zero dependencies. The geometry below is pure and is injected into the page
// by `Function.prototype.toString()`, which is also why it is self-contained,
// ES5, and must not close over anything in this module.

// ---------------------------------------------------------------------------
// The geometry
// ---------------------------------------------------------------------------

// Plans one connector: two rectangles in, a list of axis-aligned rectangles
// out, in the same coordinates.
//
//   fromRect/toRect  { x, y, w, h }, relative to the slide, in design px
//   fromPoint/toPoint  an anchor name, or "auto"
//   shape            "vh" | "hv" | "elbow" | "straight"
//   thickness        the stroke width in px
//   dot              the diameter of an endpoint node in px, 0 for none
//   node             "none" | "start" | "end" | "both"
//
// Returns { from, to, points, segments, dots }. A segment is { x, y, w, h },
// plus `angle` in degrees when and only when the run is diagonal, which
// happens for `straight` alone.
//
// SELF-CONTAINED ON PURPOSE: this function is serialised into the page with
// toString(), so it may not reference anything outside its own body.
function planConnector(fromRect, toRect, fromPoint, toPoint, shape, thickness, dot, node) {
  // Nine points on a box. Each is [fraction across, fraction down, the side it
  // lies on] — the side is what `elbow` uses to decide which way to leave.
  var POINTS = {
    "top-left": [0, 0, "top"],
    "top-center": [0.5, 0, "top"],
    "top": [0.5, 0, "top"],
    "top-right": [1, 0, "top"],
    "left-center": [0, 0.5, "left"],
    "center-left": [0, 0.5, "left"],
    "left": [0, 0.5, "left"],
    "center": [0.5, 0.5, ""],
    "middle": [0.5, 0.5, ""],
    "right-center": [1, 0.5, "right"],
    "center-right": [1, 0.5, "right"],
    "right": [1, 0.5, "right"],
    "bottom-left": [0, 1, "bottom"],
    "bottom-center": [0.5, 1, "bottom"],
    "bottom": [0.5, 1, "bottom"],
    "bottom-right": [1, 1, "bottom"]
  };

  var EPS = 0.5;
  var t = thickness > 0 ? thickness : 2;

  function mid(r) { return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; }

  // The edge of `self` that faces `other`. Used when an author named no point:
  // "connect A to B" means the sides that look at each other, and picking by
  // the larger delta is the rule that gives that answer.
  function facing(self, other) {
    var a = mid(self);
    var b = mid(other);
    var dx = b.x - a.x;
    var dy = b.y - a.y;
    if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
    return dy >= 0 ? "bottom" : "top";
  }

  function resolve(rect, name, other) {
    var key = String(name === null || name === undefined ? "auto" : name).toLowerCase();
    if (key === "auto" || !POINTS[key]) key = facing(rect, other);
    var p = POINTS[key];
    return { x: rect.x + rect.w * p[0], y: rect.y + rect.h * p[1], side: p[2], point: key };
  }

  var a = resolve(fromRect, fromPoint, toRect);
  var b = resolve(toRect, toPoint, fromRect);

  // Which axis an elbow leaves on. The side the author anchored to decides it,
  // because leaving a bottom edge sideways reads as a mistake. A point with no
  // side (the centre) falls back to the longer delta.
  var leavesVertically = a.side === "top" || a.side === "bottom";
  if (!a.side) leavesVertically = Math.abs(b.y - a.y) >= Math.abs(b.x - a.x);

  var pts;
  if (shape === "straight") {
    pts = [a, b];
  } else if (shape === "hv") {
    pts = [a, { x: b.x, y: a.y }, b];
  } else if (shape === "vh") {
    pts = [a, { x: a.x, y: b.y }, b];
  } else if (leavesVertically) {
    var ym = (a.y + b.y) / 2;
    pts = [a, { x: a.x, y: ym }, { x: b.x, y: ym }, b];
  } else {
    var xm = (a.x + b.x) / 2;
    pts = [a, { x: xm, y: a.y }, { x: xm, y: b.y }, b];
  }

  // A bend that does not bend is not a bend. Two boxes stacked exactly give an
  // elbow whose crossing run has zero length and whose two uprights are
  // collinear; drawn literally that is three rectangles where one belongs, and
  // the two mitres at the ends of a zero-length run overhang it.
  var simple = [];
  var i;
  for (i = 0; i < pts.length; i++) {
    var last = simple.length ? simple[simple.length - 1] : null;
    if (last && Math.abs(last.x - pts[i].x) < EPS && Math.abs(last.y - pts[i].y) < EPS) continue;
    simple.push({ x: pts[i].x, y: pts[i].y });
  }
  i = 1;
  while (i < simple.length - 1) {
    var pv = simple[i - 1];
    var cu = simple[i];
    var nx = simple[i + 1];
    var bothH = Math.abs(cu.y - pv.y) < EPS && Math.abs(nx.y - cu.y) < EPS;
    var bothV = Math.abs(cu.x - pv.x) < EPS && Math.abs(nx.x - cu.x) < EPS;
    if (bothH || bothV) simple.splice(i, 1);
    else i++;
  }

  var segments = [];
  for (i = 0; i + 1 < simple.length; i++) {
    var p = simple[i];
    var q = simple[i + 1];
    // Half the stroke at each interior bend, so the corner is filled rather
    // than notched. Never at an end: the line has to start exactly where the
    // author's anchor is, or the whole point of anchoring is lost.
    var padStart = i === 0 ? 0 : t / 2;
    var padEnd = i + 2 === simple.length ? 0 : t / 2;
    var dx = q.x - p.x;
    var dy = q.y - p.y;

    if (Math.abs(dy) < EPS && Math.abs(dx) >= EPS) {
      var lo = Math.min(p.x, q.x);
      var hi = Math.max(p.x, q.x);
      if (dx >= 0) { lo -= padStart; hi += padEnd; } else { hi += padStart; lo -= padEnd; }
      segments.push({ x: lo, y: p.y - t / 2, w: hi - lo, h: t });
    } else if (Math.abs(dx) < EPS && Math.abs(dy) >= EPS) {
      var top = Math.min(p.y, q.y);
      var bot = Math.max(p.y, q.y);
      if (dy >= 0) { top -= padStart; bot += padEnd; } else { bot += padStart; top -= padEnd; }
      segments.push({ x: p.x - t / 2, y: top, w: t, h: bot - top });
    } else if (Math.abs(dx) >= EPS || Math.abs(dy) >= EPS) {
      // Diagonal, which only `straight` produces. A rectangle as long as the
      // run, rotated about its own centre — the subset's transform-origin is
      // the centre and cannot be moved, so the box is placed centred on the
      // run's midpoint and nothing else is needed.
      var len = Math.sqrt(dx * dx + dy * dy);
      var cx = (p.x + q.x) / 2;
      var cy = (p.y + q.y) / 2;
      segments.push({
        x: cx - len / 2,
        y: cy - t / 2,
        w: len,
        h: t,
        angle: (Math.atan2(dy, dx) * 180) / Math.PI
      });
    }
  }

  var dots = [];
  var d = dot > 0 ? dot : 0;
  var which = String(node || "none").toLowerCase();
  if (d > 0 && (which === "start" || which === "both")) {
    dots.push({ x: a.x - d / 2, y: a.y - d / 2, w: d, h: d });
  }
  if (d > 0 && (which === "end" || which === "both")) {
    dots.push({ x: b.x - d / 2, y: b.y - d / 2, w: d, h: d });
  }

  function r2(n) { return Math.round(n * 100) / 100; }
  function tidy(box) {
    var out = { x: r2(box.x), y: r2(box.y), w: r2(box.w), h: r2(box.h) };
    if (box.angle !== undefined) out.angle = r2(box.angle);
    return out;
  }

  return {
    from: { x: r2(a.x), y: r2(a.y), side: a.side, point: a.point },
    to: { x: r2(b.x), y: r2(b.y), side: b.side, point: b.point },
    points: simple.map(function (pt) { return { x: r2(pt.x), y: r2(pt.y) }; }),
    segments: segments.map(tidy),
    dots: dots.map(tidy)
  };
}

// ---------------------------------------------------------------------------
// Reading connectors out of a slide
// ---------------------------------------------------------------------------

const CONNECTOR_SCOPE_ID = "connectors";

const SHAPES = new Set(["vh", "hv", "elbow", "straight"]);
const NODES = new Set(["none", "start", "end", "both"]);

// Every anchor name planConnector understands, so the renderer can refuse one
// it does not rather than silently placing the line at a facing edge.
const ANCHOR_POINTS = new Set([
  "auto",
  "top-left", "top-center", "top", "top-right",
  "left-center", "center-left", "left",
  "center", "middle",
  "right-center", "center-right", "right",
  "bottom-left", "bottom-center", "bottom", "bottom-right",
]);

const DEFAULT_SHAPE = "elbow";

const CONNECTOR_KEYS = new Set(["from", "to", "shape", "node", "accent"]);

// `@card-core bottom-center`, `#card-core:bottom-center`, `card-core`.
//
// The sigil is optional and both of the ones a reader might reach for are
// taken: `@` is how the id was declared and `#` is how a link refers to one,
// and an author should not have to remember which this particular line wants.
// The point is separated by a space or a colon for the same reason.
const RE_ENDPOINT = /^[@#]?([A-Za-z][A-Za-z0-9_-]*)(?:\s*[:\s]\s*([A-Za-z][a-z-]*))?$/;

function parseEndpoint(value) {
  const match = RE_ENDPOINT.exec(String(value || "").trim());
  if (!match) return null;
  return { id: match[1], point: (match[2] || "auto").toLowerCase() };
}

// One connector, read from the child scope that describes it.
//
// `config` is what extractConfig() kept and `leftovers` is what it handed
// back, which here is always a mistake: a connector scope holds no prose, so
// every line in it is meant to be a key. Elsewhere in the format a line that
// is not understood stays content on purpose — "Value: the customer keeps
// their data." is a sentence — and the same caution inside a connector would
// turn a misspelt key, or a `shape:` naming a shape that does not exist, into
// a line that is silently deleted along with the scope it sits in. So here the
// leftovers are reported.
//
// Returns a spec and a list of complaints; nothing is ever dropped silently.
function readConnector(config, index, leftovers) {
  const errors = [];
  const from = parseEndpoint(config.from);
  const to = parseEndpoint(config.to);
  const where = `connector ${index + 1}`;

  // A key this context understands but a connector does not. extractConfig
  // allows every common slide key everywhere — `kicker:`, `background:`,
  // `config:` — so without this one of those inside a connector scope would be
  // taken off the line, do nothing, and never be mentioned.
  for (const key of Object.keys(config)) {
    if (CONNECTOR_KEYS.has(key)) continue;
    errors.push(
      `${where} sets "${key}:", which means nothing on a connector ` +
        `(it takes ${[...CONNECTOR_KEYS].join(", ")})`
    );
  }

  for (const node of leftovers || []) {
    const text = node.type === "paragraph" ? node.text : `a ${node.type}`;
    errors.push(
      `${where} has a line a connector does not understand: ${text} ` +
        `(it takes ${[...CONNECTOR_KEYS].join(", ")}; shape is one of ${[...SHAPES].join(", ")} ` +
        `and node one of ${[...NODES].join(", ")})`
    );
  }

  if (!config.from) errors.push(`${where} has no "from:"`);
  else if (!from) errors.push(`${where} has a "from:" that is not an element and a point: ${config.from}`);
  if (!config.to) errors.push(`${where} has no "to:"`);
  else if (!to) errors.push(`${where} has a "to:" that is not an element and a point: ${config.to}`);

  for (const end of [["from", from], ["to", to]]) {
    if (end[1] && !ANCHOR_POINTS.has(end[1].point)) {
      errors.push(
        `${where} anchors "${end[0]}:" at "${end[1].point}", which is not a point on a box ` +
          `(try top-center, bottom-center, left, right, a corner, or leave it out)`
      );
    }
  }

  // Both ends on one element. The two anchors are then points on the same box,
  // which for the default `auto` is the same point twice — a run of no length,
  // drawn as nothing at all. Saying so beats a line that is simply absent,
  // which is the failure this whole feature exists to remove.
  if (from && to && from.id === to.id) {
    errors.push(`${where} joins @${from.id} to itself`);
  }

  const shape = (config.shape || DEFAULT_SHAPE).trim().toLowerCase();
  if (!SHAPES.has(shape)) {
    errors.push(`${where} asks for shape "${shape}"; it must be one of vh, hv, elbow, straight`);
  }
  const node = (config.node || "none").trim().toLowerCase();
  if (!NODES.has(node)) {
    errors.push(`${where} asks for node "${node}"; it must be one of none, start, end, both`);
  }

  if (errors.length) return { spec: null, errors };

  const spec = { from, to, shape, node };
  if (config.accent) spec.accent = String(config.accent).trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
  return { spec, errors };
}

// ---------------------------------------------------------------------------
// The page runtime
// ---------------------------------------------------------------------------

// The DOM half. Deliberately thin: everything with arithmetic in it is in
// planConnector above, in ordinary JavaScript that tests can call directly.
//
// Written in a template literal, so: every backslash is doubled and there is
// no backtick anywhere, including in these comments. A single `\s` here
// arrives in the page as a bare `s`, and a backtick ends the literal and puts
// the syntax error on an unrelated word several hundred lines away.
const CONNECTOR_RUNTIME = `
(function () {
  var MARK = "data-sdoc-connector-drawn";

  function num(value, fallback) {
    var n = parseFloat(value);
    return isFinite(n) && n > 0 ? n : fallback;
  }

  // Design pixels. A slide is scaled to the window with a transform, so a
  // client rect is in window pixels and the boxes an absolutely positioned
  // child is placed with are not. offsetWidth is the layout width, which is
  // the design width, so their ratio is the scale actually in force — and it
  // is read rather than taken from the custom property because print, the
  // harvests and a resize all change it by different routes.
  function scaleOf(slide, rect) {
    var sx = slide.offsetWidth > 0 ? rect.width / slide.offsetWidth : 1;
    var sy = slide.offsetHeight > 0 ? rect.height / slide.offsetHeight : 1;
    return { x: sx > 0 ? sx : 1, y: sy > 0 ? sy : 1 };
  }

  function boxOf(el, origin, scale) {
    var r = el.getBoundingClientRect();
    return {
      x: (r.left - origin.left) / scale.x,
      y: (r.top - origin.top) / scale.y,
      w: r.width / scale.x,
      h: r.height / scale.y
    };
  }

  function place(el, box) {
    var s = "position:absolute;left:" + box.x + "px;top:" + box.y + "px;" +
            "width:" + box.w + "px;height:" + box.h + "px";
    if (box.angle) s += ";transform:rotate(" + box.angle + "deg)";
    el.setAttribute("style", s);
  }

  function make(slide, cls, accent) {
    var el = document.createElement("div");
    el.className = accent ? cls + " accent-" + accent : cls;
    el.setAttribute(MARK, "1");
    el.setAttribute("aria-hidden", "true");
    slide.appendChild(el);
    return el;
  }

  function resolveSlide(slide) {
    var raw = slide.getAttribute("data-sdoc-connectors");
    if (!raw) return;

    // Everything this ran before. Re-entrant by construction: the harvests, a
    // resize and a slide becoming active all call this, and a run that left
    // its predecessor's boxes behind would stack a new line on every one.
    var old = slide.querySelectorAll("[" + MARK + "]");
    for (var i = 0; i < old.length; i++) old[i].parentNode.removeChild(old[i]);

    var specs;
    try { specs = JSON.parse(raw); } catch (err) { return; }
    if (!specs || !specs.length) return;

    // A slide nobody can measure. display:none gives every box zero size, and
    // planning against that puts every connector in the top left corner — so
    // it is left undrawn and the next call, when the slide is up, draws it.
    if (!slide.offsetWidth || !slide.offsetHeight) return;

    var origin = slide.getBoundingClientRect();
    var scale = scaleOf(slide, origin);

    for (var s = 0; s < specs.length; s++) {
      var spec = specs[s];
      var a = slide.querySelector("#" + (window.CSS && CSS.escape ? CSS.escape(spec.from.id) : spec.from.id));
      var b = slide.querySelector("#" + (window.CSS && CSS.escape ? CSS.escape(spec.to.id) : spec.to.id));
      if (!a || !b) continue;

      // The stroke is the theme's, so it is read off an element that carries
      // this connector's own classes: an accent may change the width as well
      // as the colour, and a value read from the slide would miss that.
      var probe = make(slide, "sdoc-conn", spec.accent);
      var cs = getComputedStyle(probe);
      var thickness = num(cs.getPropertyValue("--sdoc-connector-width"), 2);
      var dot = num(cs.getPropertyValue("--sdoc-connector-dot"), thickness * 4);
      probe.parentNode.removeChild(probe);

      var plan = window.sdocPlanConnector(
        boxOf(a, origin, scale), boxOf(b, origin, scale),
        spec.from.point, spec.to.point, spec.shape, thickness, dot, spec.node
      );

      for (var g = 0; g < plan.segments.length; g++) {
        place(make(slide, "sdoc-conn", spec.accent), plan.segments[g]);
      }
      for (var d = 0; d < plan.dots.length; d++) {
        place(make(slide, "sdoc-conn sdoc-conn-dot", spec.accent), plan.dots[d]);
      }
    }
  }

  // Takes one slide, or anything containing some. The harvests hand it the
  // slide they have just made measurable; the deck's own events hand it the
  // document.
  function resolve(root) {
    if (root && root.nodeType === 1 && root.getAttribute &&
        root.getAttribute("data-sdoc-connectors") !== null) {
      resolveSlide(root);
      return;
    }
    var scope = root && root.querySelectorAll ? root : document;
    var found = scope.querySelectorAll(".slide[data-sdoc-connectors]");
    for (var r = 0; r < found.length; r++) resolveSlide(found[r]);
  }

  // The two harvests and the PDF export each make a slide measurable in their
  // own way and then look at it. This is what they call once they have.
  window.sdocConnectors = { resolve: resolve };

  var slides = document.querySelectorAll(".slide[data-sdoc-connectors]");
  if (!slides.length) return;

  // A theme navigates by adding and removing .active and writes the hash with
  // replaceState, which fires no event, so the class is what there is to
  // watch. The same observer the filmstrip uses, for the same reason.
  var observer = new MutationObserver(function (records) {
    for (var m = 0; m < records.length; m++) resolveSlide(records[m].target);
  });
  for (var w = 0; w < slides.length; w++) {
    observer.observe(slides[w], { attributes: true, attributeFilter: ["class"] });
  }

  window.addEventListener("resize", function () { resolve(document); });
  window.addEventListener("beforeprint", function () { resolve(document); });
  // A face that loads after the first pass changes every box on the slide.
  if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
    document.fonts.ready.then(function () { resolve(document); });
  }
  resolve(document);
})();
`;

// The whole runtime: the pure planner, serialised, and the DOM glue above.
// Serialising rather than re-typing is what keeps one implementation of the
// routing in this repo instead of two.
const CONNECTOR_JS =
  "window.sdocPlanConnector = " + planConnector.toString() + ";\n" + CONNECTOR_RUNTIME;

// Structural, not a theme's: a connector is drawn by the runtime, so the
// classes it creates have to mean something before any theme is loaded. What a
// theme may change is here as custom properties.
const CONNECTOR_CSS = `
/* Connectors. The runtime in CONNECTOR_JS creates one absolutely positioned
   div per run of the line and per endpoint node, in design pixels, as children
   of .slide — which is the containing block, and which is also why they export
   as pinned painted rectangles without the exporter knowing what they are. */
.slide {
  --sdoc-connector-width: 2px;
  --sdoc-connector-dot: 10px;
}
.sdoc-conn {
  position: absolute;
  background: var(--sdoc-connector-color, var(--sdoc-accent, currentColor));
  pointer-events: none;
}
.sdoc-conn-dot { border-radius: 50%; }
`;

module.exports = {
  planConnector,
  parseEndpoint,
  readConnector,
  RE_ENDPOINT,
  CONNECTOR_KEYS,
  CONNECTOR_SCOPE_ID,
  CONNECTOR_JS,
  CONNECTOR_CSS,
  CONNECTOR_RUNTIME,
  SHAPES,
  NODES,
  ANCHOR_POINTS,
  DEFAULT_SHAPE,
};
