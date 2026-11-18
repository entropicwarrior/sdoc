// SDOC Slides — the presenter view, on P: a second window with the current slide, the ones
// either side and the drill-down below, the notes in large type, and a timer.
//
// It is the same deck file opened again, so every slide, the theme, the fonts
// and the notes are already in it; the window only lays them out differently.
// The two windows tell each other where they are with postMessage through the
// reference window.open gives — a BroadcastChannel does not reach between two
// file:// windows, and a deck is mostly opened from disk.
//
// Before Start the presenter window is private: flicking through slides while
// people arrive does not move the projector, and the bar says which slide the
// audience is on. Start puts the presenter back on that slide, starts the
// timer, and from then on either window moves both.
//
// Either window can draw on its current slide — pen, highlighter,
// rectangle, callout, laser — with the same tools: the presenter window in
// a column down its left, the deck's own window in a palette that comes up
// over its left edge when a tool's key is pressed. What the deck window
// draws the audience sees at once; what the presenter window draws, from
// Start. Each window sends the other what it draws, as it draws it. The
// messages, all in the "sdoc-presenter" namespace:
//
//   presenter -> deck  hello                         every 2s
//                      go { position }
//                      ink-sync                      at Start
//   either way         ink { op, ... }      op begin { stroke } | add { id,
//                        points } | end { id } | replace { stroke } |
//                        remove { slide, ids } | clear { slide? } |
//                        slide { slide, strokes }
//                      laser { slide, points } | laser { off: true }
//   deck -> presenter  position { position, deck }   answering a hello, and
//                                                    whenever the deck moves
//
// A stroke is named by the window that drew it — p or d, then a token of
// that window's load, then a count — so the names never meet, and Undo in
// a window takes that window's own last stroke. Clear and Clear all clear
// both windows.
//
// A stroke is drawn as it goes and then, once it ends, may be given its
// final shape by a replace: a highlight snapped to the words it ran along,
// or a rectangle snapped to what it was drawn round, as rects (see
// src/slide-strokes.js, which also applies the ink messages).
// A callout begins once it has text and is replaced as it is typed, at most
// every 150 ms, and ends when it is finished.
//
// The presenter window takes the deck's ink only from Start: before it, it
// is private both ways. At Start it throws its rehearsal away and asks for
// the deck's (ink-sync), which comes back as a clear and one slide message
// per slide with ink. From then on it holds a copy of everything.
//
// deck is a token the deck makes afresh each time its page loads. When the
// presenter window sees it change, the deck has reloaded and its slides are
// bare, whoever drew on them: after Start the presenter then sends everything
// it holds, the deck's own strokes with its own, as a clear and one slide
// message per slide with ink. Before Start it sends nothing — it holds none
// of the deck's ink and its own is a rehearsal — so ink drawn in the deck
// window before Start does not survive a reload of that window. A presenter
// window that reloads is not started, and takes the deck's ink at Start.
//
// Each window hears only the other. The presenter window is opened under a
// name of the deck's own (kit.presenterName), so two decks open at once have
// two; it listens to its opener and nothing else. The deck listens to the
// window it opened, and after a reload, having lost that reference, takes on
// the sender of a hello only if this window is that one's opener. A deck
// served over http also posts to, and accepts, its own origin alone; one
// opened from disk has no origin to name.
//
// createPresenter is serialised into the deck with toString() (PRESENTER_JS),
// so it reaches nothing outside its own body: the deck's kit and the drawing
// tools (src/slide-annotate.js) are handed in. The overview and the shared
// spring are looked up on window where they are used, since a deck may be
// without either. It is ES5, as the page's other runtimes are.

function createPresenter(kit, annotate) {
  if (!kit.slides.length) return;
  var NS = "sdoc-presenter";
  var el = annotate.el, keepFocus = annotate.keepFocus, icon = annotate.icon, twoClicks = annotate.twoClicks;
  var inkBook = annotate.inkBook, inkTools = annotate.inkTools;
  // A served deck sends to its own origin and hears only that. A deck opened
  // from disk has no origin that can be named, and there the window a
  // message came from is the whole check.
  var ORIGIN = /^https?:$/.test(window.location.protocol) ? window.location.origin : null;

  function post(win, msg) {
    if (!win || win.closed) return;
    msg.sdoc = NS;
    try { win.postMessage(msg, ORIGIN || "*"); } catch (err) {}
  }
  function ours(e) { return !!(e.data && e.data.sdoc === NS) && (!ORIGIN || e.origin === ORIGIN); }
  // Whether this window opened that one. A window's opener can be read
  // whatever its origin, which a deck opened from disk needs.
  function openedHere(w) {
    try { return !!w && w.opener === window; } catch (err) { return false; }
  }
  // One window's line to the other for ink and the laser: to() is the other
  // window, open() whether anything may be sent yet.
  function inkLine(to, open) {
    function sender(type) {
      return function (msg) {
        if (!open()) return;
        msg.type = type;
        post(to(), msg);
      };
    }
    return { ink: sender("ink"), laser: sender("laser") };
  }
  // Everything a window holds, for one that holds something else: a clear,
  // then each slide's ink. All but a callout still empty and unannounced,
  // which is sent, or dropped, by its own editor when that is finished.
  function sendAll(book, tools, line) {
    if (tools) tools.flush();
    var held = tools ? tools.unsent() : null;
    line.ink({ op: "clear" });
    book.labels().forEach(function (label) {
      var strokes = book.strokes(label).filter(function (s) { return s.id !== held; });
      line.ink({ op: "slide", slide: label, strokes: strokes.map(book.wire) });
    });
  }
  // The other window's ink and laser, as they arrive. True for ink.
  function take(book, m) {
    if (m.type === "ink") {
      try { book.apply(m); } catch (err) {}
      return true;
    }
    if (m.type === "laser") {
      if (m.off) book.laserOff();
      else if (m.slide != null) book.laserTo(m.slide, m.points);
    }
    return false;
  }

  // ---- The deck, as the audience sees it -----------------------------------

  function audienceWindow() {
    var win = null;
    // All the ink, the presenter's and this window's own, on this deck's
    // own slides.
    var book = inkBook(true);
    // Made afresh each time the page loads, and sent with every position:
    // a presenter window that sees it change knows this deck reloaded, and
    // has lost its ink.
    var LOAD = Math.random().toString(36).slice(2);
    function linked() { return !!(win && !win.closed); }
    function tell() { post(win, { type: "position", position: kit.position(), deck: LOAD }); }
    var line = inkLine(function () { return win; }, linked);
    var FEATURES = "popup=yes,width=1280,height=820";
    // A window just made has nothing in it yet; one whose address may not
    // be read has a document.
    function blank(w) {
      try { return w.location.href === "about:blank"; } catch (err) { return false; }
    }
    function open() {
      if (linked()) { try { win.focus(); } catch (err) {} return; }
      var url = new URL(window.location.href);
      url.searchParams.set("presenter", "1");
      url.hash = kit.position();
      // By name and with no address first: the window left from before this
      // deck reloaded is found as it is, started and its timer running,
      // where an address would load it afresh.
      var w = null;
      try { w = window.open("", kit.presenterName, FEATURES); } catch (err) {}
      if (w && blank(w)) w.location.replace(url.href);
      // Another window's of the same deck: this one gets its own.
      else if (w && !openedHere(w)) w = window.open(url.href, "_blank", FEATURES);
      else if (w) { try { w.focus(); } catch (err) {} }
      if (!w) { kit.say("The presenter window was blocked: allow pop-ups for this page"); return; }
      win = w;
    }
    document.addEventListener("keydown", function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || kit.editable(e.target)) return;
      if ((e.key || "").toLowerCase() !== "p") return;
      e.preventDefault();
      open();
    });
    window.addEventListener("message", function (e) {
      if (!ours(e)) return;
      var m = e.data;
      // Only this deck's presenter window is heard. After a reload here the
      // reference to it is gone, and its next hello restores it.
      if (!e.source || e.source !== win) {
        if (m.type !== "hello" || !openedHere(e.source)) return;
        win = e.source;
      }
      if (m.type === "hello") tell();
      else if (m.type === "go" && m.position && m.position !== kit.position()) kit.go(m.position);
      // The presenter pressed Start: it has thrown its rehearsal away and
      // takes on what is here, which is what the audience has seen.
      else if (m.type === "ink-sync") sendAll(book, tools, line);
      else if (take(book, m) && tools) tools.sync();
    });
    kit.onMove(function () {
      tell();
      if (tools) { tools.settle(); tools.newSlide(); }
    });

    // ---- Drawing here ----
    //
    // The same tools as the presenter window's, for a talk given from one
    // screen: a tool's key, or the pointer resting at the left edge, brings
    // up the palette over that edge, and putting the tool down hides it
    // again. Nothing of it is in the page until then. What is drawn here is
    // the audience's at once, and reaches a linked presenter window too.
    var tools = null, ink = null, shell = null, overShell = false, hideTimer = null, revealTimer = null;
    // Long enough at the edge that a pointer pushed aside and left there,
    // on the projector, is not asking for the palette.
    var EDGE_PX = 4, REVEAL_MS = 900, HIDE_MS = 1200;
    function ensureTools() {
      if (tools) return tools;
      ink = el("div", "sdoc-deck-ink");
      // While a tool is chosen, presses on the page are ink: this takes them
      // all, above the slide and below the tools.
      var face = el("div", "sdoc-deck-ink-face");
      ink.appendChild(face);
      tools = inkTools({
        book: book, prefix: "d", face: face, listenKeys: false, escapeDrops: true,
        pointerLabel: "No drawing tool: a click on the slide turns it (Esc)",
        slideEl: function () { return kit.activeSlide(); },
        send: line.ink, sendLaser: line.laser,
        onSync: function (t) {
          document.documentElement.classList.toggle("sdoc-inking", !!t);
          if (t) showTools(); else hideSoon();
        }
      });
      shell = el("div", "sdoc-deck-tools");
      shell.appendChild(tools.palette);
      shell.addEventListener("pointerenter", function () { overShell = true; clearTimeout(hideTimer); });
      shell.addEventListener("pointerleave", function () { overShell = false; hideSoon(); });
      ink.appendChild(shell);
      tools.overlays.forEach(function (n) { ink.appendChild(n); });
      // The theme turns the slide on any click or swipe on the page; nothing
      // here is that.
      ["click", "dblclick", "pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend"].forEach(function (type) {
        ink.addEventListener(type, function (e) { e.stopPropagation(); });
      });
      document.body.appendChild(ink);
      window.addEventListener("resize", function () { tools.invalidate(); tools.place(); });
      tools.sync();
      return tools;
    }
    function showTools() {
      ensureTools();
      clearTimeout(hideTimer);
      ink.classList.add("is-shown");
    }
    // Put away a moment after the last use, unless the pointer is on it or a
    // tool is still in hand.
    function hideSoon() {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(function () {
        if (!tools || tools.tool() || overShell || tools.busy()) return;
        ink.classList.remove("is-shown");
      }, HIDE_MS);
    }
    document.addEventListener("keydown", function (e) {
      if (kit.editable(e.target) || (window.sdocOverview && window.sdocOverview.isOpen())) return;
      var k = (e.key || "").toLowerCase();
      var undoKey = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && k === "z";
      if (!undoKey && (e.metaKey || e.ctrlKey || e.altKey)) return;
      if (!undoKey && !/^[dhrlaec]$/.test(k) && k !== "u" && k !== "escape") return;
      // Undo and Escape mean nothing until something has been drawn here.
      if (!tools && (undoKey || k === "u" || k === "escape")) return;
      ensureTools().key(e);
      // C changes the pen's colour and picks nothing up: the palette comes
      // up for a moment to show which.
      if (k === "c" && !e.repeat) { showTools(); hideSoon(); }
    });
    // The pointer resting at the left edge brings the palette up.
    document.addEventListener("pointermove", function (e) {
      if (e.pointerType === "touch" || e.buttons) return;
      if (e.clientX <= EDGE_PX && !(window.sdocOverview && window.sdocOverview.isOpen())) {
        if (!revealTimer && !(ink && ink.classList.contains("is-shown"))) {
          revealTimer = setTimeout(function () {
            revealTimer = null;
            showTools();
            hideSoon();
          }, REVEAL_MS);
        }
      } else if (revealTimer) {
        clearTimeout(revealTimer);
        revealTimer = null;
      }
    }, { passive: true });
  }

  // ---- The presenter window: its bar ---------------------------------------
  //
  // Start, the timer, Reset, where the audience is, the slide count, the
  // clock and the two halves of the notes' size. Every control keeps its
  // place and its size whatever state the talk is in: one that does not
  // apply is disabled, never removed, so nothing in the bar moves under the
  // pointer.
  //
  //   on.start()          Start was pressed
  //   on.reset()          Reset was pressed, and pressed again
  //   on.paused(paused)   the timer was paused or resumed
  //   on.notes(step)      A− or A+: the notes smaller or larger by that much
  function presenterBar(on) {
    var bar = el("div", "sdoc-presenter-bar");
    var startBtn = el("button", "sdoc-presenter-start", "Start presentation");
    var timer = el("button", "sdoc-presenter-timer", "0:00");
    timer.title = "Pause or resume the timer";
    var reset = el("button", "sdoc-presenter-reset", "Reset");
    reset.title = "Both windows back to the first slide, the timer to zero, not started";
    var status = el("div", "sdoc-presenter-status");
    var count = el("div", "sdoc-presenter-count");
    var clock = el("div", "sdoc-presenter-clock");
    var smaller = el("button", "sdoc-presenter-size", "A−");
    smaller.title = "Smaller notes (−)";
    var larger = el("button", "sdoc-presenter-size", "A+");
    larger.title = "Larger notes (+)";
    // A click leaves the keyboard focus where it was: a button that kept it
    // would be pressed again by the next Space, which the deck reads as
    // Next — a pause of the timer, mid-talk. Tab still reaches them.
    [startBtn, timer, reset, smaller, larger].forEach(function (b) { b.type = "button"; keepFocus(b); });
    // A− and A+ are one control in two halves, beside the counter and the
    // clock: three widgets of one height on the right, as on the left.
    var sizes = el("div", "sdoc-presenter-sizes");
    sizes.appendChild(smaller);
    sizes.appendChild(larger);
    [startBtn, timer, reset, status, el("div", "sdoc-presenter-gap"), count, clock, sizes]
      .forEach(function (n) { bar.appendChild(n); });

    var started = false, elapsed = 0, since = 0, running = false;
    function shown() { return elapsed + (running ? Date.now() - since : 0); }
    function two(n) { return (n < 10 ? "0" : "") + n; }
    function format(ms) {
      var s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
      return (h ? h + ":" + two(m) : String(m)) + ":" + two(s % 60);
    }
    function tick() {
      timer.textContent = format(shown());
      var d = new Date();
      clock.textContent = two(d.getHours()) + ":" + two(d.getMinutes());
    }
    setInterval(tick, 500);

    startBtn.addEventListener("click", on.start);
    timer.addEventListener("click", function () {
      if (!started) return;
      if (running) { elapsed += Date.now() - since; running = false; }
      else { since = Date.now(); running = true; }
      on.paused(!running);
      tick();
    });
    // Reset is asked twice, since one stray click mid-talk would send the
    // projector back to the title.
    var resetting = twoClicks(reset, {
      ready: function () { return started; },
      arm: function () { reset.textContent = "Click to confirm"; },
      disarm: function () { reset.textContent = "Reset"; },
      act: on.reset
    });
    smaller.addEventListener("click", function () { on.notes(-2); });
    larger.addEventListener("click", function () { on.notes(2); });

    // Started, the timer runs from zero; not started, it stands at zero.
    function setStarted(isOn) {
      started = isOn;
      running = isOn;
      elapsed = 0;
      since = Date.now();
      startBtn.disabled = isOn;
      timer.disabled = !isOn;
      reset.disabled = !isOn;
      if (!isOn) resetting.disarm();
      tick();
    }
    setStarted(false);
    return {
      el: bar, setStarted: setStarted,
      count: function (text) { count.textContent = text; },
      // waiting: linked to a deck that does not follow yet, which is amber.
      status: function (text, waiting) {
        status.classList.toggle("is-waiting", waiting);
        status.textContent = text;
      }
    };
  }

  // ---- The presenter window: its stage --------------------------------------
  //
  // The slides laid out as the arrow keys move: previous on the left, next
  // on the right, the next drill-down below the current one — and, inside a
  // column, the bottom of the slide above peeking over it, so it is plain
  // that Up goes somewhere. Each is a miniature of the slide; a click on one
  // goes there.
  //
  // Focus is the current slide alone, as large as the stage allows, to read
  // a dense slide or to draw on it. The other slides go; a chevron at each
  // edge that has a neighbour says where the arrow keys still lead.
  //
  //   ui                    the presenter view's element, told when focus is on
  //   on.click(e)           whether a click on the current slide may enlarge it
  //   on.copied(el, label)  a copy of a slide was put on the stage
  //   on.moved()            the copies moved or changed size
  function presenterStage(ui, on) {
    var stage = el("div", "sdoc-presenter-stage");
    var slots = {};
    [["up", "\u2191 Up"], ["prev", "\u2190 Previous"], ["current", "Current"], ["next", "Next \u2192"], ["down", "\u2193 Drill-down"]]
      .forEach(function (p) {
        var name = p[0];
        var slot = el("div", "sdoc-presenter-slot is-" + name);
        var lbl = el("div", "sdoc-presenter-label", p[1]);
        var frame = el("div", "sdoc-presenter-frame");
        slot.appendChild(lbl);
        slot.appendChild(frame);
        stage.appendChild(slot);
        slots[name] = { slot: slot, frame: frame, target: null };
        frame.addEventListener("click", function (e) {
          if (name === "current") { if (on.click(e)) setFocus(!focused); return; }
          if (slots[name].target) kit.go(slots[name].target);
        });
      });

    // Focus: the current slide alone, as large as the stage allows, to read a
    // dense slide or to draw on it. The other slides go; a chevron at each
    // edge that has a neighbour says where the arrow keys still lead.
    var focused = false;
    // On the stage rather than the slide, and placed by fit() where the
    // enlarged slide's top-right corner is: the same place, the same size,
    // in both states, so a second click undoes the first without the pointer
    // moving. It stays a way out when a click on the slide itself no longer
    // is one.
    var focusBtn = el("button", "sdoc-presenter-focus");
    focusBtn.type = "button";
    focusBtn.appendChild(icon("is-expand", "M14 3h7v7M21 3l-7 7M10 21H3v-7M3 21l7-7"));
    focusBtn.appendChild(icon("is-collapse", "M14 4v6h6M14 10l7-7M10 20v-6H4M10 14l-7 7"));
    keepFocus(focusBtn);
    focusBtn.addEventListener("click", function () { setFocus(!focused); });
    stage.appendChild(focusBtn);
    var chevrons = {};
    [["up", "up", "M6 15l6-6 6 6", "Up"], ["prev", "left", "M15 6l-6 6 6 6", "Previous"],
     ["next", "right", "M9 6l6 6-6 6", "Next"], ["down", "down", "M6 9l6 6 6-6", "Drill-down"]]
      .forEach(function (c) {
        var b = el("button", "sdoc-presenter-chevron is-" + c[1]);
        b.type = "button";
        b.setAttribute("aria-label", c[3] + " slide");
        b.appendChild(icon(null, c[2]));
        keepFocus(b);
        chevrons[c[0]] = { el: b, target: null };
        b.addEventListener("click", function () { if (chevrons[c[0]].target) kit.go(chevrons[c[0]].target); });
        slots.current.slot.appendChild(b);
      });
    function syncFocus() {
      ui.classList.toggle("is-focused", focused);
      focusBtn.setAttribute("aria-pressed", focused ? "true" : "false");
      focusBtn.title = focused ? "Show the slides around it again (Z or Esc)" : "Enlarge the current slide (Z)";
      focusBtn.setAttribute("aria-label", focused ? "Show the slides around it again" : "Enlarge the current slide");
    }
    // The frame flies from where it was to where it is now, on the shared
    // spring: critically damped on the way out to the stage's edges, which
    // an overshoot would cross, and springing back into its place among the
    // others. What appears fades in rather than arriving all at once.
    function setFocus(on) {
      on = !!on;
      if (on === focused) return;
      var frame = slots.current.frame;
      var from = frame.getBoundingClientRect();
      if (frame.getAnimations) frame.getAnimations().forEach(function (a) { a.cancel(); });
      focused = on;
      syncFocus();
      fit(false);
      var motion = window.sdocMotion;
      if (!motion) return;
      var to = frame.getBoundingClientRect();
      if (from.width > 0 && to.width > 0) {
        var how = on ? motion.SETTLE : motion.SPRING;
        motion.play(frame, [{ transform: motion.fly(from, to), transformOrigin: "0 0" }, { transform: "none", transformOrigin: "0 0" }],
          { duration: how.duration, easing: how.easing });
      }
      var appear = on
        ? Object.keys(chevrons).map(function (k) { return chevrons[k].el; })
        : ["up", "prev", "next", "down"].map(function (k) { return slots[k].slot; });
      appear.forEach(function (n) {
        // From nothing to whatever the stylesheet gives it.
        motion.play(n, [{ opacity: 0 }], { duration: 220, delay: on ? 120 : 60, easing: "ease-out", fill: "backwards" });
      });
    }
    document.addEventListener("keydown", function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey || kit.editable(e.target)) return;
      // The overview has the keys while it is up; Escape there closes it.
      if (window.sdocOverview && window.sdocOverview.isOpen()) return;
      if (e.key === "Escape") {
        if (!focused) return;
        e.preventDefault();
        setFocus(false);
      } else if ((e.key || "").toLowerCase() === "z") {
        e.preventDefault();
        // Held down, it would flicker in and out.
        if (!e.repeat) setFocus(!focused);
      }
    });
    // Which slide goes in which slot, as positions; null where there is none.
    function around(here) {
      var col = kit.columns[here.s] || [];
      return {
        up: here.d > 0 ? { s: here.s, d: here.d - 1 } : null,
        prev: here.s > 0 ? { s: here.s - 1, d: 0 } : null,
        current: here,
        next: here.s < kit.columns.length - 1 ? { s: here.s + 1, d: 0 } : null,
        down: col[here.d + 1] ? { s: here.s, d: here.d + 1 } : null
      };
    }
    var design = kit.designBox();
    function show(here, box) {
      design = box;
      var targets = around(here);
      Object.keys(slots).forEach(function (name) {
        var slot = slots[name], t = targets[name];
        slot.frame.textContent = "";
        slot.target = t && name !== "current" ? kit.label(t) : null;
        slot.slot.classList.toggle("is-empty", !t);
        // On a spine slide there is nothing above, and saying so would be
        // noise on every slide; the space stays, so the stage does not jump.
        if (!t && name === "up") return;
        if (!t) {
          slot.frame.appendChild(el("div", "sdoc-presenter-none",
            name === "prev" ? "Start of the deck" : name === "next" ? "End of the deck" : "No drill-down here"));
          return;
        }
        var mini = kit.miniature(kit.at(t.s, t.d));
        slot.frame.appendChild(mini);
        on.copied(mini.firstChild, kit.label(t));
      });
      Object.keys(chevrons).forEach(function (name) {
        var c = chevrons[name], t = targets[name];
        c.target = t ? kit.label(t) : null;
        c.el.classList.toggle("is-on", !!t);
      });
      fit(true);
    }
    // The current slide as large as the stage allows; the slides either
    // side at half its width, and the drill-down below at a little less, so
    // the one you are on is always the one that dominates — whatever the
    // shape of the window.
    // The slide above shows only its bottom edge, at the current slide's
    // width, directly over it — the slide you came down from, stacked above
    // this one, without taking much of its room.
    // In focus the current slide has the whole stage, less room for the ring
    // drawn around it; the button sits just inside that slide's top-right
    // corner in either state.
    var SIDE = 0.5, BELOW = 0.42, PEEK = 0.16, LABEL = 26, GAP = 14;
    var RING = 3, FOCUS_BTN = 30, FOCUS_INSET = 10;
    function fit(settle) {
      on.moved();
      var aspect = design.w / design.h;
      var W = stage.clientWidth, H = stage.clientHeight;
      var fw = Math.floor(Math.min(W - 2 * RING, (H - 2 * RING) * aspect)), fh = Math.floor(fw / aspect);
      if (fw > 0) {
        focusBtn.style.left = (Math.round((W - fw) / 2) + fw - FOCUS_INSET - FOCUS_BTN) + "px";
        focusBtn.style.top = (Math.round((H - fh) / 2) + FOCUS_INSET) + "px";
      }
      var across = (W - 2 * GAP) / (1 + 2 * SIDE);
      var down = (H - 3 * LABEL - 2 * GAP) / (1 + BELOW + PEEK) * aspect;
      var cw = Math.floor(Math.min(across, down));
      if (!(cw > 0) && !(focused && fw > 0)) return;
      var share = { up: 1, current: 1, prev: SIDE, next: SIDE, down: BELOW };
      Object.keys(slots).forEach(function (name) {
        var frame = slots[name].frame;
        var big = focused && name === "current";
        var w = big ? fw : Math.floor(cw * share[name]), h = big ? fh : Math.floor(w / aspect);
        if (!(w > 0)) return;
        frame.style.width = w + "px";
        frame.style.height = (name === "up" ? Math.max(22, Math.floor(h * PEEK)) : h) + "px";
        var box = frame.querySelector(".sdoc-overview-mini");
        if (!box) return;
        kit.sizeMiniature(box, w, h, design.w);
        if (settle) kit.settleMiniature(box);
      });
    }
    syncFocus();
    return {
      el: stage, face: slots.current.frame, show: show, fit: fit,
      slideEl: function () { return slots.current.frame.querySelector(".sdoc-overview-mini > .slide"); }
    };
  }

  // ---- The presenter window: its notes --------------------------------------
  //
  // The current slide's notes in large type, under a divider that gives the
  // notes more room and the slides less, or the other way. The share and the
  // size of the type are remembered in this browser.
  //
  //   ui          the presenter view's element, which carries the share
  //   onShare()   the divider moved: the stage has another height
  function presenterNotes(ui, onShare) {
    var hasNotes = kit.slides.some(function (s) { return !!s.querySelector("aside.notes"); });
    var notes = el("div", "sdoc-presenter-notes");
    var notesBody = el("div", "sdoc-presenter-notes-body");
    notes.appendChild(notesBody);

    // The divider between the slides and the notes. Dragged, it gives one
    // more room and the other less; the stage re-fits as it moves, so the
    // current slide grows as the notes shrink.
    var split = el("div", "sdoc-presenter-split");
    split.setAttribute("role", "separator");
    split.setAttribute("aria-orientation", "horizontal");
    split.setAttribute("aria-label", "Resize the notes");
    split.setAttribute("tabindex", "0");
    split.title = "Drag to resize the notes; double-click to reset";
    split.appendChild(el("div", "sdoc-presenter-grip"));

    var SPLIT_STORE = "sdocPresenterNotesShare";
    var SPLIT_DEFAULT = 0.38, SPLIT_MIN = 0.12, SPLIT_MAX = 0.75;
    var share = SPLIT_DEFAULT;
    try { var keptShare = parseFloat(localStorage.getItem(SPLIT_STORE)); if (keptShare >= SPLIT_MIN && keptShare <= SPLIT_MAX) share = keptShare; } catch (err) {}
    function setShare(v, keep) {
      share = Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, v));
      ui.style.setProperty("--sdoc-presenter-notes", (share * 100).toFixed(2) + "%");
      split.setAttribute("aria-valuenow", String(Math.round(share * 100)));
      onShare();
      if (keep) { try { localStorage.setItem(SPLIT_STORE, String(share)); } catch (err) {} }
    }
    split.setAttribute("aria-valuemin", String(SPLIT_MIN * 100));
    split.setAttribute("aria-valuemax", String(SPLIT_MAX * 100));
    var dragging = null;
    split.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = { id: e.pointerId };
      try { split.setPointerCapture(e.pointerId); } catch (err) {}
      split.classList.add("is-dragging");
    });
    split.addEventListener("pointermove", function (e) {
      if (!dragging || e.pointerId !== dragging.id) return;
      // The notes run from just under the divider to the bottom of the
      // window, less the window's own padding.
      var box = ui.getBoundingClientRect();
      var pad = parseFloat(getComputedStyle(ui).paddingBottom) || 0;
      var below = box.bottom - pad - (e.clientY + split.offsetHeight / 2);
      setShare(below / box.height, false);
    });
    function endDrag(e) {
      if (!dragging || e.pointerId !== dragging.id) return;
      dragging = null;
      split.classList.remove("is-dragging");
      try { split.releasePointerCapture(e.pointerId); } catch (err) {}
      setShare(share, true);
    }
    split.addEventListener("pointerup", endDrag);
    split.addEventListener("pointercancel", endDrag);
    split.addEventListener("dblclick", function () { setShare(SPLIT_DEFAULT, true); });
    // From the keyboard, once the divider has the focus. The arrows are the
    // deck's too, so they stop here rather than also turning the slide.
    split.addEventListener("keydown", function (e) {
      if (e.key === "ArrowUp") setShare(share + 0.03, true);
      else if (e.key === "ArrowDown") setShare(share - 0.03, true);
      else if (e.key === "Home") setShare(SPLIT_DEFAULT, true);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });

    var STORE = "sdocPresenterNotesSize";
    var size = 30;
    try { var kept = parseFloat(localStorage.getItem(STORE)); if (kept >= 14 && kept <= 80) size = kept; } catch (err) {}
    function setSize(v) {
      size = Math.max(14, Math.min(80, v));
      notes.style.setProperty("--sdoc-presenter-notes-size", size + "px");
      try { localStorage.setItem(STORE, String(size)); } catch (err) {}
    }
    setSize(size);
    document.addEventListener("keydown", function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey || kit.editable(e.target)) return;
      if (e.key === "+" || e.key === "=") { e.preventDefault(); setSize(size + 2); }
      else if (e.key === "-" || e.key === "_") { e.preventDefault(); setSize(size - 2); }
    });
    function show(slide) {
      notesBody.textContent = "";
      var aside = slide && slide.querySelector("aside.notes");
      if (aside) notesBody.innerHTML = aside.innerHTML;
      else notesBody.appendChild(el("p", "sdoc-presenter-none", hasNotes
        ? "No notes for this slide."
        : "This deck has no speaker notes. A deck built with --no-notes leaves them out."));
      notes.scrollTop = 0;
    }
    return {
      el: notes, split: split, show: show,
      resize: function (step) { setSize(size + step); },
      // Once the view is in the page and has a height to share out.
      place: function () { setShare(share, false); }
    };
  }

  // ---- The presenter window ------------------------------------------------
  //
  // The bar, the tools, the stage and the notes put together, and kept in
  // step with the deck that opened this window.
  function presenterWindow() {
    document.documentElement.classList.add("sdoc-presenting");
    document.title = "Presenter · " + document.title;
    function connected() { return !!(window.opener && !window.opener.closed); }
    // audience: the slide the deck is on, as far as it has said. deckLoad:
    // the token of the deck's page load, as last heard.
    var started = false, audience = null, movedAt = 0, deckLoad = null;

    var ui = el("div", "sdoc-presenter");
    ui.setAttribute("role", "region");
    ui.setAttribute("aria-label", "Presenter view");

    var bar = presenterBar({
      start: start, reset: reset,
      paused: function (paused) { ui.classList.toggle("is-paused", paused); },
      notes: function (step) { notes.resize(step); }
    });
    var stage = presenterStage(ui, {
      click: function (e) { return tools.clickToggles(e); },
      copied: function (slideEl, label) { book.layer(slideEl, label); },
      // Moved or resized — by focus, the divider, the window — the copy on
      // the stage is measured again before anything snaps to it.
      moved: function () { tools.invalidate(); }
    });
    // Before Start what is drawn stays in this window and Start throws it
    // away; after it, each stroke reaches the audience as it is drawn, a
    // frame's worth of points at a time, and Reset clears both.
    var line = inkLine(function () { return window.opener; }, function () { return started && connected(); });
    var tools = inkTools({
      book: inkBook(false), prefix: "p", face: stage.face, listenKeys: true,
      pointerLabel: "No drawing tool: a click on the slide enlarges it",
      slideEl: stage.slideEl,
      send: line.ink, sendLaser: line.laser,
      onSync: function (t) {
        ui.classList.toggle("is-inking", !!t);
        ui.setAttribute("data-ink-tool", t || "none");
      }
    });
    var book = tools.book;
    var notes = presenterNotes(ui, function () { stage.fit(false); });

    [bar.el, tools.palette, stage.el, notes.split, notes.el].forEach(function (n) { ui.appendChild(n); });
    // Out of the grid, over it; inside the window's own element, whose
    // clicks the deck never sees.
    tools.overlays.forEach(function (n) { ui.appendChild(n); });
    document.body.appendChild(ui);
    // The deck turns the slide on any click or swipe; none of this is that.
    ["click", "pointerdown", "touchstart", "touchend"].forEach(function (type) {
      ui.addEventListener(type, function (e) { e.stopPropagation(); });
    });
    window.addEventListener("resize", function () { stage.fit(false); tools.place(); });

    function showStatus() {
      if (!connected()) {
        bar.status("Rehearsing: no audience window", false);
      } else if (!started) {
        bar.status(audience
          ? "Not started · the audience stays on slide " + audience + " until you press Start"
          : "Not started · the audience will not follow until you press Start", true);
      } else {
        bar.status(audience && audience !== kit.position() ? "Live · the audience is on slide " + audience : "Live", false);
      }
    }
    function render() {
      var here = kit.where(kit.activeSlide()), design = kit.designBox();
      // A new copy of a slide: whatever was measured for snapping is gone.
      tools.setDesign(design);
      tools.newSlide();
      stage.show(here, design);
      notes.show(kit.activeSlide());
      bar.count(kit.label(here) + " / " + kit.columns.length);
      showStatus();
      tools.sync();
    }

    function start() {
      // Ink drawn while rehearsing was never the audience's.
      tools.discard();
      started = true;
      ui.classList.add("is-started");
      bar.setStarted(true);
      // Back to where the audience is: browsing beforehand never moved the
      // projector, and starting does not move it either.
      if (audience && audience !== kit.position()) kit.go(audience);
      // What the deck holds — drawn there, or by an earlier presenter
      // window — is what the audience has seen, so it is kept, and sent
      // here to be drawn on.
      if (connected()) post(window.opener, { type: "ink-sync" });
      showStatus();
    }
    // Reset ends the run: both windows back to the first slide, the timer to
    // zero, and not started again — the state for another rehearsal, or for
    // the real talk after one. Both windows, because Start begins from the
    // audience's slide.
    function reset() {
      // While still linked, so the audience goes back too, and its ink goes.
      tools.settle();
      line.ink({ op: "clear" });
      tools.discard();
      post(window.opener, { type: "go", position: "1" });
      audience = "1";
      started = false;
      ui.classList.remove("is-started", "is-paused");
      bar.setStarted(false);
      kit.go("1");
      showStatus();
    }

    // ---- Keeping in step with the deck ----

    // A presenter moving quickly sends several positions; the audience's
    // reports of the earlier ones arrive after the later moves and must not
    // pull the presenter back. Following waits until the presenter is still.
    var SETTLE_MS = 600;
    function hello() {
      if (connected()) post(window.opener, { type: "hello" });
      showStatus();
    }
    // Only the deck that opened this window is heard. Its position always;
    // its ink and its laser — the audience's — from Start, and not before.
    window.addEventListener("message", function (e) {
      if (!ours(e) || !e.source || e.source !== window.opener) return;
      var m = e.data;
      if (m.type !== "position") {
        if (started && take(book, m)) tools.sync();
        return;
      }
      audience = m.position;
      // Another page load over there: the deck reloaded and its slides are
      // bare. After Start this window holds a copy of all the ink, the
      // deck's own strokes with its own, and gives it back. Before Start
      // it holds none of the deck's, and what it has drawn is not the
      // audience's, so nothing is sent.
      var reloaded = !!deckLoad && !!m.deck && m.deck !== deckLoad;
      if (m.deck) deckLoad = m.deck;
      if (started && reloaded) sendAll(book, tools, line);
      if (started && audience !== kit.position() && Date.now() - movedAt > SETTLE_MS) kit.go(audience);
      showStatus();
    });
    kit.onMove(function (pos) {
      movedAt = Date.now();
      tools.settle();
      render();
      if (started && pos !== audience) post(window.opener, { type: "go", position: pos });
    });

    notes.place();
    render();
    hello();
    // Again every two seconds: a reload of either window loses the other's
    // reference, and the next hello restores it.
    setInterval(hello, 2000);
  }

  if (!kit.presenter) audienceWindow();
  else if (document.readyState === "complete") presenterWindow();
  else window.addEventListener("load", presenterWindow);
}

// For the deck, after ANNOTATE_JS: evaluating this starts whichever window
// this is.
const PRESENTER_JS = "(" + createPresenter.toString() + ")(window.sdocDeckKit, window.sdocAnnotate);";

module.exports = { createPresenter, PRESENTER_JS };
