// SDOC Slides — drawing on a slide while presenting.
//
// Pen, highlighter, rectangle, callout, laser and eraser, in either window of
// a talk: the presenter window draws on its copy of the current slide, the
// deck's own window on the slide itself. This is the half of that which
// touches the page — the overlay the ink is drawn in, the palette, the
// pointer — and it is the same code in both windows; src/slide-presenter.js
// gives each window its own and carries what is drawn between them.
//
// What can be decided without a page is decided elsewhere, and tested there:
//
//   slide-ink.js      a stroke's outline from its points; what an eraser hits
//   slide-snap.js     what a highlight or a rectangle snaps to
//   slide-callout.js  where a callout goes
//   slide-strokes.js  the strokes themselves, per slide, and their messages
//
// createAnnotate is serialised into the deck with toString() (ANNOTATE_JS),
// like those, so it reaches nothing outside its own body: the deck's kit and
// the four modules above are handed in, and nothing in it may spell the tag
// that closes a script element. It is ES5, as the page's other runtimes are.
// Its parts, each a function below:
//
//   inkBook        the strokes of a deck and their drawing, in every copy of
//                  a slide on the page
//   inkSurface     where the current slide is on screen, so a pointer's place
//                  on it in design pixels
//   slideTargets   what is on the slide to snap to, measured
//   inkPalette     the column of tools, colours, Undo and Clear
//   inkColours     the pens' and the highlighter's colours, and choosing them
//   calloutEditor  a callout being typed, resized, and sent as it changes
//   inkPointer     strokes, the eraser and the laser, from pointer events
//   inkTools       all of the above for one window: which tool is in hand,
//                  the keys, and what the window may ask of it

function createAnnotate(kit, ink, snap, place, createStrokes) {
  var SVG_NS = "http://www.w3.org/2000/svg";
  // Mid-tone, so each reads on a white slide and on a dark one.
  var PENS = [["#ef3434", "Red"], ["#2b7cf6", "Blue"], ["#16a34a", "Green"]];
  // What a double-click on a pen's colour offers instead: each at least 3:1
  // against white and against near-black, so a stroke in any of them reads
  // on a light slide and on a dark one. The pens' own three are among them,
  // so a changed pen can always be put back.
  var PEN_PRESETS = [
    ["#ef3434", "Red"], ["#ea580c", "Orange"], ["#d97706", "Amber"], ["#65a30d", "Lime"],
    ["#16a34a", "Green"], ["#0d9488", "Teal"], ["#0891b2", "Cyan"], ["#2b7cf6", "Blue"],
    ["#8b5cf6", "Violet"], ["#c026d3", "Magenta"], ["#db2777", "Pink"], ["#6b7280", "Grey"]
  ];
  var HIGHLIGHT = "#ffd60a";
  // And for the highlighter, a double-click on it away: the usual
  // highlighter colours, light and strong, so that at the highlighter's
  // 0.4 the text under them still reads, on a light slide and a dark one.
  var HIGHLIGHT_PRESETS = [
    ["#ffd60a", "Yellow"], ["#5ee36a", "Green"], ["#ff6fb5", "Pink"],
    ["#5cc8ff", "Blue"], ["#ffa53d", "Orange"], ["#c58cff", "Purple"]
  ];
  var TRAIL_MS = 260;
  // A stroke given its final shape cross-fades to it over this long.
  var FADE_MS = 220;
  var XHTML_NS = "http://www.w3.org/1999/xhtml";
  // A callout's box: a light fill, so its dark text reads on a light slide
  // and on a dark one, ruled in the pen's colour. Not quite opaque, so the
  // slide shows through a little; over black it is still a light grey, and
  // the text on it still better than 10:1.
  var CALLOUT_FILL = "#fffdf5";
  var CALLOUT_FILL_OPACITY = "0.8";
  // The eraser's radius on screen, so it is the same size under the pointer
  // however small the slide is drawn.
  var ERASER_PX = 10;
  // A callout being typed or resized reaches the other window at most this
  // often.
  var CALLOUT_MS = 150;
  var TOOL_KEYS = { d: "pen", h: "highlighter", r: "rect", a: "callout", l: "laser", e: "eraser" };

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function tenth(v) { return Math.round(v * 10) / 10; }
  function tenthBox(b) { return { x: tenth(b.x), y: tenth(b.y), w: tenth(b.w), h: tenth(b.h) }; }
  // Sizes are written for a slide 1280 wide; this is one of those pixels in
  // the design box there is.
  function unitOf(box) { return box.w / 1280; }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  // fn once, on the next frame — or a moment later where frames are not
  // drawn, as in a window that is not on screen.
  function soon(fn) {
    var done = false;
    function run() { if (!done) { done = true; fn(); } }
    if (window.requestAnimationFrame) window.requestAnimationFrame(run);
    setTimeout(run, 40);
  }
  // A click on one of these leaves the keyboard focus where it was: a
  // button that kept it would be pressed again by the next Space, which
  // the deck reads as Next.
  function keepFocus(b) { b.addEventListener("mousedown", function (e) { e.preventDefault(); }); }
  function icon(cls, d) {
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    if (cls) svg.setAttribute("class", cls);
    var path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
    return svg;
  }
  // A button that acts on its second click: the first arms it, for three
  // seconds, so that one stray click mid-talk does nothing. A browser's
  // confirm dialog would freeze the deck instead.
  //   on.arm(), on.disarm()  show that it is waiting, and that it no longer is
  //   on.act()               the second click
  //   on.ready()             optional: whether a click means anything now
  function twoClicks(button, on) {
    var armed = false, timer = null;
    function disarm() {
      armed = false;
      clearTimeout(timer);
      button.classList.remove("is-armed");
      on.disarm();
    }
    button.addEventListener("click", function () {
      if (on.ready && !on.ready()) return;
      if (armed) { disarm(); on.act(); return; }
      armed = true;
      button.classList.add("is-armed");
      on.arm();
      timer = setTimeout(disarm, 3000);
    });
    return { disarm: disarm, armed: function () { return armed; } };
  }
  // A callout's text, in design pixels, whatever the page around it says:
  // the presenter measures it with this and types into it with this, and
  // both windows draw it with this.
  function calloutText(el, font) {
    el.style.cssText = "all: initial; display: block; box-sizing: border-box; margin: 0;" +
      "padding: 0.35em 0.55em; font: 500 " + font + "px/1.3 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;" +
      "color: #1b1b1f; text-align: left; white-space: pre-wrap; overflow-wrap: anywhere;";
  }

  // ---- The strokes, drawn -----------------------------------------------------
  //
  // What is drawn on a deck, kept per slide for as long as the windows are
  // open (the keeping is createStrokes, src/slide-strokes.js), and drawn in
  // an svg.sdoc-ink inside the slide element itself, its viewBox the design
  // box, so the slide's own transform scales it: a stroke lands in the same
  // place on the presenter's miniature and on the projector, whatever the
  // size of either window or the deck's fit. Every copy of a slide on the
  // page carries one, and paint() brings them all up to date together. The
  // deck's own slides get one only once something is drawn on them, so a
  // built deck has none, and print hides them.
  //
  // Points are rounded to a tenth as they are taken: both windows draw from
  // the same numbers, and the same numbers give the same outline.
  //
  // originals: whether the deck's own slides are drawn on (the audience's
  // deck), or only the miniatures the caller hands to layer() (the
  // presenter's stage).
  function inkBook(originals) {
    var box = null, laser = null;
    function design() { if (!box) box = kit.designBox(); return box; }
    var store = createStrokes({
      unit: function () { return unitOf(design()); }, pen: PENS[0][0], highlight: HIGHLIGHT
    });

    function original(label) {
      var parts = String(label).split(".");
      return kit.at(parseInt(parts[0], 10) - 1, parts[1] ? parseInt(parts[1], 10) : 0);
    }
    function shape(s) {
      return s.tool === "highlighter"
        ? { size: s.size, thinning: 0, simulatePressure: false }
        : { size: s.size, thinning: 0.5 };
    }
    function roundRect(b, r) {
      r = Math.max(0, Math.min(r, b.w / 2, b.h / 2));
      var x0 = tenth(b.x), y0 = tenth(b.y), x1 = tenth(b.x + b.w), y1 = tenth(b.y + b.h), a = tenth(r);
      var arc = "A" + a + " " + a + " 0 0 1 ";
      return "M" + tenth(x0 + a) + " " + y0 + "H" + tenth(x1 - a) + arc + x1 + " " + tenth(y0 + a) +
        "V" + tenth(y1 - a) + arc + tenth(x1 - a) + " " + y1 + "H" + tenth(x0 + a) + arc + x0 + " " + tenth(y1 - a) +
        "V" + tenth(y0 + a) + arc + tenth(x0 + a) + " " + y0 + "Z";
    }
    // The outline is cached against the number of points, which are only
    // ever added, and the stroke's revision, which a replace moves on.
    function pathOf(s) {
      var key = s.points.length + ":" + (s.rev || 0);
      if (s.pathFor !== key) {
        var boxes = ink.boxesOf(s), u = unitOf(design());
        if (boxes) {
          s.path = boxes.filter(function (b) { return b.w > 0 || b.h > 0; }).map(function (b) {
            return roundRect(b, s.tool === "rect" ? 10 * u : Math.min(6 * u, b.h / 4));
          }).join("");
        } else {
          s.path = ink.stroke(s.points, shape(s));
        }
        s.pathFor = key;
      }
      return s.path;
    }
    // How a stroke's path is painted. A rectangle is an outline, dashed
    // while it is still being dragged; the others are filled shapes.
    function dress(p, s) {
      var look = s.tool + (s.live ? ":live" : "") + (s.rects ? ":boxes" : "");
      if (p.inkLook === look) return;
      p.inkLook = look;
      p.setAttribute("class", "sdoc-ink-" + s.tool + (s.rects && s.tool === "highlighter" ? " is-snapped" : ""));
      ["fill", "fill-opacity", "stroke", "stroke-width", "stroke-linejoin", "stroke-dasharray"].forEach(function (a) { p.removeAttribute(a); });
      if (s.tool === "rect") {
        p.setAttribute("fill", "none");
        p.setAttribute("stroke", s.color);
        p.setAttribute("stroke-width", String(s.size));
        p.setAttribute("stroke-linejoin", "round");
        if (s.live) p.setAttribute("stroke-dasharray", tenth(3 * s.size) + " " + tenth(2 * s.size));
      } else if (s.tool === "highlighter") {
        // In the colour it was drawn in, whatever the highlighter is now.
        p.setAttribute("fill", s.color);
        p.setAttribute("fill-opacity", "0.4");
      } else {
        p.setAttribute("fill", s.color);
      }
    }

    // ---- The overlays ----

    function ensure(slideEl, label) {
      if (!slideEl) return null;
      var svg = null;
      for (var c = slideEl.firstElementChild; c; c = c.nextElementSibling) {
        if (c.getAttribute("class") === "sdoc-ink") { svg = c; break; }
      }
      if (!svg) {
        var b = design();
        svg = document.createElementNS(SVG_NS, "svg");
        svg.setAttribute("class", "sdoc-ink");
        svg.setAttribute("viewBox", "0 0 " + b.w + " " + b.h);
        svg.setAttribute("preserveAspectRatio", "none");
        svg.setAttribute("aria-hidden", "true");
        svg.setAttribute("focusable", "false");
        var g = document.createElementNS(SVG_NS, "g");
        g.setAttribute("data-ink", "strokes");
        svg.appendChild(g);
        slideEl.appendChild(svg);
      }
      svg.setAttribute("data-slide", label);
      return svg;
    }
    function layer(slideEl, label) {
      var svg = ensure(slideEl, String(label));
      if (svg) { sync(svg); drawLaser(); }
      return svg;
    }
    function layers(label) {
      return [].slice.call(document.querySelectorAll("svg.sdoc-ink")).filter(function (svg) {
        return svg.getAttribute("data-slide") === label;
      });
    }
    function part(svg, name, tag) {
      var n = svg.querySelector("[data-ink='" + name + "']");
      if (!n && tag) {
        n = document.createElementNS(SVG_NS, tag);
        n.setAttribute("data-ink", name);
        svg.appendChild(n);
      }
      return n;
    }
    // One overlay made to match its slide: a path per stroke, in the order
    // they were drawn.
    function sync(svg) {
      var g = part(svg, "strokes", "g"), list = store.strokes(svg.getAttribute("data-slide"));
      var want = {}, have = {}, i, s, p;
      for (i = 0; i < list.length; i++) want[list[i].id] = true;
      [].slice.call(g.childNodes).forEach(function (n) {
        var id = n.getAttribute && n.getAttribute("data-stroke");
        if (id && want[id] && !have[id]) have[id] = n;
        else g.removeChild(n);
      });
      var at = g.firstChild;
      for (i = 0; i < list.length; i++) {
        s = list[i];
        p = have[s.id];
        if (!p) {
          p = document.createElementNS(SVG_NS, s.tool === "callout" ? "g" : "path");
          p.setAttribute("data-stroke", s.id);
        }
        if (p !== at) g.insertBefore(p, at); else at = at.nextSibling;
        if (s.tool === "callout") { drawCallout(p, s); continue; }
        dress(p, s);
        var d = pathOf(s);
        if (p.getAttribute("d") !== d) p.setAttribute("d", d);
      }
    }
    // A callout: a box of text on a light fill, ruled in its pen's colour,
    // and, when it is about something on the slide, a short leader from the
    // box to that thing's edge with a dot where it lands. The text is HTML
    // in a foreignObject, so it wraps as text does, in the box the presenter
    // measured for it; the box is given in the stroke, so both windows draw
    // the same one.
    function drawCallout(g, s) {
      var b = s.rects && s.rects[0], T = s.target;
      var key = b ? [b.x, b.y, b.w, b.h, s.text, s.color, s.size, s.font, !!s.editing, T ? [T.x, T.y, T.w, T.h].join(",") : ""].join("|") : "";
      if (g.inkDrawn === key) return;
      g.inkDrawn = key;
      if (!g.firstChild) {
        g.setAttribute("class", "sdoc-ink-callout");
        ["path", "circle", "rect", "foreignObject"].forEach(function (t) { g.appendChild(document.createElementNS(SVG_NS, t)); });
        g.lastChild.appendChild(document.createElementNS(XHTML_NS, "div"));
      }
      var leader = g.childNodes[0], dot = g.childNodes[1], box = g.childNodes[2], fo = g.childNodes[3], div = fo.firstChild;
      if (!b) { g.setAttribute("display", "none"); return; }
      g.removeAttribute("display");
      var d = "", tx = 0, ty = 0;
      if (T) {
        tx = clamp(b.x + b.w / 2, T.x, T.x + T.w);
        ty = clamp(b.y + b.h / 2, T.y, T.y + T.h);
        d = "M" + tenth(clamp(tx, b.x, b.x + b.w)) + " " + tenth(clamp(ty, b.y, b.y + b.h)) + "L" + tenth(tx) + " " + tenth(ty);
      }
      leader.setAttribute("d", d);
      leader.setAttribute("fill", "none");
      leader.setAttribute("stroke", s.color);
      leader.setAttribute("stroke-width", String(s.size));
      leader.setAttribute("stroke-linecap", "round");
      dot.setAttribute("cx", String(tenth(tx)));
      dot.setAttribute("cy", String(tenth(ty)));
      dot.setAttribute("r", String(T ? tenth(1.5 * s.size) : 0));
      dot.setAttribute("fill", s.color);
      [["x", b.x], ["y", b.y], ["width", b.w], ["height", b.h]].forEach(function (a) {
        box.setAttribute(a[0], String(a[1]));
        fo.setAttribute(a[0], String(a[1]));
      });
      box.setAttribute("rx", String(tenth(0.35 * s.font)));
      box.setAttribute("fill", CALLOUT_FILL);
      box.setAttribute("fill-opacity", CALLOUT_FILL_OPACITY);
      box.setAttribute("stroke", s.color);
      box.setAttribute("stroke-width", String(s.size));
      calloutText(div, s.font);
      div.style.width = "100%";
      div.style.height = "100%";
      div.style.overflow = "hidden";
      // While the presenter types into it, the text is the editor's.
      div.style.visibility = s.editing ? "hidden" : "visible";
      div.textContent = s.text;
    }
    function paint(label) {
      label = String(label);
      if (originals && store.count(label)) ensure(original(label), label);
      layers(label).forEach(sync);
    }
    function paintAll() {
      [].forEach.call(document.querySelectorAll("svg.sdoc-ink"), sync);
    }

    function repaint(labels) { labels.forEach(paint); }
    function remove(ids) { repaint(store.remove(ids)); }
    function clear(label) {
      if (label == null) { store.clear(); paintAll(); }
      else repaint(store.clear(label));
    }
    // A finished stroke given its final shape, where it is in the order: a
    // highlight snapped to the words it ran along, or a rectangle snapped to
    // what it was drawn round. Only the shape changes. Shown as a quick
    // cross-fade from the old shape to the new in every copy of the slide.
    function replace(w, fade) {
      var s = w && w.id != null ? store.get(w.id) : null;
      if (!s) return null;
      // A callout changes with every few keys typed into it: no fade.
      if (s.tool === "callout") fade = false;
      var ghosts = fade ? layers(s.slide).map(function (svg) {
        var p = pathIn(svg, s.id);
        return p && p.getAttribute("d") ? { svg: svg, p: p.cloneNode(false) } : null;
      }).filter(Boolean) : [];
      store.replace(w);
      paint(s.slide);
      ghosts.forEach(function (gh) {
        gh.p.removeAttribute("data-stroke");
        part(gh.svg, "ghosts", "g").appendChild(gh.p);
        var now = pathIn(gh.svg, s.id), fadeIn = null;
        function done() {
          if (gh.p.parentNode) gh.p.parentNode.removeChild(gh.p);
          if (fadeIn) { try { fadeIn.cancel(); } catch (err) {} fadeIn = null; }
        }
        if (gh.p.animate) {
          gh.p.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, easing: "ease-out", fill: "forwards" }).onfinish = done;
          if (now) fadeIn = now.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: "ease-out" });
        }
        // And on a timer, which runs where frames do not — a window out of
        // sight — so the old shape never lingers and the new one is never
        // left at the transparent start of its fade.
        setTimeout(done, FADE_MS + 200);
      });
      return s;
    }
    function pathIn(svg, id) {
      var g = part(svg, "strokes");
      for (var n = g ? g.firstChild : null; n; n = n.nextSibling) {
        if (n.getAttribute && n.getAttribute("data-stroke") === id) return n;
      }
      return null;
    }
    // The other window's half of the conversation. A stroke's final shape
    // fades in; the rest is drawn as it lands.
    function apply(m) {
      if (m.op === "replace" && m.stroke) replace(m.stroke, true);
      else repaint(store.apply(m));
    }
    function hit(label, a, b, r) { return ink.hit(store.strokes(label), a, b, r); }

    // ---- The laser and the eraser's ring: shown, never kept ----

    // The newest point is the dot; the trail behind it is the last quarter
    // of a second, narrowing to nothing, and fades away while the pointer
    // rests.
    function laserTo(label, points) {
      label = String(label);
      if (!laser || laser.slide !== label) { laserOff(); laser = { slide: label, trail: [], queued: false }; }
      var now = Date.now(), more = store.clean(points);
      for (var i = 0; i < more.length; i++) laser.trail.push({ x: more[i][0], y: more[i][1], t: now });
      if (!laser.trail.length) return;
      if (originals) ensure(original(label), label);
      drawLaser();
    }
    function laserOff() {
      laser = null;
      [].forEach.call(document.querySelectorAll("svg.sdoc-ink [data-ink='laser']"), function (n) { n.parentNode.removeChild(n); });
    }
    function drawLaser() {
      if (!laser || !laser.trail.length) return;
      var L = laser, t = L.trail, now = Date.now(), u = unitOf(design()), i;
      while (t.length > 1 && now - t[0].t > TRAIL_MS) t.shift();
      var last = t[t.length - 1], pts = [], len = 0;
      for (i = 0; i < t.length; i++) {
        pts.push([t[i].x, t[i].y]);
        if (i) len += Math.sqrt((t[i].x - t[i - 1].x) * (t[i].x - t[i - 1].x) + (t[i].y - t[i - 1].y) * (t[i].y - t[i - 1].y));
      }
      var d = len > 1
        ? ink.stroke(pts, { size: 9 * u, thinning: 0, simulatePressure: false, streamline: 0.2, taperStart: len })
        : "";
      layers(L.slide).forEach(function (svg) {
        var g = part(svg, "laser", "g");
        if (!g.firstChild) {
          [["path", "#ff2a2a", "0.5"], ["circle", "#ff2a2a", "0.28"], ["circle", "#ff3030", "1"]].forEach(function (k) {
            var n = document.createElementNS(SVG_NS, k[0]);
            n.setAttribute("fill", k[1]);
            n.setAttribute("fill-opacity", k[2]);
            g.appendChild(n);
          });
          g.lastChild.setAttribute("stroke", "#fff");
        }
        g.childNodes[0].setAttribute("d", d);
        [[g.childNodes[1], 15], [g.childNodes[2], 6]].forEach(function (c) {
          c[0].setAttribute("cx", String(last.x));
          c[0].setAttribute("cy", String(last.y));
          c[0].setAttribute("r", String(c[1] * u));
        });
        g.lastChild.setAttribute("stroke-width", String(1.5 * u));
        // Above the strokes, and above the ring.
        if (g !== svg.lastChild) svg.appendChild(g);
      });
      if (t.length > 1 && !L.queued) {
        L.queued = true;
        soon(function () { L.queued = false; if (laser === L) drawLaser(); });
      }
    }
    // The box a callout is being dragged out to, dashed: shown, never kept.
    function guide(label, b, color, width) {
      [].forEach.call(document.querySelectorAll("svg.sdoc-ink [data-ink='guide']"), function (n) {
        if (label == null || !b || n.parentNode.getAttribute("data-slide") !== String(label)) n.parentNode.removeChild(n);
      });
      if (label == null || !b) return;
      layers(String(label)).forEach(function (svg) {
        var p = part(svg, "guide", "path");
        p.setAttribute("d", roundRect(b, 0));
        p.setAttribute("fill", "none");
        p.setAttribute("stroke", color);
        p.setAttribute("stroke-width", String(width));
        p.setAttribute("stroke-dasharray", tenth(3 * width) + " " + tenth(2 * width));
      });
    }
    function ring(label, at, r) {
      [].forEach.call(document.querySelectorAll("svg.sdoc-ink [data-ink='ring']"), function (n) {
        if (label == null || n.parentNode.getAttribute("data-slide") !== String(label)) n.parentNode.removeChild(n);
      });
      if (label == null) return;
      layers(String(label)).forEach(function (svg) {
        var c = part(svg, "ring", "circle");
        c.setAttribute("cx", String(at[0]));
        c.setAttribute("cy", String(at[1]));
        c.setAttribute("r", String(r));
        c.setAttribute("fill", "rgba(128, 128, 128, 0.2)");
        c.setAttribute("stroke", "#888");
        c.setAttribute("stroke-width", String(r / 8));
      });
    }
    return {
      layer: layer, paint: paint, add: store.add, remove: remove, clear: clear, replace: replace, apply: apply,
      get: store.get, strokes: store.strokes, count: store.count, labels: store.labels, wire: store.wire,
      isColour: store.isColour, hit: hit, guide: guide, laserTo: laserTo, laserOff: laserOff, ring: ring
    };
  }

  // ---- Where the slide is -----------------------------------------------------
  //
  // slideEl() is the element that is the current slide — the slide itself,
  // or its copy on the presenter's stage — which is the design box once its
  // transform is taken out. A point on screen is turned into design pixels
  // by measuring that element, transform and all.
  function inkSurface(slideEl) {
    var design = kit.designBox();
    function measure() {
      var c = slideEl();
      if (!c) return null;
      var r = c.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return null;
      return { r: r, kx: r.width / design.w, ky: r.height / design.h };
    }
    // Pressure only from a stylus: a mouse reports a constant 0.5.
    function point(ev, sf, pressure) {
      var p = [tenth((ev.clientX - sf.r.left) / sf.kx), tenth((ev.clientY - sf.r.top) / sf.ky)];
      if (pressure && ev.pointerType === "pen" && ev.pressure > 0) p.push(Math.round(ev.pressure * 100) / 100);
      return p;
    }
    return {
      slideEl: slideEl, measure: measure, point: point,
      design: function () { return design; },
      unit: function () { return unitOf(design); },
      setDesign: function (d) { design = d; }
    };
  }

  // ---- What is on the slide, to snap to ---------------------------------------
  //
  // The boxes src/slide-snap.js decides between, measured off the current
  // slide and turned into design pixels through its scale: every word, from
  // a text Range, with the visual line it shares with its neighbours in the
  // same block; the inline marks, in a box per line they wrap over; the
  // blocks — a paragraph, a list item, a heading, a picture, a layout's card
  // or column; table cells, and each table column and row as the union of
  // its cells. Measured when something needs them, and kept while the slide
  // and its place and size on screen stay as they were.
  function slideTargets(surface) {
    var INLINE_TAGS = /^(span|strong|em|b|i|u|s|code|a|mark|kbd|sup|sub|small|abbr|q|cite|var|samp|del|ins)$/;
    var NOT_CONTENT = "svg.sdoc-ink, aside.notes, .slide-footer, .nav-vert, .slide-bg, script, style, template";
    var cache = null;
    function candidates() {
      var sf = surface.measure();
      if (!sf) return [];
      var root = surface.slideEl();
      var key = [kit.position(), sf.r.left, sf.r.top, sf.r.width, sf.r.height].join("|");
      if (cache && cache.root === root && cache.key === key) return cache.list;
      var list = [], tables = [], styles = new Map(), lines = new Map(), lineNo = 0, groupNo = 0;
      var design = surface.design(), whole = design.w * design.h;
      function cs(n) { var c = styles.get(n); if (!c) { c = getComputedStyle(n); styles.set(n, c); } return c; }
      function inline(n) { return /^inline/.test(cs(n).display); }
      function depth(n) { var d = 0; while (n && n !== root) { d++; n = n.parentNode; } return d; }
      function real(r) { return r.width > 0 && r.height > 0; }
      function box(r, kind, level) {
        return { x: tenth((r.left - sf.r.left) / sf.kx), y: tenth((r.top - sf.r.top) / sf.ky),
          w: tenth(r.width / sf.kx), h: tenth(r.height / sf.ky), kind: kind, level: level };
      }
      function unionOf(boxes, kind, level) {
        var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        boxes.forEach(function (b) { x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); });
        return { x: x0, y: y0, w: tenth(x1 - x0), h: tenth(y1 - y0), kind: kind, level: level };
      }
      // The block a run of text flows in, and the line in it a word is on:
      // the words of two table cells side by side share a baseline and are
      // still two lines.
      function blockOf(n) {
        var el = n.parentNode;
        while (el && el !== root && el.nodeType === 1 && inline(el)) el = el.parentNode;
        return el || root;
      }
      function lineFor(block, b) {
        var mine = lines.get(block);
        if (!mine) { mine = []; lines.set(block, mine); }
        for (var i = mine.length - 1; i >= 0; i--) {
          var L = mine[i], v = Math.min(L.bottom, b.y + b.h) - Math.max(L.top, b.y);
          if (v >= 0.5 * Math.min(L.bottom - L.top, b.h)) return L.id;
        }
        mine.push({ id: "l" + (++lineNo), top: b.y, bottom: b.y + b.h });
        return mine[mine.length - 1].id;
      }
      var range = document.createRange();
      function words(t) {
        var re = /\S+/g, m, block = null, level = depth(t);
        while ((m = re.exec(t.data))) {
          range.setStart(t, m.index);
          range.setEnd(t, m.index + m[0].length);
          var rs = range.getClientRects();
          for (var i = 0; i < rs.length; i++) {
            if (!real(rs[i])) continue;
            var b = box(rs[i], "word", level);
            if (!block) block = blockOf(t);
            b.line = lineFor(block, b);
            list.push(b);
          }
        }
      }
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) {
          if (n.nodeType !== 1) return /\S/.test(n.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
          if (n.matches(NOT_CONTENT) || n.getAttribute("aria-hidden") === "true") return NodeFilter.FILTER_REJECT;
          var c = cs(n);
          return c.display === "none" || c.visibility === "hidden" ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        }
      });
      for (var n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.nodeType === 3) { words(n); continue; }
        var tag = n.tagName.toLowerCase(), level = depth(n), d = cs(n).display, r, i;
        // Inside a drawing only the words count; the drawing is one block.
        if (n.namespaceURI === SVG_NS && tag !== "svg") continue;
        if (tag === "td" || tag === "th") {
          r = n.getBoundingClientRect();
          if (real(r)) list.push(box(r, "cell", level));
        } else if (INLINE_TAGS.test(tag) && /^inline/.test(d)) {
          var rs = n.getClientRects(), group = rs.length > 1 ? "g" + (++groupNo) : null;
          for (i = 0; i < rs.length; i++) {
            if (!real(rs[i])) continue;
            var b = box(rs[i], "inline", level);
            if (group) b.group = group;
            list.push(b);
          }
        } else if (/^table-/.test(d)) {
          // A row or a section of the table: its rows are measured below.
        } else {
          r = n.getBoundingClientRect();
          if (!real(r)) continue;
          var blk = box(r, /^inline/.test(d) && !/^(img|svg|canvas|video|picture)$/.test(tag) ? "inline" : "block", level);
          // A wrapper round the whole slide is no answer to anything.
          if (blk.w * blk.h < 0.9 * whole || /^(img|svg|canvas|video|picture)$/.test(tag)) list.push(blk);
          if (tag === "table") tables.push({ el: n, level: level });
        }
      }
      tables.forEach(function (t) {
        var cols = [];
        [].forEach.call(t.el.rows, function (row) {
          var mine = [], c = 0;
          [].forEach.call(row.cells, function (cell) {
            var r = cell.getBoundingClientRect(), span = cell.colSpan || 1;
            if (real(r)) {
              var b = box(r, "cell", 0);
              mine.push(b);
              if (span === 1) (cols[c] = cols[c] || []).push(b);
            }
            c += span;
          });
          if (mine.length) list.push(unionOf(mine, "row", t.level + 1));
        });
        cols.forEach(function (bs) { if (bs && bs.length) list.push(unionOf(bs, "column", t.level + 1)); });
      });
      cache = { root: root, key: key, list: list };
      return list;
    }
    // The snapping's distances, in this deck's design pixels.
    function options(more) {
      var u = surface.unit(), all = { pad: 2 * u, minLength: 10 * u, reversalSlack: 8 * u, tolerance: u };
      for (var k in more) all[k] = more[k];
      return all;
    }
    return { candidates: candidates, options: options, invalidate: function () { cache = null; } };
  }

  // ---- The palette -------------------------------------------------------------
  //
  // Every control is always there, in one place whatever the window is
  // doing: a column of tools, the three pens, then Undo, Clear and Clear
  // all. One that does not apply is disabled where it is. It only shows and
  // reports: what a press means is the caller's, through on.
  //
  //   pointerLabel  what the no-tool button says a click on the slide does
  //   on.tool(name | null), on.pen(i), on.colours("pen" | "highlight", i)
  //   on.undo(), on.clear(), on.clearAll()
  //   hasInk()      whether there is anything for Clear all to clear
  function inkPalette(pointerLabel, on, hasInk) {
    var root = el("div", "sdoc-ink-tools");
    root.setAttribute("role", "toolbar");
    root.setAttribute("aria-label", "Drawing tools");
    root.setAttribute("aria-orientation", "vertical");
    function button(name, label, key, d) {
      var b = el("button", "sdoc-ink-tool is-" + name);
      b.type = "button";
      b.title = label + (key ? " (" + key + ")" : "");
      b.setAttribute("aria-label", label);
      if (key) b.setAttribute("data-key", key.charAt(0));
      b.appendChild(icon(null, d));
      keepFocus(b);
      root.appendChild(b);
      return b;
    }
    var tools = {};
    [["pointer", pointerLabel, "", "M5 3l6 17 2.4-7.1L20.5 10.5z"],
     ["pen", "Pen", "D", "M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"],
     ["highlighter", "Highlighter: snaps to the words it runs along; hold \u2325 Option (Alt) to draw freehand; double-click for its colour", "H", "M9 11l-6 6v3h9l3-3M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"],
     ["rect", "Rectangle: drag round something, or click it, to box it; hold \u2325 Option (Alt) not to snap", "R", "M3 7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4z"],
     ["callout", "Callout: click something to label it, or drag a box, then type; Esc to finish", "A", "M6 4h12a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3h-7l-5 4v-4a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zM8 9h8M8 12.5h5"],
     ["laser", "Laser pointer", "L", "M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"],
     ["eraser", "Eraser: drag across strokes to remove them", "E", "M7 21l-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21M22 21H7M5 11l9 9"]]
      .forEach(function (t) {
        var b = button(t[0], t[1], t[2], t[3]);
        tools[t[0]] = b;
        // A double-click on the highlighter opens its colours; the two
        // clicks before it have chosen it already.
        if (t[0] === "highlighter") {
          b.setAttribute("aria-haspopup", "dialog");
          b.setAttribute("aria-expanded", "false");
          b.addEventListener("dblclick", function () { on.colours("highlight"); });
        }
        b.addEventListener("click", function () { on.tool(t[0] === "pointer" ? null : t[0]); });
      });
    root.appendChild(el("div", "sdoc-ink-tools-rule"));
    var swatches = PENS.map(function (p, i) {
      var b = el("button", "sdoc-ink-swatch");
      b.type = "button";
      b.setAttribute("aria-haspopup", "dialog");
      b.setAttribute("aria-expanded", "false");
      b.appendChild(el("span", "sdoc-ink-swatch-dot"));
      keepFocus(b);
      // A click picks the pen; a double-click also opens its colours, the
      // two clicks before it having picked the pen already.
      b.addEventListener("click", function () { on.pen(i); });
      b.addEventListener("dblclick", function () { on.colours("pen", i); });
      root.appendChild(b);
      return b;
    });
    root.appendChild(el("div", "sdoc-ink-tools-rule"));
    var undoBtn = button("undo", "Undo the last thing this window drew on this slide", "U or \u2318Z", "M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11");
    var clearBtn = button("clear", "Clear this slide's ink", "", "M3 5h18v14H3zM9.5 9.5l5 5M14.5 9.5l-5 5");
    var clearAllBtn = button("clear-all", "Clear the ink on every slide", "", "M7 3h14v11M3 7h14v14H3zM7.5 11.5l5 5M12.5 11.5l-5 5");
    undoBtn.addEventListener("click", on.undo);
    clearBtn.addEventListener("click", on.clear);
    // Clear all is asked twice. The button keeps its size and its icon; it
    // turns red, and the deck's hint says what the second click does.
    function nameClearAll(text) {
      clearAllBtn.setAttribute("aria-label", text);
      clearAllBtn.title = text;
    }
    var clearAll = twoClicks(clearAllBtn, {
      ready: hasInk,
      arm: function () {
        nameClearAll("Click again to clear the ink on every slide");
        kit.say("Click again to clear the ink on every slide");
      },
      disarm: function () { nameClearAll("Clear the ink on every slide"); },
      act: on.clearAll
    });
    // state: { tool, pen, penColour, highlight, canUndo, here, any } — the
    // tool in hand, the pen chosen and the colours in use, and whether
    // there is a stroke of this window's to undo, ink on this slide, ink
    // anywhere.
    function show(state) {
      Object.keys(tools).forEach(function (k) {
        var isOn = k === (state.tool || "pointer");
        tools[k].classList.toggle("is-on", isOn);
        tools[k].setAttribute("aria-pressed", isOn ? "true" : "false");
      });
      swatches.forEach(function (b, i) {
        b.classList.toggle("is-on", i === state.pen);
        b.setAttribute("aria-pressed", i === state.pen ? "true" : "false");
      });
      root.style.setProperty("--sdoc-ink-pen", state.penColour);
      root.style.setProperty("--sdoc-ink-highlight", state.highlight);
      undoBtn.disabled = !state.canUndo;
      clearBtn.disabled = !state.here;
      clearAllBtn.disabled = !state.any;
      if (clearAllBtn.disabled && clearAll.armed()) clearAll.disarm();
    }
    return { el: root, tools: tools, swatches: swatches, show: show, disarm: clearAll.disarm };
  }

  // ---- The colours, and choosing them ------------------------------------------
  //
  // The three pens' colours and the highlighter's: the ones above, or what
  // was chosen for them last time in this browser. A stroke takes its
  // colour as it begins and keeps it, so a changed pen recolours nothing
  // already drawn.
  //
  // A double-click on a pen's colour, or on the highlighter, opens its
  // choices beside the palette: the pens' dozen colours or the
  // highlighter's six, and the system's own picker for any other. A choice
  // applies at once, from the next stroke. The choices float, so nothing
  // under them moves; Escape, or a click anywhere else, closes them. Like
  // the palette's buttons, they never take the keyboard focus, which Space
  // would press.
  //
  //   face          presses on the slide arrive here: one that closes the
  //                 choices does not also draw
  //   on.pen(i)     a pen was given a colour, and is the one to draw with
  //   on.highlight()  the highlighter was given one
  function inkColours(palette, face, isColour, on) {
    var swatches = palette.swatches;
    var current = 0;
    var PENS_STORE = "sdocInkPens";
    var pens = PENS.map(function (p) { return p[0]; });
    try {
      var keptPens = JSON.parse(localStorage.getItem(PENS_STORE) || "null");
      if (keptPens && keptPens.length === pens.length) {
        keptPens.forEach(function (c, i) { if (isColour(c)) pens[i] = String(c).toLowerCase(); });
      }
    } catch (err) {}
    function penName(c) {
      for (var i = 0; i < PEN_PRESETS.length; i++) if (PEN_PRESETS[i][0] === c) return PEN_PRESETS[i][1];
      return c;
    }
    function labelSwatch(i) {
      var name = penName(pens[i]);
      swatches[i].firstChild.style.background = pens[i];
      swatches[i].title = name + " pen (C for the next colour; double-click for another)";
      swatches[i].setAttribute("aria-label", name + " pen");
    }
    swatches.forEach(function (b, i) { labelSwatch(i); });
    var HIGHLIGHT_STORE = "sdocInkHighlight";
    var highlight = HIGHLIGHT;
    try {
      var keptHighlight = localStorage.getItem(HIGHLIGHT_STORE);
      if (isColour(keptHighlight)) highlight = String(keptHighlight).toLowerCase();
    } catch (err) {}
    var chooser = el("div", "sdoc-ink-colours");
    chooser.setAttribute("role", "dialog");
    chooser.hidden = true;
    var chooserTitle = el("div", "sdoc-ink-colours-title");
    var presetGrid = el("div", "sdoc-ink-colours-grid");
    var presetBtns = [];
    function fillPresets(list) {
      presetGrid.textContent = "";
      presetGrid.style.gridTemplateColumns = "repeat(" + (list.length > 9 ? 4 : 3) + ", 28px)";
      presetBtns = list.map(function (p) {
        var b = el("button", "sdoc-ink-colours-preset");
        b.type = "button";
        b.title = p[1];
        b.setAttribute("aria-label", p[1]);
        b.setAttribute("data-colour", p[0]);
        b.style.background = p[0];
        keepFocus(b);
        b.addEventListener("click", function () {
          applyColour(p[0]);
          closeChooser();
        });
        presetGrid.appendChild(b);
        return b;
      });
    }
    var otherRow = el("label", "sdoc-ink-colours-other");
    var picker = document.createElement("input");
    picker.type = "color";
    picker.className = "sdoc-ink-colours-input";
    otherRow.appendChild(picker);
    otherRow.appendChild(el("span", "sdoc-ink-colours-other-label", "Other colour\u2026"));
    // Applied as it is dragged about; settled, it closes the choices.
    picker.addEventListener("input", function () { applyColour(picker.value); });
    picker.addEventListener("change", function () { applyColour(picker.value); closeChooser(); });
    [chooserTitle, presetGrid, otherRow].forEach(function (n) { chooser.appendChild(n); });
    // What the choices are open for: { kind: "pen", i } or { kind: "highlight" }.
    var choosing = null;
    function chosenColour() { return !choosing ? null : choosing.kind === "pen" ? pens[choosing.i] : highlight; }
    function anchorOf(c) { return c.kind === "pen" ? swatches[c.i] : palette.tools.highlighter; }
    // #rgb as the picker takes it: #rrggbb.
    function six(c) {
      c = String(c).slice(1);
      if (c.length === 3) c = c.charAt(0) + c.charAt(0) + c.charAt(1) + c.charAt(1) + c.charAt(2) + c.charAt(2);
      return "#" + c.toLowerCase();
    }
    function markPreset() {
      var c = chosenColour();
      presetBtns.forEach(function (b) {
        var on = !!c && b.getAttribute("data-colour") === c;
        b.classList.toggle("is-on", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
    }
    function applyColour(c) {
      if (!choosing || !isColour(c)) return;
      if (choosing.kind === "pen") setPen(choosing.i, c);
      else setHighlight(c);
    }
    function setPen(i, c) {
      if (!(i >= 0 && i < pens.length) || !isColour(c)) return;
      pens[i] = String(c).toLowerCase();
      labelSwatch(i);
      markPreset();
      try { localStorage.setItem(PENS_STORE, JSON.stringify(pens)); } catch (err) {}
      // The pen whose colour was chosen is the one to draw with.
      on.pen(i);
    }
    function labelHighlighter() {
      var name = null;
      HIGHLIGHT_PRESETS.forEach(function (p) { if (p[0] === highlight) name = p[1]; });
      palette.tools.highlighter.setAttribute("aria-label", "Highlighter, " + (name ? name.toLowerCase() : highlight));
    }
    function setHighlight(c) {
      highlight = String(c).toLowerCase();
      labelHighlighter();
      markPreset();
      try { localStorage.setItem(HIGHLIGHT_STORE, highlight); } catch (err) {}
      on.highlight();
    }
    labelHighlighter();
    // Just right of the column, level with what it is for, and kept inside
    // the window; the notch points at it.
    function placeChooser() {
      if (chooser.hidden || !choosing) return;
      var s = anchorOf(choosing).getBoundingClientRect(), col = palette.el.getBoundingClientRect();
      var h = chooser.offsetHeight, mid = s.top + s.height / 2, M = 8;
      var top = Math.max(M, Math.min(window.innerHeight - h - M, Math.round(mid - h / 2)));
      chooser.style.left = Math.round(col.right + 10) + "px";
      chooser.style.top = top + "px";
      chooser.style.setProperty("--sdoc-ink-colours-notch", Math.round(mid - top) + "px");
    }
    function openChooser(kind, i) {
      closeChooser();
      choosing = kind === "pen" ? { kind: "pen", i: i } : { kind: "highlight" };
      var name = kind === "pen" ? "Pen " + (i + 1) + " colour" : "Highlighter colour";
      chooserTitle.textContent = name;
      chooser.setAttribute("aria-label", name);
      fillPresets(kind === "pen" ? PEN_PRESETS : HIGHLIGHT_PRESETS);
      picker.value = six(chosenColour());
      markPreset();
      anchorOf(choosing).setAttribute("aria-expanded", "true");
      chooser.hidden = false;
      placeChooser();
    }
    function closeChooser() {
      if (chooser.hidden) return;
      chooser.hidden = true;
      if (choosing) anchorOf(choosing).setAttribute("aria-expanded", "false");
      choosing = null;
      // The picker, once used, has the focus; it goes with it.
      if (chooser.contains(document.activeElement)) document.activeElement.blur();
    }
    // Before anything else sees the press: one on the current slide that
    // closes the choices does not also draw there.
    document.addEventListener("pointerdown", function (e) {
      if (chooser.hidden || chooser.contains(e.target)) return;
      closeChooser();
      if (face.contains(e.target)) { e.preventDefault(); e.stopPropagation(); }
    }, true);
    // Escape closes the choices and does nothing else: the slide stays
    // enlarged if it was. The overview, when it is up, has had it first.
    document.addEventListener("keydown", function (e) {
      if (chooser.hidden || e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeChooser();
    }, true);
    window.addEventListener("resize", placeChooser);
    return {
      el: chooser, count: pens.length, open: openChooser, close: closeChooser, place: placeChooser,
      isOpen: function () { return !chooser.hidden; },
      current: function () { return current; },
      pick: function (i) { current = i; },
      pen: function () { return pens[current]; },
      highlight: function () { return highlight; }
    };
  }

  // ---- Callouts ------------------------------------------------------------------
  //
  // A box of text on the slide. A click on something — a word, a cell, a
  // picture, as the rectangle would snap to it — opens one beside it, where
  // the slide has room, with a leader to it; a click on nothing opens one
  // there; a drag opens one in the box dragged, which it fills no wider
  // than that (where it goes is src/slide-callout.js). The box fits the text
  // as it is typed: as wide as its longest line up to that limit, then
  // wrapping, and as tall as the lines. Enter is a new line; Escape, a click
  // elsewhere, another tool or another slide finishes it, and one left
  // empty is dropped. The other window sees it as it is typed, a few times
  // a second.
  //
  // It is typed into an editor laid over the box, at the slide's scale,
  // since a copy of a slide is inert. A handle on its side edge, shown
  // while the callout tool is over a callout and on the one being typed,
  // makes it wider or narrower: the text wraps again and the box is as tall
  // as it then needs. A resize is not an undo step: Undo takes the whole
  // callout.
  //
  //   spec  { book, surface, targets, face, send(msg), nextId(), colour(),
  //           changed() } — colour() the pen's, for a new callout;
  //           changed() told when what Undo and Clear apply to has changed
  function calloutEditor(spec) {
    var book = spec.book, surface = spec.surface, face = spec.face, send = spec.send;
    var writing = null, pressFinished = 0, measurer = null;
    var editorBox = el("div", "sdoc-ink-editor");
    editorBox.hidden = true;
    var editor = el("div", "sdoc-ink-editor-text");
    editor.setAttribute("role", "textbox");
    editor.setAttribute("aria-multiline", "true");
    editor.setAttribute("aria-label", "Callout text");
    editor.spellcheck = false;
    try { editor.contentEditable = "plaintext-only"; } catch (err) {}
    if (editor.contentEditable !== "plaintext-only") editor.contentEditable = "true";
    editorBox.appendChild(editor);

    var handle = el("div", "sdoc-ink-handle");
    handle.hidden = true;
    handle.setAttribute("aria-hidden", "true");
    handle.title = "Drag to make the callout wider or narrower";
    var handleFor = null, sizing = null;
    // The edge that moves: the one away from what it points at.
    function edgeOf(s) { return s.side === "left" ? "left" : "right"; }
    function showHandle(s) {
      handleFor = s;
      placeHandle();
    }
    function hideHandle() {
      if (sizing) return;
      handleFor = writing ? writing.s : null;
      placeHandle();
    }
    function placeHandle() {
      var s = handleFor, sf = surface.measure(), b = s && book.get(s.id) && s.rects && s.rects[0];
      if (!b || !sf || s.slide !== kit.position()) { handle.hidden = true; return; }
      var x = sf.r.left + (edgeOf(s) === "left" ? b.x : b.x + b.w) * sf.kx, y = sf.r.top + (b.y + b.h / 2) * sf.ky;
      handle.style.left = Math.round(x - 5) + "px";
      handle.style.top = Math.round(y - 12) + "px";
      handle.style.setProperty("--sdoc-callout-pen", s.color);
      handle.hidden = false;
    }
    handle.addEventListener("pointerdown", function (e) {
      if (!handleFor || e.button !== 0) return;
      // The editor keeps the keyboard focus, if it has it.
      e.preventDefault();
      try { handle.setPointerCapture(e.pointerId); } catch (err) {}
      sizing = { s: handleFor, pointer: e.pointerId };
    });
    handle.addEventListener("pointermove", function (e) {
      if (!sizing || e.pointerId !== sizing.pointer) return;
      var sf = surface.measure(), s = sizing.s, b = s.rects && s.rects[0];
      if (!sf || !b) return;
      var x = (e.clientX - sf.r.left) / sf.kx, M = place.MARGIN * surface.unit();
      var left = edgeOf(s) === "left";
      var most = left ? b.x + b.w - M : surface.design().w - M - b.x;
      s.width = tenth(clamp(left ? b.x + b.w - x : x - b.x, 3 * s.font, Math.max(3 * s.font, most)));
      placeCallout(s);
      book.paint(s.slide);
      placeEditor();
      placeHandle();
      queueCallout(s);
    });
    function endSizing(e) {
      if (!sizing || e.pointerId !== sizing.pointer) return;
      var s = sizing.s;
      sizing = null;
      // Where it was let go, at once.
      if (sendFor === s) flushCallout();
      if (e.type !== "pointerup") hideHandle();
    }
    handle.addEventListener("pointerup", endSizing);
    handle.addEventListener("pointercancel", endSizing);
    handle.addEventListener("lostpointercapture", endSizing);
    handle.addEventListener("pointerleave", function (e) {
      if (sizing || (e.relatedTarget && face.contains(e.relatedTarget))) return;
      hideHandle();
    });
    function calloutAt(p) {
      var list = book.strokes(kit.position());
      for (var i = list.length - 1; i >= 0; i--) {
        var s = list[i], b = s.tool === "callout" && s.rects && s.rects[0];
        if (b && p[0] >= b.x && p[0] <= b.x + b.w && p[1] >= b.y && p[1] <= b.y + b.h) return s;
      }
      return null;
    }
    // The box a text needs, in design pixels: as wide as its longest line,
    // up to maxW, or exactly width when it has been given one; as tall as
    // its lines. An empty last line counts.
    function measureCallout(text, font, maxW, width) {
      if (!measurer) {
        measurer = document.createElement("div");
        measurer.setAttribute("aria-hidden", "true");
        document.body.appendChild(measurer);
      }
      calloutText(measurer, font);
      measurer.style.position = "absolute";
      measurer.style.left = "-100000px";
      measurer.style.top = "0";
      measurer.style.visibility = "hidden";
      measurer.style.width = width ? width + "px" : "max-content";
      measurer.style.maxWidth = width ? "none" : maxW + "px";
      measurer.textContent = text + (text === "" || /\n$/.test(text) ? "\u200b" : "");
      var r = measurer.getBoundingClientRect();
      return { w: Math.ceil(Math.max(r.width, 3 * font)), h: Math.ceil(r.height) };
    }
    // Its box, from its text: beside what it is about, or from where it was
    // put, and inside the slide.
    function placeCallout(s) {
      var design = surface.design(), u = surface.unit();
      var size = measureCallout(s.text, s.font, s.maxW, s.width);
      var b = s.target && s.side ? place.beside(s.side, s.target, size, design, u) : place.at(s.points[0], size, design, u);
      s.rects = [{ x: tenth(b.x), y: tenth(b.y), w: size.w, h: size.h }];
      s.rev = (s.rev || 0) + 1;
    }
    // d: the press that asked for it, { start, last, free } — where it
    // began and ended, and whether Alt was held, which points at nothing.
    function startCallout(d) {
      var design = surface.design(), u = surface.unit(), band = ink.band(d.start, d.last);
      var click = band.w < 4 * u && band.h < 4 * u, target = null;
      if (click && !d.free) {
        var probe = { x: d.last[0] - u, y: d.last[1] - u, w: 2 * u, h: 2 * u }, res = null;
        try { res = snap.snapRect(probe, spec.targets.candidates(), spec.targets.options({ pad: 4 * u })); } catch (err) {}
        if (res && res.snapped) target = tenthBox(res.rect);
      }
      var s = { id: spec.nextId(), slide: kit.position(), tool: "callout", color: spec.colour(), size: 3 * u,
        font: place.FONT * u, text: "", points: [[band.x, band.y]] };
      if (target) {
        var others = book.strokes(kit.position())
          .filter(function (x) { return x.tool === "callout" && x.rects; })
          .map(function (x) { return x.rects[0]; });
        var side = place.sideFor(target, design, u, spec.targets.candidates(), others);
        s.target = target;
        s.side = side.side;
        s.maxW = side.maxW;
      } else if (click) {
        // Near the right edge it opens to the left of the click instead.
        s.maxW = place.width(design);
      } else {
        s.maxW = place.draggedWidth(band, design, u);
      }
      openEditor(book.add(s), false);
    }
    function editCallout(s) {
      if (writing && writing.s === s) return;
      finishCallout();
      openEditor(s, true);
    }
    function openEditor(s, sent) {
      s.live = true;
      s.editing = true;
      writing = { s: s, begun: sent };
      placeCallout(s);
      book.paint(s.slide);
      calloutText(editor, s.font);
      editor.style.background = "transparent";
      editor.style.caretColor = s.color;
      editor.style.outline = "none";
      editor.style.cursor = "text";
      editor.textContent = s.text;
      editorBox.hidden = false;
      placeEditor();
      showHandle(s);
      editor.focus();
      var sel = window.getSelection(), r = document.createRange();
      r.selectNodeContents(editor);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
      spec.changed();
    }
    function placeEditor() {
      if (!writing) return;
      var sf = surface.measure(), b = writing.s.rects && writing.s.rects[0];
      if (!sf || !b) return;
      editorBox.style.left = (sf.r.left + b.x * sf.kx) + "px";
      editorBox.style.top = (sf.r.top + b.y * sf.ky) + "px";
      editorBox.style.transform = "scale(" + sf.kx + ")";
      editor.style.width = b.w + "px";
      editor.style.height = b.h + "px";
    }
    function closeEditor() {
      if (writing) { writing.s.editing = false; writing.s.live = false; }
      writing = null;
      editorBox.hidden = true;
      if (document.activeElement === editor) editor.blur();
      editor.textContent = "";
    }
    // What is typed, as plain text, whatever the editor made of it.
    function typed() {
      return String(editor.innerText || "").replace(/\r\n?/g, "\n").replace(/\u200b/g, "");
    }
    editor.addEventListener("input", function () {
      if (!writing) return;
      var s = writing.s;
      s.text = typed().slice(0, 2000);
      placeCallout(s);
      book.paint(s.slide);
      placeEditor();
      queueCallout(s);
    });
    // Every key typed here is the text's: none reaches the deck, whose
    // themes read Space and the arrows without asking where the focus is.
    editor.addEventListener("keydown", function (e) {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); finishCallout(); }
      else if (e.key === "Tab") e.preventDefault();
    });
    ["keyup", "keypress"].forEach(function (type) { editor.addEventListener(type, function (e) { e.stopPropagation(); }); });
    // A callout as it is typed or resized reaches the audience at most every
    // CALLOUT_MS: the first change starts the wait, the rest ride along.
    var sendTimer = null, sendFor = null;
    function queueCallout(s) {
      if (sendFor && sendFor !== s) flushCallout();
      sendFor = s;
      if (!sendTimer) sendTimer = setTimeout(flushCallout, CALLOUT_MS);
    }
    function dropQueued() {
      clearTimeout(sendTimer);
      sendTimer = null;
      sendFor = null;
    }
    function flushCallout() {
      var s = sendFor;
      dropQueued();
      if (!s || !book.get(s.id)) return;
      if (writing && writing.s === s && !writing.begun) {
        // One with no text yet is not shown, and starts once it has some.
        if (!s.text.trim()) return;
        writing.begun = true;
        send({ op: "begin", stroke: book.wire(s) });
        return;
      }
      send({ op: "replace", stroke: book.wire(s) });
    }
    function finishCallout() {
      var w = writing;
      if (!w) return;
      var s = w.s;
      if (sendFor === s) dropQueued();
      closeEditor();
      hideHandle();
      s.text = s.text.replace(/\s+$/, "");
      if (!s.text) {
        book.remove([s.id]);
        if (w.begun) send({ op: "remove", slide: s.slide, ids: [s.id] });
      } else {
        placeCallout(s);
        book.paint(s.slide);
        if (!w.begun) send({ op: "begin", stroke: book.wire(s) });
        else send({ op: "replace", stroke: book.wire(s) });
        send({ op: "end", id: s.id });
      }
      spec.changed();
    }
    // A press anywhere but the editor finishes the callout; one on the slide
    // does nothing more, so that clicking away does not start another.
    document.addEventListener("pointerdown", function (e) {
      if (!writing || editorBox.contains(e.target) || e.target === handle) return;
      finishCallout();
      if (face.contains(e.target)) {
        pressFinished = Date.now();
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
    return {
      overlays: [editorBox, handle],
      at: calloutAt, start: startCallout, edit: editCallout, finish: finishCallout,
      hideHandle: hideHandle,
      // The callout tool's pointer is over this point, or has left the slide.
      hover: function (p) {
        var over = calloutAt(p);
        if (over) showHandle(over); else hideHandle();
      },
      leave: function (to) { if (to !== handle) hideHandle(); },
      place: function () { placeEditor(); placeHandle(); },
      newSlide: function () { sizing = null; hideHandle(); },
      // Everything here goes, and nothing is sent.
      discard: function () {
        closeEditor();
        dropQueued();
        sizing = null;
        hideHandle();
      },
      busy: function () { return !!(writing || sizing); },
      // A press on the slide a moment ago did no more than finish one.
      justFinished: function () { return Date.now() - pressFinished < 700; }
    };
  }

  // ---- The pointer -----------------------------------------------------------------
  //
  // Presses on the slide while a tool is in hand: a stroke, drawn as it
  // goes and sent a frame's worth of points at a time; the eraser; the
  // laser; and the press that asks for a callout.
  //
  // A highlight that obviously ran along a line or lines of text becomes
  // the boxes of the words it covered; one that did not stays as drawn. A
  // rectangle snaps to what it was drawn round — a word, a cell, a table
  // column, a paragraph — or, over nothing, stays as drawn; a click with it
  // boxes what is under the pointer, and a click on nothing leaves nothing.
  // Either way the other window is sent the stroke's final shape.
  //
  //   spec  { book, surface, targets, face, send(msg), sendLaser(msg),
  //           tool(), colours, callouts, nextId(), changed() }
  function inkPointer(spec) {
    var book = spec.book, surface = spec.surface, face = spec.face, callouts = spec.callouts;
    var send = spec.send, sendLaser = spec.sendLaser;
    var live = null, erasing = null, draft = null;
    var laserHeld = null, laserOut = null, laserShown = false, flushing = false;

    // Every sample the pointer took since the last event, not only the
    // last of them, so a quick curve stays a curve.
    function samples(e) {
      var list = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
      return list && list.length ? list : [e];
    }
    // A sample where the last one was adds nothing to the line.
    function push(points, p) {
      var q = points[points.length - 1];
      if (!q || q[0] !== p[0] || q[1] !== p[1]) points.push(p);
    }

    function queueFlush() {
      if (flushing) return;
      flushing = true;
      soon(function () { flushing = false; flush(); });
    }
    // Once a frame: the stroke being drawn is redrawn, and its new points
    // and the laser's go to the audience.
    function flush() {
      if (live) {
        var s = live.s;
        if (live.dirty) { live.dirty = false; book.paint(s.slide); }
        if (!live.begun) { live.begun = true; send({ op: "begin", stroke: book.wire(s) }); }
        else if (s.points.length > live.sent) send({ op: "add", id: s.id, points: s.points.slice(live.sent) });
        live.sent = s.points.length;
      }
      if (laserOut) {
        sendLaser({ slide: laserOut.slide, points: laserOut.points });
        laserOut = null;
      }
    }
    function beginStroke(e, sf) {
      var tool = spec.tool();
      var s = book.add({
        id: spec.nextId(), slide: kit.position(), tool: tool, color: tool === "highlighter" ? spec.colours.highlight() : spec.colours.pen(),
        size: (tool === "highlighter" ? 24 : tool === "rect" ? 4 : 5) * surface.unit(),
        points: [surface.point(e, sf, tool === "pen")]
      });
      s.live = true;
      // free: Alt (Option) was held at some point, and it is not snapped.
      live = { s: s, pointer: e.pointerId, sent: 0, begun: false, dirty: true, free: !!e.altKey };
      book.paint(s.slide);
      spec.changed();
      queueFlush();
    }
    // how.snap: it ended with the pointer let go on the slide, so it may be
    // snapped. Ended any other way — a move to another slide, another tool —
    // it is kept as drawn.
    function endStroke(how) {
      if (!live) return;
      var s = live.s, snapping = !!(how && how.snap) && !live.free;
      live.dirty = true;
      flush();
      s.live = false;
      live = null;
      send({ op: "end", id: s.id });
      finish(s, snapping);
      spec.changed();
    }
    // The final shape of a stroke that has ended.
    function finish(s, snapping) {
      var u = surface.unit(), res = null;
      if (s.tool === "highlighter") {
        if (!snapping) return;
        try { res = snap.snapHighlight(s.points, spec.targets.candidates(), spec.targets.options({ width: s.size })); } catch (err) {}
        if (!res || !res.snapped || !res.rects.length) return;
        book.replace({ id: s.id, points: [], rects: res.rects.map(tenthBox) }, true);
      } else if (s.tool === "rect") {
        var first = s.points[0], last = s.points[s.points.length - 1];
        var band = first ? ink.band(first, last) : { x: 0, y: 0, w: 0, h: 0 };
        var click = band.w < 4 * u && band.h < 4 * u;
        if (snapping) {
          var probe = click ? { x: band.x + band.w / 2 - u, y: band.y + band.h / 2 - u, w: 2 * u, h: 2 * u } : band;
          try { res = snap.snapRect(probe, spec.targets.candidates(), spec.targets.options({ pad: 6 * u })); } catch (err) {}
        }
        var rect = res && res.snapped ? res.rect : click ? null : band;
        if (!rect) {
          book.remove([s.id]);
          send({ op: "remove", slide: s.slide, ids: [s.id] });
          return;
        }
        book.replace({ id: s.id, points: [first, last], rects: [tenthBox(rect)] }, true);
      } else {
        return;
      }
      send({ op: "replace", stroke: book.wire(s) });
    }

    function aimLaser(e, sf) {
      var label = kit.position();
      if (!laserOut || laserOut.slide !== label) laserOut = { slide: label, points: [] };
      var pts = samples(e).map(function (ev) { return surface.point(ev, sf, false); });
      pts.forEach(function (p) { laserOut.points.push(p); });
      book.laserTo(label, pts);
      laserShown = true;
      queueFlush();
    }
    function stopLaser() {
      laserHeld = null;
      laserOut = null;
      if (!laserShown) return;
      laserShown = false;
      book.laserOff();
      sendLaser({ off: true });
    }
    function eraseAlong(a, b, sf) {
      var label = kit.position();
      var ids = book.hit(label, a, b, ERASER_PX / sf.kx);
      if (!ids.length) return;
      book.remove(ids);
      send({ op: "remove", slide: label, ids: ids });
      spec.changed();
    }

    function dropDraft() {
      if (!draft) return;
      draft = null;
      book.guide(null);
    }

    face.addEventListener("pointerdown", function (e) {
      var tool = spec.tool();
      if (!tool || live || erasing || (e.pointerType === "mouse" && e.button !== 0)) return;
      var sf = surface.measure();
      if (!sf) return;
      // No text selection, no picture drag, and the focus stays put.
      e.preventDefault();
      try { face.setPointerCapture(e.pointerId); } catch (err) {}
      if (tool === "laser") { laserHeld = e.pointerId; aimLaser(e, sf); return; }
      if (tool === "eraser") {
        var at = surface.point(e, sf, false);
        erasing = { pointer: e.pointerId, last: at };
        book.ring(kit.position(), at, ERASER_PX / sf.kx);
        eraseAlong(at, at, sf);
        return;
      }
      if (tool === "callout") {
        var p = surface.point(e, sf, false), c = callouts.at(p);
        if (c) { callouts.edit(c); return; }
        draft = { pointer: e.pointerId, start: p, last: p, free: !!e.altKey };
        return;
      }
      beginStroke(e, sf);
    });
    face.addEventListener("pointermove", function (e) {
      var tool = spec.tool();
      if (!tool) return;
      var sf = surface.measure();
      if (!sf) return;
      if (tool === "laser") {
        // A mouse points without a button held; a pen or a finger only
        // while it is down.
        if (e.pointerType === "mouse" || laserHeld === e.pointerId) aimLaser(e, sf);
        return;
      }
      var list = samples(e), i, at;
      if (tool === "callout") {
        if (!draft) {
          callouts.hover(surface.point(e, sf, false));
          return;
        }
        if (e.pointerId !== draft.pointer) return;
        draft.last = surface.point(e, sf, false);
        if (e.altKey) draft.free = true;
        var gb = ink.band(draft.start, draft.last);
        book.guide(kit.position(), gb.w > 0 || gb.h > 0 ? gb : null, spec.colours.pen(), 2 * surface.unit());
        return;
      }
      if (tool === "eraser") {
        for (i = 0; i < list.length; i++) {
          at = surface.point(list[i], sf, false);
          if (erasing && e.pointerId === erasing.pointer) { eraseAlong(erasing.last, at, sf); erasing.last = at; }
        }
        book.ring(kit.position(), at, ERASER_PX / sf.kx);
        return;
      }
      if (!live || e.pointerId !== live.pointer) return;
      if (e.altKey) live.free = true;
      // A rectangle needs only where the pointer is now.
      if (live.s.tool === "rect") push(live.s.points, surface.point(list[list.length - 1], sf, false));
      else for (i = 0; i < list.length; i++) push(live.s.points, surface.point(list[i], sf, live.s.tool === "pen"));
      live.dirty = true;
      queueFlush();
    });
    function release(e) {
      if (live && e.pointerId === live.pointer) {
        var sf = surface.measure();
        if (e.altKey) live.free = true;
        if (sf && e.type === "pointerup") push(live.s.points, surface.point(e, sf, live.s.tool === "pen"));
        endStroke({ snap: e.type === "pointerup" });
      }
      if (erasing && e.pointerId === erasing.pointer) erasing = null;
      if (draft && e.pointerId === draft.pointer) {
        var dsf = surface.measure();
        if (dsf && e.type === "pointerup") {
          draft.last = surface.point(e, dsf, false);
          if (e.altKey) draft.free = true;
          var d = draft;
          dropDraft();
          callouts.start(d);
        } else {
          dropDraft();
        }
      }
      if (laserHeld === e.pointerId) {
        laserHeld = null;
        if (e.pointerType !== "mouse") stopLaser();
      }
    }
    // A double-click on a callout, with no tool or the callout tool, opens
    // it to be typed into again.
    face.addEventListener("dblclick", function (e) {
      var tool = spec.tool();
      if (tool && tool !== "callout") return;
      var sf = surface.measure();
      var c = sf && callouts.at(surface.point(e, sf, false));
      if (!c) return;
      e.preventDefault();
      callouts.edit(c);
    });
    face.addEventListener("pointerup", release);
    face.addEventListener("pointercancel", release);
    face.addEventListener("lostpointercapture", release);
    face.addEventListener("pointerleave", function (e) {
      callouts.leave(e.relatedTarget);
      // While a press is captured, the pointer is still this slide's.
      if (live || erasing || laserHeld != null) return;
      book.ring(null);
      stopLaser();
    });
    return {
      flush: flush, endStroke: endStroke,
      // A stroke under way is forgotten where it is, and nothing is sent.
      abandon: function () { if (live) { live.s.live = false; live = null; } },
      // Whatever else the pointer was doing stops.
      drop: function () {
        dropDraft();
        erasing = null;
        stopLaser();
        book.ring(null);
      },
      drawing: function () { return !!live; },
      busy: function () { return !!(live || erasing || draft); }
    };
  }

  // ---- The drawing tools, in either window -------------------------------------
  //
  // What the window supplies:
  //   book       the inkBook the strokes are kept in
  //   prefix     the first letter of this window's stroke names
  //   slideEl()  the element that is the current slide
  //   face       the element presses on the slide arrive at
  //   send(msg), sendLaser(msg)   to the other window, as it sees fit
  //   onSync(tool)   told whenever the tools change
  //   listenKeys     listen for the tools' keys itself, or leave it to the
  //                  window, which calls key(e)
  //   escapeDrops    Escape puts the chosen tool down
  //   pointerLabel   what the no-tool button says a click on the slide does
  // The window places the palette and the overlays.
  function inkTools(host) {
    var book = host.book, send = host.send;
    var tool = null, strokeNo = 0;
    // Each window names its own strokes, and a reloaded window does not
    // reuse the names of the strokes it drew before.
    var idBase = host.prefix + Math.random().toString(36).slice(2, 6) + "-";
    function nextId() { return idBase + (++strokeNo); }
    function own(s) { return String(s.id).charAt(0) === host.prefix; }

    var surface = inkSurface(host.slideEl);
    var targets = slideTargets(surface);
    var palette = inkPalette(host.pointerLabel || "No drawing tool", {
      tool: choose, pen: pickPen, undo: undo, clear: clearSlide, clearAll: clearAll,
      colours: function (kind, i) { colours.open(kind, i); }
    }, function () { return book.count() > 0; });
    var colours = inkColours(palette, host.face, book.isColour, {
      pen: pickPen,
      highlight: function () { if (tool !== "highlighter") choose("highlighter"); else sync(); }
    });
    var callouts = calloutEditor({
      book: book, surface: surface, targets: targets, face: host.face, send: send,
      nextId: nextId, colour: colours.pen, changed: sync
    });
    var pointer = inkPointer({
      book: book, surface: surface, targets: targets, face: host.face, send: send, sendLaser: host.sendLaser,
      tool: function () { return tool; }, colours: colours, callouts: callouts, nextId: nextId, changed: sync
    });

    function sync() {
      var here = kit.position();
      palette.show({
        tool: tool, pen: colours.current(), penColour: colours.pen(), highlight: colours.highlight(),
        canUndo: book.strokes(here).some(own), here: book.count(here) > 0, any: book.count() > 0
      });
      if (host.onSync) host.onSync(tool);
      if (tool !== "callout") callouts.hideHandle();
    }
    // Whatever is under way stops: a stroke is finished where it is.
    function settle() {
      pointer.endStroke();
      callouts.finish();
      pointer.drop();
    }
    function choose(t) {
      settle();
      tool = t || null;
      sync();
    }
    function pickPen(i) {
      colours.pick(i);
      if (tool !== "pen") choose("pen");
      else sync();
    }
    // This window's last stroke on the slide: what the other window drew
    // is the other window's to undo.
    function undo() {
      if (pointer.drawing()) return;
      var mine = book.strokes(kit.position()).filter(own), s = mine[mine.length - 1];
      if (!s) return;
      book.remove([s.id]);
      send({ op: "remove", slide: s.slide, ids: [s.id] });
      sync();
    }
    function clearSlide() {
      pointer.endStroke();
      var label = kit.position();
      if (!book.count(label)) return;
      book.clear(label);
      send({ op: "clear", slide: label });
      sync();
    }
    function clearAll() {
      pointer.endStroke();
      book.clear();
      send({ op: "clear" });
      sync();
    }
    // Everything here goes, and nothing is sent: in the presenter window
    // before Start, what was drawn while rehearsing never reached anyone.
    function discard() {
      pointer.abandon();
      callouts.discard();
      pointer.drop();
      book.clear();
      palette.disarm();
      sync();
    }
    window.addEventListener("blur", settle);

    // The tools' keys. True when the key was one of them.
    function onKey(e) {
      if (kit.editable(e.target)) return false;
      if (window.sdocOverview && window.sdocOverview.isOpen()) return false;
      var k = (e.key || "").toLowerCase();
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && k === "z") {
        e.preventDefault();
        undo();
        return true;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return false;
      if (Object.prototype.hasOwnProperty.call(TOOL_KEYS, k)) {
        e.preventDefault();
        // The chosen tool's key again puts it down.
        if (!e.repeat) choose(tool === TOOL_KEYS[k] ? null : TOOL_KEYS[k]);
      } else if (k === "c") {
        e.preventDefault();
        // The colour only: whatever tool is in hand, or none, stays so.
        if (!e.repeat) { colours.pick((colours.current() + 1) % colours.count); sync(); }
      } else if (k === "u") {
        e.preventDefault();
        undo();
      } else if (k === "escape" && host.escapeDrops && tool) {
        e.preventDefault();
        choose(null);
      } else {
        return false;
      }
      return true;
    }
    if (host.listenKeys) document.addEventListener("keydown", onKey);

    // Whether a click on the slide is free for the window's own use — the
    // presenter's to enlarge it: not while a tool is chosen, when a press
    // there draws, nor on a callout, which a double-click opens for
    // editing, nor straight after a press that only finished one.
    function clickToggles(e) {
      if (tool || callouts.justFinished()) return false;
      var sf = e && surface.measure();
      return !(sf && callouts.at(surface.point(e, sf, false)));
    }

    return {
      book: book, palette: palette.el, overlays: [colours.el].concat(callouts.overlays),
      key: onKey, tool: function () { return tool; },
      settle: settle, discard: discard, sync: sync, clickToggles: clickToggles,
      setDesign: surface.setDesign,
      // A slide's copy was made again, or moved: measure afresh.
      invalidate: targets.invalidate,
      newSlide: function () { targets.invalidate(); callouts.newSlide(); },
      place: function () { callouts.place(); colours.place(); },
      flush: pointer.flush,
      // Something under way: a stroke, a callout being typed, its colours open.
      busy: function () { return pointer.busy() || callouts.busy() || colours.isOpen(); }
    };
  }

  return { inkBook: inkBook, inkTools: inkTools, el: el, keepFocus: keepFocus, icon: icon, twoClicks: twoClicks };
}

// For the deck, after the kit and the four pure modules: evaluating this
// defines window.sdocAnnotate.
const ANNOTATE_JS = "window.sdocAnnotate = (" + createAnnotate.toString() +
  ")(window.sdocDeckKit, window.sdocInk, window.sdocSnap, window.sdocCallout, window.sdocStrokes);";

module.exports = { createAnnotate, ANNOTATE_JS };
