// Scroll sync between the VS Code editor and the preview, in a real page.
//
// The mapping is unit-tested in test-all.js. This puts the real sync script in
// the page the preview renders — the authoring guide, long enough to scroll,
// with every kind of block — and checks both directions on every block:
// scrolled to the top of the preview, it reports its own line; asked for its
// line, the preview puts it at the top. And that neither direction echoes.
//
// The extension host's half (revealing the line in the editor) runs only in
// VS Code. What it is sent is checked here; what it does with it is not.

const fs = require("fs");
const path = require("path");
const browser = require("./browser.js");
const { tempDir } = require("./tempdir.js");
const { parseSdoc, extractMeta, renderHtmlDocumentFromParsed } = require("../src/sdoc.js");
const { PREVIEW_SYNC_SCRIPT } = require("../src/preview-sync.js");
const { runHarvest, SENTINEL } = require("../src/slide-geometry.js");

let pass = 0, fail = 0;
const asyncTests = [];
let browserQueue = Promise.resolve();
function runTest(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return result.then(
        () => { pass++; console.log("  PASS: " + name); },
        (e) => {
          if (browser.isSkip(e)) { browser.record(name); return; }
          fail++; console.log("  FAIL: " + name + " — " + e.message);
        }
      );
    }
    pass++; console.log("  PASS: " + name);
  } catch (e) {
    if (browser.isSkip(e)) { browser.record(name); return undefined; }
    fail++; console.log("  FAIL: " + name + " — " + e.message);
  }
  return undefined;
}
function test(name, fn) {
  if (browser.skipping()) { browser.record(name); return; }
  if (fn.constructor.name === "AsyncFunction") {
    browserQueue = browserQueue.then(() => runTest(name, fn));
    asyncTests.push(browserQueue);
    return;
  }
  const pending = runTest(name, fn);
  if (pending) asyncTests.push(pending);
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

// The preview's page, as the extension builds it, with a stand-in for the one
// VS Code API the sync uses. requestAnimationFrame runs at once: headless
// Chrome stops making frames once a page settles, and the sync posts from one.
const INITIAL_LINE = 600;
const PAGE_SCRIPT = `
window.__posted = [];
window.requestAnimationFrame = function (f) { f(); return 0; };
${PREVIEW_SYNC_SCRIPT}
window.__sync = window.sdocPreviewSync(
  { postMessage: function (m) { window.__posted.push(m); } },
  { scrollEditor: true, scrollPreview: true, initialLine: ${INITIAL_LINE} }
);
`;

const DRIVE_SCRIPT = `
(function () {
  var out = {};
  function report() {
    var el = document.createElement("script");
    el.type = "application/json";
    el.id = "sdoc-preview-sync";
    el.textContent = JSON.stringify(out) + "\\n/*${SENTINEL}*/";
    document.body.appendChild(el);
  }
  async function run() {
    var main = document.querySelector(".sdoc-main");
    var top = function (el) { return el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop; };
    var revealed = function () { return window.__posted.filter(function (m) { return m.type === "revealLine"; }); };
    var scrolled = function () { main.dispatchEvent(new Event("scroll")); };
    var ask = function (line) { window.dispatchEvent(new MessageEvent("message", { data: { type: "scrollToLine", line: line } })); };
    var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var maxTop = main.scrollHeight - main.clientHeight;
    var leaves = [].slice.call(document.querySelectorAll("[data-line]")).filter(function (el) {
      return !el.querySelector("[data-line]") && el.getClientRects().length;
    });
    out.scrolls = maxTop > 0;
    out.blocks = leaves.length;

    // Opened at the editor's line, as after an edit.
    out.initialLine = Math.floor(window.sdocLineAtOffset(window.__sync.measure().byTop, main.scrollTop + 2));
    out.postedOnOpen = revealed().length;

    // Preview to editor: each block at the top reports its own line.
    await wait(200);
    var wrong = [], checked = 0;
    leaves.forEach(function (el) {
      var t = top(el);
      if (t > maxTop - 2) return;
      main.scrollTop = t;
      scrolled();
      checked++;
      var got = revealed().length ? revealed()[revealed().length - 1].line : null;
      var want = +el.getAttribute("data-line");
      if (got !== want) wrong.push(el.tagName.toLowerCase() + " line " + want + " reported " + got);
    });
    out.toEditor = { checked: checked, wrong: wrong.slice(0, 5), wrongCount: wrong.length };

    // Editor to preview: each line asked for lands at the top, and the
    // scroll that causes is not sent back.
    var before = revealed().length, far = [], landed = 0;
    leaves.forEach(function (el) {
      ask(+el.getAttribute("data-line"));
      scrolled();
      if (main.scrollTop >= maxTop - 1) return;
      landed++;
      var off = Math.abs(el.getBoundingClientRect().top - main.getBoundingClientRect().top);
      if (off > 1) far.push("line " + el.getAttribute("data-line") + " " + Math.round(off) + "px off");
    });
    out.toPreview = { landed: landed, far: far.slice(0, 5), farCount: far.length, echoed: revealed().length - before };

    // A sweep down the whole page never reports a line going backwards.
    await wait(200);
    var start = revealed().length, back = 0;
    for (var y = 0; y < maxTop; y += 37) { main.scrollTop = y; scrolled(); }
    var sweep = revealed().slice(start).map(function (m) { return m.line; });
    for (var i = 1; i < sweep.length; i++) if (sweep[i] < sweep[i - 1]) back++;
    out.sweep = { reports: sweep.length, backwards: back };
  }
  function start() {
    run().catch(function (e) { out.__error = String((e && e.message) || e); }).then(report);
  }
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start);
})();
`;

console.log("\n--- Preview scroll sync ---");

test("preview and editor agree on every block, both ways, without echoing (browser)", async () => {
  browser.skip();
  const dir = tempDir("sdoc-preview-sync-");
  const src = fs.readFileSync(path.join(__dirname, "..", "docs", "reference", "sdoc-authoring.sdoc"), "utf8");
  const parsed = parseSdoc(src);
  const { nodes, meta } = extractMeta(parsed.nodes);
  const file = path.join(dir, "preview.html");
  fs.writeFileSync(file, renderHtmlDocumentFromParsed({ nodes, errors: parsed.errors }, "Preview", {
    meta, includeSignposts: true, script: PAGE_SCRIPT,
  }), "utf8");
  const r = await runHarvest(file, DRIVE_SCRIPT, "sdoc-preview-sync");
  assert(!r.__error, "the drive threw: " + r.__error);
  assert(r.scrolls && r.blocks > 300, "a page long enough to scroll, with every kind of block: " + r.blocks);

  assert(r.initialLine === INITIAL_LINE, "opened at the editor's line " + INITIAL_LINE + ", not " + r.initialLine);
  assert(r.postedOnOpen === 0, "and opening there sent nothing back to the editor");

  assert(r.toEditor.checked > 300, "most blocks can be scrolled to the top: " + r.toEditor.checked);
  assert(r.toEditor.wrongCount === 0, r.toEditor.wrongCount + " blocks reported the wrong line: " +
    r.toEditor.wrong.join("; "));

  assert(r.toPreview.landed > 300, "most lines can be brought to the top: " + r.toPreview.landed);
  assert(r.toPreview.farCount === 0, r.toPreview.farCount + " lines landed away from the top: " +
    r.toPreview.far.join("; "));
  assert(r.toPreview.echoed === 0, "the preview sent back " + r.toPreview.echoed + " scrolls the editor caused");

  assert(r.sweep.reports > 100 && r.sweep.backwards === 0,
    "a sweep down the page never goes back a line: " + JSON.stringify(r.sweep));
});

Promise.all(asyncTests).then(() => {
  console.log("\n" + "=".repeat(40));
  console.log(`Results: ${pass} passed, ${fail} failed${browser.summary()}`);
  process.exit(fail > 0 ? 1 : 0);
});
