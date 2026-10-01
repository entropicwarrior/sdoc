// The Claude Slides artifact export: the subset validator, the id and font
// helpers, and a round trip through a real browser.
// Run with: node test/test-slide-artifact.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseSdoc, extractMeta } = require("../src/sdoc.js");
const { renderSlides } = require("../src/slide-renderer.js");
const { loadTheme } = require("../src/theme.js");
const { findChrome } = require("../src/slide-pdf.js");
const {
  parseSubsetHtml,
  parseStyle,
  validateSlideHtml,
  validateDeckJson,
  MIN_FONT_SIZE,
} = require("../src/slide-artifact-validate.js");
const {
  harvestArtifact,
  buildArtifact,
  fontStack,
  slideIds,
} = require("../src/slide-artifact.js");

let pass = 0, fail = 0;
const asyncTests = [];
function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      asyncTests.push(result.then(
        () => { pass++; console.log("  PASS: " + name); },
        (e) => { fail++; console.log("  FAIL: " + name + " — " + e.message); }
      ));
    } else {
      pass++; console.log("  PASS: " + name);
    }
  } catch (e) {
    fail++; console.log("  FAIL: " + name + " — " + e.message);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

// Every validator fixture is one <section>, so each says only what it is
// testing. The background is there because a section without one draws a
// warning of its own, which would muddy the warning assertions below.
function slide(inner, attrs = 'id="s1" style="background:#ffffff"') {
  return `<section ${attrs}>\n${inner}\n</section>`;
}
const messages = (list) => list.map((e) => e.message).join(" | ");
const errorsFor = (html, options) => messages(validateSlideHtml(html, options).errors);
const warningsFor = (html, options) => messages(validateSlideHtml(html, options).warnings);

// Rejected means an error, not a warning: the page silently heals anything it
// cannot read, so only an error stops the export and tells the author.
function rejects(html, needle) {
  const { errors, warnings } = validateSlideHtml(html);
  assert(
    errors.some((e) => e.message.includes(needle)),
    `expected an error naming "${needle}", got errors [${messages(errors)}] warnings [${messages(warnings)}]`
  );
}

// ============================================================
console.log("--- The subset validator: what passes ---");

test("a slide inside the subset passes with no errors and no warnings", () => {
  const r = validateSlideHtml(`<section id="cover" style="background:#ffffff;padding:128px;display:flex;flex-direction:column;gap:32px">
<h1 style="font-size:96px;font-weight:700;color:#111111">Title</h1>
<p style="font-size:32px;color:#333333">One line of body copy.</p>
</section>`);
  assert(r.errors.length === 0, "errors: " + messages(r.errors));
  assert(r.warnings.length === 0, "warnings: " + messages(r.warnings));
});

// ============================================================
console.log("\n--- The subset validator: what is rejected ---");

test("var() is rejected — the page resolves no custom properties", () => {
  // A theme's whole palette is custom properties, so this is the single most
  // likely thing to carry through from a cascade that was not fully resolved.
  rejects(slide('<p style="color:var(--sdoc-accent)">Accented.</p>'), "var() is not in the subset");
});

test("an em or rem length is rejected and the unit is named", () => {
  rejects(slide('<p style="padding:2em">Padded.</p>'), "uses em");
  rejects(slide('<div style="width:3rem"></div>'), "uses rem");
});

test("z-index is rejected — stacking is not a property the subset carries", () => {
  rejects(slide('<div style="z-index:5"></div>'), "z-index is not allowed on <div>");
});

test("a nested list is rejected rather than flattened in silence", () => {
  rejects(slide("<ul><li>Outer<ul><li>Inner</li></ul></li></ul>"), "nested lists are not in the subset");
});

test("an <img> with a data: URI src is rejected", () => {
  // The exporter writes embedded images back out as files for the publish step
  // precisely because the page takes an uploaded blob and nothing else.
  rejects(slide('<img src="data:image/png;base64,AA==" alt="x">'), "may not be a data: URI");
});

test("an <img> with an http src is rejected", () => {
  rejects(slide('<img src="https://example.com/logo.png" alt="x">'), "may not be an http URL");
});

test("colspan on a cell is rejected", () => {
  rejects(slide('<table><tr><td colspan="2">Spanned</td></tr></table>'), "colspan and rowspan are not in the subset");
});

test("font-size on a <span> is rejected — a span carries colour and nothing else", () => {
  // This is the rule that forces the exporter to bake text case into the runs:
  // a span cannot opt out of its parent's text-transform the way the renderer's
  // unit span does.
  rejects(slide('<p><span style="font-size:30px">10</span></p>'), "font-size is not allowed on <span>");
});

test("a file holding two <section>s is rejected", () => {
  rejects(
    '<section id="a" style="background:#fff"></section><section id="b" style="background:#fff"></section>',
    "must hold exactly one <section>"
  );
});

test("an <aside> that is not the last child is rejected", () => {
  // Anywhere else the page does not read it as speaker notes — it renders the
  // notes onto the slide instead, which is the worst possible failure.
  rejects(slide("<aside>Speaker notes.</aside>\n<p>Body.</p>"), "must be the section's last child");
  assert(errorsFor(slide("<p>Body.</p>\n<aside>Speaker notes.</aside>")) === "", "last child is fine");
});

test("an unknown x-shape kind is rejected", () => {
  rejects(slide('<x-shape kind="blob"></x-shape>'), 'x-shape kind "blob"');
});

test("an unknown x-icon name is rejected", () => {
  rejects(slide('<x-icon name="Banana"></x-icon>'), 'x-icon name "Banana"');
});

test("a negative scale is rejected, so nothing can be mirrored", () => {
  // The only way to flip an image in CSS is a negative scale, and the subset
  // caps scale at 0.5-2. A deck relying on a mirrored background cannot export.
  rejects(slide('<div style="transform:scale(-1)"></div>'), "a mirror, is not in the subset");
});

// ============================================================
console.log("\n--- The subset validator: what is only a warning ---");

// These four publish and read. Treating any of them as an error would refuse a
// deck the page handles perfectly well.
test("type under 24px warns rather than failing the export", () => {
  const html = slide('<p style="font-size:18px">Small print.</p>');
  assert(errorsFor(html) === "", "not an error: " + errorsFor(html));
  assert(warningsFor(html).includes(`under the ${MIN_FONT_SIZE}px`), "warned: " + warningsFor(html));
});

test("margin warns — the page accepts it and then does nothing", () => {
  const html = slide('<div style="margin:10px;background:#eeeeee"></div>');
  assert(errorsFor(html) === "", "not an error: " + errorsFor(html));
  assert(warningsFor(html).includes("margin is accepted but does nothing"), "warned: " + warningsFor(html));
});

test("<text> inside an svg warns — fonts never load inside a drawing", () => {
  const html = slide('<svg aria-label="A diagram"><text x="0" y="0">Label</text></svg>');
  assert(errorsFor(html) === "", "not an error: " + errorsFor(html));
  assert(warningsFor(html).includes("fonts never load inside a drawing"), "warned: " + warningsFor(html));
});

test("a class attribute warns — it is stripped on save", () => {
  const html = slide('<p class="kicker">Kicker.</p>');
  assert(errorsFor(html) === "", "not an error: " + errorsFor(html));
  assert(warningsFor(html).includes("class is stripped on save"), "warned: " + warningsFor(html));
});

// ============================================================
console.log("\n--- deck.json ---");

// One well-formed deck, so each case below changes exactly one thing and the
// assertion can name the error that change should produce.
function deckJson(overrides) {
  return {
    v: 4,
    title: "Deck",
    cover: "cover",
    order: ["cover", "second"],
    sections: { s1: { start: "cover" } },
    faces: {},
    ...overrides,
  };
}
const face = (family) => ({
  family,
  href: `https://fonts.googleapis.com/css2?family=${family.replace(/\s+/g, "+")}&display=swap`,
});
const deckErrors = (overrides) => messages(validateDeckJson(deckJson(overrides)).errors);

test("a well-formed deck.json passes, so the cases below each name one fault", () => {
  const r = validateDeckJson(deckJson());
  assert(r.errors.length === 0, "errors: " + messages(r.errors));
  assert(r.warnings.length === 0, "warnings: " + messages(r.warnings));
});

test('deck.json "v" must be present and 4', () => {
  assert(deckErrors({ v: undefined }).includes('"v" must be 4'), "missing v: " + deckErrors({ v: undefined }));
  assert(deckErrors({ v: 3 }).includes('"v" must be 4'), "wrong v: " + deckErrors({ v: 3 }));
});

test("deck.json needs a non-empty order", () => {
  assert(deckErrors({ order: [], cover: null }).includes('non-empty "order"'), deckErrors({ order: [], cover: null }));
});

test("a duplicate id in order is rejected", () => {
  // Two slides keyed the same would make the order ambiguous and the diff
  // against a published deck meaningless.
  assert(deckErrors({ order: ["cover", "cover"] }).includes("duplicate id"), deckErrors({ order: ["cover", "cover"] }));
});

test("more than four faces is rejected", () => {
  const faces = {};
  for (const name of ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"]) faces[name.toLowerCase()] = face(name);
  assert(deckErrors({ faces }).includes("5 faces; the limit is 4"), deckErrors({ faces }));
});

test("a face takes href or src, never both", () => {
  const faces = { inter: { ...face("Inter"), src: "/_blob/abc123" } };
  assert(deckErrors({ faces }).includes("has both href and src"), deckErrors({ faces }));
});

test("a face href must be a Google Fonts css2 link", () => {
  // Any other host simply does not load, and the deck heals to a basic face.
  const faces = { inter: { family: "Inter", href: "https://example.com/inter.css" } };
  assert(deckErrors({ faces }).includes("must be a https://fonts.googleapis.com/css2? link"), deckErrors({ faces }));
});

test("a cover naming an id that is not in order is rejected", () => {
  assert(deckErrors({ cover: "missing" }).includes("which is not in order"), deckErrors({ cover: "missing" }));
});

// ============================================================
console.log("\n--- The subset parser ---");

test("a void element written with a closing tag does not report a stray close", () => {
  // Shapes, icons and connectors parse as void, but an author writing by hand
  // closes them. A stray-close complaint here would bury the real one.
  const { errors } = parseSubsetHtml('<section id="s"><x-shape kind="line"></x-shape></section>');
  assert(errors.length === 0, "parse errors: " + JSON.stringify(errors));
  assert(errorsFor(slide('<x-shape kind="line"></x-shape>')) === "", "and the slide validates");
});

// ============================================================
console.log("\n--- Slide ids ---");

test("a valid scope id becomes the slide id unchanged", () => {
  // Comments, links and the diff against a published deck all key on this, so
  // an id that survives the round trip is the whole point.
  const warnings = [];
  const ids = slideIds([{ id: "cover" }, { id: "stats-slide" }], warnings);
  assert(ids.map((s) => s.id).join() === "cover,stats-slide", "ids: " + JSON.stringify(ids));
  assert(ids.every((s) => !s.slugged), "nothing slugged");
  assert(warnings.length === 0, "warnings: " + messages(warnings));
});

test("an id outside the artifact's grammar is slugged, and the warning names both", () => {
  const warnings = [];
  const ids = slideIds([{ id: "Why SDOC?" }], warnings);
  assert(ids[0].id === "why-sdoc", "slugged to: " + ids[0].id);
  assert(ids[0].sdocId === "Why SDOC?" && ids[0].slugged, "the source id is kept: " + JSON.stringify(ids[0]));
  assert(warnings.length === 1, "one warning: " + messages(warnings));
  assert(
    warnings[0].message.includes("Why SDOC?") && warnings[0].message.includes("why-sdoc"),
    "the author needs both halves to find it: " + warnings[0].message
  );
});

test("a scope with no id becomes slide-<n> and says the trace is lost", () => {
  const warnings = [];
  const ids = slideIds([{ id: "cover" }, { id: null }], warnings);
  assert(ids[1].id === "slide-2", "positional id: " + ids[1].id);
  assert(ids[1].sdocId === null, "nothing to trace back to");
  assert(warnings.length === 1 && /cannot be traced back/.test(warnings[0].message), messages(warnings));
});

test("duplicate ids are made unique rather than overwriting each other", () => {
  // Both slides are written to project/slides/<id>.html, so a collision would
  // silently drop a slide from the export.
  const ids = slideIds([{ id: "intro" }, { id: "intro" }, { id: "intro" }], []);
  assert(ids.map((s) => s.id).join() === "intro,intro-2,intro-3", "ids: " + JSON.stringify(ids.map((s) => s.id)));
});

// ============================================================
console.log("\n--- Font stacks ---");

test("a stack is reduced to the declared face, a basic face and a generic", () => {
  const stack = fontStack('Inter, "Segoe UI", Arial, Helvetica, sans-serif');
  assert(stack.css === "Inter, Arial, sans-serif", "css: " + stack.css);
  assert(stack.declared === "Inter", "declared: " + stack.declared);
  const quoted = fontStack('"Source Serif Pro", Georgia, serif');
  assert(quoted.css === "'Source Serif Pro', Georgia, serif", "a multi-word face keeps its quotes: " + quoted.css);
});

test("a system keyword is never taken for a declared face", () => {
  // -apple-system and system-ui resolve to whatever the reader's machine has.
  // Declaring one as a deck face would ask the artifact to load a font that
  // does not exist, and every such stack would then burn one of the four slots.
  for (const stack of ["-apple-system, BlinkMacSystemFont, Arial, sans-serif", "system-ui, Arial, sans-serif"]) {
    const reduced = fontStack(stack);
    assert(reduced.declared === null, `"${stack}" declares nothing, got ${reduced.declared}`);
    assert(reduced.css === "Arial, sans-serif", `"${stack}" reduces to the basic face, got ${reduced.css}`);
  }
});

// ============================================================
console.log("\n--- Export through a browser ---");

const EXAMPLE = path.join(__dirname, "..", "examples", "layouts-example.sdoc");

if (!findChrome()) {
  console.log("  SKIP: Chrome not found — the artifact export harvests a live page");
} else {
  // One harvest, shared. A browser run costs seconds; the four claims below are
  // all about what buildArtifact does with the result, not about the browser.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-artifact-test-"));
  const htmlPath = path.join(tmpDir, "deck.html");
  // The shipped theme on purpose: its 1280x720 box is what makes the scale 1.5,
  // and a theme written here would not prove the export handles a real one.
  const theme = loadTheme(path.join(__dirname, "..", "themes", "default"));
  const parsed = parseSdoc(fs.readFileSync(EXAMPLE, "utf-8"));
  assert(parsed.errors.length === 0, "the example should parse clean");
  const { nodes, meta } = extractMeta(parsed.nodes);
  fs.writeFileSync(
    htmlPath,
    renderSlides(nodes, {
      meta,
      themeCss: theme.themeCss,
      themeJs: theme.themeJs,
      themeConfig: theme.themeConfig,
    }),
    "utf-8"
  );

  const NOW = "2026-01-01T00:00:00Z";
  const buildOptions = { title: "SDOC Slide Layouts", theme: theme.themeConfig, now: NOW };
  const builtPromise = harvestArtifact(htmlPath).then((harvest) => ({
    harvest,
    built: buildArtifact(harvest, buildOptions),
  }));

  test("every layout in the example exports with no validator errors", async () => {
    // The example carries one slide per layout, so this is the whole renderer
    // checked against the subset at once — including a layout added later.
    const { built } = await builtPromise;
    assert(built.errors.length === 0, "errors: " + JSON.stringify(built.errors.slice(0, 5), null, 2));
    assert(built.manifest.slides.length >= 10, "every slide exported");
    const layouts = new Set(built.manifest.slides.map((s) => s.layout));
    assert(layouts.size >= 10, "layouts covered: " + [...layouts].join(", "));
  });

  test("deck.json orders exactly the slides the manifest names, cover first", async () => {
    const { built } = await builtPromise;
    const ids = built.manifest.slides.map((s) => s.id);
    assert(built.deck.order.join() === ids.join(), "order matches the manifest");
    assert(built.deck.cover === ids[0], `cover should be the first slide, got ${built.deck.cover}`);
    for (const id of built.deck.order) {
      assert(built.files[`project/slides/${id}.html`], `no file for ordered slide ${id}`);
    }
  });

  test("the theme's 1280x720 box is scaled 1.5x onto the fixed canvas", async () => {
    const { built } = await builtPromise;
    assert(built.manifest.designBox.w === 1280 && built.manifest.designBox.h === 720, "design box measured");
    assert(built.manifest.canvas.w === 1920 && built.manifest.canvas.h === 1080, "canvas is fixed");
    assert(built.manifest.scale === 1.5, "scale: " + built.manifest.scale);
    // The theme's `.slide { padding: 60px 100px }` is the one number in the
    // output a reader can check against the stylesheet by eye.
    const cover = built.files[`project/slides/${built.deck.cover}.html`];
    const style = parseStyle(/<section [^>]*style="([^"]*)"/.exec(cover)[1]);
    const padding = style.find((d) => d.prop === "padding").value;
    assert(padding === "90px 150px 90px 150px", "padding should be 1.5x 60px 100px, got " + padding);
  });

  test("two builds of one harvest differ only where the timestamp does", async () => {
    // The manifest records a sha256 per slide and the publish step diffs on it,
    // so an unstable build would republish every slide on every run.
    const { harvest, built } = await builtPromise;
    const again = buildArtifact(harvest, buildOptions);
    for (const [file, body] of Object.entries(built.files)) {
      assert(again.files[file] === body, `${file} is not reproducible`);
    }
    assert(
      JSON.stringify(again.manifest.slides) === JSON.stringify(built.manifest.slides),
      "the manifest's slide records are not reproducible"
    );

    const later = buildArtifact(harvest, { ...buildOptions, now: "2027-06-06T06:06:06Z" });
    for (const file of Object.keys(built.files)) {
      if (!file.endsWith(".html")) continue;
      assert(later.files[file] === built.files[file], `${file} changed with the clock`);
    }
    assert(later.deck.createdOnFiles.at === "2027-06-06T06:06:06Z", "the new time is taken");
    const strip = (deck) => JSON.stringify({ ...deck, createdOnFiles: null });
    assert(strip(later.deck) === strip(built.deck), "deck.json changed beyond its timestamp");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
}

// ============================================================
console.log("\n--- Pulling edits back (artifact-diff) ---");

const { readSlide, classifySlide, canonStyle, canonColour } = require("../tools/artifact-diff.js");

// A slide shaped the way the exporter writes one: a marked pipeline step whose
// colour carries meaning, an ordinary paragraph, and speaker notes.
function slideFixture(opts = {}) {
  const stepColour = opts.stepColour || "rgb(37, 99, 235)";
  const body = opts.body || "The original sentence.";
  const notes = opts.notes === undefined ? "Original note." : opts.notes;
  const extra = opts.extra || "";
  return (
    `<section id="s" style="background:rgb(255, 255, 255);color:rgb(0, 0, 0)">\n` +
    `<h2 style="font-size:48px">Title</h2>\n` +
    `<div style="display:flex;gap:12px">\n` +
    `<p style="color:${stepColour};font-weight:600">Convert</p>\n` +
    `</div>\n` +
    `<p style="font-size:30px">${body}</p>\n` +
    extra +
    `<aside>${notes}</aside>\n` +
    `</section>\n`
  );
}

// What the exporter would have recorded for that slide, in source order.
const FIXTURE_ROLES = [
  { role: "h2", tag: "h2", text: "Title" },
  { role: "pipe-step is-marked", tag: "p", text: "Convert" },
  { role: "col-body", tag: "p", text: "The original sentence." },
];

function diffFixture(after, roles) {
  return classifySlide(readSlide(slideFixture()), readSlide(after), { texts: roles || FIXTURE_ROLES });
}

test("a slide re-saved in the editor's normalised form reads as unchanged", () => {
  // The editor rewrites every slide it touches: declarations reordered,
  // colours re-cased, whitespace collapsed. Without this, every slide in the
  // deck would be reported as edited and the report would be worthless.
  const normalised = slideFixture()
    .replace('style="background:rgb(255, 255, 255);color:rgb(0, 0, 0)"', 'style="color:#000000;background:#FFF"')
    .replace('style="color:rgb(37, 99, 235);font-weight:600"', 'style="font-weight:600;color:#2563EB"')
    .replace(/>\s+</g, "> <");
  const r = diffFixture(normalised);
  assert(r.classification.join() === "unchanged", "classified: " + r.classification.join());
});

test("an edited sentence is reported against the role it came from", () => {
  const r = diffFixture(slideFixture({ body: "A rewritten sentence." }));
  assert(r.classification.includes("text-edited"), "text-edited");
  assert(r.textChanges.length === 1, "one change, got " + r.textChanges.length);
  assert(r.textChanges[0].role === "col-body", "role: " + r.textChanges[0].role);
  assert(r.textChanges[0].from === "The original sentence.", "from");
  assert(r.textChanges[0].to === "A rewritten sentence.", "to");
});

test("a recoloured mark is flagged, because the colour carries the argument", () => {
  // In .sdoc the mark is bold in the source and the theme picks the colour, so
  // a colour chosen in the editor cannot be written back as a colour.
  const r = diffFixture(slideFixture({ stepColour: "rgb(220, 38, 38)" }));
  assert(r.classification.includes("restyled"), "restyled");
  assert(r.accentFlags.length === 1, "one accent flag, got " + r.accentFlags.length);
  assert(r.accentFlags[0].role === "pipe-step is-marked", "role: " + r.accentFlags[0].role);
});

test("an ordinary restyle is not flagged as carrying meaning", () => {
  const r = diffFixture(slideFixture().replace("font-size:48px", "font-size:52px"));
  assert(r.classification.includes("restyled"), "restyled");
  assert(r.accentFlags.length === 0, "nothing flagged");
});

test("a notes-only edit is reported as notes, not as a text change", () => {
  const r = diffFixture(slideFixture({ notes: "A rewritten note." }));
  assert(r.classification.join() === "notes-edited", "classified: " + r.classification.join());
  assert(r.notesChange.to === "A rewritten note.", "new note");
  assert(r.textChanges.length === 0, "no text changes");
});

test("adding an element is a restructure, not an edit", () => {
  // Structure carries meaning in the source that the slide does not, so this
  // is never applied automatically.
  const r = diffFixture(slideFixture({ extra: '<p style="font-size:30px">Added.</p>\n' }));
  assert(r.classification.includes("restructured"), "classified: " + r.classification.join());
  assert(r.textChanges.length === 0, "a restructure does not guess at text mappings");
});

test("a slide missing from the pull is removed, one with no export is added", () => {
  const gone = classifySlide(readSlide(slideFixture()), null, {});
  assert(gone.classification.join() === "removed", "removed");
  const fresh = classifySlide(null, readSlide(slideFixture()), {});
  assert(fresh.classification.join() === "added", "added");
});

test("colour spellings are compared by what they mean", () => {
  assert(canonColour("#FFF") === canonColour("rgb(255, 255, 255)"), "hex short vs rgb");
  assert(canonColour("#ffffff") === canonColour("WHITE"), "hex vs named");
  assert(canonColour("rgba(0, 0, 0, 1)") === canonColour("#000000"), "opaque rgba vs hex");
  assert(canonColour("rgba(0, 0, 0, 0.5)") !== canonColour("#000000"), "alpha is not dropped");
});

test("a bare number keeps its meaning: 600 is a weight, 12 is a length", () => {
  // Treating every bare number as px reported font-weight:600px, which is not
  // a thing and made every weight look changed.
  assert(canonStyle("font-weight: 600") === "font-weight:600", canonStyle("font-weight: 600"));
  assert(canonStyle("gap: 12") === "gap:12px", canonStyle("gap: 12"));
  assert(canonStyle("line-height: 1.4") === "line-height:1.4", canonStyle("line-height: 1.4"));
});

// ============================================================
Promise.all(asyncTests).then(() => {
  console.log("\n" + "=".repeat(40));
  console.log(`Results: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
});
