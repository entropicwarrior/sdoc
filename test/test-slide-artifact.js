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
  MAX_NOTES,
} = require("../src/slide-artifact-validate.js");
const {
  harvestArtifact,
  buildArtifact,
  fontStack,
  slideIds,
  ARTIFACT_SCRIPT,
} = require("../src/slide-artifact.js");
const { MEASURE_SCRIPT, harvestComplete, SENTINEL } = require("../src/slide-geometry.js");

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

// ============================================================
console.log("\n--- Scaling a theme onto the canvas ---");

// A harvest, hand-built. The default theme is 1920x1080 now, the same as the
// canvas, so nothing it produces exercises the scaling any more — and a theme
// of another size is exactly the case that would break silently.
function fakeStyle(over) {
  return Object.assign({
    display: "block", flexDirection: "row", flexWrap: "nowrap", gap: "0px",
    alignItems: "normal", justifyContent: "normal",
    gridTemplateColumns: "none", gridTemplateRows: "none",
    paddingTop: "0px", paddingRight: "0px", paddingBottom: "0px", paddingLeft: "0px",
    backgroundColor: "rgba(0, 0, 0, 0)", backgroundImage: "none",
    borderTopWidth: "0px", borderRightWidth: "0px", borderBottomWidth: "0px", borderLeftWidth: "0px",
    borderTopStyle: "none", borderRightStyle: "none", borderBottomStyle: "none", borderLeftStyle: "none",
    borderTopColor: "rgb(0, 0, 0)", borderRightColor: "rgb(0, 0, 0)",
    borderBottomColor: "rgb(0, 0, 0)", borderLeftColor: "rgb(0, 0, 0)",
    borderTopLeftRadius: "0px", opacity: "1",
    flexGrow: "0", flexShrink: "1", flexBasis: "auto",
    marginTop: "0px", marginRight: "0px", marginBottom: "0px", marginLeft: "0px",
    position: "static",
    fontFamily: "Arial, sans-serif", fontSize: "16px", fontWeight: "400", fontStyle: "normal",
    lineHeight: "24px", letterSpacing: "normal", textAlign: "start", textTransform: "none",
    whiteSpace: "normal", color: "rgb(17, 17, 17)",
  }, over || {});
}

function fakeHarvest(design) {
  return {
    slides: [{
      id: "one", classes: "slide", layout: null, spine: 1, detail: 0,
      design: design, notes: "", pseudos: [],
      style: fakeStyle({
        backgroundColor: "rgb(255, 255, 255)", fontSize: "16px",
        paddingTop: "60px", paddingRight: "100px", paddingBottom: "60px", paddingLeft: "100px",
      }),
      children: [{
        tag: "h2", cls: "", style: fakeStyle({ fontSize: "32px", fontWeight: "700" }),
        box: { x: 0, y: 0, w: 400, h: 40 }, runs: [{ text: "Title" }],
      }],
    }],
  };
}

test("a theme smaller than the canvas is scaled onto it", () => {
  const built = buildArtifact(fakeHarvest({ w: 1280, h: 720 }), { title: "T", now: "2026-01-01T00:00:00Z" });
  assert(built.errors.length === 0, "no errors: " + JSON.stringify(built.errors.slice(0, 2)));
  assert(built.manifest.scale === 1.5, "scale: " + built.manifest.scale);
  const html = built.files["project/slides/one.html"];
  assert(/padding:90px 150px 90px 150px/.test(html), "60/100 padding scaled: " + html.slice(0, 160));
  assert(/font-size:48px/.test(html), "32px type scaled to 48px");
});

test("a theme already the size of the canvas is copied across untouched", () => {
  const built = buildArtifact(fakeHarvest({ w: 1920, h: 1080 }), { title: "T", now: "2026-01-01T00:00:00Z" });
  assert(built.manifest.scale === 1, "scale: " + built.manifest.scale);
  const html = built.files["project/slides/one.html"];
  assert(/padding:60px 100px 60px 100px/.test(html), "padding unscaled");
  assert(/font-size:32px/.test(html), "type unscaled");
});

test("a theme larger than the canvas is scaled down", () => {
  // The floor is off here: scaling and the 24px minimum are separate features
  // and a test that asserts both at once cannot say which one broke.
  const opts = { title: "T", now: "2026-01-01T00:00:00Z", minFontSize: false };
  const built = buildArtifact(fakeHarvest({ w: 3840, h: 2160 }), opts);
  assert(built.manifest.scale === 0.5, "scale: " + built.manifest.scale);
  assert(/font-size:16px/.test(built.files["project/slides/one.html"]), "32px type halved");
});

test("text under the type's floor is left at the size the theme set", () => {
  // Halving a 32px heading lands it at 16px, under the 24px the format asks
  // for — and the format says of that floor, in its own words, "(not
  // build-checked)". A published deck with text down to 8.67px renders every
  // size as authored, so raising them changed the design for a rule nothing
  // enforces. They are left alone, and reported so the author knows.
  const built = buildArtifact(fakeHarvest({ w: 3840, h: 2160 }), { title: "T", now: "2026-01-01T00:00:00Z" });
  assert(/font-size:16px/.test(built.files["project/slides/one.html"]),
    "kept at the authored size: " + built.files["project/slides/one.html"].slice(0, 200));
  assert(built.warnings.some((w) => /under the .* the type asks for/.test(w.message)),
    "and reported: " + JSON.stringify(built.warnings.map((w) => w.message).slice(0, 3)));
});

test("raising to the floor is still available, and still says so", () => {
  const built = buildArtifact(fakeHarvest({ w: 3840, h: 2160 }), {
    title: "T", now: "2026-01-01T00:00:00Z", minFontSize: true,
  });
  assert(/font-size:24px/.test(built.files["project/slides/one.html"]), "raised to the floor");
  assert(built.warnings.some((w) => /raised .* text size/.test(w.message)),
    "and reported: " + JSON.stringify(built.warnings.map((w) => w.message).slice(0, 3)));
});

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

  test("the built-in theme needs no scaling: its box is the canvas", async () => {
    // Since 0.2.24 the default box is 1920x1080, which is what a Claude Slides
    // artifact is fixed at. Lengths copy across instead of being scaled, and a
    // theme's small type clears the format's 24px floor without being raised.
    const { built } = await builtPromise;
    assert(built.manifest.designBox.w === 1920 && built.manifest.designBox.h === 1080,
      "design box measured: " + JSON.stringify(built.manifest.designBox));
    assert(built.manifest.canvas.w === 1920 && built.manifest.canvas.h === 1080, "canvas is fixed");
    assert(built.manifest.scale === 1, "scale: " + built.manifest.scale);
    // The theme's `.slide { padding: 90px 150px }` is the one number in the
    // output a reader can check against the stylesheet by eye.
    const cover = built.files[`project/slides/${built.deck.cover}.html`];
    const style = parseStyle(/<section [^>]*style="([^"]*)"/.exec(cover)[1]);
    const padding = style.find((d) => d.prop === "padding").value;
    assert(padding === "90px 150px 90px 150px", "padding copied unscaled, got " + padding);
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
console.log("\n--- Asset placeholders, between export and publish ---");

// An image cannot carry its final /_blob/<id> until the publish step has
// uploaded the file and been told the id, so the export writes a placeholder
// and tools/artifact-resolve-assets.js rewrites it. The validator used to
// reject that placeholder outright, which meant no deck containing an image
// could be exported at all — the export refused and wrote nothing.
const imgSrc = (src) => `<section id="s1"><img src="${src}" alt="" /></section>`;
const srcErrors = (r) => r.errors.filter((e) => /src must be/.test(e.message));

test("an export may carry an unresolved asset placeholder", () => {
  const r = validateSlideHtml(imgSrc("sdoc-asset:embedded-1.png"), {
    slide: "s1", assetPlaceholders: true,
  });
  assert(srcErrors(r).length === 0, "the export stage accepts it: " + JSON.stringify(srcErrors(r)));
});

test("a placeholder that reached the publish step is still an error", () => {
  const r = validateSlideHtml(imgSrc("sdoc-asset:embedded-1.png"), { slide: "s1" });
  assert(srcErrors(r).length === 1, "unresolved by default, which is what guards a publish");
});

test("the opt-in is narrow: a data: URI is refused either way", () => {
  const r = validateSlideHtml(imgSrc("data:image/png;base64,AA"), {
    slide: "s1", assetPlaceholders: true,
  });
  assert(r.errors.some((e) => /data: URI/.test(e.message)), "still refused");
});

test("a resolved blob id passes without the opt-in", () => {
  const r = validateSlideHtml(imgSrc("/_blob/abc123"), { slide: "s1" });
  assert(srcErrors(r).length === 0, "the resolved form is the normal one");
});

test("a font face follows the same rule, since deck.json carries one too", () => {
  const deck = { title: "t", order: ["a"], faces: { Body: { src: "sdoc-asset:f.woff2" } } };
  const lenient = validateDeckJson(deck, { assetPlaceholders: true });
  const strict = validateDeckJson(deck);
  assert(srcErrors(lenient).length === 0, "accepted while exporting");
  assert(srcErrors(strict).length === 1, "refused once it would be published");
});

test("a deck with images exports rather than refusing outright", () => {
  // The whole bug in one assertion: before, this wrote nothing and reported an
  // error for every image in the deck.
  const parsed = parseSdoc(
    "# Deck {\n    # Slide {\n        background: pic.png\n\n        Body copy.\n    }\n}"
  );
  assert(parsed.errors.length === 0, "fixture parses");
  const { nodes, meta } = extractMeta(parsed.nodes);
  const html = renderSlides(nodes, { meta });
  assert(html.includes('<img src="pic.png"'), "the deck has an image to export");
});

// ============================================================
console.log("\n--- Declarations are filtered to what each tag may carry ---");

if (!findChrome()) {
  console.log("  SKIP: Chrome not found");
} else {
  test("an <img> never carries the type it inherited (integration)", async () => {
    // Reported against a real deck: 26 of its 35 export errors were
    // "font-size is not allowed on <img>", and the same for padding,
    // line-height and text-align. The exporter built one style string per node
    // and put it on whatever tag it ended up emitting, so a picture inside a
    // styled container got that container's type — which the subset refuses,
    // taking the whole deck with it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-imgprops-"));
    fs.writeFileSync(path.join(dir, "pic.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAAEAQMAAACTPww9AAAABlBMVEUzZsz///8N3jmNAAAAC0lEQVQI12BggAAAAAgAAS8g3TEAAAAASUVORK5CYII=", "base64"));
    const theme = loadTheme(path.join(__dirname, "..", "themes", "default"));
    const parsed = parseSdoc(
      "# Deck {\n    # Slide {\n        background: pic.png\n\n        Body copy.\n    }\n}"
    );
    assert(parsed.errors.length === 0, "fixture parses");
    const { nodes, meta } = extractMeta(parsed.nodes);
    const { inlineDeckImages } = require("../src/slide-renderer.js");
    const html = inlineDeckImages(
      renderSlides(nodes, { meta, themeCss: theme.themeCss, themeConfig: theme.themeConfig }),
      dir
    ).html;
    const htmlPath = path.join(dir, "deck.html");
    fs.writeFileSync(htmlPath, html, "utf-8");

    try {
      const harvest = await harvestArtifact(htmlPath);
      // Put the type back on, the way a theme that styles the container does.
      let touched = 0;
      const walk = (n) => {
        if (n.tag === "img") {
          Object.assign(n.style, {
            fontSize: "48px", lineHeight: "1.5", textAlign: "center", padding: "10px 20px",
          });
          touched++;
        }
        for (const k of n.children || []) walk(k);
      };
      for (const slide of harvest.slides) walk(slide);
      assert(touched > 0, "the fixture should have an image to style");

      const built = buildArtifact(harvest, { title: "t", theme: theme.themeConfig, now: "2026-01-01T00:00:00Z" });
      assert(built.errors.length === 0,
        "the type must be filtered off the img, not emitted and rejected: " +
        JSON.stringify(built.errors.slice(0, 3)));
      const slideHtml = Object.entries(built.files).find(([f]) => f.endsWith(".html"))[1];
      const imgTag = /<img[^>]*>/.exec(slideHtml);
      assert(imgTag, "an img was emitted");
      for (const prop of ["font-size", "line-height", "text-align", "padding"]) {
        assert(!imgTag[0].includes(prop + ":"), `${prop} should not reach the img: ${imgTag[0]}`);
      }
      assert(imgTag[0].includes("object-fit:"), "the fit it does take is still there");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

if (findChrome()) {
  test("a pseudo-element the theme paints becomes a box of its own (integration)", async () => {
    // A pseudo-element has no node, so a DOM walk cannot see it — and a theme
    // that draws a rule or a disk with one has drawn something the reader sees.
    // Worse than a missing mark: it occupies space, so dropping it displaces
    // whatever shared its box. Reported against a real deck, where losing a
    // cover rule also moved the wordmark beside it to the slide margin.
    const theme = loadTheme(path.join(__dirname, "..", "themes", "default"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-pseudo-"));
    const parsed = parseSdoc("# Deck {\n    # Slide {\n        Body copy here.\n    }\n}");
    assert(parsed.errors.length === 0, "fixture parses");
    const { nodes, meta } = extractMeta(parsed.nodes);
    const html = renderSlides(nodes, {
      meta,
      themeCss: theme.themeCss,
      themeConfig: theme.themeConfig,
      // An absolutely positioned rule, centred on its own height by a translate
      // — the shape that needs both the box and the matrix to land correctly.
      deckCss: ".slide-body { position: relative; }\n" +
        ".slide-body::before { content: \"\"; position: absolute; left: 20px; top: 50px;" +
        " width: 120px; height: 6px; background: rgb(220, 30, 30);" +
        " transform: translate(-10px, -3px); }",
    });
    const htmlPath = path.join(dir, "deck.html");
    fs.writeFileSync(htmlPath, html, "utf-8");
    try {
      const harvest = await harvestArtifact(htmlPath);
      const built = buildArtifact(harvest, {
        title: "t", theme: theme.themeConfig, now: "2026-01-01T00:00:00Z",
      });
      assert(built.errors.length === 0, "exports clean: " + JSON.stringify(built.errors.slice(0, 2)));
      const slideHtml = Object.entries(built.files).find(([f]) => f.endsWith(".html"))[1];
      const box = /<div style="position:absolute;[^"]*background:rgb\(220, 30, 30\)[^"]*"><\/div>/.exec(slideHtml);
      assert(box, "the painted pseudo-element should be emitted as a pinned box:\n" + slideHtml.slice(0, 600));
      // left 20 and top 50, moved by the element's own translate(-10,-3).
      assert(/left:10px/.test(box[0]), "its own translate is applied to x: " + box[0]);
      assert(/top:47px/.test(box[0]), "and to y: " + box[0]);
      assert(/width:120px/.test(box[0]) && /height:6px/.test(box[0]), "sized from the style: " + box[0]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

if (findChrome()) {
  test("a figure set large in its own paragraph keeps its size (integration)", async () => {
    // The subset has no font-size or font-family on a span, so an inline mark
    // set larger is flattened to its parent's type — a 44px figure rendering as
    // 28px body text. When the mark is the whole of its parent it can become a
    // block of its own and look identical.
    const theme = loadTheme(path.join(__dirname, "..", "themes", "default"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-inline-"));
    const parsed = parseSdoc(
      "# Deck {\n    # Slide {\n        **10 W**\n\n        Body copy with `code` inside the sentence.\n    }\n}"
    );
    assert(parsed.errors.length === 0, "fixture parses");
    const { nodes, meta } = extractMeta(parsed.nodes);
    const html = renderSlides(nodes, {
      meta, themeCss: theme.themeCss, themeConfig: theme.themeConfig,
      deckCss: ".slide-body strong { font-size: 64px; color: rgb(0, 200, 210); }",
    });
    const htmlPath = path.join(dir, "deck.html");
    fs.writeFileSync(htmlPath, html, "utf-8");
    try {
      const harvest = await harvestArtifact(htmlPath);
      const built = buildArtifact(harvest, { title: "t", theme: theme.themeConfig, now: "2026-01-01T00:00:00Z" });
      assert(built.errors.length === 0, "exports clean: " + JSON.stringify(built.errors.slice(0, 2)));
      const out = Object.entries(built.files).find(([f]) => f.endsWith(".html"))[1];

      // The standalone figure became its own block and kept its size.
      assert(/font-size:64px/.test(out), "the figure keeps its size:\n" + out.slice(0, 700));

      // The sentence did NOT get split into stacked paragraphs. This export
      // emits flow, not pinned boxes, so breaking a line into blocks would be
      // worse than losing a code span's face.
      const sentence = /<p[^>]*>[^<]*Body copy with/.exec(out);
      assert(sentence, "the sentence is still one element:\n" + out.slice(0, 700));
      assert(/inside the sentence/.test(sentence.input.slice(sentence.index, sentence.index + 400)),
        "and it still runs to the end rather than stacking");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

if (findChrome()) {
  test("tracing pins every box and arranges nothing (integration)", async () => {
    // The opt-in alternative to flow. The subset has no margin, and a container
    // has one gap — which says "space my children equally" and nothing else —
    // so a theme that spaces different children differently cannot be rebuilt
    // from flow properties. Tracing sidesteps the question by copying the
    // answer: every box is pinned where the browser put it.
    //
    // Flat on purpose. A position:absolute box nested in another is placed
    // against that one, so a tree of pinned boxes offsets every child by its
    // parent; each has to be a direct child of a host holding slide coordinates.
    const theme = loadTheme(path.join(__dirname, "..", "themes", "default"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-traced-"));
    const parsed = parseSdoc(fs.readFileSync(EXAMPLE, "utf-8"));
    assert(parsed.errors.length === 0, "the example parses");
    const { nodes, meta } = extractMeta(parsed.nodes);
    const htmlPath = path.join(dir, "deck.html");
    fs.writeFileSync(htmlPath, renderSlides(nodes, {
      meta, themeCss: theme.themeCss, themeJs: theme.themeJs, themeConfig: theme.themeConfig,
    }), "utf-8");
    try {
      const harvest = await harvestArtifact(htmlPath);
      const opts = { title: "T", theme: theme.themeConfig, now: "2026-01-01T00:00:00Z" };
      const flow = buildArtifact(harvest, opts);
      const traced = buildArtifact(harvest, { ...opts, pinAll: true });

      assert(traced.errors.length === 0,
        "a traced deck is still inside the subset: " + JSON.stringify(traced.errors.slice(0, 3)));

      const count = (built, needle) => Object.entries(built.files)
        .filter(([f]) => f.endsWith(".html"))
        .reduce((n, [, b]) => n + (b.split(needle).length - 1), 0);

      assert(count(traced, "position:absolute") > count(flow, "position:absolute"),
        "tracing pins far more than flow does");
      assert(count(traced, "display:flex") < count(flow, "display:flex"),
        "and arranges far less");
      // The section itself must not arrange or pad, or every coordinate inside
      // it is measured from the wrong origin.
      const section = /<section [^>]*>/.exec(
        Object.entries(traced.files).find(([f]) => f.endsWith(".html"))[1]
      )[0];
      assert(!/display:flex/.test(section), "a traced section does not lay out: " + section);
      assert(!/padding:/.test(section), "nor pad: " + section);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}


// --- Traced text that fitted on one line is held to one line ---------------
if (findChrome()) {
  test("traced text that took one line is not left free to wrap (integration)", async () => {
    // Tracing pins a text box at exactly the ink's measured width, with no
    // headroom at all. The artifact's copy of a face is never bit-identical to
    // the harvest browser's, so a fraction of a pixel wider and a line that
    // fitted in the build wraps in the export. Seen on a published deck: a
    // wordmark pinned at 88.09px and a heading at 355.53px both arrived on two
    // lines. Text that was already wrapping must keep wrapping.
    const theme = loadTheme(path.join(__dirname, "..", "themes", "default"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-nowrap-"));
    const long = "This sentence is deliberately long enough that it cannot " +
      "possibly fit on a single line of a slide, so it must wrap across at " +
      "least two lines and keep the freedom to do so after it is exported.";
    const parsed = parseSdoc(
      "# Deck {\n    # Slide {\n        ## Short heading\n\n        " + long + "\n    }\n}"
    );
    assert(parsed.errors.length === 0, "fixture parses");
    const { nodes, meta } = extractMeta(parsed.nodes);
    const htmlPath = path.join(dir, "deck.html");
    fs.writeFileSync(htmlPath, renderSlides(nodes, {
      meta, themeCss: theme.themeCss, themeConfig: theme.themeConfig,
    }), "utf-8");
    try {
      const harvest = await harvestArtifact(htmlPath);
      const traced = buildArtifact(harvest, {
        title: "t", theme: theme.themeConfig, now: "2026-01-01T00:00:00Z", pinAll: true,
      });
      const out = Object.entries(traced.files).find(([f]) => f.endsWith(".html"))[1];
      const h3 = /<h3[^>]*>/.exec(out);
      assert(h3, "the heading is in the export:\n" + out.slice(0, 400));
      assert(/white-space:nowrap/.test(h3[0]),
        "a heading that took one line is held to one line: " + h3[0]);

      const para = (/<p[^>]*>[^<]*This sentence[^<]*/.exec(out) || [""])[0];
      assert(para, "the paragraph is in the export");
      assert(!/white-space:nowrap/.test(para),
        "but a paragraph that already wrapped is left free to wrap: " + para.slice(0, 160));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

// --- An inline mark keeps a colour of its own ------------------------------
if (findChrome()) {
  test("an inline mark keeps its own colour (integration)", async () => {
    // The colour of a run was kept only for <span> and <code>, by tag. A theme
    // that colours one word with `h3 strong { color: ... }` lost it: <strong>
    // became a bare <b> and the word inherited the heading's colour. Found by
    // eye on a published deck, where one cyan word arrived grey.
    const theme = loadTheme(path.join(__dirname, "..", "themes", "default"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-markcolour-"));
    const parsed = parseSdoc("# Deck {\n    # Slide {\n        ## Per-block energy, ours — **simulated**\n    }\n}");
    assert(parsed.errors.length === 0, "fixture parses");
    const { nodes, meta } = extractMeta(parsed.nodes);
    const html = renderSlides(nodes, {
      meta, themeCss: theme.themeCss, themeConfig: theme.themeConfig,
      deckCss: ".slide h3 { color: rgb(126, 142, 149); } .slide h3 strong { color: rgb(0, 200, 220); }",
    });
    const htmlPath = path.join(dir, "deck.html");
    fs.writeFileSync(htmlPath, html, "utf-8");
    try {
      const harvest = await harvestArtifact(htmlPath);
      const built = buildArtifact(harvest, { title: "t", theme: theme.themeConfig, now: "2026-01-01T00:00:00Z" });
      const out = Object.entries(built.files).find(([f]) => f.endsWith(".html"))[1];
      assert(/rgb\(0, 200, 220\)/.test(out),
        "the marked word keeps the colour the theme gave it:\n" + (/<h3[^>]*>.*?<\/h3>/s.exec(out) || [""])[0]);
      assert(/<span style="color:rgb\(0, 200, 220\)">simulated<\/span>/.test(out) ||
             /<b><span style="color:rgb\(0, 200, 220\)">simulated<\/span><\/b>/.test(out) ||
             /<span style="color:rgb\(0, 200, 220\)"><b>simulated<\/b><\/span>/.test(out),
        "and it is the word that carries it, not the heading");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

// --- A shadow is paint, and paint was not travelling -----------------------
if (findChrome()) {
  test("a box-shadow survives the export, in the order the grammar wants (integration)", async () => {
    // box-shadow is in the subset — `[inset] LEN LEN [LEN [LEN]] COLOR` on a
    // div, a text element, an image or a table — and was neither harvested nor
    // emitted, so every shadow in every deck was lost. Nothing moves when a
    // shadow goes, so no positional check could ever see it: a raised card
    // simply stops being raised.
    //
    // The browser serialises the colour FIRST, which is the one order the
    // grammar refuses, so this also pins the reordering.
    const theme = loadTheme(path.join(__dirname, "..", "themes", "default"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-shadow-"));
    const parsed = parseSdoc("# Deck {\n    # One {\n        Body copy.\n    }\n}");
    assert(parsed.errors.length === 0, "fixture parses");
    const { nodes, meta } = extractMeta(parsed.nodes);
    const htmlPath = path.join(dir, "deck.html");
    fs.writeFileSync(htmlPath, renderSlides(nodes, {
      meta, themeCss: theme.themeCss, themeConfig: theme.themeConfig,
      // A painted box so it is certainly emitted, and a shadow past every limit
      // so the clamping is exercised rather than assumed.
      // On the heading, not on .slide-head: that wrapper is display:contents in
      // this theme, so it has no box of its own and emits none.
      deckCss: ".slide h2 { background: rgb(250, 250, 250); " +
        "box-shadow: rgba(0, 0, 0, 0.25) 0px 400px 900px 99px; }",
    }), "utf-8");
    try {
      const harvest = await harvestArtifact(htmlPath);
      const built = buildArtifact(harvest, { title: "t", theme: theme.themeConfig, now: "2026-01-01T00:00:00Z" });
      const out = Object.entries(built.files).find(([f]) => f.endsWith(".html"))[1];
      const shadow = /box-shadow:([^;"]*)/.exec(out);
      assert(shadow, "the shadow reached the export:\n" + out.slice(0, 500));
      const v = shadow[1].trim();
      assert(/rgba?\([^)]*\)$/.test(v), "with its colour last, as the grammar requires: " + v);
      assert(/^0px 64px 160px 32px /.test(v),
        "and every length clamped into range rather than dropped: " + v);
      assert(built.errors.length === 0, "and the result is inside the subset: " + JSON.stringify(built.errors.slice(0, 2)));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

// --- Two more the subset has and the exporter never wrote ------------------
if (findChrome()) {
  test("align-self and text-shadow reach the export (integration)", async () => {
    // Both are in the subset and neither was harvested, so both were lost in
    // silence. align-self matters beyond its own sake: converting a theme's
    // `margin-inline: auto` centring to `align-self: center` is the standard
    // move for making a theme flow-ready, and it was a no-op here — the
    // replacement for the dropped property was dropped too.
    //
    // text-shadow is the box-shadow story again, with a tighter blur ceiling:
    // 64 for text against 160 for a box.
    const theme = loadTheme(path.join(__dirname, "..", "themes", "default"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-selfshadow-"));
    const parsed = parseSdoc("# Deck {\n    # One {\n        Body copy.\n    }\n}");
    assert(parsed.errors.length === 0, "fixture parses");
    const { nodes, meta } = extractMeta(parsed.nodes);
    const htmlPath = path.join(dir, "deck.html");
    fs.writeFileSync(htmlPath, renderSlides(nodes, {
      meta, themeCss: theme.themeCss, themeConfig: theme.themeConfig,
      deckCss: ".slide h2 { align-self: center; " +
        "text-shadow: rgba(0, 0, 0, 0.4) 2px 3px 200px; }",
    }), "utf-8");
    try {
      const harvest = await harvestArtifact(htmlPath);
      const built = buildArtifact(harvest, { title: "t", theme: theme.themeConfig, now: "2026-01-01T00:00:00Z" });
      const out = Object.entries(built.files).find(([f]) => f.endsWith(".html"))[1];

      assert(/align-self:center/.test(out),
        "the heading places itself:\n" + (/<h2[^>]*>/.exec(out) || [""])[0]);

      const ts = /text-shadow:([^;"]*)/.exec(out);
      assert(ts, "and carries its text shadow: " + (/<h2[^>]*>/.exec(out) || [""])[0]);
      assert(/rgba?\([^)]*\)$/.test(ts[1].trim()), "with the colour last: " + ts[1]);
      assert(/\b64px\b/.test(ts[1]), "and the blur at the 64px text ceiling, not the box's 160: " + ts[1]);
      assert(built.errors.length === 0, "inside the subset: " + JSON.stringify(built.errors.slice(0, 2)));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

// --- A gap too wide for padding is given back as a spacer ------------------
if (findChrome()) {
  test("a leading gap wider than padding allows becomes a spacer (integration)", async () => {
    // A ::before in flow holds space open on its host's first line. Pinning it
    // hands that space back, so the words slide left by its width, and the
    // compensation was padding — which the format caps at 256px. On a real
    // cover a 646px mark left the words 408px adrift, the largest error in
    // that deck, and all the exporter could do was say so.
    //
    // A gap that size is expressible, just not as padding: a flex row with a
    // sized spacer puts the words where the deck has them and still reflows.
    const theme = loadTheme(path.join(__dirname, "..", "themes", "default"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-spacer-"));
    const parsed = parseSdoc("# Deck {\n    # One {\n        Body copy.\n    }\n}");
    assert(parsed.errors.length === 0, "fixture parses");
    const { nodes, meta } = extractMeta(parsed.nodes);
    const htmlPath = path.join(dir, "deck.html");
    fs.writeFileSync(htmlPath, renderSlides(nodes, {
      meta, themeCss: theme.themeCss, themeConfig: theme.themeConfig,
      // Far past the 256px cap, and painted so it travels as a box of its own.
      deckCss: "h2::before { content: ''; display: inline-block; width: 640px; " +
        "height: 20px; background: rgb(10, 120, 200); }",
    }), "utf-8");
    try {
      const harvest = await harvestArtifact(htmlPath);
      const built = buildArtifact(harvest, { title: "t", theme: theme.themeConfig, now: "2026-01-01T00:00:00Z" });
      const out = Object.entries(built.files).find(([f]) => f.endsWith(".html"))[1];

      const spacer = /<div style="width:(\d+)px"><\/div>/.exec(out);
      assert(spacer, "a sized spacer stands in for the gap:\n" + out.slice(0, 700));
      assert(parseInt(spacer[1], 10) > 256,
        "and it is the full width, not the capped one: " + spacer[1]);
      assert(!/padding:0px 0px 0px 256px/.test(out),
        "so the padding is not quietly clipped instead");
      assert(built.errors.length === 0,
        "and the slide is inside the subset: " + JSON.stringify(built.errors.slice(0, 2)));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

// --- A painted pseudo-element lands in its host's layer --------------------
if (findChrome()) {
  test("a pseudo-element is not painted over by a later backdrop (integration)", async () => {
    // Every synthesised pseudo box used to be emitted before all the content,
    // so it sat behind it. That is right for a band drawn behind its own text
    // and wrong the moment a full-bleed backdrop is listed later: paint order
    // is source order and there is no z-index, so the backdrop covered it.
    // Seen on a published cover — the rule under the wordmark was drawn and
    // then hidden.
    const theme = loadTheme(path.join(__dirname, "..", "themes", "default"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-pseudoz-"));
    const parsed = parseSdoc(
      "# Deck {\n    # One {\n        config: cover\n\n        Body copy.\n    }\n}"
    );
    assert(parsed.errors.length === 0, "fixture parses: " + JSON.stringify(parsed.errors.slice(0, 2)));
    const { nodes, meta } = extractMeta(parsed.nodes);
    const htmlPath = path.join(dir, "deck.html");
    fs.writeFileSync(htmlPath, renderSlides(nodes, {
      meta, themeCss: theme.themeCss, themeConfig: theme.themeConfig,
      // A rule under the heading, and a full-bleed backdrop after it in the
      // deck's own order.
      deckCss:
        "h2 { position: relative; }" +
        "h2::after { content: ''; position: absolute; left: 0; bottom: -12px; " +
        "width: 300px; height: 6px; background: rgb(200, 30, 30); }" +
        ".slide::before { content: ''; position: absolute; left: 0; top: 0; " +
        "width: 1920px; height: 1080px; background: rgb(0, 0, 0); }",
    }), "utf-8");
    try {
      const harvest = await harvestArtifact(htmlPath);
      const built = buildArtifact(harvest, { title: "t", theme: theme.themeConfig, now: "2026-01-01T00:00:00Z" });
      const out = Object.entries(built.files).find(([f]) => f.endsWith(".html"))[1];

      const rule = out.indexOf("rgb(200, 30, 30)");
      const heading = out.indexOf("<h2");
      assert(rule >= 0, "the rule is in the export:\n" + out.slice(0, 600));
      assert(heading >= 0, "and so is its host");
      // Paint order is source order: the rule must come after its host, not
      // before everything on the slide.
      assert(rule > heading,
        "the rule is emitted with its host rather than behind all the content");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

// --- A pinned box is lifted out of the flow it was nested in ---------------
if (findChrome()) {
  test("a pinned box is emitted as a direct child of the section (integration)", async () => {
    // The page does not place a pinned box the way CSS does. Measured on a
    // live artifact, one variable at a time: the same box directly under the
    // section lands where its coordinates say, and buried in two flow divs it
    // lands near the bottom of the slide — the page adds the offset its flow
    // parent would have had. The coordinates are already the slide's, so the
    // nesting is the whole error.
    //
    // The same nesting also made the box change its parent's size and stop a
    // sibling centring, so this is one cause behind two symptoms.
    const theme = loadTheme(path.join(__dirname, "..", "themes", "default"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-hoist-"));
    // A columns layout, so there is real nesting to be buried in: the slide
    // holds .columns, which holds a .column, which holds the paragraph. A
    // pseudo-element would not do — those are emitted at the top of the slide
    // already, so a fixture built from one passes whether or not this works.
    const parsed = parseSdoc(
      "# Deck {\n    # One {\n        config: columns\n\n" +
      "        # A {\n            Text one.\n        }\n" +
      "        # B {\n            Text two.\n        }\n    }\n}"
    );
    assert(parsed.errors.length === 0, "fixture parses: " + JSON.stringify(parsed.errors.slice(0, 2)));
    const { nodes, meta } = extractMeta(parsed.nodes);
    const htmlPath = path.join(dir, "deck.html");
    fs.writeFileSync(htmlPath, renderSlides(nodes, {
      meta, themeCss: theme.themeCss, themeConfig: theme.themeConfig,
      deckCss: ".column p { position: absolute; left: 40px; top: 20px; " +
        "width: 200px; height: 16px; background: rgb(10, 20, 30); }",
    }), "utf-8");
    try {
      const harvest = await harvestArtifact(htmlPath);
      const built = buildArtifact(harvest, { title: "t", theme: theme.themeConfig, now: "2026-01-01T00:00:00Z" });
      const out = Object.entries(built.files).find(([f]) => f.endsWith(".html"))[1];

      // Every pinned box must sit at the top level of the section: one line,
      // not indented inside another element's subtree.
      const lines = out.split("\n");
      let depth = 0;
      const nested = [];
      for (const line of lines) {
        const isPinned = /^<\w+[^>]*position:absolute/.test(line.trim());
        if (isPinned && depth > 0) nested.push(line.trim().slice(0, 90));
        const opens = (line.match(/<div\b[^>]*>/g) || []).length;
        const closes = (line.match(/<\/div>/g) || []).length;
        depth += opens - closes;
      }
      assert(nested.length === 0,
        "a pinned box is still nested in flow content, where the page offsets it:\n  " +
          nested.join("\n  "));
      assert(built.errors.length === 0, "and the slide is inside the subset");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

// --- A positioned box keeps the edge it was anchored to --------------------
if (findChrome()) {
  test("a box anchored at the bottom is exported anchored at the bottom (integration)", async () => {
    // getComputedStyle resolves top AND bottom to used lengths on a positioned
    // element, so neither says which edge the author chose — the cascade does.
    // It matters because the export removes chrome from inside such a box: the
    // slide footer holds two navigation chevrons set far larger than its text,
    // and pinned by the top coordinate it measured with them, the footer rose
    // 15px on every slide of every deck. It also must not keep its measured
    // height, or anchoring it to the bottom decides nothing.
    const theme = loadTheme(path.join(__dirname, "..", "themes", "default"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-anchor-"));
    const parsed = parseSdoc("# Deck {\n\n@meta {\n    company: Acme\n}\n\n    # One {\n        Body.\n    }\n}");
    assert(parsed.errors.length === 0, "fixture parses");
    const { nodes, meta } = extractMeta(parsed.nodes);
    const htmlPath = path.join(dir, "deck.html");
    fs.writeFileSync(htmlPath, renderSlides(nodes, {
      meta, themeCss: theme.themeCss, themeConfig: theme.themeConfig,
    }), "utf-8");
    try {
      const harvest = await harvestArtifact(htmlPath);
      const built = buildArtifact(harvest, { title: "t", theme: theme.themeConfig, now: "2026-01-01T00:00:00Z" });
      const out = Object.entries(built.files).find(([f]) => f.endsWith(".html"))[1];
      const footer = /<div style="position:absolute[^"]*display:flex[^"]*"/.exec(out);
      assert(footer, "the footer row is in the export:\n" + out.slice(0, 500));
      assert(/bottom:30px/.test(footer[0]),
        "and carries the bottom the deck anchored it with: " + footer[0]);
      assert(!/top:/.test(footer[0]),
        "instead of a top measured against contents that do not travel: " + footer[0]);
      assert(!/height:/.test(footer[0]),
        "and is free to grow upward from it: " + footer[0]);

      // A box the deck positioned from the top is untouched by any of this.
      const tops = out.match(/<div style="position:absolute[^"]*top:[^"]*"/g) || [];
      for (const t of tops) {
        assert(!/bottom:/.test(t), "a top-anchored box is not also given a bottom: " + t);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

// --- What an export lost, as a number ------------------------------------
if (findChrome()) {
  test("the engine's own footer chrome costs a deck no dropped margins (integration)", async () => {
    // .sdoc-company-footer and .slide-indicator carried margins, and the footer
    // is on every slide — so every deck paid two dropped margins per slide for
    // spacing the engine itself asked for. 42 of them on a 21-slide deck, which
    // a theme author cannot fix from their side. The footer row spaces its
    // parts with a gap now, which the subset can carry.
    const theme = loadTheme(path.join(__dirname, "..", "themes", "default"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-chrome-"));
    const parsed = parseSdoc(
      "# Deck {\n\n@meta {\n    company: Acme Corp\n}\n\n    # One {\n        Body.\n    }\n    # Two {\n        Body.\n    }\n}"
    );
    assert(parsed.errors.length === 0, "fixture parses");
    const { nodes, meta } = extractMeta(parsed.nodes);
    const htmlPath = path.join(dir, "deck.html");
    fs.writeFileSync(htmlPath, renderSlides(nodes, {
      meta, themeCss: theme.themeCss, themeConfig: theme.themeConfig,
    }), "utf-8");
    try {
      const harvest = await harvestArtifact(htmlPath);
      const built = buildArtifact(harvest, { title: "t", theme: theme.themeConfig, now: "2026-01-01T00:00:00Z" });
      // Only dropped spacing. The footer's parts also warn for being under the
      // 24px the type asks for, which is deliberate — footer chrome is small,
      // and that floor is advisory in the format's own words.
      const chrome = built.warnings.filter(
        (w) => w.kind === "margin-dropped" &&
          /sdoc-company-footer|slide-indicator|sdoc-confidential-notice/.test(w.message)
      );
      assert(chrome.length === 0,
        "the footer's own parts drop no spacing: " + chrome.map((w) => w.message).join("; "));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the manifest reports what the export lost, per kind and per slide (integration)", async () => {
    // The console stops at 25 warnings and says "and N more", so it cannot be
    // measured from. Counting dropped margins meant exporting twice and
    // subtracting a traced run from a flow one, because tracing never drops
    // one. The manifest carries the whole list, tagged.
    const theme = loadTheme(path.join(__dirname, "..", "themes", "default"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-fidelity-"));
    const parsed = parseSdoc("# Deck {\n    # One {\n        Body.\n    }\n    # Two {\n        Body.\n    }\n}");
    assert(parsed.errors.length === 0, "fixture parses");
    const { nodes, meta } = extractMeta(parsed.nodes);
    const htmlPath = path.join(dir, "deck.html");
    fs.writeFileSync(htmlPath, renderSlides(nodes, {
      meta, themeCss: theme.themeCss, themeConfig: theme.themeConfig,
    }), "utf-8");
    try {
      const harvest = await harvestArtifact(htmlPath);
      const opts = { title: "t", theme: theme.themeConfig, now: "2026-01-01T00:00:00Z" };
      const flow = buildArtifact(harvest, opts).manifest.fidelity;
      const traced = buildArtifact(harvest, { ...opts, pinAll: true }).manifest.fidelity;

      assert(flow.mode === "flow" && traced.mode === "traced", "each export says which mode it was");
      assert(flow.warnings.length === flow.total, "the list is whole, not truncated");
      assert(flow.byKind["margin-dropped"] > 0, "a flow export drops margins and counts them");
      // The very arithmetic this field exists to make unnecessary.
      assert(!traced.byKind["margin-dropped"], "a traced export drops none, so the count is a flow measure");

      const slides = Object.keys(flow.droppedSpacingBySlide);
      assert(slides.length > 0, "and the spacing lost is totalled per slide");
      assert(slides.every((k) => flow.droppedSpacingBySlide[k] > 0), "in pixels, so slides can be ranked");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

// --- A labelled drawing is painted, because the viewer will not load its font --
if (findChrome()) {
  test("a labelled drawing is painted rather than carried as markup (integration)", async () => {
    // The format treats a drawing as one opaque graphic and never loads a font
    // inside one, so a <text> label carried as markup arrives in whatever face
    // the viewer falls back to. The drawing is painted during the harvest
    // instead, where the deck's own faces are live.
    const theme = loadTheme(path.join(__dirname, "..", "themes", "default"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-svglabel-"));
    const parsed = parseSdoc(
      "# Deck {\n    # Slide {\n        Body copy.\n\n        ```svg\n" +
      '        <svg viewBox="0 0 400 100" width="400" height="100" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="d">\n' +
      '        <rect x="10" y="10" width="120" height="60" fill="#0c2238"/>\n' +
      '        <text x="200" y="50" font-size="20">LABEL</text>\n' +
      "        </svg>\n        ```\n    }\n}"
    );
    assert(parsed.errors.length === 0, "fixture parses");
    const { nodes, meta } = extractMeta(parsed.nodes);
    const html = renderSlides(nodes, { meta, themeCss: theme.themeCss, themeConfig: theme.themeConfig });
    const htmlPath = path.join(dir, "deck.html");
    fs.writeFileSync(htmlPath, html, "utf-8");
    try {
      const harvest = await harvestArtifact(htmlPath);
      const built = buildArtifact(harvest, { title: "t", theme: theme.themeConfig, now: "2026-01-01T00:00:00Z" });
      const out = Object.entries(built.files).find(([f]) => f.endsWith(".html"))[1];
      assert(/<img\b/.test(out), "the drawing is in the export, as a picture:\n" + out.slice(0, 600));
      assert(!/<text[\s>]/.test(out), "no label is left to fall back to another face");
      const png = [...built.assets.values()].find((v) => /^data:image\/png/.test(v));
      assert(png, "and the picture was written out as an asset");
      assert(png.length > 500, "which holds an actual image, not an empty canvas");
      assert(!built.warnings.some((w) => /could not be painted/.test(w.message)),
        "and nothing warns that it could not be painted");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

// --- and the faces its labels ask for travel with it ----------------------
const PROBE_FONTS = [
  "/System/Library/Fonts/Supplemental/Georgia.ttf",
  "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
];
const probeFont = PROBE_FONTS.find((f) => fs.existsSync(f));

if (findChrome() && probeFont) {
  test("a painted label uses the deck's webfont, not a fallback (integration)", async () => {
    // Painting alone is not enough, and this is the half that is easy to miss.
    // An <svg> handed to an <img> is an isolated document: it cannot see the
    // page's @font-face rules, so the raster falls back exactly as the viewer
    // would and the defect survives the fix. Measured before this guard
    // existed: the PNG of a webfont label was byte-identical to the fallback.
    //
    // So: two drawings, same string, same size. One asks for a face the deck
    // loads from a data: URL, the other for a name nothing resolves. If the
    // faces travel into the drawing the two pictures differ; if they do not,
    // both fall back and the bytes match.
    const theme = loadTheme(path.join(__dirname, "..", "themes", "default"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-svgface-"));
    const b64 = fs.readFileSync(probeFont).toString("base64");
    const draw = (family) =>
      '        <svg viewBox="0 0 400 100" width="400" height="100" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="d">\n' +
      '        <text x="10" y="60" font-size="36" font-family="' + family + '">Hamburgefonstiv</text>\n' +
      "        </svg>";
    const parsed = parseSdoc(
      "# Deck {\n    # Slide {\n        A.\n\n        ```svg\n" + draw("SdocProbe, sans-serif") +
      "\n        ```\n    }\n    # Slide {\n        B.\n\n        ```svg\n" + draw("NoSuchFaceXYZ, sans-serif") +
      "\n        ```\n    }\n}"
    );
    assert(parsed.errors.length === 0, "fixture parses");
    const { nodes, meta } = extractMeta(parsed.nodes);
    const html = renderSlides(nodes, {
      meta, themeCss: theme.themeCss, themeConfig: theme.themeConfig,
      deckCss: '@font-face { font-family: "SdocProbe"; src: url(data:font/ttf;base64,' + b64 + ') format("truetype"); }',
    });
    const htmlPath = path.join(dir, "deck.html");
    fs.writeFileSync(htmlPath, html, "utf-8");
    try {
      const harvest = await harvestArtifact(htmlPath);
      const built = buildArtifact(harvest, { title: "t", theme: theme.themeConfig, now: "2026-01-01T00:00:00Z" });
      const pngs = [...built.assets.values()].filter((v) => /^data:image\/png/.test(v));
      assert(pngs.length === 2, "both drawings were painted, got " + pngs.length);
      assert(pngs[0] !== pngs[1],
        "the webfont label differs from the fallback label; identical bytes mean the faces never reached the drawing");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

if (findChrome()) {
  test("an unlabelled drawing stays markup, and its var() is resolved (integration)", async () => {
    // An <svg> is display:inline by default and its own <text> counts towards
    // textContent, so the block holding a labelled diagram looked like a run of
    // text: it was emitted as a <p> of those labels and the drawing was never
    // visited. Three of a real deck's technical diagrams vanished that way, and
    // the only ones that survived were two a stylesheet had made display:block
    // for unrelated reasons — which is why no example here caught it.
    //
    // And a drawing is carried as markup and shown as an image, so nothing on
    // the far side has the stylesheet that defined a custom property. The
    // subset says as much: no var(). Each is resolved here, in the live page.
    const theme = loadTheme(path.join(__dirname, "..", "themes", "default"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-svgtext-"));
    const parsed = parseSdoc(
      "# Deck {\n    # Slide {\n        Body copy.\n\n        ```svg\n" +
      '        <svg viewBox="0 0 400 100" width="100%" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="d">\n' +
      '        <rect x="10" y="10" width="120" height="60" fill="var(--probe-fill)" stroke="#333"/>\n' +
      "        </svg>\n        ```\n    }\n}"
    );
    assert(parsed.errors.length === 0, "fixture parses: " + JSON.stringify(parsed.errors.slice(0, 2)));
    const { nodes, meta } = extractMeta(parsed.nodes);
    const html = renderSlides(nodes, {
      meta, themeCss: theme.themeCss, themeConfig: theme.themeConfig,
      deckCss: ".slide { --probe-fill: rgb(12, 34, 56); }",
    });
    const htmlPath = path.join(dir, "deck.html");
    fs.writeFileSync(htmlPath, html, "utf-8");
    try {
      const harvest = await harvestArtifact(htmlPath);
      const built = buildArtifact(harvest, { title: "t", theme: theme.themeConfig, now: "2026-01-01T00:00:00Z" });
      assert(built.errors.length === 0, "exports clean: " + JSON.stringify(built.errors.slice(0, 2)));
      const out = Object.entries(built.files).find(([f]) => f.endsWith(".html"))[1];
      assert(/<svg[\s>]/.test(out), "the drawing is in the export:\n" + out.slice(0, 500));
      assert(/<rect\b/.test(out), "and its shapes, not just its labels");
      assert(!/<img\b/.test(out), "an unlabelled drawing stays markup, which keeps it vector");
      assert(!/var\(/.test(out), "no custom property survives: " + (/var\([^)]*\)/.exec(out) || [""])[0]);
      assert(/rgb\(12, 34, 56\)/.test(out), "resolved to the literal the page computed");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("the browser-half scripts keep their regex escapes", () => {
  // Both harvests are held in template literals, which eat any escape they do
  // not recognise: a `\\s` written once arrives in the page as a bare `s`, so
  // `replace(/\\s+/g, " ")` silently becomes "replace every letter s with a
  // space". It has shipped that way once — a filmstrip rendering "Purpose" as
  // "Purpo e" in every deck — and nearly again here. The source has to double
  // every backslash, and nothing but reading the evaluated script proves it.
  for (const file of ["slide-artifact.js", "slide-geometry.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", file), "utf-8");
    // The character class below is matched literally, not interpreted: a bare
    // "s+" where a whitespace class was meant is the signature of the bug.
    const broken = /[/(]s\+[/)]/.test(src.replace(/\\\\s/g, "\u0000"));
    assert(!broken, `${file} looks like it lost a backslash before an s`);
    // And the real thing is present, doubled.
    assert(/\\\\s\+/.test(src), `${file} should carry a doubled whitespace class`);

    // A backtick inside the template literal simply ends it, and the error
    // lands on whatever word follows — nowhere near the comment that caused it.
    // Three times while writing this, all in prose naming a CSS property.
    const lines = src.split("\n");
    const open = lines.findIndex((l) => /_SCRIPT = `/.test(l));
    const close = lines.findIndex((l, i) => i > open && l === "`;");
    if (open >= 0 && close > open) {
      const stray = [];
      for (let i = open + 1; i < close; i++) {
        if (lines[i].includes("`")) stray.push(`${file}:${i + 1}`);
      }
      assert(stray.length === 0, `a backtick ends the script early at ${stray.join(", ")}`);
    }
  }
});

test("the notes limit counts characters, not the escaping around them", () => {
  // Found on a real deck: five slides refused with "speaker notes are 4,140
  // characters; the limit is 4,000", all of them marginal. The exporter
  // truncates to exactly 4,000 and then escapes, so an ampersand in the notes
  // became `&amp;` and the validator counted the file rather than the content.
  // Every one of those decks was inside the limit as a reader would count it.
  const plain = "x&".repeat(1995);           // 3,990 characters
  const escaped = plain.replace(/&/g, "&amp;");
  assert(escaped.length > MAX_NOTES, "the escaped form is what used to be counted");
  const r = validateSlideHtml(`<section id="s1"><aside>${escaped}</aside></section>`, { slide: "s1" });
  assert(!r.errors.some((e) => /speaker notes/.test(e.message)),
    "within the limit as a reader counts it: " + JSON.stringify(r.errors.slice(0, 2)));
});

test("notes genuinely over the limit are still refused", () => {
  const tooLong = "y".repeat(MAX_NOTES + 50);
  const r = validateSlideHtml(`<section id="s1"><aside>${tooLong}</aside></section>`, { slide: "s1" });
  assert(r.errors.some((e) => /speaker notes/.test(e.message)), "the limit still bites");
});

test("over-long notes are cut with a warning rather than refused", () => {
  // The exporter's half: it truncates and says so, so a long note costs a
  // warning and a trimmed aside instead of an export that writes nothing.
  const { decodeEntities } = require("../src/slide-artifact-validate.js");
  assert(decodeEntities("a &amp; b") === "a & b", "entities decode");
  assert(decodeEntities("&#39;q&#39;") === "'q'", "numeric entities decode");
  assert(decodeEntities("&notareal;") === "&notareal;", "an unknown entity is left alone");
});

test("a color-mix() computed value becomes a colour the subset has", () => {
  // Chrome serialises `color-mix(in srgb, var(--cyan) 10%, transparent)` as
  // `color(srgb 0 0.819608 0.854902 / 0.1)`. The subset has no color()
  // function, so a theme using increasingly ordinary CSS was refused outright.
  const { srgbToRgba } = require("../src/slide-artifact-validate.js");
  assert(srgbToRgba("color(srgb 0 0.819608 0.854902 / 0.1)") === "rgba(0, 209, 218, 0.1)",
    "converted with alpha: " + srgbToRgba("color(srgb 0 0.819608 0.854902 / 0.1)"));
  assert(srgbToRgba("color(srgb 1 0 0)") === "rgb(255, 0, 0)", "no alpha means opaque");
  assert(srgbToRgba("rgb(1, 2, 3)") === null, "anything else is left alone");
  const r = validateSlideHtml(
    '<section id="s1"><p style="background:color(srgb 0 0.82 0.85 / 0.1)">x</p></section>',
    { slide: "s1" }
  );
  assert(!r.errors.some((e) => /colour or a gradient/.test(e.message)),
    "the validator knows the shape too: " + JSON.stringify(r.errors));
});

// ============================================================
// Both harvests are written as template literals, so a backslash written once
// arrives in the page halved: "\\s" becomes a bare "s", and a lone "\\n"
// inside a string ends the line and the script with it. The browser's only
// report of that is "the page was serialised before it reported its geometry",
// which names neither the file nor the character. This parses what actually
// reaches the page, and needs no browser to do it.
console.log("\n--- The injected harvests are valid JavaScript ---");

function resolvedScript(script) {
  // ${SENTINEL} is interpolated before injection; the rest is already resolved.
  return script.replace(/\$\{SENTINEL\}/g, "SENTINEL");
}

for (const [name, script] of [
  ["slide-artifact.js ARTIFACT_SCRIPT", ARTIFACT_SCRIPT],
  ["slide-geometry.js MEASURE_SCRIPT", MEASURE_SCRIPT],
]) {
  test(`${name} parses as the page will see it`, () => {
    const body = resolvedScript(script);
    try {
      new Function(body);
    } catch (e) {
      // Point at the damage rather than at the whole script.
      const line = /position (\d+)/.exec(e.message);
      const where = line ? body.slice(Math.max(0, +line[1] - 80), +line[1] + 80) : "";
      throw new Error(`${e.message}${where ? " near: " + JSON.stringify(where) : ""}`);
    }
  });
}

test("a harvest carries no backtick, which would end the script early", () => {
  for (const [name, script] of [
    ["ARTIFACT_SCRIPT", ARTIFACT_SCRIPT],
    ["MEASURE_SCRIPT", MEASURE_SCRIPT],
  ]) {
    assert(!script.includes("\u0060"), `${name} holds a backtick`);
  }
});

// ============================================================
console.log("\n--- Measuring a named subset of a deck ---");

const { narrowToSlides } = require("../tools/artifact-fidelity.js");

function deckNodes(src) {
  const parsed = parseSdoc(src);
  assert(parsed.errors.length === 0, "fixture parses");
  return extractMeta(parsed.nodes).nodes;
}

const SUBSET_DECK =
  "# Deck {\n    # One @alpha {\n        A.\n    }\n    # Two @beta {\n        B.\n    }\n" +
  "    # Three @gamma {\n        C.\n    }\n}";

test("narrowing a deck keeps the slides asked for and drops the rest", () => {
  // A deck with its images inlined is tens of megabytes, and the harness builds
  // it twice. Narrowing the measurement alone would save almost nothing — the
  // cost is the build — so the slides are cut before anything is rendered.
  const out = narrowToSlides(deckNodes(SUBSET_DECK), new Set(["alpha", "gamma"]));
  const ids = out[0].children.filter((n) => n.type === "scope").map((n) => n.id);
  assert(ids.includes("alpha") && ids.includes("gamma"), "the named slides are kept: " + ids.join(","));
  assert(!ids.includes("beta"), "and the others are not: " + ids.join(","));
});

test("narrowing refuses an id no slide has, and says what the deck does have", () => {
  // A filter that matches nothing measures nothing and reports a flawless
  // deck. Same empty-set trap as a guard that cannot fail.
  let err = null;
  try {
    narrowToSlides(deckNodes(SUBSET_DECK), new Set(["alpha", "delta"]));
  } catch (e) {
    err = e;
  }
  assert(err, "an unknown id is refused rather than silently matching nothing");
  assert(/"delta"/.test(err.message), "naming the one that is wrong: " + err.message);
  assert(!/"alpha"/.test(err.message), "and not the one that is right: " + err.message);
  assert(/alpha, beta, gamma/.test(err.message), "and listing the deck's own: " + err.message);
});

// ============================================================
console.log("\n--- A harvest is finished only when it has reported ---");

test("the injected script's own source does not count as a finished harvest", () => {
  // The sentinel string lives in the script that writes it, so a page that had
  // merely been serialised contained it already. The poll took that for a
  // finished measurement, returned the DOM, and the caller then failed with
  // "the page was serialised before it reported its geometry" — which reads as
  // contention. Worse, it meant the growing retry window was never waited out.
  const page = "<html><body><script>" + MEASURE_SCRIPT + "</script></body></html>";
  assert(page.includes(SENTINEL), "the script source does carry the sentinel");
  assert(!harvestComplete(page, "sdoc-geometry"),
    "but a page that has only been serialised has not reported");
});

test("a harvest that did report is recognised", () => {
  const page = "<html><body><script>" + MEASURE_SCRIPT + "</script>" +
    '<script type="application/json" id="sdoc-geometry">{"box":{}}\n/*' + SENTINEL + "*/</script></body></html>";
  assert(harvestComplete(page, "sdoc-geometry"), "the result element is there and complete");
  assert(!harvestComplete(page, "sdoc-artifact"), "and it is matched by id, not by any result at all");
});

test("a result element without its sentinel is not finished", () => {
  // Chrome serialised mid-write: the element exists, the JSON is truncated.
  const page = '<script type="application/json" id="sdoc-geometry">{"box":{"w":19';
  assert(!harvestComplete(page, "sdoc-geometry"), "a truncated result is not a result");
});

test("the virtual-time budget grows with the attempt, as the wall clock does", () => {
  // Both budgets have to widen or the retry is theatre: when the virtual-time
  // budget runs out Chrome serialises what it has and exits, so re-running on
  // the same budget fails in the same place. Three identical failures on a
  // large deck looked like contention and were not.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "slide-geometry.js"), "utf-8");
  const at = src.indexOf('"--virtual-time-budget="');
  assert(at >= 0, "the budget is still built in slide-geometry.js");
  // The expression spans lines and holds commas of its own, so take the whole
  // argument up to the next line that closes it rather than matching a shape.
  const expr = src.slice(at, src.indexOf("\n", src.indexOf("),", at)));
  assert(/attempt/.test(expr),
    "and it scales with the attempt, not just the page size: " + expr.replace(/\s+/g, " "));
});

// ============================================================
Promise.all(asyncTests).then(() => {
  console.log("\n" + "=".repeat(40));
  console.log(`Results: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
});
