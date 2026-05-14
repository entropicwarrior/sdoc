// SDOC Slides — Default Theme Runtime
// Keyboard navigation, click navigation, touch swipe, URL hash, nav indicators.
//
// Slides form a 2D grid: a horizontal spine of top-level slides, with optional
// vertical "detail" columns under any spine slide. Each .slide element carries
// data-spine (1-based) and data-detail (0 = spine, 1..N = nth detail). Decks
// without :detail children behave exactly like a 1D deck.

(function () {
  var slides = Array.prototype.slice.call(document.querySelectorAll(".slide"));
  if (slides.length === 0) return;

  // Build a 2D grid: columns[s-1] = [spineSlide, detail1, detail2, ...]
  var columns = [];
  slides.forEach(function (el) {
    var s = parseInt(el.getAttribute("data-spine") || "0", 10);
    var d = parseInt(el.getAttribute("data-detail") || "0", 10);
    if (!s) return; // slides without position info (shouldn't happen) — skip
    if (!columns[s - 1]) columns[s - 1] = [];
    columns[s - 1][d] = el;
  });
  // Fallback: if no data-spine attributes are present (custom themes / older
  // renderers), treat every slide as its own spine column.
  if (columns.length === 0) {
    slides.forEach(function (el, i) { columns[i] = [el]; });
  }

  var spineCount = columns.length;
  var cur = { s: 0, d: 0 }; // 0-based indices

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(n, hi)); }

  function activeEl() {
    var col = columns[cur.s];
    if (!col) return null;
    return col[cur.d] || col[0];
  }

  function show(s, d) {
    // Hide currently active slide
    var prevEl = activeEl();
    if (prevEl) prevEl.classList.remove("active");

    cur.s = clamp(s, 0, spineCount - 1);
    var col = columns[cur.s] || [];
    // Detail count for this spine = col.length - 1 (index 0 is the spine itself)
    var maxDetail = Math.max(0, col.length - 1);
    cur.d = clamp(d, 0, maxDetail);

    var el = activeEl();
    if (el) el.classList.add("active");

    // Update nav indicator visibility per slide. In the flat slide order,
    // a slide is "first" if it is the very first emitted slide, and "last"
    // if it is the very last; in between, every slide has a next/prev in
    // the flat sequence. We mirror the prior 1D behaviour: show chevrons
    // when there is something to move to in the *flat* sequence.
    var flatIndex = 0;
    var totalFlat = slides.length;
    for (var si = 0; si < cur.s; si++) {
      flatIndex += (columns[si] || [{}]).length;
    }
    flatIndex += cur.d;

    slides.forEach(function (slide) {
      var prev = slide.querySelector(".nav-prev");
      var next = slide.querySelector(".nav-next");
      if (prev) prev.style.visibility = flatIndex > 0 ? "visible" : "hidden";
      if (next) next.style.visibility = flatIndex < totalFlat - 1 ? "visible" : "hidden";
    });

    // URL hash: "N" for spine, "N.K" for detail K of spine N (1-based)
    var hashVal = (cur.s + 1) + (cur.d > 0 ? "." + cur.d : "");
    history.replaceState(null, "", "#" + hashVal);
  }

  // Move horizontally one step. On a detail, advance through remaining details
  // in the column, then return to the parent spine and advance to next spine.
  function nextStep() {
    var col = columns[cur.s] || [];
    if (cur.d > 0 && cur.d < col.length - 1) {
      show(cur.s, cur.d + 1);
      return;
    }
    if (cur.s < spineCount - 1) {
      show(cur.s + 1, 0);
    }
  }

  function prevStep() {
    if (cur.d > 0) {
      show(cur.s, cur.d - 1);
      return;
    }
    if (cur.s > 0) {
      show(cur.s - 1, 0);
    }
  }

  function downStep() {
    var col = columns[cur.s] || [];
    if (cur.d < col.length - 1) {
      show(cur.s, cur.d + 1);
    }
  }

  function upStep() {
    if (cur.d > 0) {
      show(cur.s, 0);
    }
  }

  document.addEventListener("keydown", function (e) {
    if (e.key === "ArrowRight" || e.key === " ") {
      e.preventDefault();
      nextStep();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      prevStep();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      downStep();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      upStep();
    } else if (e.key === "Home") {
      e.preventDefault();
      show(0, 0);
    } else if (e.key === "End") {
      e.preventDefault();
      show(spineCount - 1, 0);
    }
  });

  // Click navigation — right half forward, left half back (spine only)
  document.addEventListener("click", function (e) {
    if (e.target.closest("a, button, input, textarea, select")) return;
    if (e.clientX > window.innerWidth / 2) {
      nextStep();
    } else {
      prevStep();
    }
  });

  // Touch swipe — horizontal for spine/next-step, vertical for drilldown
  var touchStartX = 0, touchStartY = 0;
  document.addEventListener("touchstart", function (e) {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  });
  document.addEventListener("touchend", function (e) {
    var dx = e.changedTouches[0].clientX - touchStartX;
    var dy = e.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dx) > Math.abs(dy)) {
      if (dx < -50) nextStep();
      else if (dx > 50) prevStep();
    } else {
      if (dy < -50) downStep();
      else if (dy > 50) upStep();
    }
  });

  // Parse "#N" or "#N.K" hash
  function parseHash(hash) {
    var m = /^#(\d+)(?:\.(\d+))?$/.exec(hash || "");
    if (!m) return null;
    return { s: parseInt(m[1], 10) - 1, d: m[2] ? parseInt(m[2], 10) : 0 };
  }

  var initial = parseHash(window.location.hash) || { s: 0, d: 0 };
  show(initial.s, initial.d);

  window.addEventListener("hashchange", function () {
    var p = parseHash(window.location.hash);
    if (p) show(p.s, p.d);
  });
})();
