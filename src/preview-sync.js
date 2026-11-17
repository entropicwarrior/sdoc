// Scroll sync between an .sdoc editor and its preview.
//
// Every block the renderer emits carries the source line it came from
// (data-line, and data-line-end when it spans more than one). Scrolling the
// preview turns its position into a source line, and the extension reveals
// that line at the top of the editor; scrolling the editor sends its top line
// back, and the preview scrolls to it. The Markdown preview works the same way.
//
// The mapping is two pure functions over a list of the marked blocks, measured
// in the scroll container's own pixels: lineAtOffset and offsetForLine. They
// are serialised into the webview with toString(), the way the connector
// routing is, so the one implementation that runs in the preview is the one
// the fast suite tests — extension.js cannot be loaded outside VS Code.
//
// Only the innermost marked elements are used. A section is marked, and so is
// every heading, paragraph and list item inside it; the section's own box says
// nothing finer than its children do, and its top coincides with its heading's.

// entries: [{ line, end, top, bottom }] in document order, top and bottom in
// the scroll container's pixels, line and end the first and last source line.
// Returns a fractional source line: a block spreads its own lines over its
// height, and the gap between two blocks spreads the lines between them.
function lineAtOffset(entries, offset) {
  if (!entries || !entries.length) return 1;
  var lo = 0, hi = entries.length - 1, at = -1;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    if (entries[mid].top <= offset) { at = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  if (at === -1) return entries[0].line;
  var e = entries[at];
  if (offset < e.bottom && e.bottom > e.top) {
    return e.line + (e.end + 1 - e.line) * (offset - e.top) / (e.bottom - e.top);
  }
  var next = entries[at + 1];
  if (!next) return e.end + 1;
  var gap = next.top - e.bottom;
  var into = gap > 0 ? Math.min(1, Math.max(0, (offset - e.bottom) / gap)) : 0;
  return (e.end + 1) + (next.line - (e.end + 1)) * into;
}

// The inverse: where, in the container's pixels, a source line sits. A line
// inside a block is placed proportionally down that block; a line between two
// blocks, proportionally down the gap between them.
function offsetForLine(entries, line) {
  if (!entries || !entries.length) return 0;
  var lo = 0, hi = entries.length - 1, at = -1;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    if (entries[mid].line <= line) { at = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  if (at === -1) return entries[0].top;
  var e = entries[at];
  if (line < e.end + 1) {
    return e.top + (e.bottom - e.top) * (line - e.line) / (e.end + 1 - e.line);
  }
  var next = entries[at + 1];
  if (!next) return e.bottom;
  var span = next.line - (e.end + 1);
  var into = span > 0 ? Math.min(1, Math.max(0, (line - (e.end + 1)) / span)) : 0;
  return e.bottom + (next.top - e.bottom) * into;
}

// The webview half. Defines window.sdocPreviewSync(vscodeApi, options), which
// the preview's own script calls with the one vscodeApi a webview may acquire.
// options: { scrollEditor, scrollPreview, initialLine }.
//
// Same rule as every runtime embedded in a template literal: no backslashes
// and no backticks in the text below. The two functions above are inserted by
// value, so they are exempt.
const PREVIEW_SYNC_SCRIPT = `
window.sdocLineAtOffset = ${lineAtOffset.toString()};
window.sdocOffsetForLine = ${offsetForLine.toString()};
window.sdocPreviewSync = function (vscodeApi, options) {
  options = options || {};
  var main = document.querySelector(".sdoc-main");
  var container = main && main.scrollHeight > main.clientHeight ? main
    : (document.scrollingElement || document.documentElement);
  var isRoot = container === document.scrollingElement || container === document.documentElement;
  var scroller = isRoot ? window : container;

  // The innermost marked blocks that are on screen, measured in the
  // container's own pixels. Read fresh each time: a collapsed scope, an image
  // or a diagram arriving all move them, and a few hundred rects is cheap.
  function measure() {
    var base = isRoot ? 0 : container.getBoundingClientRect().top;
    var scroll = container.scrollTop;
    var out = [];
    var all = document.querySelectorAll("[data-line]");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.querySelector("[data-line]")) continue;
      var line = parseInt(el.getAttribute("data-line"), 10);
      if (!(line > 0)) continue;
      // A heading is one line, whatever range it carries: the renderer gives
      // it its whole section's end, and spread over a heading's height that
      // made 34 pixels stand for 870 lines.
      var end = /^H[1-6]$/.test(el.tagName) ? line : parseInt(el.getAttribute("data-line-end"), 10);
      if (!(end >= line)) end = line;
      var r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      out.push({ line: line, end: end, top: r.top - base + scroll, bottom: r.bottom - base + scroll });
    }
    var byTop = out.slice().sort(function (a, b) { return a.top - b.top || a.line - b.line; });
    var byLine = out.slice().sort(function (a, b) { return a.line - b.line || a.top - b.top; });
    return { byTop: byTop, byLine: byLine };
  }

  // A scroll this script caused is not the reader's, and must not be sent
  // back to the editor that asked for it.
  var quietUntil = 0;
  // The line the editor last asked for, kept while the reader has not
  // scrolled since, so the preview can be put back on it when an image or a
  // diagram arriving late moves everything below.
  var target = null;

  function scrollToLine(line) {
    var at = window.sdocOffsetForLine(measure().byLine, line);
    quietUntil = Date.now() + 120;
    container.scrollTop = Math.max(0, at);
    target = line;
  }

  var lastSent = null, queued = false;
  scroller.addEventListener("scroll", function () {
    if (Date.now() < quietUntil) return;
    target = null;
    if (!options.scrollEditor || queued) return;
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      // Read a hair below the top edge. A block's top is often fractional and
      // scrollTop is rounded, so a heading scrolled exactly to the top sits a
      // fraction of a pixel below it — and the top edge itself reads as the
      // gap above the heading, one line short.
      var line = Math.max(1, Math.floor(window.sdocLineAtOffset(measure().byTop, container.scrollTop + 2) + 0.001));
      if (line === lastSent) return;
      lastSent = line;
      vscodeApi.postMessage({ type: "revealLine", line: line });
    });
  }, { passive: true });

  window.addEventListener("message", function (e) {
    var msg = e.data;
    if (msg && msg.type === "scrollToLine" && options.scrollPreview && msg.line > 0) {
      scrollToLine(msg.line);
    }
  });

  // Opened, or re-rendered after an edit, at the editor's line rather than at
  // a pixel offset from before the edit.
  if (options.scrollPreview && options.initialLine > 0) {
    scrollToLine(options.initialLine);
    if (window.ResizeObserver) {
      var settle = new ResizeObserver(function () {
        if (target !== null) scrollToLine(target);
      });
      settle.observe(main || document.body);
      setTimeout(function () { settle.disconnect(); }, 3000);
    }
  }

  return { scrollToLine: scrollToLine, measure: measure };
};
`;

module.exports = { lineAtOffset, offsetForLine, PREVIEW_SYNC_SCRIPT };
