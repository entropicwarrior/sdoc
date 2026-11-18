// SDOC Slides — what the deck's runtimes share.
//
// The slides as columns, where the deck is, moving it, and a miniature of any
// slide. The overview and the presenter view both draw slides small, and both
// need to know the current position and hear when it changes; one copy of
// each keeps them agreeing. Also the deck's one line of passing remarks, what
// counts as typing into a field, and whether this window is the presenter
// view — the deck with ?presenter in its address, which is how P opens it —
// with the name this deck's presenter window goes by.
//
// It couples to a theme the way every runtime does: the URL hash to navigate,
// the .active class to read.
//
// createDeckKit is serialised into the deck with toString() (DECK_KIT_JS), so
// it may not reference anything outside its own body, and nothing in it may
// spell the tag that closes a script element. It is ES5, as the page's other
// runtimes are.

function createDeckKit() {
  var slides = [].slice.call(document.querySelectorAll(".slide"));

  // columns[s] = [spine slide, detail 1, detail 2, ...], as theme.js builds them.
  var columns = [];
  slides.forEach(function (el) {
    var s = parseInt(el.getAttribute("data-spine") || "0", 10);
    var d = parseInt(el.getAttribute("data-detail") || "0", 10);
    if (!s) return;
    if (!columns[s - 1]) columns[s - 1] = [];
    columns[s - 1][d] = el;
  });
  if (!columns.length) slides.forEach(function (el, i) { columns[i] = [el]; });

  // The originals, never a clone: a clone carries .active too, so a query of
  // the whole document would find whichever came first.
  function activeSlide() {
    for (var i = 0; i < slides.length; i++) if (slides[i].classList.contains("active")) return slides[i];
    return null;
  }
  function where(slide) {
    for (var s = 0; s < columns.length; s++) {
      var col = columns[s] || [];
      for (var d = 0; d < col.length; d++) if (col[d] === slide) return { s: s, d: d };
    }
    return { s: 0, d: 0 };
  }
  // A position as the hash writes it: "7" for a spine slide, "7.2" for its
  // second detail.
  function label(at) { return (at.s + 1) + (at.d ? "." + at.d : ""); }
  function position() { return label(where(activeSlide())); }
  function at(s, d) { var col = columns[s]; return col ? col[d] || null : null; }
  // Every theme navigates on the hash; it is the one interface they share.
  function go(pos) { if (pos) window.location.hash = String(pos); }

  // The design box, from a laid-out slide: a custom property is not resolved
  // to px, and offsetWidth ignores the fit-to-window transform.
  function designBox() {
    var el = activeSlide();
    if (el && el.offsetWidth > 0 && el.offsetHeight > 0) return { w: el.offsetWidth, h: el.offsetHeight };
    var cs = getComputedStyle(document.documentElement);
    var w = parseFloat(cs.getPropertyValue("--sdoc-slide-w"));
    var h = parseFloat(cs.getPropertyValue("--sdoc-slide-h"));
    return { w: w > 0 ? w : 1280, h: h > 0 ? h : 720 };
  }

  function textOf(slide, sel) {
    var el = slide.querySelector(sel);
    return el ? el.textContent.replace(/\s+/g, " ").trim() : "";
  }

  // A miniature is the slide's own markup, made inert and scaled. It keeps
  // .active, because that is the class every theme uses to show a slide, and
  // whatever the theme does to the slide on screen is what the miniature
  // should look like.
  //
  // A copy also inherits from wherever it is put — a presenter frame, an
  // overview cell, with their own font, colour and centring — where the
  // slide itself inherits from the deck's body, and a theme may well set its
  // type there rather than on .slide. So the box takes back what the slide
  // would have inherited: read once off the slide's parent, which does not
  // change. Not the cursor or visibility, which are the chrome's to set.
  var INHERITED = ["font-family", "font-size", "font-weight", "font-style", "font-variant",
    "font-variant-caps", "font-variant-ligatures", "font-variant-numeric", "font-variant-east-asian",
    "font-stretch", "font-kerning", "font-feature-settings", "font-variation-settings", "font-size-adjust",
    "line-height", "letter-spacing", "word-spacing", "text-align", "text-transform", "text-indent",
    "text-shadow", "text-rendering", "color", "direction", "white-space", "hyphens", "word-break",
    "overflow-wrap", "-webkit-font-smoothing"];
  var inherited = null;
  function inheritedFrom(slide) {
    if (inherited) return inherited;
    var parent = slide.parentElement || document.body;
    var cs = getComputedStyle(parent);
    inherited = [];
    INHERITED.forEach(function (p) {
      var v = cs.getPropertyValue(p);
      if (v) inherited.push([p, v]);
    });
    // A unitless line-height is inherited as the number and multiplied by
    // each element's own size, but read back as pixels, which copied would
    // set every line in the slide to the body's. A probe at twice the size
    // tells them apart: its line doubles only if the height is a number.
    var lh = parseFloat(cs.lineHeight), size = parseFloat(cs.fontSize);
    if (lh > 0 && size > 0) {
      var probe = document.createElement("span");
      probe.style.cssText = "position:absolute;visibility:hidden;display:block;font-size:200%;";
      parent.appendChild(probe);
      var twice = parseFloat(getComputedStyle(probe).lineHeight);
      parent.removeChild(probe);
      if (Math.abs(twice - 2 * lh) < 0.5 && Math.abs(twice - lh) > 0.5) {
        inherited.forEach(function (pv) { if (pv[0] === "line-height") pv[1] = String(Math.round(lh / size * 1000) / 1000); });
      }
    }
    return inherited;
  }
  function miniature(slide) {
    var box = document.createElement("div");
    box.className = "sdoc-overview-mini";
    inheritedFrom(slide).forEach(function (pv) { box.style.setProperty(pv[0], pv[1]); });
    var c = slide.cloneNode(true);
    c.classList.add("active");
    c.setAttribute("aria-hidden", "true");
    c.setAttribute("inert", "");
    box.appendChild(c);
    return box;
  }
  function sizeMiniature(box, w, h, designW) {
    box.style.width = w + "px";
    box.style.height = h + "px";
    box.style.setProperty("--sdoc-overview-k", String(w / designW));
  }
  // Once it is in the page and measurable. A connector is drawn by the
  // runtime against laid-out boxes, and a slide nobody has visited yet has
  // never been drawn, so its clone is drawn here. Handed over whole: the
  // connector runtime decides what in it is a connector, and it is only on
  // the page when the deck has one. A later redraw of the whole document
  // reaches the clones too, which is harmless — positions are in design
  // pixels, the same at any scale.
  function settleMiniature(box) {
    if (window.sdocConnectors && box.firstChild) {
      try { window.sdocConnectors.resolve(box.firstChild); } catch (err) {}
    }
  }

  // Told when the position changes. A theme navigates with replaceState,
  // which fires no event, so the active class is what there is to watch.
  var watchers = [], last = null, observer = null;
  function onMove(fn) {
    watchers.push(fn);
    if (observer) return;
    last = position();
    observer = new MutationObserver(function () {
      var p = position();
      if (p === last) return;
      last = p;
      for (var i = 0; i < watchers.length; i++) watchers[i](p);
    });
    slides.forEach(function (s) { observer.observe(s, { attributes: true, attributeFilter: ["class"] }); });
  }

  // A key typed into a field is text, not a command to the deck.
  function editable(t) {
    return !!(t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName || "")));
  }

  // The presenter window's name, from this deck's path: two decks open at
  // once each get a window of their own, and a deck that reloads finds the
  // one it opened.
  function presenterName() {
    var path = window.location.pathname, h = 5381;
    for (var i = 0; i < path.length; i++) h = ((h * 33) ^ path.charCodeAt(i)) >>> 0;
    return "sdoc-presenter-" + h.toString(36);
  }

  // The deck's one line of passing remarks, shared by every runtime.
  // ms: how long it stays; a moment longer than it takes to read by default.
  var hint = null, hintTimer = null;
  function say(text, ms) {
    if (!hint) {
      hint = document.createElement("div");
      hint.className = "sdoc-deck-hint";
      document.body.appendChild(hint);
    }
    hint.textContent = text;
    hint.classList.add("is-shown");
    clearTimeout(hintTimer);
    hintTimer = setTimeout(function () { hint.classList.remove("is-shown"); }, ms > 0 ? ms : 2400);
  }

  return {
    slides: slides, columns: columns,
    activeSlide: activeSlide, where: where, label: label, position: position, at: at, go: go,
    designBox: designBox, textOf: textOf,
    miniature: miniature, sizeMiniature: sizeMiniature, settleMiniature: settleMiniature,
    onMove: onMove, say: say, editable: editable,
    presenter: /[?&]presenter(=|&|$)/.test(window.location.search),
    presenterName: presenterName()
  };
}

// For the deck, before every runtime that uses it: evaluating this defines
// window.sdocDeckKit.
const DECK_KIT_JS = "window.sdocDeckKit = (" + createDeckKit.toString() + ")();";

module.exports = { createDeckKit, DECK_KIT_JS };
