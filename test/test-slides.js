const fs = require("fs");
const browser = require("./browser.js");
const { tempDir } = require("./tempdir.js");
const path = require("path");
const os = require("os");
const { parseSdoc, extractMeta } = require("../src/sdoc.js");
const { renderSlides, renderSlide, renderNode, renderInline, isOptionalSlide, inlineDeckImages } = require("../src/slide-renderer.js");

let pass = 0, fail = 0;
const asyncTests = [];
// An async test waits for the one before it to finish. They used to start
// together the moment the file loaded, and nearly every async test here
// launches a headless Chrome, so a suite put twenty or thirty browsers on the
// machine at once and froze it. A synchronous test still runs where it is
// declared, so the output keeps its sections.
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
  // Inside a browser group with no browser here: counted, never run.
  if (browser.skipping()) { browser.record(name); return; }
  if (fn.constructor.name === "AsyncFunction") {
    browserQueue = browserQueue.then(() => runTest(name, fn));
    asyncTests.push(browserQueue);
    return;
  }
  const pending = runTest(name, fn);
  if (pending) asyncTests.push(pending);
}
// Everything queued, including anything a test queued while it ran.
function allSettled() {
  const count = asyncTests.length;
  return Promise.all(asyncTests).then(() => (asyncTests.length === count ? null : allSettled()));
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

// The rendered markup with every <script> removed. Several assertions below
// ask whether a class or a tag appears in a deck, and the answer must come
// from the markup rather than from the source of the runtime shipped beside
// it, which names the very classes it goes looking for.
function markupOf(html) {
  return html.replace(/<script\b[\s\S]*?<\/script>/gi, "");
}

function parseAndRender(sdoc, options = {}) {
  const parsed = parseSdoc(sdoc);
  assert(parsed.errors.length === 0, "parse errors: " + parsed.errors.map(e => e.message).join(", "));
  const { nodes, meta } = extractMeta(parsed.nodes);
  return renderSlides(nodes, { meta, ...options });
}

function parseSlides(sdoc) {
  const parsed = parseSdoc(sdoc);
  const { nodes, meta } = extractMeta(parsed.nodes);
  return { nodes, meta };
}

// ============================================================
console.log("--- Basic slide generation ---");

test("single slide", () => {
  const html = parseAndRender(`
# Deck {
    # Hello World {
        This is a slide.
    }
}
`);
  assert(html.includes('<div class="slide"'), "should have slide div");
  assert(html.includes("<h2>Hello World</h2>"), "should have slide title");
  assert(html.includes("<p>This is a slide.</p>"), "should have paragraph");
});

test("multiple slides", () => {
  const html = parseAndRender(`
# Deck {
    # Slide One {
        First slide.
    }
    # Slide Two {
        Second slide.
    }
}
`);
  const slideCount = (html.match(/<div class="slide"/g) || []).length;
  assert(slideCount === 2, "should have 2 slides, got " + slideCount);
  assert(html.includes("<h2>Slide One</h2>"), "should have first title");
  assert(html.includes("<h2>Slide Two</h2>"), "should have second title");
});

test("slide with @id", () => {
  const html = parseAndRender(`
# Deck {
    # My Slide @my-slide {
        Content.
    }
}
`);
  assert(html.includes('id="my-slide"'), "should have id attribute");
});

// ============================================================
console.log("\n--- Meta extraction ---");

test("title from meta", () => {
  const html = parseAndRender(`
# Deck {
    # Meta @meta {
        type: slides

        title: My Presentation
    }
    # Slide {
        Hello.
    }
}
`);
  assert(html.includes("<title>My Presentation</title>"), "should use title from meta");
});

test("meta scope is excluded from slides", () => {
  const html = parseAndRender(`
# Deck {
    # Meta @meta {
        type: slides
    }
    # Slide {
        Hello.
    }
}
`);
  const slideCount = (html.match(/<div class="slide"/g) || []).length;
  assert(slideCount === 1, "meta should not become a slide, got " + slideCount);
});

test("signposts are excluded from slides", () => {
  const html = parseAndRender(`
# Deck {
    @about {
        Summary.
    }
    @not-about {
        - Not this.
    }
    @related-resources {
        {[table]
            Resource | Relation
            [Other](other.sdoc) | Sibling
        }
    }
    @reading-guide {
        Start here.
    }
    @editing-guide {
        - Rules.
    }
    # Slide {
        Hello.
    }
}
`);
  const slideCount = (html.match(/<div class="slide"/g) || []).length;
  assert(slideCount === 1, "signposts should not become slides, got " + slideCount);
});

test("title falls back to document scope title", () => {
  const html = parseAndRender(`
# My Deck Title {
    # Slide {
        Hello.
    }
}
`);
  assert(html.includes("<title>My Deck Title</title>"), "should fall back to doc title");
});

test("signposts and :comment scopes beside the deck root do not merge the slides", () => {
  const html = parseAndRender(`
# Notes :comment {
    Draft.
}
@about {
    Summary.
}
# My Deck Title {
    # Slide 1 {
        One.
    }
    # Slide 2 {
        Two.
    }
}
`);
  const slideCount = (html.match(/<div class="slide"/g) || []).length;
  assert(slideCount === 2, "two slides, got " + slideCount);
  assert(html.includes("<title>My Deck Title</title>"), "the deck title is found");
});

test("a deck root beside a signpost is unwrapped without extractMeta too", () => {
  const nodes = parseSdoc("@about {\n    Summary.\n}\n# Deck {\n    # Slide 1 {\n        One.\n    }\n    # Slide 2 {\n        Two.\n    }\n}").nodes;
  const slideCount = (renderSlides(nodes).match(/<div class="slide"/g) || []).length;
  assert(slideCount === 2, "two slides, got " + slideCount);
});

test("a lone ordinary scope is the deck root whatever sits beside it, as it is alone", () => {
  // The root rule: what sits beside the only ordinary scope does not change
  // how the deck is read. A one-slide deck with sub-scopes needs a root.
  const slide = "# Welcome @cover {\n    # Left {\n        L.\n    }\n    # Right {\n        R.\n    }\n}";
  const count = (src) => (parseAndRender(src).match(/<div class="slide"/g) || []).length;
  assert(count(slide) === 2, "alone: its sub-scopes are the slides");
  assert(count("@about {\n    Summary.\n}\n" + slide) === 2, "beside @about: the same");
  assert(count("# Draft :comment {\n    x\n}\n" + slide) === 2, "beside a :comment: the same");
  assert(count("# Deck {\n" + slide.replace(/^/gm, "    ") + "\n}") === 1, "inside a root: one slide");
});

// ============================================================
console.log("\n--- Layouts ---");

test("center layout", () => {
  const html = parseAndRender(`
# Deck {
    # Centered Slide {
        config: center

        Some centered content.
    }
}
`);
  assert(html.includes('class="slide center layout-center"'), "should have center class");
  assert(!html.includes("config:"), "config line should be stripped from content");
  assert(html.includes("<p>Some centered content.</p>"), "content should still render");
});

test("two-column layout", () => {
  const html = parseAndRender(`
# Deck {
    # Comparison {
        config: two-column

        # Left {
            Left content.
        }
        # Right {
            Right content.
        }
    }
}
`);
  assert(html.includes('class="slide two-column layout-two-column"'), "should have two-column class");
  assert(html.includes('class="columns cols-2"'), "should have columns container");
  assert(html.includes('class="column"'), "should have column divs");
  assert(html.includes("<h3>Left</h3>"), "should have column headings");
  assert(html.includes("<p>Left content.</p>"), "left column content");
  assert(html.includes("<p>Right content.</p>"), "right column content");
});

test("default layout (no config)", () => {
  const html = parseAndRender(`
# Deck {
    # Plain Slide {
        Just text.
    }
}
`);
  assert(html.includes('class="slide"'), "should have plain slide class");
  assert(!html.includes("layout-center"), "should not have center class on slide");
  assert(!html.includes("layout-two-column"), "should not have two-column class on slide");
});

// ============================================================
console.log("\n--- Speaker notes ---");

test("notes scope becomes hidden aside", () => {
  const html = parseAndRender(`
# Deck {
    # My Slide {
        Visible content.

        # Speaker Notes @notes {
            These are my notes.
        }
    }
}
`);
  assert(html.includes('<aside class="notes">'), "should have notes aside");
  assert(html.includes("These are my notes."), "notes content should be present");
  assert(html.includes("<p>Visible content.</p>"), "slide content should be present");
});

test("notes are separated from content", () => {
  const html = parseAndRender(`
# Deck {
    # My Slide {
        Content.

        # Notes @notes {
            Secret notes.
        }
    }
}
`);
  assert(html.includes("Content."), "content present");
  assert(html.includes('<aside class="notes">'), "notes rendered as aside");
  // Notes live outside the .slide-content-scale wrapper (sibling, not child),
  // confirming they are separate from the main slide content flow.
  const scaleOpen = html.indexOf('class="slide-content-scale"');
  const scaleClose = html.indexOf('</div>', scaleOpen);
  const notesStart = html.indexOf('<aside class="notes">');
  assert(notesStart > scaleClose, "notes appear after the content-scale wrapper, not inside it");
});

test("includeNotes false leaves the notes out of the page, not just out of sight", () => {
  // Hidden is not absent: the aside is in the file for anyone who reads its
  // source, and the PowerPoint and Claude Slides exports read it back out as
  // speaker notes. A deck whose notes are internal needs them gone.
  const src = `
# Deck {
    # My Slide {
        Visible content.

        # Speaker Notes @notes {
            Only the presenter should read this.
        }
    }
}
`;
  const kept = parseAndRender(src);
  assert(kept.includes("Only the presenter should read this."), "kept by default");
  const html = parseAndRender(src, { includeNotes: false });
  assert(!html.includes("Only the presenter should read this."), "the words are nowhere in the file");
  assert(!html.includes('<aside class="notes">'), "and there is no notes aside");
  assert(html.includes("<p>Visible content.</p>"), "the slide itself is untouched");
});

test("the built page carries no CSS comments from the theme or the deck", () => {
  // A comment is for whoever reads the stylesheet; a built deck is read by
  // whoever it is sent to. One real deck carried 264 of them — 149,000
  // characters naming people and decisions — in the source of a page meant
  // to be emailed.
  const theme = require("../src/theme.js").loadTheme(path.join(__dirname, "..", "themes", "default"));
  assert(theme.themeCss.includes("/*"), "the default theme has comments to lose");
  const html = parseAndRender("# Deck {\n    # Slide {\n        Hello.\n    }\n}", {
    themeCss: theme.themeCss,
    deckCss: "/* decided with the CTO on 3 Oct: keep the bar blue */ .bar-track { background: blue; }\n/*! Licence: keep */",
  });
  const css = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || "";
  assert(!css.includes("decided with the CTO"), "the deck's comment is gone");
  assert(css.includes(".bar-track { background: blue; }"), "and its rule is kept");
  assert(css.includes("/*! Licence: keep */"), "a /*! comment stays");
  assert(!/\/\*(?!!)/.test(css), "no other comment is left: " + (css.match(/\/\*(?!!)[\s\S]{0,60}/) || [""])[0]);
});

test("stripCssComments leaves strings, urls and token boundaries alone", () => {
  const { stripCssComments: strip } = require("../src/slide-renderer");
  const cases = [
    ["/*! (c) Licence */ .x{}", "/*! (c) Licence */ .x{}"],
    ['.x::before { content: "/* not a comment */"; }', '.x::before { content: "/* not a comment */"; }'],
    [".x { content: 'a */ b'; }", ".x { content: 'a */ b'; }"],
    ['.x { content: "a\\"/*b*/"; }', '.x { content: "a\\"/*b*/"; }'],
    [".x { background: url(data:image/svg+xml;utf8,<svg>/*x*/</svg>); }", ".x { background: url(data:image/svg+xml;utf8,<svg>/*x*/</svg>); }"],
    ['.x { background: url( "a/*b*/.png" ); }', '.x { background: url( "a/*b*/.png" ); }'],
    // Two words a comment separated keep a space; a selector it sat inside does not gain one.
    [".x { margin: 1px/**/2px; }", ".x { margin: 1px 2px; }"],
    ["a/**/.b { }", "a.b { }"],
    [".x { color: red; } /* unterminated", ".x { color: red; } "],
  ];
  for (const [input, want] of cases) {
    const got = strip(input);
    assert(got === want, `${JSON.stringify(input)} gave ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
  }
});

// ============================================================
console.log("\n--- Content rendering ---");

test("bullet list", () => {
  const html = parseAndRender(`
# Deck {
    # Lists {
        {[.]
            - First item
            - Second item
        }
    }
}
`);
  assert(html.includes("<ul>"), "should have ul");
  assert(html.includes("<li>First item</li>"), "should have first item");
  assert(html.includes("<li>Second item</li>"), "should have second item");
});

test("numbered list", () => {
  const html = parseAndRender(`
# Deck {
    # Lists {
        {[#]
            - Step one
            - Step two
        }
    }
}
`);
  assert(html.includes("<ol>"), "should have ol");
});

test("table", () => {
  const html = parseAndRender(`
# Deck {
    # Data {
        {[table]
            Name | Value
            Alice | 30
            Bob | 25
        }
    }
}
`);
  assert(html.includes("<table>"), "should have table");
  assert(html.includes("<th>Name</th>"), "should have header");
  assert(html.includes("<td>Alice</td>"), "should have cell");
});

test("code block", () => {
  const html = parseAndRender(`
# Deck {
    # Code {
        \`\`\`js
        const x = 42;
        \`\`\`
    }
}
`);
  assert(html.includes("<pre>"), "should have pre");
  assert(html.includes('class="language-js"'), "should have language class");
  assert(html.includes("const x = 42;"), "should have code content");
});

test("blockquote", () => {
  const html = parseAndRender(`
# Deck {
    # Quote {
        > The documentation is the product.
    }
}
`);
  assert(html.includes("<blockquote>"), "should have blockquote");
  assert(html.includes("The documentation is the product."), "should have quote text");
});

test("inline formatting", () => {
  const html = parseAndRender(`
# Deck {
    # Formatting {
        This has **bold** and *italic* and \`code\` and ~~strike~~.
    }
}
`);
  assert(html.includes("<strong>bold</strong>"), "should have bold");
  assert(html.includes("<em>italic</em>"), "should have italic");
  assert(html.includes("<code>code</code>"), "should have inline code");
  assert(html.includes("<del>strike</del>"), "should have strikethrough");
});

test("links", () => {
  const html = parseAndRender(`
# Deck {
    # Links {
        Visit [Example](https://example.com) for more.
    }
}
`);
  assert(html.includes('href="https://example.com"'), "should have link href");
  assert(html.includes(">Example</a>"), "should have link text");
});

test("images", () => {
  const html = parseAndRender(`
# Deck {
    # Images {
        ![Logo](logo.png)
    }
}
`);
  assert(html.includes('src="logo.png"'), "should have image src");
  assert(html.includes('alt="Logo"'), "should have image alt");
});

// ============================================================
console.log("\n--- Theme injection ---");

test("theme CSS is inlined", () => {
  const html = parseAndRender(`
# Deck {
    # Slide {
        Hello.
    }
}
`, { themeCss: "body { color: red; }" });
  assert(html.includes("body { color: red; }"), "should inline CSS");
  assert(html.includes("<style>"), "should have style tag");
});

test("theme JS is inlined", () => {
  const html = parseAndRender(`
# Deck {
    # Slide {
        Hello.
    }
}
`, { themeJs: "console.log('loaded');" });
  assert(html.includes("console.log('loaded');"), "should inline JS");
  assert(html.includes("<script>"), "should have script tag");
});

// ============================================================
console.log("\n--- HTML document structure ---");

test("produces valid HTML document", () => {
  const html = parseAndRender(`
# Deck {
    # Slide {
        Hello.
    }
}
`);
  assert(html.includes("<!DOCTYPE html>"), "should have doctype");
  assert(/<html lang="en"[ >]/.test(html), "should have html tag");
  assert(html.includes("<head>"), "should have head");
  assert(html.includes("<body>"), "should have body");
  assert(html.includes("</html>"), "should close html");
});

test("includes slide footer with nav indicators", () => {
  const html = parseAndRender(`
# Deck {
    # Slide {
        Hello.
    }
}
`);
  assert(html.includes('class="slide-footer"'), "should have slide footer");
  assert(html.includes('class="nav-prev"'), "should have nav-prev");
  assert(html.includes('class="nav-next"'), "should have nav-next");
});

// ============================================================
console.log("\n--- Image inlining ---");

// A one-pixel PNG, so the fixtures carry real bytes rather than a stub whose
// base64 an assertion could match by accident.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

function imageFixture() {
  const dir = tempDir("sdoc-img-");
  fs.mkdirSync(path.join(dir, "img"), { recursive: true });
  fs.writeFileSync(path.join(dir, "img", "pic.png"), PNG_1PX);
  return dir;
}

test("a local image is embedded, resolved against the .sdoc", () => {
  // The documented contract: "Paths are resolved relative to the .sdoc file."
  // Embedding settles it once, so where the built file is written stops
  // mattering — which is the bug: an HTML build sent elsewhere with -o used to
  // ship a relative path that named nothing and said nothing about it.
  const dir = imageFixture();
  const { html, inlined, missing } = inlineDeckImages(
    '<img src="img/pic.png" alt="x" />', dir
  );
  assert(missing.length === 0, "nothing should be missing: " + JSON.stringify(missing));
  assert(inlined.length === 1, "one image inlined");
  assert(html.includes("data:image/png;base64,"), "src became a data URI");
  assert(!html.includes('src="img/pic.png"'), "relative path is gone");
  assert(html.includes('alt="x"'), "other attributes survive");
});

test("remote and data sources are left exactly as they are", () => {
  const dir = imageFixture();
  const cases = [
    '<img src="https://example.com/a.png" />',
    '<img src="//example.com/a.png" />',
    '<img src="data:image/png;base64,AAAA" />',
  ];
  for (const one of cases) {
    const out = inlineDeckImages(one, dir);
    assert(out.html === one, "left alone: " + one);
    assert(out.inlined.length === 0 && out.missing.length === 0,
      "neither inlined nor missing: " + one);
  }
});

test("an unreadable local image is reported, not silently dropped", () => {
  // The whole point. The old failure mode was a broken-image glyph in a PDF
  // and a build that printed nothing and exited 0.
  const dir = imageFixture();
  const { html, missing } = inlineDeckImages('<img src="img/absent.png" />', dir);
  assert(missing.length === 1, "the missing image is reported");
  assert(missing[0].src === "img/absent.png", "reported by name: " + missing[0].src);
  assert(missing[0].reason === "not-found", "reason given: " + missing[0].reason);
  // The resolved path is the part that shows WHY: a deck written against a
  // different convention can see the file plainly and needs to be told which
  // directory was actually searched.
  assert(missing[0].resolved === path.join(dir, "img", "absent.png"),
    "resolved path reported: " + missing[0].resolved);
  // Left as written, so a deck whose images really do sit beside the OUTPUT
  // keeps working; it just no longer does so silently.
  assert(html.includes('src="img/absent.png"'), "reference is preserved");
});

test("a local file that is not an embeddable image type is reported", () => {
  const dir = imageFixture();
  fs.writeFileSync(path.join(dir, "notes.txt"), "not an image");
  const { missing } = inlineDeckImages('<img src="notes.txt" />', dir);
  assert(missing.length === 1 && missing[0].src === "notes.txt",
    "unsupported type reported: " + JSON.stringify(missing));
  assert(missing[0].reason === "unsupported-type", "distinguished from not-found");
  assert(missing[0].resolved === path.join(dir, "notes.txt"), "resolved path reported");
});

test("query strings and escaped entities in a src still resolve", () => {
  const dir = imageFixture();
  const { missing, html } = inlineDeckImages('<img src="img/pic.png?v=2" />', dir);
  assert(missing.length === 0, "?query stripped before resolving: " + JSON.stringify(missing));
  assert(html.includes("data:image/png;base64,"), "still embedded");
});

test("a rendered deck's images survive being written to another directory", () => {
  // End to end over the real renderer: the regression this guards is that
  // renderSlides emits the raw src and something downstream must resolve it.
  const dir = imageFixture();
  const html = parseAndRender(`
# Deck {
    # Slide {
        ![A picture](img/pic.png)
    }
}
`);
  assert(html.includes('src="img/pic.png"'), "renderer emits the path as written");
  const out = inlineDeckImages(html, dir);
  assert(out.missing.length === 0, "resolved against the deck directory");
  assert(out.html.includes("data:image/png;base64,"), "embedded for any output location");
});

// ============================================================
console.log("\n--- Edge cases ---");

test("nested scope inside slide", () => {
  const html = parseAndRender(`
# Deck {
    # Main Slide {
        Intro.

        # Sub Section {
            Detail.
        }
    }
}
`);
  assert(html.includes("<section>"), "nested scope should render as section");
  assert(html.includes("<h3>Sub Section</h3>"), "nested scope heading");
  assert(html.includes("<p>Detail.</p>"), "nested scope content");
});

test("empty slide", () => {
  const html = parseAndRender(`
# Deck {
    # Empty Slide {
    }
}
`);
  assert(html.includes('<div class="slide"'), "should still render slide");
  assert(html.includes("<h2>Empty Slide</h2>"), "should still have title");
});

test("config line with extra whitespace", () => {
  const html = parseAndRender(`
# Deck {
    # Slide {
        config:   center

        Content.
    }
}
`);
  assert(html.includes('class="slide center layout-center"'), "should handle whitespace in config");
});

// ============================================================
console.log("\n--- PDF export ---");

test("rendered slides include print styles", () => {
  const html = parseAndRender(`
# Deck {
    # Slide { Hello. }
}
`);
  assert(html.includes("@media print"), "should have @media print block");
  assert(html.includes("page-break-after"), "should have page-break rules");
  assert(html.includes("display: flex !important"), "should force slides visible in print");
  // Regression guard: this was `display: block`, which made the theme's
  // `justify-content` inert and collapsed a `margin-top: auto`, so a slide
  // centred on screen printed hard against the top of the page.
  assert(html.includes("flex-direction: column !important"), "print slides stay a flex column");
});

// ============================================================
console.log("\n--- Fit-to-window scaling ---");

test("structural CSS defines the fixed design box", () => {
  const html = parseAndRender(`
# Deck {
    # Slide { Hello. }
}
`);
  assert(html.includes("--sdoc-slide-w: 1920px"), "design box width defined");
  assert(html.includes("--sdoc-slide-h: 1080px"), "design box height defined");
  // Must default to 1 so a deck with no JS renders at natural size rather
  // than collapsing to scale(0).
  assert(html.includes("--sdoc-slide-scale: 1"), "scale defaults to 1");
});

test("slides are sized from the design box and scaled by the variable", () => {
  const html = parseAndRender(`
# Deck {
    # Slide { Hello. }
}
`);
  assert(html.includes("width: var(--sdoc-slide-w)"), "slide width from design box");
  assert(html.includes("height: var(--sdoc-slide-h)"), "slide height from design box");
  assert(
    html.includes("scale(var(--sdoc-slide-scale), var(--sdoc-slide-scale-y))"),
    "slide transform reads the scale variables"
  );
});

test("print neutralizes the screen transform so each slide is one page", () => {
  const html = parseAndRender(`
# Deck {
    # Slide { Hello. }
}
`);
  const printBlock = html.slice(html.indexOf("@media print"));
  assert(printBlock.includes("transform: none !important"), "screen scale is cleared in print");
  assert(
    printBlock.includes("position: relative !important"),
    "slides return to flow so they paginate"
  );
  assert(
    printBlock.includes("width: var(--sdoc-slide-w)"),
    "print page uses the same design box as screen"
  );
});

// One rule out of the @media print block, with its comments stripped: the
// assertions below look for declarations, and a comment that mentions the very
// property it warns against would otherwise answer for the stylesheet.
function printRule(html, selector) {
  const block = html.slice(html.indexOf("@media print"));
  const start = block.indexOf(selector);
  assert(start !== -1, "print block styles " + selector.trim());
  return block.slice(start, block.indexOf("}", start)).replace(/\/\*[\s\S]*?\*\//g, "");
}

test("print keeps the slide a flex column, as the screen layout is", () => {
  // A print block that set `display: block` would silently change the layout
  // every theme is written against: justify-content goes inert and an auto
  // margin computes to 0, so a centred slide prints hard against the top of
  // the page and a footnote pinned to the foot rides up under the body.
  // This guard is cheap and unconditional; the geometry tests below prove the
  // consequence, but they need a browser and skip without one.
  const html = parseAndRender(`
# Deck {
    # Slide { Hello. }
}
`);
  const rule = printRule(html, "  .slide {");
  assert(!/display:\s*block/.test(rule),
    "the slide must not fall back to block layout in print");
  assert(/display:\s*flex\s*!important/.test(rule), "the slide stays a flex container in print");
  assert(/flex-direction:\s*column\s*!important/.test(rule), "the slide stays a column in print");
});

test("the print scale wrapper fills the slide and inherits its flex rules", () => {
  // The wrapper has to be a real box in print, because fitSlidesForPrint
  // transforms it — and a real box takes over as the flex container, leaving
  // .slide one full-height child and nothing to distribute. So the wrapper
  // must fill the slide (or an auto margin inside has nothing to push
  // against) and must inherit rather than hard-code the theme's alignment:
  // our own theme centres every slide, not only .layout-title.
  const html = parseAndRender(`
# Deck {
    # Slide { Hello. }
}
`);
  const rule = printRule(html, "  .slide-content-scale {");
  assert(/display:\s*flex\s*!important/.test(rule), "wrapper is a flex container");
  assert(/flex-direction:\s*column\s*!important/.test(rule), "wrapper is a column");
  assert(/flex:\s*1 1 auto\s*!important/.test(rule), "wrapper fills the slide");
  assert(/justify-content:\s*inherit/.test(rule), "wrapper inherits the slide's justify-content");
  assert(/align-items:\s*inherit/.test(rule), "wrapper inherits the slide's align-items");
  assert(/transform-origin:\s*top left/.test(rule), "scaling still anchors at the top left");
});

test("findChrome returns a string or null", () => {
  const { findChrome } = require("../src/slide-pdf");
  const result = findChrome();
  assert(result === null || typeof result === "string", "should return string or null");
  if (result) {
    assert(fs.existsSync(result), "returned path should exist: " + result);
  }
});

test("exportPdf produces a file (integration)", async () => {
  const { exportSlidePdf } = require("../src/slide-pdf");
  browser.skip();

  const themeCss = fs.readFileSync(
    path.join(__dirname, "..", "themes", "default", "theme.css"), "utf-8"
  );
  const html = parseAndRender(`
# Deck {
    # Slide 1 { Hello. }
    # Slide 2 { World. }
}
`, { themeCss });

  const tmpHtml = path.join(os.tmpdir(), "test-slides-" + Date.now() + ".html");
  const tmpPdf = tmpHtml.replace(".html", ".pdf");

  fs.writeFileSync(tmpHtml, html, "utf-8");
  try {
    await exportSlidePdf(tmpHtml, tmpPdf);
    assert(fs.existsSync(tmpPdf), "PDF file should exist");
    const stat = fs.statSync(tmpPdf);
    assert(stat.size > 0, "PDF should not be empty");
  } finally {
    try { fs.unlinkSync(tmpHtml); } catch {}
    try { fs.unlinkSync(tmpPdf); } catch {}
  }
});

test("a PDF export makes its folder, and fails when nothing was written (integration)", async () => {
  // Chrome neither creates the folder nor reports that it could not write the
  // file: it exits 0, so a missing folder used to print "PDF: <path>", exit 0
  // and write nothing.
  const { exportSlidePdf } = require("../src/slide-pdf");
  browser.skip();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-pdf-dir-"));
  try {
    const tmpHtml = path.join(dir, "deck.html");
    fs.writeFileSync(tmpHtml, parseAndRender("# Deck {\n    # Slide {\n        Hello.\n    }\n}"), "utf-8");

    const nested = path.join(dir, "not", "yet", "there", "deck.pdf");
    await exportSlidePdf(tmpHtml, nested);
    assert(fs.existsSync(nested) && fs.statSync(nested).size > 0, "the folder is made and the PDF written");

    // A path Chrome cannot write to: an existing directory. It still exits 0.
    const blocked = path.join(dir, "blocked.pdf");
    fs.mkdirSync(blocked);
    let failed = null;
    try {
      await exportSlidePdf(tmpHtml, blocked);
    } catch (err) {
      failed = err;
    }
    assert(failed && /wrote no PDF/.test(failed.message), "a PDF that was not written is an error: " + (failed && failed.message));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================
console.log("\n--- Print layout geometry ---");

// The repo's geometry harvest measures in screen media, which is exactly how
// a print-only layout bug reached a release: the HTML was right and only the
// PDF was wrong. These tests put the print rules, and only those, into the
// cascade by promoting the @media print block to @media all, then measure the
// result in a real browser. Everything inside one slide is then the real
// print layout, fitSlidesForPrint included — it runs because the scale
// wrapper has a box. What this does not model is pagination and @page, so a
// bug in how slides break across pages would still get past it.
const { runHarvest, SENTINEL } = require("../src/slide-geometry.js");
const { loadTheme } = require("../src/theme.js");

function promotePrintRules(html) {
  assert(html.includes("@media print {"), "deck carries a print block");
  return html.replace("@media print {", "@media all {");
}

const PRINT_GEOMETRY_SCRIPT = `
(function () {
  // Where the ink actually sits: the union of every leaf that carries text.
  // Measuring the wrapper's own box would not catch a slide that is centred
  // correctly but whose content has spilled out of it.
  function inkOf(root, origin) {
    var min = 1e9, max = -1e9;
    var all = root.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.children.length) continue;
      if (!el.textContent || !el.textContent.trim()) continue;
      var r = el.getBoundingClientRect();
      if (r.height <= 0) continue;
      if (r.top - origin < min) min = r.top - origin;
      if (r.bottom - origin > max) max = r.bottom - origin;
    }
    return { top: min, bottom: max };
  }

  function run() {
    var out = {};
    // Report a thrown measurement rather than letting the page go silent: a
    // harvest that never files its findings fails every assertion with the
    // same unhelpful timeout, whatever actually went wrong.
    try {
      var slides = document.querySelectorAll(".slide");
      for (var i = 0; i < slides.length; i++) {
        var slide = slides[i];
        var wrap = slide.querySelector(".slide-content-scale");
        var sRect = slide.getBoundingClientRect();
        var sStyle = getComputedStyle(slide);
        var wStyle = getComputedStyle(wrap);
        var ink = inkOf(wrap, sRect.top);
        var foot = slide.querySelector(".footnote");
        out[slide.id] = {
          slideH: sRect.height,
          display: sStyle.display,
          direction: sStyle.flexDirection,
          wrapDisplay: wStyle.display,
          wrapJustify: wStyle.justifyContent,
          scaled: wStyle.transform !== "none",
          inkTop: ink.top,
          inkBottom: ink.bottom,
          footnoteBottom: foot ? foot.getBoundingClientRect().bottom - sRect.top : null
        };
      }
    } catch (e) {
      out = { __error: String((e && e.message) || e) };
    }
    var el = document.createElement("script");
    el.type = "application/json";
    el.id = "sdoc-print-geometry";
    el.textContent = JSON.stringify(out) + "\\n/*${SENTINEL}*/";
    document.body.appendChild(el);
  }

  function start() {
    // fitSlidesForPrint runs on load and again on a double rAF, and web fonts
    // can move the metrics it measured. Measure after all of that.
    var go = function () {
      requestAnimationFrame(function () { requestAnimationFrame(run); });
    };
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(go);
    } else {
      go();
    }
  }

  if (document.readyState === "complete") start();
  else window.addEventListener("load", start);
})();
`;

// One deck covers all four cases, so the browser is driven once.
//   cover   — the theme centres it; it must not print against the top
//   body    — a footnote in normal flow, on a slide the theme also centres
//   pinned  — the same, with the auto margin a theme uses to pin a footnote
//             to the foot of the slide (ours does not; the reporter's does)
//   toomuch — more lines than the page holds, for fitSlidesForPrint
const PRINT_DECK = `
# Deck {
    @meta { type: slides }

    # A Centred Title @cover {
        config: title

        The theme centres this, so the PDF must too.
    }

    # A Normal Slide @body {
        footnote: Provenance, in normal flow under the body.

        - First point
        - Second point
    }

    # A Pinned Footnote @pinned {
        footnote: Pinned to the foot of the slide by an auto margin.

        - First point
        - Second point
    }

    # Far Too Much @toomuch {
        footnote: The last thing on the slide, and it must survive the fit.

${Array.from({ length: 26 }, (_, i) => `        - Line ${i + 1} of a body with far more in it than one page holds`).join("\n\n")}
    }
}
`;

let printGeometryPromise = null;
function printGeometry() {
  if (printGeometryPromise) return printGeometryPromise;
  const theme = loadTheme(path.join(__dirname, "..", "themes", "default"));
  const html = promotePrintRules(parseAndRender(PRINT_DECK, {
    themeCss: theme.themeCss,
    themeJs: theme.themeJs,
    themeConfig: theme.themeConfig,
    // Only this slide pins its footnote, so the comparison with #body shows
    // the auto margin is what moved it rather than the print rules alone.
    deckCss: "#pinned .footnote { margin-top: auto; }"
  }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-print-geom-"));
  const file = path.join(dir, "deck.html");
  fs.writeFileSync(file, html, "utf-8");
  printGeometryPromise = runHarvest(file, PRINT_GEOMETRY_SCRIPT, "sdoc-print-geometry")
    .finally(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return printGeometryPromise;
}

test("print keeps a centred slide centred (geometry)", async () => {
  browser.skip();
  const g = await printGeometry();
  for (const id of ["cover", "body"]) {
    const s = g[id];
    assert(s, "measured slide " + id);
    assert(s.display === "flex" && s.direction === "column",
      id + ": slide is a flex column in print, got " + s.display + "/" + s.direction);
    assert(s.wrapJustify === "center",
      id + ": the wrapper inherits the theme's centring, got " + s.wrapJustify);
    // Equal air above and below is the whole claim. In block layout the top
    // gap was one padding and the bottom gap most of the page.
    const above = s.inkTop;
    const below = s.slideH - s.inkBottom;
    assert(Math.abs(above - below) < s.slideH * 0.06,
      id + ": content is not centred — " + above.toFixed(0) + "px above, " +
      below.toFixed(0) + "px below a " + s.slideH.toFixed(0) + "px page");
  }
});

test("an auto margin still reaches the foot of the page in print (geometry)", async () => {
  browser.skip();
  const g = await printGeometry();
  const pinned = g.pinned, body = g.body;
  assert(pinned && body, "measured both footnote slides");
  assert(pinned.footnoteBottom > pinned.slideH * 0.85 &&
         pinned.footnoteBottom <= pinned.slideH,
    "a footnote with margin-top:auto should sit at the foot, got " +
    pinned.footnoteBottom.toFixed(0) + " of " + pinned.slideH.toFixed(0));
  assert(body.footnoteBottom < body.slideH * 0.75,
    "a footnote without it should stay under the body, got " +
    body.footnoteBottom.toFixed(0) + " of " + body.slideH.toFixed(0));
});

test("content taller than the page is scaled to fit, not clipped (geometry)", async () => {
  browser.skip();
  const g = await printGeometry();
  const s = g.toomuch;
  assert(s, "measured the overflowing slide");
  assert(s.scaled, "fitSlidesForPrint should have scaled the wrapper");
  // Centring an overflow spills it out of both ends, where scaling from the
  // top-left cannot bring the top back, so the fit has to start-align too.
  assert(s.inkTop >= -1,
    "content runs off the top of the page by " + (-s.inkTop).toFixed(0) + "px");
  assert(s.inkBottom <= s.slideH + 1,
    "content runs off the bottom of the page by " +
    (s.inkBottom - s.slideH).toFixed(0) + "px");
});

// ============================================================
console.log("\n--- Company and confidential ---");

test("company meta renders footer on slides", () => {
  const html = parseAndRender(`
# Deck {
    # Meta @meta {
        type: slides

        company: Northwind Ltd
    }
    # Slide { Hello. }
}
`);
  assert(html.includes("sdoc-company-footer"), "should have company footer");
  assert(html.includes("Northwind Ltd"), "should have company name");
});

test("confidential: true with company renders notice", () => {
  const html = parseAndRender(`
# Deck {
    # Meta @meta {
        type: slides

        company: Northwind Ltd

        confidential: true
    }
    # Slide { Hello. }
}
`);
  assert(html.includes("sdoc-confidential-notice"), "should have confidential notice");
  assert(html.includes("CONFIDENTIAL"), "should say CONFIDENTIAL");
  assert(html.includes("Northwind Ltd"), "should include company name");
});

test("confidential with explicit entity overrides company", () => {
  const html = parseAndRender(`
# Deck {
    # Meta @meta {
        type: slides

        company: Northwind Ltd

        confidential: Acme Corp
    }
    # Slide { Hello. }
}
`);
  assert(html.includes("Acme Corp"), "should use explicit entity");
  assert(!html.includes("sdoc-confidential-notice\">CONFIDENTIAL \u2014 Northwind"), "should not use company");
});

test("confidential: true without company renders plain notice", () => {
  const html = parseAndRender(`
# Deck {
    # Meta @meta {
        type: slides

        confidential: true
    }
    # Slide { Hello. }
}
`);
  assert(html.includes("sdoc-confidential-notice"), "should have notice");
  assert(html.includes(">CONFIDENTIAL</span>"), "should be plain CONFIDENTIAL");
});

test("no company or confidential produces no extra elements", () => {
  const html = parseAndRender(`
# Deck {
    # Meta @meta {
        type: slides
    }
    # Slide { Hello. }
}
`);
  assert(!html.includes('<span class="sdoc-company-footer">'), "no company footer element");
  assert(!html.includes('<span class="sdoc-confidential-notice">'), "no confidential notice element");
});

// ============================================================
console.log("\n--- Mermaid diagrams ---");

test("mermaid code block in slide renders as pre.mermaid", () => {
  const html = parseAndRender(`
# Deck {
    # Architecture {
        \`\`\`mermaid
        graph LR
          A --> B
        \`\`\`
    }
}
`);
  assert(html.includes('<pre class="mermaid">'), "should have pre.mermaid");
  assert(html.includes("graph LR"), "should have diagram content");
  assert(!html.includes('language-mermaid'), "should not use language-mermaid");
});

test("mermaid blocks in slides trigger CDN script", () => {
  const html = parseAndRender(`
# Deck {
    # Diagram {
        \`\`\`mermaid
        graph TD
          X --> Y
        \`\`\`
    }
}
`);
  assert(html.includes("cdn.jsdelivr.net"), "should include CDN URL");
});

test("slides without mermaid have no mermaid script", () => {
  const html = parseAndRender(`
# Deck {
    # Code {
        \`\`\`python
        print("hello")
        \`\`\`
    }
}
`);
  assert(!html.includes("cdn.jsdelivr.net"), "should not include CDN URL");
});

// ============================================================
console.log("\n--- Dark mode ---");

test("darkMode injects dark CSS overrides", () => {
  const html = parseAndRender(`
# Deck {
    # Intro {
        Hello world
    }
}
`, { darkMode: true });
  assert(html.includes("background: #1e1e1e"), "should have dark background");
  assert(html.includes("color: #d4d4d4"), "should have light text color");
});

test("darkMode false does not inject dark CSS overrides", () => {
  const html = parseAndRender(`
# Deck {
    # Intro {
        Hello world
    }
}
`);
  assert(!html.includes("background: #1e1e1e"), "should not have dark background");
});

test("darkMode initializes mermaid with dark theme", () => {
  const html = parseAndRender(`
# Deck {
    # Diagram {
        \`\`\`mermaid
        graph LR
          A --> B
        \`\`\`
    }
}
`, { darkMode: true });
  assert(html.includes('theme:"dark"'), "should use dark mermaid theme");
});

test("mermaid uses neutral theme when darkMode is false", () => {
  const html = parseAndRender(`
# Deck {
    # Diagram {
        \`\`\`mermaid
        graph LR
          A --> B
        \`\`\`
    }
}
`);
  assert(html.includes('theme:"neutral"'), "should use neutral mermaid theme");
});

// ============================================================
console.log("\n--- SVG diagrams in slides ---");

test("svg code block in slide renders as sdoc-svg-block", () => {
  const html = parseAndRender(`
# Deck {
    # Diagram {
        \`\`\`svg
        <svg viewBox="0 0 100 50"><rect width="100" height="50" fill="blue"/></svg>
        \`\`\`
    }
}
`);
  assert(html.includes('class="sdoc-svg-block"'), "should have sdoc-svg-block wrapper");
  assert(html.includes("<rect"), "should have SVG content");
  assert(!html.includes('language-svg'), "should not use language-svg");
});

test("svg block in slide strips script tags", () => {
  const html = parseAndRender(`
# Deck {
    # Diagram {
        \`\`\`svg
        <svg><script>alert(1)</script><rect/></svg>
        \`\`\`
    }
}
`);
  assert(!markupOf(html).includes("<script"), "should strip script from slide SVG");
  assert(html.includes("<rect/>"), "should keep safe elements");
});

// ============================================================
console.log("\n--- Drilldown (vertical) slides ---");

test("plain 1D deck still gets spine/detail metadata but no detail slides", () => {
  const html = parseAndRender(`
# Deck {
    # Slide One { First. }
    # Slide Two { Second. }
}
`);
  const slideCount = (html.match(/<div class="slide"/g) || []).length;
  assert(slideCount === 2, "1D deck still has 2 slides, got " + slideCount);
  assert(html.includes('data-spine="1"'), "spine 1 attr present");
  assert(html.includes('data-spine="2"'), "spine 2 attr present");
  assert(html.includes('data-detail="0"'), "detail=0 attr on spine slides");
  assert(!html.includes('data-detail="1"'), "no detail slides emitted");
  assert(!markupOf(html).includes("slide-has-details"), "no has-details class for 1D deck");
});

test("slide-indicator shows spine count denominator", () => {
  const html = parseAndRender(`
# Deck {
    # A { aaa }
    # B { bbb }
    # C { ccc }
}
`);
  assert(html.includes('class="slide-indicator">1 / 3'), "first slide indicator");
  assert(html.includes('class="slide-indicator">2 / 3'), "second slide indicator");
  assert(html.includes('class="slide-indicator">3 / 3'), "third slide indicator");
});

test(":detail children become sibling slides", () => {
  const html = parseAndRender(`
# Deck {
    # Spine @spine1 {
        Main content here.

        # Detail one @det1 :detail {
            First drilldown.
        }

        # Detail two @det2 :detail {
            Second drilldown.
        }
    }
    # Next @spine2 {
        Plain.
    }
}
`);
  // Three slides total: spine1, det1, det2... plus spine2 = 4
  const slideCount = (html.match(/<div class="slide[^"]*"[^>]*data-spine=/g) || []).length;
  assert(slideCount === 4, "expected 4 emitted slides (2 spines + 2 details), got " + slideCount);
  assert(html.includes('data-spine="1" data-detail="0"'), "spine 1 attrs");
  assert(html.includes('data-spine="1" data-detail="1"'), "detail 1 attrs");
  assert(html.includes('data-spine="1" data-detail="2"'), "detail 2 attrs");
  assert(html.includes('data-spine="2" data-detail="0"'), "spine 2 attrs");
});

test("emission order is spine then its details then next spine (PDF flattening)", () => {
  const html = parseAndRender(`
# Deck {
    # First @first {
        # D1 @d1 :detail {
            d1 body
        }
        # D2 @d2 :detail {
            d2 body
        }
    }
    # Second @second {
        Second body.
    }
}
`);
  const iFirst = html.indexOf('id="first"');
  const iD1 = html.indexOf('id="d1"');
  const iD2 = html.indexOf('id="d2"');
  const iSecond = html.indexOf('id="second"');
  assert(iFirst >= 0 && iD1 >= 0 && iD2 >= 0 && iSecond >= 0,
    "all anchor ids found (first=" + iFirst + " d1=" + iD1 + " d2=" + iD2 + " second=" + iSecond + ")");
  assert(iFirst < iD1 && iD1 < iD2 && iD2 < iSecond, "order should be first, d1, d2, second");
});

test("spine with details gets slide-has-details class; details do not", () => {
  const html = parseAndRender(`
# Deck {
    # Spine {
        # Detail @det :detail {
            Detail body.
        }
    }
}
`);
  // Spine has class slide-has-details; the detail itself does not.
  const spineMatch = html.match(/<div class="([^"]*)"[^>]*data-spine="1" data-detail="0"/);
  assert(spineMatch, "spine slide div found");
  assert(spineMatch[1].split(/\s+/).includes("slide-has-details"), "spine has slide-has-details");
  const detailMatch = html.match(/<div class="([^"]*)"[^>]*data-spine="1" data-detail="1"/);
  assert(detailMatch, "detail slide div found");
  assert(!detailMatch[1].split(/\s+/).includes("slide-has-details"), "detail does not have slide-has-details");
  assert(detailMatch[1].split(/\s+/).includes("slide-detail"), "detail has slide-detail class");
});

test("every slide carries the vertical nav pair, hidden until the runtime acts", () => {
  const html = parseAndRender(`
# Deck {
    # Spine one {
        # Detail @det :detail {
            Detail body.
        }
    }
    # Spine two {
        No details here.
    }
}
`);
  // Emitted on every slide, spine and detail alike. The down arrowhead has to
  // exist on a detail slide or it cannot stay visible while drilling.
  const pairs = html.match(/<div class="nav-vert">/g) || [];
  assert(pairs.length === 3, "expected nav-vert on all 3 slides, got " + pairs.length);
  assert(html.includes('<span class="nav-up">'), "nav-up emitted");
  assert(html.includes('<span class="nav-down">'), "nav-down emitted");

  // One path, drawn twice and mirrored in CSS. Text arrowheads (U+2303 against
  // U+2304) are not a matched pair: they measure ~26% apart in ink width, and
  // since few fonts carry either codepoint the mismatch varies by platform.
  const paths = html.match(/<path d="M1 1\.25 L6 5\.75 L11 1\.25"/g) || [];
  assert(paths.length === 6, "expected the same path on all 6 arrows, got " + paths.length);
  assert(!/[\u2303\u2304]/.test(html), "no text arrowhead glyphs");
  assert(/\.nav-up svg \{ transform: scaleY\(-1\); \}/.test(html), "up arrow is the mirrored copy");

  // Up sits above down in source order, so the bottom-anchored column stacks
  // them the way round Michael asked for.
  const up = html.indexOf('class="nav-up"');
  const down = html.indexOf('class="nav-down"');
  assert(up !== -1 && down !== -1 && up < down, "nav-up precedes nav-down");

  // A detail slide gets the pair too — the regression that started this.
  const detailSlice = html.slice(html.indexOf('data-detail="1"'));
  assert(detailSlice.includes('class="nav-vert"'), "detail slide carries the pair");
});

test("vertical nav starts hidden and is kept out of the print path", () => {
  const html = parseAndRender(`
# Deck {
    # Slide { Hello. }
}
`);
  // Hidden by default: a custom theme.js predating these elements does not
  // know to hide them, and a dead arrowhead on every slide is worse than none.
  const rule = html.match(/\.nav-up, \.nav-down \{[^}]*\}/);
  assert(rule, "structural rule for .nav-up/.nav-down present");
  assert(/visibility:\s*hidden/.test(rule[0]), "pair starts hidden");

  // The PDF leave-behind must not show navigation affordances.
  assert(
    html.includes(".nav-vert { display: none !important; }"),
    "print block hides .nav-vert"
  );
});

test("the drilldown chevrons are static", () => {
  const html = parseAndRender(`
# Deck {
    # Spine {
        # Detail @det :detail { Body. }
    }
}
`);
  // The down arrow used to bounce to advertise the vertical axis. A visible
  // chevron carries that on its own, and perpetual motion competes with the
  // slide, so nothing here animates.
  assert(!/slide-has-details-bounce/.test(html), "bounce keyframes gone");
  assert(!/@keyframes/.test(html) || !/nav-down\s*\{[^}]*animation/.test(html),
    "no animation on the down chevron");
});

test("detail slide indicator uses N.K notation", () => {
  const html = parseAndRender(`
# Deck {
    # A {
        # D :detail {
            d1
        }
        # E :detail {
            d2
        }
    }
    # B {
        plain
    }
}
`);
  assert(html.includes('class="slide-indicator">1 / 2'), "spine indicator");
  assert(html.includes('class="slide-indicator">1.1 / 2'), "first detail indicator");
  assert(html.includes('class="slide-indicator">1.2 / 2'), "second detail indicator");
  assert(html.includes('class="slide-indicator">2 / 2'), "second spine indicator");
});

test(":detail children are pulled out of spine slide content", () => {
  const html = parseAndRender(`
# Deck {
    # Spine {
        Main paragraph.

        # Drill @det :detail {
            Drilled content.
        }
    }
}
`);
  // The spine slide's body should NOT contain the detail's h2; only its own.
  // Easiest check: detail content must appear in a separate slide element,
  // and the spine's <section> nested rendering of the detail must not exist.
  const spineMatch = html.match(/<div class="[^"]*"[^>]*data-spine="1" data-detail="0"[^>]*>([\s\S]*?)<\/div>(?=\s*<div class="slide)/);
  assert(spineMatch, "spine slide HTML extracted");
  assert(spineMatch[1].includes("Main paragraph."), "spine still contains its own paragraph");
  assert(!spineMatch[1].includes("Drilled content."), "spine slide body should NOT contain detail body");
  assert(html.includes("Drilled content."), "detail body present elsewhere in document");
});

test("detail slide can use config: center", () => {
  const html = parseAndRender(`
# Deck {
    # Spine {
        # Drill :detail {
            config: center

            Centered drilldown.
        }
    }
}
`);
  // The detail slide should carry the "center" layout class.
  const m = html.match(/<div class="([^"]*)"[^>]*data-spine="1" data-detail="1"/);
  assert(m, "detail slide found");
  assert(m[1].split(/\s+/).includes("center"), "detail has center class");
});

// ============================================================
console.log("--- Optional slides ---");

// `optional: true` is a slide property rather than a scope type, because a
// heading carries one `:type` and a drilldown has already spent it on
// `:detail`. These tests pin the orthogonality: both spine and detail slides
// can be optional, and optional-ness never changes which of the two a slide is.

const OPTIONAL_DECK = `
# Deck {
    # Required spine {
        Plain.
    }

    # Spine with details {
        Body.

        # Required detail :detail {
            Kept.
        }

        # Optional detail :detail {
            optional: true

            Reserve.
        }
    }

    # Optional spine {
        optional: true

        Reserve spine.

        # Detail of an optional spine :detail {
            Goes with its parent.
        }
    }

    # Last spine {
        Plain.
    }
}
`;

function slideAttrs(html) {
  return (html.match(/data-spine="\d+" data-detail="\d+"/g) || []);
}

test("optional slides are present in the HTML build by default", () => {
  const html = parseAndRender(OPTIONAL_DECK);
  assert(slideAttrs(html).length === 7, "expected 7 slides, got " + slideAttrs(html).length);
  assert(html.includes("Reserve spine."), "optional spine body present");
  assert(html.includes("Reserve."), "optional detail body present");
});

test("an optional slide carries the slide-optional class", () => {
  const html = parseAndRender(OPTIONAL_DECK);
  const marked = html.match(/<div class="[^"]*slide-optional[^"]*"/g) || [];
  assert(marked.length === 2, "expected 2 marked slides, got " + marked.length);
});

test("optional-ness does not change spine or detail identity", () => {
  const html = parseAndRender(OPTIONAL_DECK);
  // The optional detail is still a detail slide…
  const detail = html.match(/<div class="([^"]*)"[^>]*data-spine="2" data-detail="2"/);
  assert(detail, "optional detail emitted under its spine");
  const detailClasses = detail[1].split(/\s+/);
  assert(detailClasses.includes("slide-detail"), "optional detail keeps slide-detail");
  assert(detailClasses.includes("slide-optional"), "optional detail is marked optional");
  // …and the optional spine is still a spine slide.
  const spine = html.match(/<div class="([^"]*)"[^>]*data-spine="3" data-detail="0"/);
  assert(spine, "optional spine emitted in the spine");
  const spineClasses = spine[1].split(/\s+/);
  assert(!spineClasses.includes("slide-detail"), "optional spine is not a detail");
  assert(spineClasses.includes("slide-optional"), "optional spine is marked optional");
});

test("optional: true is configuration, not content", () => {
  const html = parseAndRender(OPTIONAL_DECK);
  assert(!/<p>\s*optional:/i.test(html), "the config line must not render as a paragraph");
});

test("includeOptional: false drops optional slides", () => {
  const html = parseAndRender(OPTIONAL_DECK, { includeOptional: false });
  assert(slideAttrs(html).length === 4, "expected 4 slides, got " + slideAttrs(html).length);
  assert(!html.includes("Reserve spine."), "optional spine body gone");
  assert(!html.includes("Reserve."), "optional detail body gone");
  assert(!html.includes("slide-optional"), "no slide is marked optional");
  assert(html.includes("Kept."), "required detail survives");
});

test("an optional spine takes its details with it", () => {
  const html = parseAndRender(OPTIONAL_DECK, { includeOptional: false });
  assert(!html.includes("Goes with its parent."), "detail of an excluded spine is excluded");
});

test("excluding optional slides renumbers the spine", () => {
  const html = parseAndRender(OPTIONAL_DECK, { includeOptional: false });
  assert(slideAttrs(html).join("|") ===
    'data-spine="1" data-detail="0"|data-spine="2" data-detail="0"|' +
    'data-spine="2" data-detail="1"|data-spine="3" data-detail="0"',
    "spine numbering closes over the gap: " + slideAttrs(html).join("|"));
  assert(html.includes('class="slide-indicator">3 / 3'), "denominator counts the kept spines");
  assert(!markupOf(html).includes("/ 4"), "the excluded spine is not still counted");
});

test("a spine whose only detail is optional loses its drilldown affordance on export", () => {
  const deck = `
# Deck {
    # Spine {
        Body.

        # Only detail :detail {
            optional: true

            Reserve.
        }
    }
}
`;
  const full = parseAndRender(deck);
  assert(markupOf(full).includes("slide-has-details"), "the chevron is there while presenting");
  const exported = parseAndRender(deck, { includeOptional: false });
  assert(!markupOf(exported).includes("slide-has-details"), "no chevron pointing at nothing on export");
});

test("a deck with no optional slides renders identically either way", () => {
  const deck = `
# Deck {
    # One {
        Body.

        # Drill :detail {
            Detail body.
        }
    }

    # Two {
        Body.
    }
}
`;
  assert(parseAndRender(deck) === parseAndRender(deck, { includeOptional: false }),
    "includeOptional must be inert when nothing is marked optional");
});

test("optional takes the same truthy words as the other boolean keys", () => {
  const mark = (value) => `
# Deck {
    # Kept {
        Body.
    }

    # Marked {
        optional: ${value}

        Reserve.
    }
}
`;
  for (const yes of ["true", "yes", "on", "1", "TRUE"]) {
    const html = parseAndRender(mark(yes), { includeOptional: false });
    assert(!html.includes("Reserve."), `optional: ${yes} should exclude the slide`);
  }
  for (const no of ["false", "no", "later"]) {
    const html = parseAndRender(mark(no), { includeOptional: false });
    assert(html.includes("Reserve."), `optional: ${no} should keep the slide`);
  }
});

// The CLI decides includeOptional from the output format and the flags, and
// that resolution lives in build-slides.js rather than in the renderer, so it
// needs exercising through the CLI. HTML only — no browser required.
test("the CLI resolves optional slides per format, and the flags override it", () => {
  const { execFileSync } = require("child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-cli-opt-"));
  const input = path.join(dir, "deck.sdoc");
  fs.writeFileSync(input, `
# Deck {
    @meta {
        type: slides
    }

    # Kept {
        Always here.
    }

    # Reserve {
        optional: true

        Only when asked.
    }
}
`);
  const cli = path.join(__dirname, "..", "tools", "build-slides.js");
  const build = (...flags) => {
    const out = path.join(dir, "out-" + (flags.join("") || "default") + ".html");
    execFileSync(process.execPath, [cli, input, "-o", out, ...flags], { stdio: "ignore" });
    return fs.readFileSync(out, "utf-8");
  };

  // HTML keeps them by default: it is the format you present from.
  assert(build().includes("Only when asked."), "HTML default keeps optional slides");
  // But an HTML deck is also something you send on.
  assert(!build("--no-optional").includes("Only when asked."), "--no-optional drops them from HTML");
  assert(build("--with-optional").includes("Only when asked."), "--with-optional keeps them");
  // The indicator denominator follows whatever was kept.
  assert(build("--no-optional").includes('class="slide-indicator">1 / 1'), "denominator counts kept spines");
  assert(build().includes('class="slide-indicator">2 / 2'), "and counts them all by default");
  // Last flag wins, as with --fit.
  assert(!build("--with-optional", "--no-optional").includes("Only when asked."), "last flag wins");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("the CLI's --no-notes leaves every slide's notes out of the HTML", () => {
  const { execFileSync } = require("child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-cli-notes-"));
  try {
    const input = path.join(dir, "deck.sdoc");
    fs.writeFileSync(input, `
# Deck {
    # One {
        First.

        # Notes @notes {
            Internal guardrail one.
        }
    }
    # Two {
        Second.

        # Notes @notes {
            Internal guardrail two.
        }
    }
}
`);
    const cli = path.join(__dirname, "..", "tools", "build-slides.js");
    const build = (...flags) => {
      const out = path.join(dir, "out-" + (flags.join("") || "default") + ".html");
      execFileSync(process.execPath, [cli, input, "-o", out, ...flags], { stdio: "ignore" });
      return fs.readFileSync(out, "utf-8");
    };
    const withNotes = build();
    assert(withNotes.includes("Internal guardrail one.") && withNotes.includes("Internal guardrail two."), "notes kept by default");
    const without = build("--no-notes");
    assert(!/Internal guardrail/.test(without), "no slide's notes survive --no-notes");
    assert(!without.includes('<aside class="notes">'), "and no notes aside is left behind");
    assert(without.includes("First.") && without.includes("Second."), "the slides themselves are all there");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("isOptionalSlide reads the flag off a scope", () => {
  const { nodes } = parseSlides(OPTIONAL_DECK);
  const slides = nodes[0].children;
  assert(isOptionalSlide(slides[2]) === true, "the optional spine reads as optional");
  assert(isOptionalSlide(slides[0]) === false, "a plain spine does not");
  const details = slides[1].children.filter((c) => c.scopeType === "detail");
  assert(isOptionalSlide(details[1]) === true, "the optional detail reads as optional");
  assert(isOptionalSlide(details[0]) === false, "the required detail does not");
});

// ============================================================
console.log("\n--- Filmstrip ---");

test("the filmstrip runtime ships with every deck, whatever the theme", () => {
  // Structural rather than part of a theme: navigation is the one thing every
  // theme implements, and none of them should have to implement it twice. It
  // couples to a theme through the URL hash alone.
  const html = parseAndRender("# Deck {\n    # One {\n        a\n    }\n\n    # Two {\n        b\n    }\n}");
  assert(html.includes("sdoc-filmstrip-track"), "runtime present with no theme at all");
});

test("the filmstrip runtime survives being embedded in a template literal", () => {
  // It very much did not. A template literal drops an unrecognised escape, so
  // `\\s` arrived as `s` and the regex meant to collapse whitespace became one
  // that replaced every letter s with a space: "Purpose" rendered "Purpo e" in
  // every thumbnail of every deck. Silent, and invisible to any test that did
  // not look at the emitted source.
  const html = parseAndRender("# Deck {\n    # One {\n        a\n    }\n}");
  assert(html.includes('replace(/\\s+/g, " ")'), "the whitespace regex kept its backslash");
  assert(!/replace\(\/s\+\/g/.test(html), "and did not collapse into a literal s");
});

test("the filmstrip is hidden in print, so it cannot reach the PDF", () => {
  const html = parseAndRender("# Deck {\n    # One {\n        a\n    }\n}");
  const print = html.slice(html.indexOf("@media print"));
  assert(/\.sdoc-filmstrip[^{]*\{ display: none !important; \}/.test(print), "hidden in print");
});

test("a thumbnail is a button, and the strip swallows its own clicks", () => {
  // The deck navigates on a click anywhere — left half back, right half
  // forward. A thumbnail that did not stop the click would set the hash and
  // then watch the deck flip a slide and overwrite it.
  const html = parseAndRender("# Deck {\n    # One {\n        a\n    }\n}");
  assert(html.includes('createElement("button")'), "a real button, which the theme's click handler already exempts");
  assert(html.includes("strip.addEventListener(\"click\", function (e) { e.stopPropagation(); })"),
    "and the strip stops every click, for a theme that exempts nothing");
});

test("the filmstrip lives outside the slides, so no export can see it", () => {
  // It is appended to the body. The geometry harvest walks each slide's own
  // children, so a body-level element is never measured — which is what keeps
  // it out of the PowerPoint and Claude Slides exports.
  const html = parseAndRender("# Deck {\n    # One {\n        a\n    }\n}");
  const body = html.slice(html.indexOf("<body"));
  const slideAt = body.indexOf('class="slide');
  const stripAt = body.indexOf("sdoc-filmstrip-track");
  assert(slideAt !== -1 && stripAt !== -1, "both present");
  assert(html.includes("document.body.appendChild(strip)"), "attached to the body, not to a slide");
});

// ============================================================
console.log("\n--- Overview, full screen and the deck keys ---");

// Each runtime the renderer ships, by a string only that runtime contains.
function runtimeScripts(html) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const find = (marker) => scripts.find((s) => s.includes(marker));
  return {
    all: scripts,
    filmstrip: find("sdoc-filmstrip-track"),
    fullscreen: find("requestFullscreen"),
    overview: find("sdoc-overview-grid"),
    motion: find("window.sdocMotion = {"),
    gesture: find("sdoc-pull-handle"),
    kit: find("window.sdocDeckKit = ("),
    presenter: find("sdoc-presenter-notes-body"),
  };
}

test("every deck runtime ships with no theme at all", () => {
  // What each key does is tested where it is pressed, in a browser; this is
  // only that a deck built with no theme still carries them all.
  const html = parseAndRender("# Deck {\n    # One {\n        a\n    }\n\n    # Two {\n        b\n    }\n}");
  const rt = runtimeScripts(html);
  for (const name of ["filmstrip", "fullscreen", "overview", "motion", "gesture", "kit", "presenter"]) {
    assert(rt[name], "the " + name + " runtime is in the page");
  }
});

test("every deck runtime is still valid JavaScript once out of its template literal", () => {
  // The runtimes are template literals in the renderer, which silently drop
  // an unrecognised escape — the filmstrip once shipped a regex that deleted
  // every letter s. Compiling each script is what catches the next one, in a
  // runtime nobody has opened in a browser since it was edited.
  const html = parseAndRender("# Deck {\n    # One {\n        a\n    }\n\n    # Two {\n        b\n    }\n}");
  for (const src of runtimeScripts(html).all) {
    try { new Function(src); } catch (e) {
      throw new Error("a runtime does not compile: " + e.message + " — " + src.slice(0, 80).replace(/\s+/g, " "));
    }
  }
  const kit = runtimeScripts(html).kit;
  assert(kit.includes('replace(/\\s+/g, " ")'), "the shared kit's whitespace regex kept its backslash");
});

test("the overview, the pull handles and the deck hint are hidden in print", () => {
  const html = parseAndRender("# Deck {\n    # One {\n        a\n    }\n}");
  const print = html.slice(html.indexOf("@media print"));
  assert(/\.sdoc-overview, \.sdoc-deck-hint \{ display: none !important; \}/.test(print), "overview hidden in print");
  assert(/\.sdoc-pull-handle \{ display: none !important; \}/.test(print), "pull handles hidden in print");
});

test("the overview is built when it opens, so a built deck carries none of it", () => {
  // Nothing that reads a built deck — the harvests, print, any export — can
  // see what is not there.
  const html = parseAndRender("# Deck {\n    # One {\n        a\n    }\n\n    # Two {\n        b\n    }\n}");
  const body = markupOf(html.slice(html.indexOf("<body")));
  assert(!body.includes("sdoc-overview"), "no overview markup in the page as built");
});

test("while the overview is up its keys are caught before the deck's", () => {
  // The theme listens on the document. The overview listens on the window in
  // the capture phase, which runs first, so an arrow key moves through the
  // grid instead of turning the slide underneath it.
  const html = parseAndRender("# Deck {\n    # One {\n        a\n    }\n\n    # Two {\n        b\n    }\n}");
  const ov = runtimeScripts(html).overview;
  assert(/window\.addEventListener\("keydown", function \(e\) \{[\s\S]*?\}, true\);/.test(ov),
    "keydown on the window, capturing");
  assert(ov.includes("e.stopPropagation()"), "and stops what it handles");
});

// Driven in a real browser: open it, move with the keys, go somewhere, and
// check the deck underneath only moved when it was told to.
const OVERVIEW_DRIVE_SCRIPT = `
(function () {
  var out = { steps: {} };
  var press = function (k) {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  };
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  // Polled rather than timed: the springs take what they take in a headless
  // browser, and a fixed sleep is either slow or flaky.
  var until = function (cond, ms) {
    var t0 = Date.now();
    return new Promise(function (resolve) {
      (function check() {
        if (cond()) return resolve(true);
        if (Date.now() - t0 > ms) return resolve(false);
        setTimeout(check, 40);
      })();
    });
  };
  var cells = function () { return [].slice.call(document.querySelectorAll(".sdoc-overview-cell")); };
  var indexOf = function (cls) {
    return cells().findIndex(function (c) { return c.classList.contains(cls); }) + 1;
  };
  var activeId = function () {
    var a = [].slice.call(document.querySelectorAll("body > .slide.active"));
    return a.map(function (s) { return s.id; }).join(",");
  };
  var settled = function () { return indexOf("is-current") > 0; };
  var gone = function () { return !document.querySelector(".sdoc-overview"); };

  function report() {
    var el = document.createElement("script");
    el.type = "application/json";
    el.id = "sdoc-overview-drive";
    el.textContent = JSON.stringify(out) + "\\n/*${SENTINEL}*/";
    document.body.appendChild(el);
  }

  async function run() {
    out.slidesBefore = document.querySelectorAll(".slide").length;

    press("o");
    out.steps.opened = await until(settled, 4000);
    var cs = cells();
    out.cells = cs.length;
    out.badges = cs.map(function (c) {
      var m = c.querySelector(".sdoc-overview-more");
      return m ? m.textContent : "";
    });
    out.captions = cs.map(function (c) {
      var t = c.querySelector(".sdoc-overview-title");
      return t ? t.textContent : "";
    });
    out.fit = cs.map(function (c) {
      var mini = c.querySelector(".sdoc-overview-mini").getBoundingClientRect();
      var clone = c.querySelector(".sdoc-overview-mini > .slide").getBoundingClientRect();
      return {
        dw: Math.abs(mini.width - clone.width), dh: Math.abs(mini.height - clone.height),
        inside: mini.left >= 0 && mini.top >= 0 && mini.right <= innerWidth && mini.bottom <= innerHeight
      };
    });
    out.current = indexOf("is-current");
    out.focusOnHot = document.activeElement === cells()[indexOf("is-hot") - 1];
    out.ariaCurrent = cells()[0].getAttribute("aria-current");
    // A held O auto-repeats. The repeats must not close what it opened.
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "o", repeat: true, bubbles: true }));
    // Past the point a close would have finished and removed it.
    await wait(900);
    out.heldStaysOpen = !!document.querySelector(".sdoc-overview");
    // The last slide has a connector and has never been shown, so the runtime
    // has never drawn it. Its miniature is drawn by the overview.
    out.connectors = {
      original: document.querySelectorAll("body > .slide#s5 .sdoc-conn").length,
      clone: cs[4].querySelectorAll(".sdoc-conn").length
    };

    press("ArrowRight");
    press("ArrowRight");
    await wait(60);
    out.steps.arrows = { hash: location.hash, hot: indexOf("is-hot") };

    press("Enter");
    out.steps.enterClosed = await until(gone, 4000);
    out.steps.enter = { hash: location.hash, active: activeId(), slides: document.querySelectorAll(".slide").length };

    press("o");
    await until(settled, 4000);
    cells()[3].dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 5, clientY: 5 }));
    out.steps.clickClosed = await until(gone, 4000);
    out.steps.click = { hash: location.hash, active: activeId() };

    press("o");
    await until(settled, 4000);
    press("ArrowLeft");
    press("Escape");
    out.steps.escapeClosed = await until(gone, 4000);
    out.steps.escape = { hash: location.hash };

    // The larger copy. Pointer events are dispatched on whatever is under the
    // point, as a real pointer's would be.
    var move = function (x, y) {
      var target = document.elementFromPoint(x, y) || document.body;
      target.dispatchEvent(new PointerEvent("pointermove", {
        clientX: x, clientY: y, bubbles: true, pointerType: "mouse"
      }));
    };
    var centre = function (r) { return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
    var peekEl = function () { return document.querySelector(".sdoc-overview-peek"); };
    press("o");
    await until(settled, 4000);
    var mini = cells()[1].querySelector(".sdoc-overview-mini").getBoundingClientRect();
    var c = centre(mini);
    var t0 = Date.now();
    move(c.x, c.y);
    await wait(250);
    var early = !!peekEl();
    var appeared = await until(peekEl, 3000);
    var after = Date.now() - t0;
    await wait(800);
    var pr = peekEl().getBoundingClientRect();
    var held = peekEl();
    // Inside the copy but well clear of the cell it came from.
    move(pr.left + 8, pr.top + 8);
    await wait(900);
    out.steps.peek = {
      early: early, appeared: appeared, after: after,
      offCentreX: Math.abs(centre(pr).x - c.x),
      coversCell: pr.left <= mini.left && pr.right >= mini.right && pr.top <= mini.top && pr.bottom >= mini.bottom,
      biggerBy: pr.width / mini.width,
      held: peekEl() === held
    };
    // Off it, onto the bare ground: back into its cell, and nothing else
    // comes up however long the pointer stays there.
    move(4, 4);
    await wait(1400);
    out.steps.peekGone = !peekEl();
    // Resting on another cell starts the wait from nothing.
    var mini3 = cells()[2].querySelector(".sdoc-overview-mini").getBoundingClientRect();
    var c3 = centre(mini3);
    move(c3.x, c3.y);
    await wait(250);
    out.steps.peekAgainEarly = !!peekEl();
    out.steps.peekAgain = await until(peekEl, 3000);
    await wait(800);
    peekEl().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    out.steps.peekClickClosed = await until(gone, 4000);
    out.steps.peekClick = { hash: location.hash, active: activeId() };

    // A pointer that moves while the cells are still flying in. The slide we
    // are on starts the size of the window and shrinks into its cell, so for
    // most of the way in it is under the pointer wherever the pointer is.
    // Which cell the pointer is on has to be asked once they land.
    press("o");
    var first = cells()[0];
    var aim = {
      x: parseFloat(first.style.left) + parseFloat(first.style.width) / 2,
      y: parseFloat(first.style.top) + 20
    };
    var underThen = document.elementFromPoint(aim.x, aim.y);
    underThen = underThen && underThen.closest ? underThen.closest(".sdoc-overview-cell") : null;
    move(aim.x, aim.y);
    await until(settled, 4000);
    await until(peekEl, 3000);
    out.steps.midFlight = {
      underThen: underThen ? underThen.getAttribute("data-sdoc-overview") : null,
      peekOf: peekEl() ? peekEl().getAttribute("aria-label") : null
    };
    press("Escape");
    press("Escape");
    await until(gone, 4000);

    var calls = 0;
    document.documentElement.requestFullscreen = function () { calls++; return Promise.resolve(); };
    press("f");
    await wait(30);
    var strip = document.querySelector(".sdoc-filmstrip");
    out.steps.f = { fullscreenCalls: calls, stripOpen: strip.classList.contains("is-open") };
    press("t");
    await wait(30);
    out.steps.t = { stripOpen: strip.classList.contains("is-open") };
  }

  function start() {
    var go = function () {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          run().catch(function (e) { out.__error = String((e && e.message) || e); }).then(report);
        });
      });
    };
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) document.fonts.ready.then(go);
    else go();
  }
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start);
})();
`;

const OVERVIEW_DECK = `
# Deck {
    @meta { type: slides }

    # Opening @s1 {
        kicker: Start

        The first slide.
    }

    # With details @s2 {
        Has two details under it.

        # First detail @s2a :detail {
            One.
        }

        # Second detail @s2b :detail {
            Two.
        }
    }

    # Middle @s3 {
        The third slide.
    }

    # Fourth @s4 {
        The fourth slide.
    }

    # Last @s5 {
        config: columns

        # Alpha @alpha {
            One.
        }

        # Beta @beta {
            Two.
        }

        # @connectors {
            {
                from: @alpha right

                to: @beta left

                shape: straight
            }
        }
    }
}
`;

test("the overview opens, moves on the keys, and goes where it is told (browser)", async () => {
  browser.skip();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-overview-"));
  const file = path.join(dir, "deck.html");
  const themeDir = path.join(__dirname, "..", "themes", "default");
  fs.writeFileSync(file, parseAndRender(OVERVIEW_DECK, {
    themeCss: fs.readFileSync(path.join(themeDir, "theme.css"), "utf-8"),
    themeJs: fs.readFileSync(path.join(themeDir, "theme.js"), "utf-8"),
  }), "utf-8");
  let r;
  try {
    r = await runHarvest(file, OVERVIEW_DRIVE_SCRIPT, "sdoc-overview-drive");
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  assert(!r.__error, "the drive threw: " + r.__error);
  const s = r.steps;

  assert(s.opened, "the overview opened and settled");
  assert(r.cells === 5, "one cell per spine slide, details folded in: got " + r.cells);
  assert(r.badges[1] === "+2" && r.badges.filter(Boolean).length === 1,
    "the spine slide with two details says so, and only it: " + JSON.stringify(r.badges));
  assert(r.captions[2] === "Middle", "captions carry the title: " + JSON.stringify(r.captions));
  assert(r.connectors.original === 0, "the unvisited original is undrawn, as expected: " + r.connectors.original);
  assert(r.connectors.clone > 0, "but its miniature has its connector drawn");
  assert(r.current === 1, "the slide we were on is marked current, got " + r.current);
  assert(r.ariaCurrent === "true", "and says so to a screen reader");
  assert(r.focusOnHot, "focus moves to the chosen cell, so it is announced");
  assert(r.heldStaysOpen, "holding O does not close the overview it just opened");
  // The clone is scaled from its design box to exactly the cell, and every
  // cell fits the window: five slides should never need a scroll.
  for (const [i, f] of r.fit.entries()) {
    assert(f.dw < 1.5 && f.dh < 1.5, "cell " + (i + 1) + ": the miniature is not the cell's size, off by " + f.dw + "x" + f.dh);
    assert(f.inside, "cell " + (i + 1) + " is outside the window");
  }

  assert(s.arrows.hash === "#1", "an arrow key turned the slide under the overview: " + s.arrows.hash);
  assert(s.arrows.hot === 3, "two steps right from the first cell is the third, got " + s.arrows.hot);

  assert(s.enterClosed, "Enter closed the overview");
  assert(s.enter.hash === "#3" && s.enter.active === "s3", "Enter went to the chosen slide: " + JSON.stringify(s.enter));
  assert(s.enter.slides === r.slidesBefore, "the clones went with it: " + s.enter.slides + " slides, was " + r.slidesBefore);

  assert(s.clickClosed, "a click closed the overview");
  assert(s.click.hash === "#4" && s.click.active === "s4", "a click went to that slide: " + JSON.stringify(s.click));

  assert(s.escapeClosed, "Escape closed the overview");
  assert(s.escape.hash === "#4", "Escape stays where you were, whatever was chosen: " + s.escape.hash);

  const pk = s.peek;
  assert(!pk.early, "the larger copy waits for the pointer to rest, it does not pop up at once");
  assert(pk.appeared && pk.after >= 550, "and does come up once it has: after " + pk.after + "ms");
  assert(pk.offCentreX < 1.5, "centred on its cell, off by " + pk.offCentreX + "px");
  assert(pk.coversCell && pk.biggerBy > 1.3, "over the cell and larger than it: " + JSON.stringify(pk));
  assert(pk.held, "the pointer staying inside it keeps it");
  assert(s.peekGone, "leaving it sends it back, and nothing else comes up unbidden");
  assert(!s.peekAgainEarly, "the wait starts from nothing on the next cell");
  assert(s.peekAgain, "and the next cell does get one once the pointer rests");
  assert(s.peekClickClosed && s.peekClick.hash === "#3" && s.peekClick.active === "s3",
    "a click on the larger copy goes to its slide: " + JSON.stringify(s.peekClick));
  assert(s.midFlight.underThen === "2",
    "the trap was set: the current slide was under the pointer as it moved, got " + s.midFlight.underThen);
  assert(s.midFlight.peekOf === "Slide 1: Opening",
    "the copy is of the cell the pointer is on once they land, not the one passing under it: " + s.midFlight.peekOf);

  assert(s.f.fullscreenCalls === 1, "F asked for full screen");
  assert(!s.f.stripOpen, "and did not open the filmstrip, which it used to");
  assert(s.t.stripOpen, "T opens the filmstrip");
});

test("no cell is ringed just for sitting under a resting pointer", () => {
  // The runtime reads hover from movement, so that a resting mouse cannot take
  // the choice from the keys. A :hover rule would ring that cell anyway, and
  // two cells would look chosen with only one answering Enter.
  const html = parseAndRender("# Deck {\n    # One {\n        a\n    }\n\n    # Two {\n        b\n    }\n}");
  assert(!/\.sdoc-overview-cell:hover/.test(html), "no :hover ring on a cell");
});

// A deck long enough that the overview scrolls.
const LONG_DRIVE_SCRIPT = `
(function () {
  var out = {};
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var until = function (cond, ms) {
    var t0 = Date.now();
    return new Promise(function (resolve) {
      (function check() {
        if (cond()) return resolve(true);
        if (Date.now() - t0 > ms) return resolve(false);
        setTimeout(check, 40);
      })();
    });
  };
  var press = function (k) { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); };
  function report() {
    var el = document.createElement("script");
    el.type = "application/json";
    el.id = "sdoc-long-drive";
    el.textContent = JSON.stringify(out) + "\\n/*${SENTINEL}*/";
    document.body.appendChild(el);
  }
  async function run() {
    press("o");
    await until(function () { return !!document.querySelector(".sdoc-overview-cell.is-current"); }, 4000);
    var ov = document.querySelector(".sdoc-overview");
    out.scrolls = ov.scrollHeight > ov.clientHeight;
    var cells = [].slice.call(document.querySelectorAll(".sdoc-overview-cell"));
    var room = ov.getBoundingClientRect().left + ov.clientWidth;
    out.overhang = Math.max.apply(null, cells.map(function (c) { return c.getBoundingClientRect().right - room; }));
    // To the last cell, below the fold: the grid scrolls to it, and its
    // larger copy still comes up after the usual wait.
    press("End");
    await wait(60);
    out.scrolled = ov.scrollTop > 0;
    out.peek = await until(function () { return !!document.querySelector(".sdoc-overview-peek"); }, 2500);
    out.peekOf = out.peek ? document.querySelector(".sdoc-overview-peek").getAttribute("aria-label") : null;
  }
  function start() {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        run().catch(function (e) { out.__error = String((e && e.message) || e); }).then(report);
      });
    });
  }
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start);
})();
`;

test("a deck too long to fit scrolls, and the keys still bring up the larger copy (browser)", async () => {
  browser.skip();
  let src = "# Deck {\n    @meta { type: slides }\n";
  for (let i = 1; i <= 150; i++) src += `\n    # Slide ${i} {\n        Body ${i}.\n    }\n`;
  src += "}\n";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-long-"));
  const file = path.join(dir, "deck.html");
  const themeDir = path.join(__dirname, "..", "themes", "default");
  fs.writeFileSync(file, parseAndRender(src, {
    themeCss: fs.readFileSync(path.join(themeDir, "theme.css"), "utf-8"),
    themeJs: fs.readFileSync(path.join(themeDir, "theme.js"), "utf-8"),
  }), "utf-8");
  let r;
  try {
    r = await runHarvest(file, LONG_DRIVE_SCRIPT, "sdoc-long-drive");
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  assert(!r.__error, "the drive threw: " + r.__error);
  assert(r.scrolls, "a hundred and fifty slides do not fit, so the overview scrolls");
  assert(r.overhang <= 0.5, "no column runs past the scroll area: " + r.overhang + "px over");
  assert(r.scrolled, "End scrolls the grid to the last cell");
  assert(r.peek && r.peekOf === "Slide 150: Slide 150",
    "and the scroll does not cancel its larger copy: " + r.peekOf);
});

// A pull from either edge, driven the way a mouse and a finger would drive it.
const PULL_DRIVE_SCRIPT = `
(function () {
  var out = {};
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var until = function (cond, ms) {
    var t0 = Date.now();
    return new Promise(function (resolve) {
      (function check() {
        if (cond()) return resolve(true);
        if (Date.now() - t0 > ms) return resolve(false);
        setTimeout(check, 40);
      })();
    });
  };
  var pe = function (type, x, y) {
    var t = document.elementFromPoint(x, y) || document.body;
    t.dispatchEvent(new PointerEvent(type, {
      clientX: x, clientY: y, bubbles: true, cancelable: true,
      pointerType: "mouse", pointerId: 7, button: 0, buttons: type === "pointerup" ? 0 : 1
    }));
  };
  // What a browser sends after a press and release on the page.
  var click = function (x, y) {
    document.documentElement.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y }));
  };
  var drag = function (x, ys) { ys.forEach(function (y) { pe("pointermove", x, y); }); };
  var range = function (a, b, step) {
    var r = [];
    for (var y = a; step > 0 ? y <= b : y >= b; y += step) r.push(y);
    return r;
  };
  var overlay = function () { return document.querySelector(".sdoc-overview"); };
  var settled = function () { return !!document.querySelector(".sdoc-overview-cell.is-current"); };
  var goHash = function (h) {
    if (location.hash === "#" + h) return Promise.resolve();
    location.hash = h;
    return until(function () { return location.hash === "#" + h; }, 1000).then(function () { return wait(60); });
  };

  function report() {
    var el = document.createElement("script");
    el.type = "application/json";
    el.id = "sdoc-pull-drive";
    el.textContent = JSON.stringify(out) + "\\n/*${SENTINEL}*/";
    document.body.appendChild(el);
  }

  async function run() {
    // In the right half, where a click the pull failed to swallow would turn
    // the slide forward. At the centre it reads as "back", which from the
    // first slide does nothing and would hide the leak.
    var cx = Math.round(innerWidth * 0.7), vh = innerHeight;

    // A press in the band that never moves is an ordinary click.
    pe("pointerdown", innerWidth - 100, 20);
    pe("pointerup", innerWidth - 100, 20);
    click(innerWidth - 100, 20);
    await wait(80);
    out.plainClick = location.hash;
    await goHash("1");

    // Down from the top, held part-way: the overview is under the pointer.
    pe("pointerdown", cx, 20);
    drag(cx, range(26, 120, 6));
    var cur = document.querySelector(".sdoc-overview-cell");
    var bd = document.querySelector(".sdoc-overview-backdrop");
    var curCell = document.querySelector(".sdoc-overview-cell:nth-child(1)");
    var armed = function () { return document.documentElement.classList.contains("sdoc-pull-armed"); };
    out.midPull = {
      overlay: !!overlay(),
      backdrop: bd ? parseFloat(bd.style.opacity) : null,
      currentMoving: cur ? cur.style.transform !== "" && cur.style.transform !== "none" : false,
      currentFading: curCell ? parseFloat(curCell.style.opacity) : null,
      armed: armed(),
      grabbing: getComputedStyle(document.body).cursor
    };
    // An arrow mid-pull belongs to the pull, not to the deck underneath.
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await wait(40);
    out.arrowMidPull = location.hash;
    drag(cx, range(126, 320, 6));
    out.armedAtLine = { armed: armed(), cursor: getComputedStyle(document.body).cursor };
    pe("pointerup", cx, 320);
    click(cx, 320);
    out.pullOpened = await until(settled, 4000);
    out.afterPull = { hash: location.hash, cls: document.documentElement.className };
    // T behind the overview would switch the strip on unseen.
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "t", bubbles: true }));
    out.tBehindOverview = document.querySelector(".sdoc-filmstrip").classList.contains("is-open");
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await until(function () { return !overlay(); }, 4000);

    // Past the line and back: called off.
    pe("pointerdown", cx, 20);
    drag(cx, range(26, 320, 6));
    drag(cx, range(314, 40, -6));
    out.backedOff = armed();
    pe("pointerup", cx, 40);
    click(cx, 40);
    out.cancelGone = await until(function () { return !overlay(); }, 4000);
    out.afterCancel = { hash: location.hash, slides: document.querySelectorAll(".slide").length };

    // Up from the bottom: the filmstrip, switched on as T would.
    var strip = document.querySelector(".sdoc-filmstrip");
    pe("pointerdown", cx, vh - 20);
    drag(cx, range(vh - 26, vh - 320, -6));
    out.bottomArmed = armed();
    pe("pointerup", cx, vh - 320);
    click(cx, vh - 320);
    await wait(700);
    out.strip = { open: strip.classList.contains("is-open"), stored: sessionStorage.getItem("sdocFilmstrip"), hash: location.hash };
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "t", bubbles: true }));

    // A finger, on a drilldown slide, where the theme reads a vertical swipe
    // as a move up the column. The pull has to be the only thing that happens.
    await goHash("2.1");
    var tt = document.elementFromPoint(cx, 20);
    var touch = function (y) { return new Touch({ identifier: 1, target: tt, clientX: cx, clientY: y }); };
    tt.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [touch(20)], changedTouches: [touch(20)] }));
    var moves = 0, held = 0;
    range(26, 320, 6).forEach(function (y) {
      var ev = new TouchEvent("touchmove", { bubbles: true, cancelable: true, touches: [touch(y)], changedTouches: [touch(y)] });
      tt.dispatchEvent(ev);
      moves++;
      if (ev.defaultPrevented) held++;
    });
    tt.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true, touches: [], changedTouches: [touch(320)] }));
    out.touch = { moves: moves, held: held, opened: await until(settled, 4000), hash: location.hash };
  }

  function start() {
    var go = function () {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          run().catch(function (e) { out.__error = String((e && e.message) || e); }).then(report);
        });
      });
    };
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) document.fonts.ready.then(go);
    else go();
  }
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start);
})();
`;

test("a pull from either edge opens its view, and only a pull does (browser)", async () => {
  browser.skip();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-pull-"));
  const file = path.join(dir, "deck.html");
  const themeDir = path.join(__dirname, "..", "themes", "default");
  fs.writeFileSync(file, parseAndRender(OVERVIEW_DECK, {
    themeCss: fs.readFileSync(path.join(themeDir, "theme.css"), "utf-8"),
    themeJs: fs.readFileSync(path.join(themeDir, "theme.js"), "utf-8"),
  }), "utf-8");
  let r;
  try {
    r = await runHarvest(file, PULL_DRIVE_SCRIPT, "sdoc-pull-drive");
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  assert(!r.__error, "the drive threw: " + r.__error);

  assert(r.plainClick === "#2", "a press in the band that never moved still turns the slide: " + r.plainClick);

  assert(r.midPull.overlay, "the overview is there while the pull is held");
  assert(r.midPull.backdrop > 0 && r.midPull.backdrop <= 1, "its ground is coming in: " + r.midPull.backdrop);
  assert(r.midPull.currentMoving, "and the slide we were on is part way into its cell — the pull scrubs the way in");
  assert(r.midPull.currentFading > 0 && r.midPull.currentFading < 0.9,
    "and fading as it goes, so the grid reads through it: " + r.midPull.currentFading);
  assert(r.arrowMidPull === "#1", "an arrow key mid-pull did not turn the slide underneath: " + r.arrowMidPull);
  assert(!r.midPull.armed && r.midPull.grabbing === "grabbing",
    "short of the line the cursor is a closed hand: " + JSON.stringify(r.midPull));
  assert(r.armedAtLine.armed && r.armedAtLine.cursor === "grab",
    "past it, the cursor says letting go counts: " + JSON.stringify(r.armedAtLine));
  assert(r.pullOpened, "let go past the line, the overview finishes opening");
  assert(r.afterPull.hash === "#1", "and the click after the pull did not turn the slide: " + r.afterPull.hash);
  assert(!/sdoc-pull/.test(r.afterPull.cls), "and the pull's cursors are gone: " + r.afterPull.cls);
  assert(!r.tBehindOverview, "T does nothing while the overview is up");

  assert(r.backedOff === false, "dragged back above the line, it no longer counts");
  assert(r.cancelGone, "let go there, the overview goes back where it came from");
  assert(r.afterCancel.hash === "#1", "having changed nothing: " + r.afterCancel.hash);
  assert(r.afterCancel.slides === 7, "and leaving no clones behind: " + r.afterCancel.slides + " slides");

  assert(r.bottomArmed, "the bottom edge counts the same way");
  assert(r.strip.open && r.strip.stored === "1", "and switches the strip on as T does: " + JSON.stringify(r.strip));
  assert(r.strip.hash === "#1", "without turning the slide: " + r.strip.hash);

  assert(r.touch.held === r.touch.moves, "every touchmove of a pull is kept from scrolling or reloading the page: " +
    r.touch.held + " of " + r.touch.moves);
  assert(r.touch.opened, "a finger pulls the overview open too");
  assert(r.touch.hash === "#2.1", "and the theme never saw it as a swipe up the column: " + r.touch.hash);
});

// ---- Page Down and Page Up, on their own: the default theme's, with no
// presenter view involved.
test("Page Down and Page Up move as a presentation clicker expects (browser)", async () => {
  browser.skip();
  const themeDir = path.join(__dirname, "..", "themes", "default");
  const html = parseAndRender(`
# Deck {
    @meta { type: slides }

    # One @c1 {
        a
    }

    # Two @c2 {
        b

        # First detail @c2a :detail {
            c
        }

        # Second detail @c2b :detail {
            d
        }
    }

    # Three @c3 {
        e
    }
}
`, {
    themeCss: fs.readFileSync(path.join(themeDir, "theme.css"), "utf-8"),
    themeJs: fs.readFileSync(path.join(themeDir, "theme.js"), "utf-8"),
  });
  const file = path.join(tempDir("sdoc-clicker-"), "deck.html");
  fs.writeFileSync(file, html, "utf-8");
  const r = await runHarvest(file, `
(function () {
  var out = { steps: [] };
  // The slide on show, as the hash would write it. The theme takes a hash
  // set from outside a moment after it is set, so the slide is what says
  // the deck has arrived.
  var shown = function () {
    var a = document.querySelector("body > .slide.active");
    if (!a) return null;
    var d = a.getAttribute("data-detail") || "0";
    return "#" + a.getAttribute("data-spine") + (d === "0" ? "" : "." + d);
  };
  var at = function (hash) {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      (function check() {
        if (location.hash === hash && shown() === hash) return resolve(true);
        if (Date.now() - t0 > 1500) return resolve(false);
        setTimeout(check, 30);
      })();
    });
  };
  // From a slide, a key: where the deck ends up, once it has moved.
  var press = async function (from, key, to) {
    location.hash = from;
    await at("#" + from);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: key, bubbles: true }));
    var arrived = await at("#" + to);
    out.steps.push(from + " " + key + " -> " + location.hash.slice(1) + (arrived ? "" : " (wanted " + to + ")"));
  };
  async function run() {
    await press("2", "PageDown", "3");
    await press("2.1", "PageDown", "2.2");
    await press("2.2", "PageDown", "3");
    await press("2.2", "PageUp", "2.1");
    await press("2.1", "PageUp", "2");
    await press("2", "PageUp", "1");
    await press("3", "PageUp", "2");
    // At either end there is nowhere to go, and a key typed into a field
    // is text.
    location.hash = "3";
    await at("#3");
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }));
    var field = document.createElement("input");
    document.body.appendChild(field);
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
    await new Promise(function (r) { setTimeout(r, 150); });
    out.stayed = location.hash;
  }
  function start() {
    run().catch(function (e) { out.__error = String((e && e.stack) || e); }).then(function () {
      var el = document.createElement("script");
      el.type = "application/json";
      el.id = "sdoc-clicker";
      el.textContent = JSON.stringify(out) + "\\n/*${SENTINEL}*/";
      document.body.appendChild(el);
    });
  }
  if (document.readyState === "complete") start(); else window.addEventListener("load", start);
})();
`, "sdoc-clicker");
  assert(!r.__error, "the drive threw: " + r.__error);
  const want = [
    "2 PageDown -> 3",       // from a spine slide, on along the spine
    "2.1 PageDown -> 2.2",   // inside a column, down it
    "2.2 PageDown -> 3",     // and from its last detail, on to the next spine slide
    "2.2 PageUp -> 2.1",     // back up a column a detail at a time
    "2.1 PageUp -> 2",       // the first detail to its spine slide
    "2 PageUp -> 1",         // from a spine slide, the previous one
    "3 PageUp -> 2",         // which is not that slide's last detail
  ];
  assert(r.steps.join("; ") === want.join("; "), "each key from each place: " + r.steps.join("; "));
  assert(r.stayed === "#3", "Page Down on the last slide, and Page Up typed into a field, move nothing: " + r.stayed);
});

// ============================================================
console.log("\n--- Presenter view ---");

// Notes on the opening slide, on a spine slide with two details and on its
// first detail; none on the second detail or the last slide.
const PRESENTER_DECK = `
# Deck {
    @meta { type: slides }

    # Opening @p1 {
        Welcome.

        # Notes @notes {
            Thank everyone for coming.
        }
    }

    # With details @p2 {
        The middle.

        # Notes @notes {
            Say why this matters, then **drill down**.
        }

        # First detail @p2a :detail {
            One.

            # Notes @notes {
                The first detail's note.
            }
        }

        # Second detail @p2b :detail {
            Two.
        }
    }

    # Third @p3 {
        Three.
    }

    # Last @p4 {
        The end.
    }
}
`;

// The deck as a page. Harvested with AS_PRESENTER it is the presenter window,
// as the deck opens it; opener gives that window a deck to talk to before any
// runtime runs — a frame's window, since a message's source has to be a
// window — which records what the presenter window tells the audience.
const AS_PRESENTER = { query: "?presenter=1" };
function presenterPage(src, { opener, themeConfig, deckCss } = {}) {
  const themeDir = path.join(__dirname, "..", "themes", "default");
  let html = parseAndRender(src, {
    themeCss: fs.readFileSync(path.join(themeDir, "theme.css"), "utf-8"),
    themeJs: fs.readFileSync(path.join(themeDir, "theme.js"), "utf-8"),
    ...(themeConfig ? { themeConfig } : {}),
    ...(deckCss ? { deckCss } : {}),
  });
  if (opener) {
    const early = "<script>(function () {" +
      'var f = document.createElement("iframe");' +
      'f.style.cssText = "position:absolute;left:-20px;top:0;width:1px;height:1px;border:0";' +
      "document.body.appendChild(f);" +
      // A copy of each message, as postMessage makes one: what was sent
      // cannot change afterwards under the test reading it.
      "window.__toAudience = [];" +
      "f.contentWindow.postMessage = function (m) { window.__toAudience.push(JSON.parse(JSON.stringify(m))); };" +
      "window.opener = f.contentWindow;" +
      "})();</script>";
    html = html.replace("<body>", "<body>\n" + early);
  }
  const dir = tempDir("sdoc-presenter-");
  const file = path.join(dir, "deck.html");
  fs.writeFileSync(file, html, "utf-8");
  return file;
}

// Shared by the drives below: waiting, reporting, reading the stage.
const DRIVE_HELPERS = `
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var until = function (cond, ms) {
    var t0 = Date.now();
    return new Promise(function (resolve) {
      (function check() { if (cond()) return resolve(true); if (Date.now() - t0 > ms) return resolve(false); setTimeout(check, 40); })();
    });
  };
  var key = function (k) { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); };
  var frameWindow = function () {
    var f = document.createElement("iframe");
    f.style.cssText = "position:absolute;left:-20px;top:0;width:1px;height:1px;border:0";
    document.body.appendChild(f);
    return f.contentWindow;
  };
  // The other window, stood in for by a frame's: for a presenter page the
  // opener it was given, for a deck a window this one opened. Made when it
  // is first asked for.
  var peerWindow = null, strangerWindow = null;
  var peer = function () {
    if (!peerWindow) {
      peerWindow = window.opener || frameWindow();
      if (!window.opener) peerWindow.opener = window;
    }
    return peerWindow;
  };
  // A window that is neither: another deck's, or anything else on the page.
  var stranger = function () { return strangerWindow || (strangerWindow = frameWindow()); };
  var started = function () { var p = document.querySelector(".sdoc-presenter"); return !!(p && p.classList.contains("is-started")); };
  var resetArmed = function () { return document.querySelector(".sdoc-presenter-reset").classList.contains("is-armed"); };
  var from = function (msg, source) {
    msg.sdoc = "sdoc-presenter";
    window.dispatchEvent(new MessageEvent("message", { data: msg, source: source || peer() }));
  };
  var go = function (pos) {
    location.hash = pos;
    return until(function () { return location.hash === "#" + pos; }, 1000).then(function () { return wait(80); });
  };
`;

// ---- What a key is, and where the deck's remarks go.
test("keys typed into a field are text, a window's name makes no presenter view, and there is one hint (browser)", async () => {
  browser.skip();
  const themeDir = path.join(__dirname, "..", "themes", "default");
  let html = parseAndRender(PRESENTER_DECK, {
    themeCss: fs.readFileSync(path.join(themeDir, "theme.css"), "utf-8"),
    themeJs: fs.readFileSync(path.join(themeDir, "theme.js"), "utf-8"),
  });
  // A window can keep a name from whatever it showed before.
  html = html.replace("<body>", '<body>\n<script>window.name = "sdoc-presenter";</script>');
  const file = path.join(tempDir("sdoc-keys-"), "deck.html");
  fs.writeFileSync(file, html, "utf-8");
  const r = await runHarvest(file, `
(function () {
  var out = {};
  ${DRIVE_HELPERS}
  var q = function (s) { return document.querySelector(s); };
  var stripOpen = function () { var s = q(".sdoc-filmstrip"); return !!(s && s.classList.contains("is-open")); };
  var hints = function () { return document.querySelectorAll(".sdoc-deck-hint"); };
  var hintShown = function () { return [].some.call(hints(), function (h) { return h.classList.contains("is-shown"); }); };
  async function run() {
    out.presenterUi = !!q(".sdoc-presenter");
    var opened = 0, asked = 0;
    window.open = function () { opened++; return null; };
    document.documentElement.requestFullscreen = function () { asked++; return Promise.reject(new Error("not here")); };
    var field = document.createElement("input");
    document.body.appendChild(field);
    field.focus();
    var hash = location.hash;
    ["t", "o", "p", "f", "d", "c", "ArrowRight", " "].forEach(function (k) {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    });
    // Nothing is meant to happen, so there is nothing to wait for but time.
    await wait(200);
    out.typed = { strip: stripOpen(), overview: !!q(".sdoc-overview"), opened: opened, asked: asked,
      ink: !!q(".sdoc-deck-ink"), hint: hintShown(), moved: location.hash !== hash };
    field.parentNode.removeChild(field);
    // The same keys on the page are commands.
    key("t");
    out.onPage = { strip: await until(stripOpen, 1000) };
    key("p");
    await until(hintShown, 1000);
    out.onPage.opened = opened;
    out.onPage.blocked = hints()[0] ? hints()[0].textContent : null;
    // Full screen refused: said in the same place, and for a shorter time.
    key("f");
    await until(function () { return hints()[0] && /Full screen/.test(hints()[0].textContent); }, 1000);
    out.full = { asked: asked, said: hints()[0] ? hints()[0].textContent : null, hints: hints().length };
    out.full.goneSoon = await until(function () { return !hintShown(); }, 2000);
  }
  function start() {
    run().catch(function (e) { out.__error = String((e && e.stack) || e); }).then(function () {
      var el = document.createElement("script");
      el.type = "application/json";
      el.id = "sdoc-keys";
      el.textContent = JSON.stringify(out) + "\\n/*${SENTINEL}*/";
      document.body.appendChild(el);
    });
  }
  if (document.readyState === "complete") start(); else window.addEventListener("load", start);
})();
`, "sdoc-keys");
  assert(!r.__error, "the drive threw: " + r.__error);
  const show = (o) => JSON.stringify(o);
  assert(!r.presenterUi, "the presenter view is the deck with ?presenter in its address, whatever the window is called");
  const t = r.typed;
  assert(!t.strip && !t.overview && t.opened === 0 && t.asked === 0 && !t.ink && !t.hint && !t.moved,
    "T, O, P, F, D, C, an arrow and Space typed into a field do nothing to the deck: " + show(t));
  assert(r.onPage.strip && r.onPage.opened === 1 && /blocked/.test(r.onPage.blocked || ""), "on the page they are commands: " + show(r.onPage));
  assert(r.full.asked === 1 && /Full screen is not available/.test(r.full.said || "") && r.full.hints === 1,
    "a refusal to go full screen is said in the deck's one hint, not a second: " + show(r.full));
  assert(r.full.goneSoon, "and is gone within two seconds, sooner than the deck's other remarks");
});

const PRESENTER_DRIVE = `
(function () {
  var out = {};
  ${DRIVE_HELPERS}
  function stage() {
    var res = {};
    ["up", "prev", "current", "next", "down"].forEach(function (k) {
      var slot = document.querySelector(".sdoc-presenter-slot.is-" + k);
      var mini = slot.querySelector(".sdoc-overview-mini > .slide");
      res[k] = mini ? mini.id : null;
      res[k + "W"] = slot.querySelector(".sdoc-presenter-frame").getBoundingClientRect().width;
    });
    res.notes = document.querySelector(".sdoc-presenter-notes-body").textContent.trim();
    res.count = document.querySelector(".sdoc-presenter-count").textContent;
    res.status = document.querySelector(".sdoc-presenter-status").textContent;
    return res;
  }
  var sent = function (type) { return (window.__toAudience || []).filter(function (m) { return m.type === type; }); };
  // Where each control in the bar is, and how wide: none may move or resize
  // as the talk changes state.
  var barAt = function () {
    return [].slice.call(document.querySelectorAll(".sdoc-presenter-bar > *")).map(function (n) {
      var r = n.getBoundingClientRect();
      return n.className.split(" ")[0].replace("sdoc-presenter-", "") + "@" + Math.round(r.left) + "+" + Math.round(r.width);
    }).filter(function (k) { return !/^(status|gap)[ @]/.test(k); });
  };
  function report() {
    var el = document.createElement("script");
    el.type = "application/json";
    el.id = "sdoc-presenter-drive";
    el.textContent = JSON.stringify(out) + "\\n/*${SENTINEL}*/";
    document.body.appendChild(el);
  }
  async function run() {
    await until(function () { return !!document.querySelector(".sdoc-presenter-slot.is-current .sdoc-overview-mini"); }, 4000);
    out.ui = !!document.querySelector(".sdoc-presenter");
    out.hello = sent("hello").length;

    await go("2");
    out.atSpine = stage();
    await go("2.1");
    out.atDetail = stage();
    await go("2.2");
    out.atLastDetail = stage();
    await go("1");
    out.atFirst = stage();

    // The divider: dragged down, the notes shrink and the current slide
    // grows to fill the room; remembered; a double-click resets it.
    var split = document.querySelector(".sdoc-presenter-split");
    var notesEl = document.querySelector(".sdoc-presenter-notes");
    var curW = function () { return document.querySelector(".sdoc-presenter-slot.is-current .sdoc-presenter-frame").getBoundingClientRect().width; };
    var sr = split.getBoundingClientRect(), y0 = sr.top + sr.height / 2;
    var pe = function (type, y) { split.dispatchEvent(new PointerEvent(type, { clientX: sr.left + 20, clientY: y, bubbles: true, pointerId: 9, button: 0, buttons: type === "pointerup" ? 0 : 1 })); };
    var before = { notesH: notesEl.getBoundingClientRect().height, curW: curW(), hash: location.hash };
    pe("pointerdown", y0); pe("pointermove", y0 + 80); pe("pointermove", y0 + 160); pe("pointerup", y0 + 160);
    await until(function () { return localStorage.getItem("sdocPresenterNotesShare") !== null; }, 1000);
    out.split = { before: before, after: { notesH: notesEl.getBoundingClientRect().height, curW: curW() },
      stored: localStorage.getItem("sdocPresenterNotesShare") };
    split.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await until(function () { return notesEl.getBoundingClientRect().height !== out.split.after.notesH; }, 1000);
    out.split.reset = { notesH: notesEl.getBoundingClientRect().height, curW: curW() };
    split.focus();
    split.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    await until(function () { return notesEl.getBoundingClientRect().height !== out.split.reset.notesH; }, 1000);
    out.split.keyed = { notesH: notesEl.getBoundingClientRect().height, hash: location.hash };

    // Notes size: + makes them larger, and it is remembered.
    var before = parseFloat(getComputedStyle(document.querySelector(".sdoc-presenter-notes")).fontSize);
    key("+"); key("+");
    out.notesSize = { before: before, after: parseFloat(getComputedStyle(document.querySelector(".sdoc-presenter-notes")).fontSize),
      stored: localStorage.getItem("sdocPresenterNotesSize") };

    out.barBefore = barAt();
    // Every widget in the bar one height, centred on one line.
    out.barBoxes = [].slice.call(document.querySelectorAll(".sdoc-presenter-bar > *")).filter(function (n) {
      return !/sdoc-presenter-(status|gap)/.test(n.className);
    }).map(function (n) {
      var r = n.getBoundingClientRect();
      return { name: n.className.split(" ")[0].replace("sdoc-presenter-", ""), h: Math.round(r.height), mid: Math.round(r.top + r.height / 2) };
    });
    out.disabledBefore = { start: document.querySelector(".sdoc-presenter-start").disabled,
      timer: document.querySelector(".sdoc-presenter-timer").disabled, reset: document.querySelector(".sdoc-presenter-reset").disabled };
    // Before Start: private. The audience is on 1; browsing here sends nothing.
    from({ type: "position", position: "1" });
    await go("3");
    out.beforeStart = { goSent: sent("go").length, here: location.hash, status: stage().status, timer: document.querySelector(".sdoc-presenter-timer").textContent,
      flagged: document.querySelector(".sdoc-presenter-status").classList.contains("is-waiting") };
    from({ type: "position", position: "4" });
    await wait(50);
    out.beforeStart.followedAudience = location.hash === "#4";

    // Start: back to where the audience is, timer running, linked both ways.
    document.querySelector(".sdoc-presenter-start").click();
    await until(function () { return location.hash === "#4"; }, 1000);
    out.started = { here: location.hash, status: stage().status };
    out.barStarted = barAt();
    out.disabledStarted = { start: document.querySelector(".sdoc-presenter-start").disabled,
      timer: document.querySelector(".sdoc-presenter-timer").disabled, reset: document.querySelector(".sdoc-presenter-reset").disabled };
    // The display refreshes every half second on its own phase, so 1.6s is
    // the read that is past one refresh after the first second whatever the
    // phase, and short of the second.
    await wait(1600);
    out.started.timer = document.querySelector(".sdoc-presenter-timer").textContent;
    await go("2");
    out.started.goSent = sent("go").map(function (m) { return m.position; });
    await wait(700);
    from({ type: "position", position: "3" });
    await until(function () { return location.hash === "#3"; }, 1000);
    out.started.followed = location.hash;

    // The timer pauses and resumes on a click.
    document.querySelector(".sdoc-presenter-timer").click();
    out.paused = document.querySelector(".sdoc-presenter").classList.contains("is-paused");

    // Reset ends the run, but only on a second click: one stray click
    // mid-talk must not send the projector back to the title.
    var resetBtn = document.querySelector(".sdoc-presenter-reset");
    var goBefore = sent("go").length;
    resetBtn.click();
    await until(resetArmed, 1000);
    out.barArmed = barAt();
    out.resetOnce = { here: location.hash, started: document.querySelector(".sdoc-presenter").classList.contains("is-started"),
      label: resetBtn.textContent, goSent: sent("go").length - goBefore };
    resetBtn.click();
    await until(function () { return location.hash === "#1"; }, 1000);
    out.resetTwice = { here: location.hash, started: document.querySelector(".sdoc-presenter").classList.contains("is-started"),
      timer: document.querySelector(".sdoc-presenter-timer").textContent,
      audienceSentTo: sent("go").slice(goBefore).map(function (m) { return m.position; }), status: stage().status };
    // Not started again: browsing is private once more.
    var goAfter = sent("go").length;
    await go("3");
    out.resetTwice.privateAgain = sent("go").length === goAfter;
  }
  function start() { run().catch(function (e) { out.__error = String((e && e.message) || e); }).then(report); }
  if (document.readyState === "complete") start(); else window.addEventListener("load", start);
})();
`;

test("the presenter window: neighbours, notes, Start, and private until then (browser)", async () => {
  browser.skip();
  const file = presenterPage(PRESENTER_DECK, { opener: true });
  const r = await runHarvest(file, PRESENTER_DRIVE, "sdoc-presenter-drive", AS_PRESENTER);
  assert(!r.__error, "the drive threw: " + r.__error);
  assert(r.ui, "the window is laid out as the presenter view");
  assert(r.hello >= 1, "it checks in with the audience window as it opens");

  const sp = r.atSpine;
  assert(sp.prev === "p1" && sp.current === "p2" && sp.next === "p3" && sp.down === "p2a",
    "on a spine slide: previous left, next right, its first detail below: " + JSON.stringify(sp));
  assert(sp.up === null, "and nothing above a spine slide: " + sp.up);
  assert(sp.currentW > sp.prevW && sp.currentW > sp.nextW && sp.currentW > sp.downW,
    "the current slide is the largest on the stage: " + JSON.stringify(sp));
  assert(/Say why this matters, then drill down/.test(sp.notes), "its notes, with their emphasis kept as text: " + sp.notes);
  assert(sp.count === "2 / 4", "the counter: " + sp.count);
  const dt = r.atDetail;
  assert(dt.prev === "p1" && dt.next === "p3" && dt.down === "p2b" && dt.count === "2.1 / 4",
    "on a detail: left and right still move along the spine, below is the next detail: " + JSON.stringify(dt));
  assert(dt.up === "p2" && dt.upW === dt.currentW,
    "and the slide above peeks over it, at its width, so Up plainly goes somewhere: " + JSON.stringify(dt));
  assert(r.atLastDetail.up === "p2a", "deeper in the column, the detail above: " + r.atLastDetail.up);
  assert(r.atLastDetail.down === null && /No notes for this slide/.test(r.atLastDetail.notes),
    "the last detail has nothing below and no notes: " + JSON.stringify(r.atLastDetail));
  assert(r.atFirst.prev === null, "nothing before the first slide");

  const sp2 = r.split;
  assert(sp2.after.notesH < sp2.before.notesH - 100 && sp2.after.curW > sp2.before.curW,
    "dragging the divider down shrinks the notes and grows the current slide: " + JSON.stringify(sp2));
  assert(sp2.stored && Math.abs(parseFloat(sp2.stored) - 0.38) > 0.05, "and the split is remembered: " + sp2.stored);
  assert(Math.abs(sp2.reset.notesH - sp2.before.notesH) < 2 && Math.abs(sp2.reset.curW - sp2.before.curW) < 2,
    "a double-click puts it back: " + JSON.stringify(sp2.reset));
  assert(sp2.keyed.notesH > sp2.reset.notesH && sp2.keyed.hash === sp2.before.hash,
    "the up arrow on the divider grows the notes without turning the slide: " + JSON.stringify(sp2.keyed));
  assert(r.notesSize.after === r.notesSize.before + 4 && r.notesSize.stored === String(r.notesSize.after),
    "+ enlarges the notes and remembers the size: " + JSON.stringify(r.notesSize));

  const b = r.beforeStart;
  assert(b.goSent === 0, "browsing before Start never moves the audience");
  assert(/the audience stays on slide 1 until you press Start/.test(b.status) && b.flagged,
    "and says so in a way that cannot be missed: " + b.status);
  assert(b.timer === "0:00", "the timer waits for Start: " + b.timer);
  assert(!b.followedAudience, "nor does the audience moving pull the presenter about before Start");

  const s = r.started;
  assert(s.here === "#4", "Start goes back to the audience's slide: " + s.here);
  assert(/^Live/.test(s.status), "and is live: " + s.status);
  assert(s.timer === "0:01", "the timer runs from Start: " + s.timer);
  assert(s.goSent.includes("2"), "after Start, moving here moves the audience: " + JSON.stringify(s.goSent));
  assert(s.followed === "#3", "and the audience moving moves this window: " + s.followed);
  assert(r.paused, "a click on the timer pauses it");
  assert(r.resetOnce.here === "#3" && r.resetOnce.started && r.resetOnce.goSent === 0 && /confirm/.test(r.resetOnce.label),
    "one click on Reset only asks again: " + JSON.stringify(r.resetOnce));
  const rt = r.resetTwice;
  assert(rt.here === "#1" && rt.audienceSentTo.includes("1"),
    "the second takes both windows back to the first slide: " + JSON.stringify(rt));
  assert(!rt.started && rt.timer === "0:00" && /until you press Start/.test(rt.status),
    "with the timer at zero and the run not started: " + JSON.stringify(rt));
  assert(rt.privateAgain, "so browsing is private again until the next Start");

  // Nothing in the bar moves or resizes as the talk changes state; what does
  // not apply is disabled in place.
  assert(JSON.stringify(r.barStarted) === JSON.stringify(r.barBefore),
    "Start leaves every control where it was:\n  " + r.barBefore.join(" ") + "\n  " + r.barStarted.join(" "));
  assert(JSON.stringify(r.barArmed) === JSON.stringify(r.barBefore),
    "asking to confirm a reset moves nothing:\n  " + r.barBefore.join(" ") + "\n  " + r.barArmed.join(" "));
  const heights = new Set(r.barBoxes.map((b) => b.h)), mids = new Set(r.barBoxes.map((b) => b.mid));
  assert(heights.size === 1 && mids.size === 1,
    "every widget in the bar is one height, on one line: " + JSON.stringify(r.barBoxes));
  assert(r.barBoxes.map((b) => b.name).join(" ").endsWith("count clock sizes"),
    "the counter, the clock and the notes size are the three on the right: " + r.barBoxes.map((b) => b.name).join(" "));
  assert(!r.disabledBefore.start && r.disabledBefore.timer && r.disabledBefore.reset,
    "before Start, the timer and Reset are there but disabled: " + JSON.stringify(r.disabledBefore));
  assert(r.disabledStarted.start && !r.disabledStarted.timer && !r.disabledStarted.reset,
    "after it, Start is there but disabled: " + JSON.stringify(r.disabledStarted));
});

// Focus: the current slide alone, as large as the stage allows. Every
// reading is taken once the motion has stopped, since a rect includes the
// transform the spring is still running.
const FOCUS_DRIVE = `
(function () {
  var out = {};
  ${DRIVE_HELPERS}
  var q = function (s) { return document.querySelector(s); };
  var box = function (n) { var r = n.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
  var seen = function (n) { var r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(n).visibility !== "hidden"; };
  var still = function () { return until(function () { return !document.getAnimations().length; }, 2000).then(function () { return wait(40); }); };
  var frame = function () { return q(".sdoc-presenter-slot.is-current .sdoc-presenter-frame"); };
  var focused = function () { return q(".sdoc-presenter").classList.contains("is-focused"); };
  var barAt = function () {
    return [].slice.call(document.querySelectorAll(".sdoc-presenter-bar > *")).map(function (n) {
      var r = n.getBoundingClientRect();
      return n.className.split(" ")[0].replace("sdoc-presenter-", "") + "@" + Math.round(r.left) + "," + Math.round(r.top) + "+" + Math.round(r.width) + "x" + Math.round(r.height);
    }).filter(function (k) { return !/^(status|gap)[ @]/.test(k); });
  };
  function snap() {
    return {
      focused: focused(),
      pressed: q(".sdoc-presenter-focus").getAttribute("aria-pressed"),
      cur: box(frame()), stage: box(q(".sdoc-presenter-stage")), notes: box(q(".sdoc-presenter-notes")),
      button: box(q(".sdoc-presenter-focus")), bar: barAt(), hash: location.hash,
      shown: ["up", "prev", "next", "down"].filter(function (k) { return seen(q(".sdoc-presenter-slot.is-" + k)); }),
      chevrons: ["up", "left", "right", "down"].filter(function (k) { return seen(q(".sdoc-presenter-chevron.is-" + k)); })
    };
  }
  function report() {
    var el = document.createElement("script");
    el.type = "application/json";
    el.id = "sdoc-presenter-focus-drive";
    el.textContent = JSON.stringify(out) + "\\n/*${SENTINEL}*/";
    document.body.appendChild(el);
  }
  async function run() {
    await until(function () { return !!q(".sdoc-presenter-slot.is-current .sdoc-overview-mini"); }, 4000);
    await go("2");
    await still();
    out.normal = snap();

    key("z");
    out.barAtOnce = barAt();
    out.buttonAtOnce = box(q(".sdoc-presenter-focus"));
    await still();
    out.zoomed = snap();
    // Through a move, and on a detail Up is a way to go.
    await go("2.1");
    await still();
    out.detail = snap();
    q(".sdoc-presenter-chevron.is-right").click();
    await until(function () { return location.hash === "#3"; }, 1000);
    await still();
    out.chevronWent = snap();
    await go("2");
    await still();

    frame().click();
    await still();
    out.clickedOff = snap();
    frame().click();
    await still();
    out.clickedOn = snap();
    key("Escape");
    await still();
    out.escaped = snap();
    key("Escape");
    await still();
    out.escapedAgain = snap();

    q(".sdoc-presenter-focus").click();
    await still();
    out.buttonOn = snap();
    q(".sdoc-presenter-focus").click();
    await still();
    out.buttonOff = snap();

    // The divider still works in focus: smaller notes, a larger slide.
    key("z");
    await still();
    var split = q(".sdoc-presenter-split");
    var sr = split.getBoundingClientRect(), y0 = sr.top + sr.height / 2;
    var pe = function (type, y) { split.dispatchEvent(new PointerEvent(type, { clientX: sr.left + 20, clientY: y, bubbles: true, pointerId: 7, button: 0, buttons: type === "pointerup" ? 0 : 1 })); };
    var before = snap();
    pe("pointerdown", y0); pe("pointermove", y0 + 120); pe("pointerup", y0 + 120);
    await until(function () { return JSON.stringify(snap()) !== JSON.stringify(before); }, 1000);
    out.split = { before: before, after: snap() };

    // The overview has the keys while it is up: Z does nothing behind it,
    // and Escape closes the overview, not focus.
    window.sdocOverview.open();
    await until(function () { return window.sdocOverview.isOpen(); }, 1000);
    await still();
    key("z");
    out.behindOverview = focused();
    key("Escape");
    await until(function () { return !window.sdocOverview.isOpen(); }, 3000);
    out.overviewClosed = !window.sdocOverview.isOpen();
    out.afterOverview = focused();
  }
  function start() { run().catch(function (e) { out.__error = String((e && e.message) || e); }).then(report); }
  if (document.readyState === "complete") start(); else window.addEventListener("load", start);
})();
`;

test("focus in the presenter window: the current slide alone, the controls where they were (browser)", async () => {
  browser.skip();
  const file = presenterPage(PRESENTER_DECK);
  const r = await runHarvest(file, FOCUS_DRIVE, "sdoc-presenter-focus-drive", AS_PRESENTER);
  assert(!r.__error, "the drive threw: " + r.__error);
  const n = r.normal, z = r.zoomed;
  assert(!n.focused && n.pressed === "false" && n.chevrons.length === 0,
    "the window opens with every slide on the stage and no chevrons: " + JSON.stringify(n));
  assert(["prev", "next", "down"].every((k) => n.shown.includes(k)), "neighbours shown before: " + n.shown);

  assert(z.focused && z.pressed === "true", "Z enters focus: " + JSON.stringify(z));
  assert(z.cur.w > n.cur.w * 1.4, "the current slide grows to fill the stage: " + n.cur.w + " -> " + z.cur.w);
  assert(Math.abs(z.cur.w - z.stage.w) <= 8 || Math.abs(z.cur.h - z.stage.h) <= 8,
    "as large as the stage allows: " + JSON.stringify(z.cur) + " in " + JSON.stringify(z.stage));
  assert(z.cur.x >= z.stage.x && z.cur.y >= z.stage.y && z.cur.x + z.cur.w <= z.stage.x + z.stage.w && z.cur.y + z.cur.h <= z.stage.y + z.stage.h,
    "and inside it: " + JSON.stringify(z.cur) + " in " + JSON.stringify(z.stage));
  assert(z.shown.length === 0, "the other slides are gone: " + z.shown);
  assert(z.chevrons.join() === "left,right,down",
    "chevrons on a spine slide with details: left, right and down, not up: " + z.chevrons);
  const right = z.button.x + z.button.w, slideRight = z.cur.x + z.cur.w;
  assert(right <= slideRight && right >= slideRight - 24 && z.button.y >= z.cur.y && z.button.y <= z.cur.y + 20,
    "the button sits in the enlarged slide's top-right corner: " + JSON.stringify(z.button) + " on " + JSON.stringify(z.cur));

  // The owner's rule: nothing moves or resizes but the stage's own contents.
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  assert(same(r.barAtOnce, n.bar) && same(z.bar, n.bar),
    "the bar does not move when focus changes:\n  " + n.bar.join(" ") + "\n  " + z.bar.join(" "));
  assert(same(z.notes, n.notes) && same(z.stage, n.stage), "nor the notes, nor the stage itself: " + JSON.stringify([n.notes, z.notes]));
  assert(same(r.buttonAtOnce, n.button) && same(z.button, n.button),
    "the focus button keeps one place and one size: " + JSON.stringify([n.button, r.buttonAtOnce, z.button]));

  const d = r.detail;
  assert(d.focused && d.hash === "#2.1" && d.cur.w === z.cur.w, "focus holds through a move: " + JSON.stringify(d));
  assert(d.chevrons.join() === "up,left,right,down", "on a detail, Up has a chevron too: " + d.chevrons);
  assert(r.chevronWent.hash === "#3" && r.chevronWent.focused && r.chevronWent.chevrons.join() === "left,right",
    "a chevron goes where it points, still in focus: " + JSON.stringify(r.chevronWent));

  const off = r.clickedOff;
  assert(!off.focused && Math.abs(off.cur.w - n.cur.w) <= 1 && ["prev", "next", "down"].every((k) => off.shown.includes(k)),
    "a click on the slide puts the others back, at the size it had: " + JSON.stringify(off));
  assert(r.clickedOn.focused, "and another enlarges it again");
  assert(!r.escaped.focused && !r.escapedAgain.focused, "Escape leaves focus, and a second does nothing more");
  assert(r.buttonOn.focused && !r.buttonOff.focused, "the corner button toggles focus both ways");
  assert(same(r.buttonOn.button, n.button) && same(r.buttonOff.button, n.button),
    "from one place: " + JSON.stringify([r.buttonOn.button, r.buttonOff.button]));
  for (const k of ["detail", "chevronWent", "clickedOff", "clickedOn", "escaped", "buttonOn", "buttonOff"]) {
    assert(same(r[k].bar, n.bar), "the bar has not moved (" + k + "):\n  " + n.bar.join(" ") + "\n  " + r[k].bar.join(" "));
  }

  const s = r.split;
  assert(s.after.focused && s.after.notes.h < s.before.notes.h - 60 && s.after.cur.w > s.before.cur.w,
    "in focus, dragging the divider down gives the slide the room: " + JSON.stringify([s.before.cur, s.after.cur, s.before.notes.h, s.after.notes.h]));
  assert(s.after.cur.y + s.after.cur.h <= s.after.stage.y + s.after.stage.h, "and it still fits: " + JSON.stringify([s.after.cur, s.after.stage]));

  assert(r.behindOverview, "Z does nothing while the overview is up");
  assert(r.overviewClosed && r.afterOverview, "Escape there closes the overview and leaves focus as it was");
});

test("a deck without notes says so in the presenter window (browser)", async () => {
  browser.skip();
  const file = presenterPage("# Deck {\n    @meta { type: slides }\n\n    # One {\n        a\n    }\n\n    # Two {\n        b\n    }\n}");
  const r = await runHarvest(file, `
(function () {
  ${DRIVE_HELPERS}
  window.addEventListener("load", async function () {
    await until(function () { return !!document.querySelector(".sdoc-presenter-notes-body"); }, 4000);
    var el = document.createElement("script");
    el.type = "application/json";
    el.id = "sdoc-presenter-nonotes";
    el.textContent = JSON.stringify({
      notes: document.querySelector(".sdoc-presenter-notes-body").textContent.trim(),
      status: document.querySelector(".sdoc-presenter-status").textContent
    }) + "\\n/*${SENTINEL}*/";
    document.body.appendChild(el);
  });
})();
`, "sdoc-presenter-nonotes", AS_PRESENTER);
  assert(/no speaker notes/.test(r.notes) && /--no-notes/.test(r.notes), "it says the deck has none, and why it might not: " + r.notes);
  assert(/Rehearsing/.test(r.status), "with no audience window it is a rehearsal: " + r.status);
});

// A miniature is a copy of the slide put inside the presenter's chrome or an
// overview cell, and would inherit their type; it must look like the slide,
// which inherits from the deck's body.
const MINIATURE_TYPE_DRIVE = `
(function () {
  var out = {};
  ${DRIVE_HELPERS}
  var PROPS = ["text-align", "color", "font-family", "line-height", "font-size", "letter-spacing"];
  // The slide, its heading and a paragraph with no alignment of its own, in
  // a copy and in the deck's own slide.
  function compare(copy, original) {
    var diffs = [];
    [":scope", ":scope h1, :scope h2, :scope h3", ":scope p"].forEach(function (sel) {
      var a = sel === ":scope" ? copy : copy.querySelector(sel), b = sel === ":scope" ? original : original.querySelector(sel);
      if (!a || !b) { diffs.push(sel + " missing"); return; }
      var ca = getComputedStyle(a), cb = getComputedStyle(b);
      PROPS.forEach(function (p) {
        if (ca.getPropertyValue(p) !== cb.getPropertyValue(p)) diffs.push(sel + " " + p + ": " + ca.getPropertyValue(p) + " / " + cb.getPropertyValue(p));
      });
    });
    return diffs;
  }
  function report() {
    var el = document.createElement("script");
    el.type = "application/json";
    el.id = "sdoc-miniature-type";
    el.textContent = JSON.stringify(out) + "\\n/*${SENTINEL}*/";
    document.body.appendChild(el);
  }
  async function run() {
    await until(function () { return !!document.querySelector(".sdoc-presenter-slot.is-current .sdoc-overview-mini > .slide"); }, 4000);
    var original = document.getElementById("p1");
    out.paragraphAlign = getComputedStyle(original.querySelector("p")).textAlign;
    out.frameAlign = getComputedStyle(document.querySelector(".sdoc-presenter-frame")).textAlign;
    out.presenter = compare(document.querySelector(".sdoc-presenter-slot.is-current .sdoc-overview-mini > .slide"), original);
    window.sdocOverview.open();
    await until(function () { return !!document.querySelector(".sdoc-overview-cell .sdoc-overview-mini > .slide"); }, 2000);
    out.overview = compare(document.querySelector(".sdoc-overview-cell .sdoc-overview-mini > .slide"), original);
  }
  function start() { run().catch(function (e) { out.__error = String((e && e.stack) || e); }).then(report); }
  if (document.readyState === "complete") start(); else window.addEventListener("load", start);
})();
`;

test("a miniature takes its type from the deck, not from the chrome around it (browser)", async () => {
  browser.skip();
  // The default theme sets its font and colour on body; this deck adds an
  // alignment, a line height and a letter spacing there too, none of which
  // the presenter frame or the overview shares.
  const file = presenterPage(PRESENTER_DECK, {
    deckCss: "body { text-align: right; line-height: 1.9; letter-spacing: 0.03em; }",
  });
  const r = await runHarvest(file, MINIATURE_TYPE_DRIVE, "sdoc-miniature-type", AS_PRESENTER);
  assert(!r.__error, "the drive threw: " + r.__error);
  assert(r.paragraphAlign === "right" && r.frameAlign === "center",
    "the deck and the chrome disagree, so the check means something: " + r.paragraphAlign + " / " + r.frameAlign);
  assert(r.presenter.length === 0, "the presenter's current slide is typeset as the slide is: " + r.presenter.join("; "));
  assert(r.overview.length === 0, "and so is an overview cell: " + r.overview.join("; "));
});

const AUDIENCE_DRIVE = `
(function () {
  var out = {};
  ${DRIVE_HELPERS}
  var heard = [];
  peer().addEventListener("message", function (e) { if (e.data && e.data.sdoc === "sdoc-presenter") heard.push(e.data); });
  var active = function () { var a = [].slice.call(document.querySelectorAll("body > .slide.active")); return a.length ? a[0].id : null; };
  function report() {
    var el = document.createElement("script");
    el.type = "application/json";
    el.id = "sdoc-audience-drive";
    el.textContent = JSON.stringify(out) + "\\n/*${SENTINEL}*/";
    document.body.appendChild(el);
  }
  async function run() {
    // The presenter window checks in; the deck answers with where it is.
    from({ type: "hello", position: "1" });
    await until(function () { return heard.some(function (m) { return m.type === "position"; }); }, 1000);
    out.answered = heard.filter(function (m) { return m.type === "position"; }).map(function (m) { return m.position; });
    // The presenter moves; the deck follows.
    from({ type: "go", position: "2.1" });
    await until(function () { return active() === "p2a"; }, 1000);
    out.followed = active();
    // The deck moves by itself; the presenter is told.
    heard = [];
    await go("3");
    await until(function () { return heard.length; }, 1000);
    out.reported = heard.map(function (m) { return m.type + ":" + m.position; });
  }
  function start() { run().catch(function (e) { out.__error = String((e && e.message) || e); }).then(report); }
  if (document.readyState === "complete") start(); else window.addEventListener("load", start);
})();
`;

test("the deck answers the presenter window, follows it, and reports its own moves (browser)", async () => {
  browser.skip();
  const file = presenterPage(PRESENTER_DECK);
  const r = await runHarvest(file, AUDIENCE_DRIVE, "sdoc-audience-drive");
  assert(!r.__error, "the drive threw: " + r.__error);
  assert(r.answered.includes("1"), "a hello is answered with the deck's position: " + JSON.stringify(r.answered));
  assert(r.followed === "p2a", "a move in the presenter window moves the deck: " + r.followed);
  assert(r.reported.includes("position:3"), "and a move here is reported: " + JSON.stringify(r.reported));
});

// Two decks open at once, or a deck beside any page that posts messages:
// each window hears its own other half and no one else.
const DECK_TRUST_DRIVE = `
(function () {
  var out = {};
  ${DRIVE_HELPERS}
  var heard = [], strange = [];
  peer().addEventListener("message", function (e) { if (e.data && e.data.sdoc === "sdoc-presenter") heard.push(e.data); });
  stranger().addEventListener("message", function (e) { if (e.data && e.data.sdoc === "sdoc-presenter") strange.push(e.data); });
  var inked = function () { return document.querySelectorAll("svg.sdoc-ink [data-stroke]").length; };
  var stroke = function (id) { return { id: id, slide: "1", tool: "pen", color: "#2b7cf6", size: 8, points: [[100, 100], [300, 100]] }; };
  function report() {
    var el = document.createElement("script");
    el.type = "application/json";
    el.id = "sdoc-deck-trust";
    el.textContent = JSON.stringify(out) + "\\n/*${SENTINEL}*/";
    document.body.appendChild(el);
  }
  async function run() {
    // A window this deck did not open checks in, moves and draws.
    from({ type: "hello", ink: 0 }, stranger());
    from({ type: "go", position: "3" }, stranger());
    from({ type: "ink", op: "begin", v: 1, stroke: stroke("x1") }, stranger());
    await wait(200);
    out.stranger = { here: location.hash, answered: strange.length, ink: inked() };
    // Its own presenter window is taken on at a hello, and at nothing else.
    from({ type: "go", position: "3" });
    await wait(200);
    out.unintroduced = location.hash;
    from({ type: "hello", ink: 0 });
    await until(function () { return heard.length; }, 1000);
    from({ type: "go", position: "2" });
    await until(function () { return location.hash === "#2"; }, 1000);
    out.own = { answered: heard.length, here: location.hash };
    // Linked, it still hears no one else, and a stranger's hello does not
    // take the link away.
    heard = [];
    from({ type: "hello", ink: 0 }, stranger());
    from({ type: "go", position: "4" }, stranger());
    from({ type: "ink", op: "begin", v: 1, stroke: stroke("x2") }, stranger());
    await wait(200);
    out.linked = { here: location.hash, answered: strange.length, ink: inked() };
    await go("3");
    await until(function () { return heard.length; }, 1000);
    out.reported = { own: heard.map(function (m) { return m.position; }), stranger: strange.length };
  }
  function start() { run().catch(function (e) { out.__error = String((e && e.stack) || e); }).then(report); }
  if (document.readyState === "complete") start(); else window.addEventListener("load", start);
})();
`;

test("the deck hears its own presenter window and no other (browser)", async () => {
  browser.skip();
  const r = await runHarvest(presenterPage(PRESENTER_DECK), DECK_TRUST_DRIVE, "sdoc-deck-trust");
  assert(!r.__error, "the drive threw: " + r.__error);
  const show = (o) => JSON.stringify(o);
  assert(r.stranger.here !== "#3" && r.stranger.answered === 0 && r.stranger.ink === 0,
    "a window the deck did not open cannot move it, draw on it or get an answer: " + show(r.stranger));
  assert(r.unintroduced !== "#3", "the deck's own presenter window is not heard before its hello: " + r.unintroduced);
  assert(r.own.answered >= 1 && r.own.here === "#2", "and is from its hello on: " + show(r.own));
  assert(r.linked.here === "#2" && r.linked.answered === 0 && r.linked.ink === 0,
    "once linked, a stranger still moves nothing, draws nothing and hears nothing: " + show(r.linked));
  assert(r.reported.own.includes("3") && r.reported.stranger === 0,
    "and the deck's own moves still go to its presenter window alone: " + show(r.reported));
});

const PRESENTER_TRUST_DRIVE = `
(function () {
  var out = {};
  ${DRIVE_HELPERS}
  var sent = function (type) { return (window.__toAudience || []).filter(function (m) { return m.type === type; }); };
  var inked = function () { return document.querySelectorAll(".sdoc-presenter-slot.is-current svg.sdoc-ink [data-stroke]").length; };
  var status = function () { return document.querySelector(".sdoc-presenter-status").textContent; };
  var stroke = function (id) { return { id: id, slide: "1", tool: "pen", color: "#2b7cf6", size: 8, points: [[100, 100], [300, 100]] }; };
  function report() {
    var el = document.createElement("script");
    el.type = "application/json";
    el.id = "sdoc-presenter-trust";
    el.textContent = JSON.stringify(out) + "\\n/*${SENTINEL}*/";
    document.body.appendChild(el);
  }
  async function run() {
    await until(function () { return !!document.querySelector(".sdoc-presenter-slot.is-current .sdoc-overview-mini"); }, 4000);
    // Before Start the deck reloads: a new page load over there, and
    // nothing here is the audience's to give back.
    from({ type: "position", position: "1", deck: "load-a" });
    from({ type: "position", position: "1", deck: "load-b" });
    out.beforeStart = sent("ink").length;
    document.querySelector(".sdoc-presenter-start").click();
    await until(function () { return sent("ink-sync").length; }, 1000);
    out.sync = sent("ink-sync").length;
    // Another deck's window, or anything else: not the one that opened this.
    from({ type: "position", position: "3" }, stranger());
    from({ type: "ink", op: "begin", v: 1, stroke: stroke("d1") }, stranger());
    await wait(300);
    out.stranger = { here: location.hash, status: status(), ink: inked() };
    // The deck that did.
    from({ type: "ink", op: "begin", v: 1, stroke: stroke("d2") });
    out.ownInk = inked();
    from({ type: "position", position: "3" });
    await until(function () { return location.hash === "#3"; }, 1000);
    out.own = { here: location.hash };
    // Only the deck has drawn, and this window has sent no ink at all. The
    // deck reloads: its slides are bare, and this window gives it back the
    // ink it showed. The same page load again is nothing new.
    out.sentBefore = sent("ink").length;
    from({ type: "position", position: "3", deck: "load-b" });
    out.sameLoad = sent("ink").length - out.sentBefore;
    from({ type: "position", position: "3", deck: "load-c" });
    out.reloaded = sent("ink").slice(out.sentBefore).map(function (m) { return m.op + (m.strokes ? ":" + m.slide + "=" + m.strokes.map(function (x) { return x.id; }).join(",") : ""); });
    from({ type: "position", position: "3", deck: "load-c" });
    out.again = sent("ink").length - out.sentBefore - out.reloaded.length;
    // T is the deck's filmstrip; here the stage shows the slides either side.
    key("t");
    await wait(80);
    out.strip = document.querySelectorAll(".sdoc-filmstrip").length;
  }
  function start() { run().catch(function (e) { out.__error = String((e && e.stack) || e); }).then(report); }
  if (document.readyState === "complete") start(); else window.addEventListener("load", start);
})();
`;

test("the presenter window hears the deck that opened it and no other (browser)", async () => {
  browser.skip();
  const file = presenterPage(PRESENTER_DECK, { opener: true });
  const r = await runHarvest(file, PRESENTER_TRUST_DRIVE, "sdoc-presenter-trust", AS_PRESENTER);
  assert(!r.__error, "the drive threw: " + r.__error);
  const show = (o) => JSON.stringify(o);
  assert(r.beforeStart === 0, "before Start a deck that reloads is sent nothing: " + r.beforeStart);
  assert(r.sync === 1, "Start asks for the deck's ink: " + r.sync);
  assert(r.stranger.here !== "#3" && r.stranger.ink === 0 && !/slide 3/.test(r.stranger.status),
    "a window that did not open it cannot move it, draw on it or pass for the audience: " + show(r.stranger));
  assert(r.ownInk === 1 && r.own.here === "#3", "its own deck does all three: " + r.ownInk + " " + show(r.own));
  assert(r.sentBefore === 0 && r.sameLoad === 0, "this window has sent no ink, and a position from the same page load sends none: " + r.sentBefore + " " + r.sameLoad);
  assert(r.reloaded.join() === "clear,slide:1=d2", "a deck that reloaded is given back the ink only it had drawn: " + r.reloaded);
  assert(r.again === 0, "once: " + r.again);
  assert(r.strip === 0, "T brings up no filmstrip under the presenter view: " + r.strip);
});

// P, when a window of this deck's name may already be there. window.open is
// stood in for, since the windows it returns cannot be read from a file.
const REOPEN_DRIVE = `
(function () {
  var out = {};
  ${DRIVE_HELPERS}
  // href null: a loaded window, whose address a deck opened from disk may
  // not read.
  var fake = function (href, mine) {
    var w = { closed: false, opener: mine ? window : null, replaced: [], focused: 0, posted: [],
      focus: function () { w.focused++; }, postMessage: function (m) { w.posted.push(m); },
      location: { replace: function (u) { w.replaced.push(u); } } };
    if (href === null) Object.defineProperty(w.location, "href", { get: function () { throw new Error("not readable"); } });
    else w.location.href = href;
    return w;
  };
  var calls = [], next = [];
  window.open = function (url, name) { calls.push({ url: url, name: name }); return next.shift() || null; };
  function report() {
    var el = document.createElement("script");
    el.type = "application/json";
    el.id = "sdoc-reopen";
    el.textContent = JSON.stringify(out) + "\\n/*${SENTINEL}*/";
    document.body.appendChild(el);
  }
  async function run() {
    await go("2");
    // No such window yet: the one made is blank, and is sent to this deck.
    var fresh = fake("about:blank", true);
    next = [fresh];
    key("p");
    out.fresh = { calls: calls.slice(), replaced: fresh.replaced.slice() };
    key("p");
    out.again = { calls: calls.length, focused: fresh.focused };
    // The deck reloaded and lost its reference, and the window is still
    // there, started: found by name, and left as it is.
    fresh.closed = true;
    var live = fake(null, true);
    next = [live];
    calls = [];
    key("p");
    out.live = { calls: calls.slice(), replaced: live.replaced.length, focused: live.focused };
    await go("3");
    out.live.told = live.posted.map(function (m) { return m.type + ":" + m.position; });
    // The same deck in another tab has one of that name: not this window's.
    live.closed = true;
    var other = fake(null, false), own = fake("about:blank", true);
    next = [other, own];
    calls = [];
    key("p");
    out.other = { calls: calls.slice(), otherReplaced: other.replaced.length, ownReplaced: own.replaced.length };
    await go("1");
    out.other.told = [other.posted.length, own.posted.length];
    // Blocked: said out loud.
    own.closed = true;
    next = [];
    key("p");
    var hint = document.querySelector(".sdoc-deck-hint");
    out.blocked = hint ? hint.textContent : null;
  }
  function start() { run().catch(function (e) { out.__error = String((e && e.stack) || e); }).then(report); }
  if (document.readyState === "complete") start(); else window.addEventListener("load", start);
})();
`;

test("P finds the presenter window a reloaded deck left open, and loads only a new one (browser)", async () => {
  browser.skip();
  const r = await runHarvest(presenterPage(PRESENTER_DECK), REOPEN_DRIVE, "sdoc-reopen");
  assert(!r.__error, "the drive threw: " + r.__error);
  const show = (o) => JSON.stringify(o);
  const name = r.fresh.calls[0] && r.fresh.calls[0].name;
  assert(r.fresh.calls.length === 1 && r.fresh.calls[0].url === "" && /^sdoc-presenter-[0-9a-z]+$/.test(name),
    "the window is asked for by a name of this deck's own, with no address: " + show(r.fresh.calls));
  assert(r.fresh.replaced.length === 1 && /[?&]presenter=1/.test(r.fresh.replaced[0]) && /#2$/.test(r.fresh.replaced[0]),
    "a new one is sent to this deck as its presenter view, at the deck's slide: " + show(r.fresh.replaced));
  assert(r.again.calls === 1 && r.again.focused === 1, "P again brings it forward: " + show(r.again));
  assert(r.live.calls.length === 1 && r.live.calls[0].url === "" && r.live.calls[0].name === name && r.live.replaced === 0,
    "one left open by a deck that reloaded is found by that name and not loaded again: " + show(r.live));
  assert(r.live.focused === 1 && r.live.told.includes("position:3"), "and is the deck's presenter window once more: " + show(r.live));
  assert(r.other.calls.length === 2 && r.other.calls[1].name === "_blank" && /[?&]presenter=1/.test(r.other.calls[1].url) &&
    r.other.otherReplaced === 0 && r.other.told[0] === 0 && r.other.told[1] >= 1,
    "another deck window's is left alone, and this one opens its own: " + show(r.other));
  assert(/blocked/.test(r.blocked || ""), "a blocked window is said out loud: " + r.blocked);
});

test("P opens the presenter window, and it checks in with the deck (browser)", async () => {
  // End to end, on file:// as a deck is mostly opened: the deck opens the
  // window with window.open, and the presenter window's hello comes back
  // through that reference. Pop-ups allowed, since nothing here is a person.
  browser.skip();
  const file = presenterPage(PRESENTER_DECK);
  const r = await runHarvest(file, `
(function () {
  ${DRIVE_HELPERS}
  var heard = [];
  window.addEventListener("message", function (e) { if (e.data && e.data.sdoc === "sdoc-presenter") heard.push(e.data); });
  window.addEventListener("load", async function () {
    await go("2");
    key("p");
    var ok = await until(function () { return heard.some(function (m) { return m.type === "hello"; }); }, 8000);
    var el = document.createElement("script");
    el.type = "application/json";
    el.id = "sdoc-presenter-e2e";
    el.textContent = JSON.stringify({ ok: ok }) + "\\n/*${SENTINEL}*/";
    document.body.appendChild(el);
  });
})();
`, "sdoc-presenter-e2e", { chromeArgs: ["--disable-popup-blocking"] });
  assert(r.ok, "the presenter window opened and said hello");
});

// ---- Ink: drawing in the presenter window, mirrored to the deck ----

test("the ink runtime ships with every deck, and a built deck has no ink in it", () => {
  const html = parseAndRender("# Deck {\n    # One {\n        a\n    }\n}");
  const scripts = runtimeScripts(html).all;
  const inkAt = scripts.findIndex((s) => s.includes("window.sdocInk = ("));
  const snapAt = scripts.findIndex((s) => s.includes("window.sdocSnap = ("));
  const presenterAt = scripts.findIndex((s) => s.includes("sdoc-presenter-notes-body"));
  assert(inkAt !== -1 && inkAt < presenterAt, "window.sdocInk is defined before the presenter view that draws with it");
  assert(snapAt !== -1 && snapAt < presenterAt, "and window.sdocSnap, which it snaps with");
  assert(!/<svg[^>]*sdoc-ink/.test(markupOf(html)), "no ink overlay until someone draws");
  assert(/\.sdoc-ink \{ display: none !important; \}/.test(html.slice(html.indexOf("@media print"))),
    "and print hides any there is");
});

// Shared by the ink drives: pointer events on the current slide, at a point
// given as a fraction of it, dispatched on whatever is under that point.
const INK_HELPERS = `
  var q = function (s) { return document.querySelector(s); };
  var sent = function (type) { return (window.__toAudience || []).filter(function (m) { return m.type === type; }); };
  var face = function () { return q(".sdoc-presenter-slot.is-current .sdoc-presenter-frame"); };
  var copy = function () { return q(".sdoc-presenter-slot.is-current .sdoc-overview-mini > .slide"); };
  var at = function (fx, fy) { var r = copy().getBoundingClientRect(); return { x: r.left + fx * r.width, y: r.top + fy * r.height }; };
  var pointer = function (type, p, o) {
    o = o || {};
    var down = type === "pointerdown" || (type === "pointermove" && !o.hover);
    (document.elementFromPoint(p.x, p.y) || face()).dispatchEvent(new PointerEvent(type, {
      clientX: p.x, clientY: p.y, bubbles: true, cancelable: true, composed: true, altKey: !!o.alt,
      pointerId: o.id || 21, pointerType: o.type || "mouse", isPrimary: true,
      button: type === "pointermove" ? -1 : 0, buttons: down ? 1 : 0,
      pressure: down ? (o.pressure != null ? o.pressure : 0.5) : 0
    }));
  };
  var drag = function (from, to, o) {
    pointer("pointerdown", at(from[0], from[1]), o);
    for (var i = 1; i <= 6; i++) pointer("pointermove", at(from[0] + (to[0] - from[0]) * i / 6, from[1] + (to[1] - from[1]) * i / 6), o);
    pointer("pointerup", at(to[0], to[1]), o);
    return wait(60);
  };
  var strokesIn = function (sel) {
    return [].slice.call(document.querySelectorAll(sel + " svg.sdoc-ink [data-ink=strokes] > [data-stroke]")).map(function (p) { return p.getAttribute("data-stroke"); });
  };
  var here = function () { return strokesIn(".sdoc-presenter-slot.is-current"); };
  var toolOn = function () { var b = q(".sdoc-ink-tool.is-on"); return b ? b.className.split(" ")[1].replace("is-", "") : null; };
  var ops = function (list) {
    return list.map(function (m) { return m.op + (m.slide ? ":" + m.slide : "") + (m.ids ? "=" + m.ids.join(",") : "") + (m.strokes ? "=" + m.strokes.map(function (s) { return s.id; }).join(",") : ""); });
  };
  // Where each control in the palette is, and its size.
  var palAt = function () {
    return [].slice.call(document.querySelectorAll(".sdoc-ink-tools > *")).map(function (n) {
      var r = n.getBoundingClientRect();
      var name = n.className.split(" ").filter(function (c) { return c !== "is-on" && c !== "is-armed"; }).join(".");
      return name.replace(/sdoc-(presenter|ink)-/g, "") + "@" + Math.round(r.left) + "," + Math.round(r.top) + "+" + Math.round(r.width) + "x" + Math.round(r.height);
    });
  };
  var barAt = function () {
    return [].slice.call(document.querySelectorAll(".sdoc-presenter-bar > *")).map(function (n) {
      var r = n.getBoundingClientRect();
      return n.className.split(" ")[0].replace("sdoc-presenter-", "") + "@" + Math.round(r.left) + "," + Math.round(r.top) + "+" + Math.round(r.width) + "x" + Math.round(r.height);
    }).filter(function (k) { return !/^(status|gap)[ @]/.test(k); });
  };
  var still = function () { return until(function () { return !document.getAnimations().length; }, 2000).then(function () { return wait(40); }); };
  var focused = function () { return q(".sdoc-presenter").classList.contains("is-focused"); };
  var reportAs = function (id, out) {
    var el = document.createElement("script");
    el.type = "application/json";
    el.id = id;
    el.textContent = JSON.stringify(out) + "\\n/*${SENTINEL}*/";
    document.body.appendChild(el);
  };
`;

const INK_DRIVE = `
(function () {
  var out = {};
  ${DRIVE_HELPERS}
  ${INK_HELPERS}
  async function run() {
    await until(function () { return !!copy(); }, 4000);
    out.design = { w: copy().offsetWidth, h: copy().offsetHeight };
    out.disabledAtFirst = [".is-undo", ".is-clear", ".is-clear-all"].map(function (c) { return q(".sdoc-ink-tool" + c).disabled; });

    // Before Start: drawn here, sent nowhere, and still here after a move.
    key("d");
    out.penKey = toolOn();
    await drag([0.2, 0.3], [0.6, 0.3]);
    out.rehearsal = { here: here().length, sent: sent("ink").length + sent("laser").length };
    await go("3");
    await go("1");
    out.rehearsalBack = here().length;

    // Start throws it away.
    from({ type: "position", position: "1" });
    q(".sdoc-presenter-start").click();
    await until(function () { return sent("ink-sync").length; }, 1000);
    out.afterStart = { here: here().length, ops: ops(sent("ink")), sync: sent("ink-sync").length };

    // After it, a stroke reaches the audience as it is drawn.
    var n0 = sent("ink").length;
    var r = copy().getBoundingClientRect();
    pointer("pointerdown", at(0.25, 0.5));
    for (var i = 1; i <= 4; i++) pointer("pointermove", at(0.25 + 0.05 * i, 0.5));
    await until(function () { return sent("ink").length > n0; }, 1000);
    out.midStroke = sent("ink").slice(n0).map(function (m) { return m.op + "/" + (m.stroke ? m.stroke.points.length : (m.points || []).length); });
    out.midStrokeShown = here().length;
    for (i = 5; i <= 10; i++) pointer("pointermove", at(0.25 + 0.05 * i, 0.5));
    pointer("pointerup", at(0.75, 0.5));
    await until(function () { return sent("ink").slice(n0).some(function (m) { return m.op === "end"; }); }, 1000);
    var mine = sent("ink").slice(n0);
    var begin = mine.filter(function (m) { return m.op === "begin"; })[0] || { stroke: { points: [] } };
    var all = [];
    mine.forEach(function (m) { all = all.concat(m.stroke ? m.stroke.points : (m.points || [])); });
    out.stroke = { ops: mine.map(function (m) { return m.op; }), slide: begin.stroke.slide, tool: begin.stroke.tool,
      first: all[0], last: all[all.length - 1], count: all.length, id: begin.stroke.id };
    // A stylus's pressure travels with its points; a mouse's 0.5 does not.
    n0 = sent("ink").length;
    await drag([0.3, 0.7], [0.6, 0.7], { type: "pen", pressure: 0.8, id: 5 });
    var pb = sent("ink").slice(n0).filter(function (m) { return m.op === "begin"; })[0];
    out.penStroke = pb ? { first: pb.stroke.points[0], id: pb.stroke.id } : null;

    // Away and back, the ink is still there, and the previews show it.
    var both = here();
    await go("2");
    out.onTwo = { prev: strokesIn(".sdoc-presenter-slot.is-prev"), here: here() };
    await go("1");
    out.backOnOne = here();
    key("z");
    await still();
    out.inFocus = { focused: focused(), here: here() };
    key("z");
    await still();

    // The eraser takes the stroke it crosses, not the one it does not.
    key("e");
    n0 = sent("ink").length;
    await drag([0.5, 0.42], [0.5, 0.58]);
    out.erased = { before: both, left: here(), msgs: ops(sent("ink").slice(n0)) };

    // Undo: the last stroke on this slide, on U and on Cmd-Z.
    key("d");
    await drag([0.2, 0.15], [0.4, 0.15]);
    var before = here();
    n0 = sent("ink").length;
    key("u");
    out.undo = { before: before, after: here(), msgs: ops(sent("ink").slice(n0)) };
    await drag([0.2, 0.2], [0.4, 0.2]);
    before = here();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true }));
    out.cmdZ = { before: before, after: here(), focused: focused() };

    // Clear this slide.
    n0 = sent("ink").length;
    q(".sdoc-ink-tool.is-clear").click();
    out.clearSlide = { here: here(), msgs: ops(sent("ink").slice(n0)),
      disabled: [".is-undo", ".is-clear"].map(function (c) { return q(".sdoc-ink-tool" + c).disabled; }) };

    // Clear all, which asks first.
    await drag([0.2, 0.3], [0.6, 0.3]);
    await go("3");
    await drag([0.2, 0.3], [0.6, 0.3]);
    var all3 = here();
    n0 = sent("ink").length;
    q(".sdoc-ink-tool.is-clear-all").click();
    out.clearAllOnce = { here: here(), armed: q(".sdoc-ink-tool.is-clear-all").classList.contains("is-armed"), msgs: ops(sent("ink").slice(n0)) };
    q(".sdoc-ink-tool.is-clear-all").click();
    out.clearAllTwice = { before: all3, here: here(), msgs: ops(sent("ink").slice(n0)), disabled: q(".sdoc-ink-tool.is-clear-all").disabled };
    await go("1");
    out.clearAllOnOne = here();

    // The laser: where it points, then off, and nothing kept.
    key("l");
    var nl = sent("laser").length;
    pointer("pointermove", at(0.5, 0.5), { hover: true });
    await until(function () { return sent("laser").length > nl; }, 1000);
    out.laser = { msgs: sent("laser").slice(nl), dot: !!q(".sdoc-presenter-slot.is-current svg.sdoc-ink [data-ink=laser]"), strokes: here().length };
    face().dispatchEvent(new PointerEvent("pointerleave", { pointerId: 21, pointerType: "mouse" }));
    await until(function () { var l = sent("laser"); return l.length && l[l.length - 1].off; }, 1000);
    out.laserOff = { msgs: sent("laser").slice(nl).map(function (m) { return m.off ? "off" : "at"; }),
      dot: !!q(".sdoc-presenter-slot.is-current svg.sdoc-ink [data-ink=laser]") };

    // A deck that reloaded says so by answering from another page load,
    // and is sent everything again; the same load again is sent nothing.
    key("d");
    await drag([0.3, 0.5], [0.6, 0.5]);
    out.kept = here();
    from({ type: "position", position: "1", deck: "load-a" });
    n0 = sent("ink").length;
    from({ type: "position", position: "1", deck: "load-b" });
    out.resync = ops(sent("ink").slice(n0));
    n0 = sent("ink").length;
    from({ type: "position", position: "1", deck: "load-b" });
    out.noResync = sent("ink").length - n0;

    // Reset clears the ink in both windows, and drawing is private again.
    n0 = sent("ink").length;
    q(".sdoc-presenter-reset").click();
    await until(resetArmed, 1000);
    q(".sdoc-presenter-reset").click();
    await until(function () { return !started() && location.hash === "#1"; }, 1000);
    out.reset = { here: here(), msgs: ops(sent("ink").slice(n0)) };
    n0 = sent("ink").length;
    await drag([0.3, 0.5], [0.6, 0.5]);
    out.afterReset = { sent: sent("ink").length - n0, here: here().length };
  }
  function start() { run().catch(function (e) { out.__error = String((e && e.stack) || e); }).then(function () { reportAs("sdoc-ink-drive", out); }); }
  if (document.readyState === "complete") start(); else window.addEventListener("load", start);
})();
`;

test("ink in the presenter window: private until Start, then streamed to the deck (browser)", async () => {
  browser.skip();
  const file = presenterPage(PRESENTER_DECK, { opener: true });
  const r = await runHarvest(file, INK_DRIVE, "sdoc-ink-drive", AS_PRESENTER);
  assert(!r.__error, "the drive threw: " + r.__error);
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  assert(r.disabledAtFirst.every(Boolean), "Undo and both clears are disabled with nothing drawn: " + r.disabledAtFirst);
  assert(r.penKey === "pen", "D picks the pen: " + r.penKey);

  assert(r.rehearsal.here === 1 && r.rehearsal.sent === 0,
    "before Start a stroke shows here and nothing is sent: " + JSON.stringify(r.rehearsal));
  assert(r.rehearsalBack === 1, "it is still there after a move away and back: " + r.rehearsalBack);
  assert(r.afterStart.here === 0, "Start throws the rehearsal's ink away: " + JSON.stringify(r.afterStart));
  assert(r.afterStart.ops.length === 0 && r.afterStart.sync === 1,
    "and sends the deck nothing to draw, but asks it for the ink it holds: " + JSON.stringify(r.afterStart));

  assert(r.midStroke.length >= 1 && /^begin\/\d+$/.test(r.midStroke[0]) && !r.midStroke.some((m) => /^end/.test(m)),
    "a stroke's first points reach the deck before it ends: " + r.midStroke);
  assert(parseInt(r.midStroke[0].split("/")[1], 10) >= 2, "with the points taken so far: " + r.midStroke);
  assert(r.midStrokeShown === 1, "and it shows here while it is drawn");
  const s = r.stroke, W = r.design.w, H = r.design.h;
  assert(s.ops[0] === "begin" && s.ops[s.ops.length - 1] === "end" && s.ops.includes("add"),
    "begun, added to, ended: " + s.ops);
  assert(s.slide === "1" && s.tool === "pen", "on the slide it was drawn on, as a pen stroke: " + JSON.stringify(s));
  assert(s.first.length === 2 && near(s.first[0], W * 0.25, 4) && near(s.first[1], H * 0.5, 4),
    "its first point in design pixels, a quarter across and half down " + W + "x" + H + ": " + s.first);
  assert(near(s.last[0], W * 0.75, 4) && near(s.last[1], H * 0.5, 4), "and its last: " + s.last);
  assert(s.count === 11, "every sample, each sent once: " + s.count);
  assert(r.penStroke && r.penStroke.first.length === 3 && r.penStroke.first[2] === 0.8,
    "a stylus's pressure goes with each point: " + JSON.stringify(r.penStroke));

  assert(r.onTwo.prev.length === 2 && r.onTwo.here.length === 0,
    "on the next slide, the previous one's preview shows its ink: " + JSON.stringify(r.onTwo));
  assert(r.backOnOne.length === 2, "back on it, both strokes are there: " + r.backOnOne);
  assert(r.inFocus.focused && r.inFocus.here.length === 2, "and in focus: " + JSON.stringify(r.inFocus));

  const e = r.erased;
  assert(e.left.length === 1 && e.left[0] === r.penStroke.id && !e.left.includes(s.id),
    "the eraser takes the stroke it crosses and leaves the other: " + JSON.stringify(e));
  assert(e.msgs.join() === "remove:1=" + s.id, "and tells the deck which: " + e.msgs);

  const u = r.undo;
  assert(u.before.length === 2 && u.after.join() === u.before.slice(0, 1).join() && u.msgs.join() === "remove:1=" + u.before[1],
    "U undoes the last stroke on the slide, here and in the deck: " + JSON.stringify(u));
  assert(r.cmdZ.before.length === 2 && r.cmdZ.after.length === 1 && !r.cmdZ.focused,
    "so does Cmd-Z, which is not Z: " + JSON.stringify(r.cmdZ));
  assert(r.clearSlide.here.length === 0 && r.clearSlide.msgs.join() === "clear:1" && r.clearSlide.disabled.every(Boolean),
    "Clear clears this slide, and Undo and Clear grey out: " + JSON.stringify(r.clearSlide));

  assert(r.clearAllOnce.here.length === 1 && r.clearAllOnce.armed && r.clearAllOnce.msgs.length === 0,
    "one click on Clear all only asks: " + JSON.stringify(r.clearAllOnce));
  assert(r.clearAllTwice.here.length === 0 && r.clearAllTwice.msgs.join() === "clear" && r.clearAllTwice.disabled,
    "the second clears every slide: " + JSON.stringify(r.clearAllTwice));
  assert(r.clearAllOnOne.length === 0, "including the one not on screen: " + r.clearAllOnOne);

  const l = r.laser;
  assert(l.msgs.length >= 1 && l.msgs[0].slide === "1" && near(l.msgs[0].points[0][0], W / 2, 4) && near(l.msgs[0].points[0][1], H / 2, 4),
    "the laser sends where it points, in design pixels: " + JSON.stringify(l.msgs));
  assert(l.dot && l.strokes === 0, "shows its dot here, and leaves no stroke: " + JSON.stringify(l));
  assert(r.laserOff.msgs[r.laserOff.msgs.length - 1] === "off" && !r.laserOff.dot,
    "and is put away when the pointer leaves the slide: " + JSON.stringify(r.laserOff));

  assert(r.kept.length === 1, "a stroke to resend: " + r.kept);
  assert(r.resync.join() === "clear,slide:1=" + r.kept[0],
    "a deck that reloaded is sent a clear and then each slide's ink: " + r.resync);
  assert(r.noResync === 0, "the same page load again is sent nothing: " + r.noResync);

  assert(r.reset.here.length === 0 && r.reset.msgs.includes("clear"),
    "Reset clears the ink here and in the deck: " + JSON.stringify(r.reset));
  assert(r.afterReset.sent === 0 && r.afterReset.here === 1, "and drawing is private again: " + JSON.stringify(r.afterReset));
});

// The tools against everything else on the presenter view: focus, the
// controls' places, and the keyboard focus a click leaves behind.
const INK_CONTROLS_DRIVE = `
(function () {
  var out = {};
  ${DRIVE_HELPERS}
  ${INK_HELPERS}
  var layout = function (why) { return why + " | " + palAt().join(" ") + " | " + barAt().join(" "); };
  async function run() {
    await until(function () { return !!copy(); }, 4000);
    await still();
    var layouts = [layout("opened")];

    // With a tool chosen, a click on the slide does not change focus; the
    // corner button still does.
    key("e");
    out.eraser = toolOn();
    pointer("pointerdown", at(0.5, 0.5));
    pointer("pointerup", at(0.5, 0.5));
    face().click();
    await still();
    out.clickWithTool = focused();
    q(".sdoc-presenter-focus").click();
    await still();
    out.buttonWithTool = focused();
    layouts.push(layout("focused, eraser"));
    q(".sdoc-presenter-focus").click();
    await still();
    out.buttonBack = focused();
    // The pointer control puts the tool down, and a click focuses again.
    q(".sdoc-ink-tool.is-pointer").click();
    out.pointer = toolOn();
    face().click();
    await still();
    out.clickWithout = focused();
    face().click();
    await still();
    // A tool's key again puts it down too.
    key("h");
    out.hOn = toolOn();
    key("h");
    out.hOff = toolOn();

    // Nothing in the palette or the bar moves, whatever is chosen or armed.
    ["pen", "highlighter", "rect", "callout", "laser", "eraser", "pointer"].forEach(function (t) {
      q(".sdoc-ink-tool.is-" + t).click();
      layouts.push(layout(t));
    });
    [].forEach.call(document.querySelectorAll(".sdoc-ink-swatch"), function (b, i) {
      b.click();
      layouts.push(layout("swatch " + i));
    });
    out.swatch = { tool: toolOn(), on: [].map.call(document.querySelectorAll(".sdoc-ink-swatch"), function (b) { return b.classList.contains("is-on"); }),
      pen: getComputedStyle(q(".sdoc-ink-tool.is-pen svg")).color };
    key("c");
    out.cKey = [].map.call(document.querySelectorAll(".sdoc-ink-swatch"), function (b) { return b.classList.contains("is-on"); });
    await drag([0.2, 0.3], [0.6, 0.3]);
    layouts.push(layout("drawn"));
    q(".sdoc-ink-tool.is-clear-all").click();
    out.armed = q(".sdoc-ink-tool.is-clear-all").classList.contains("is-armed");
    layouts.push(layout("clear all armed"));
    q(".sdoc-ink-tool.is-clear-all").click();
    layouts.push(layout("cleared"));
    key("z");
    await still();
    layouts.push(layout("focused"));
    key("z");
    await still();
    q(".sdoc-presenter-start").click();
    await until(started, 1000);
    layouts.push(layout("started"));
    q(".sdoc-presenter-reset").click();
    layouts.push(layout("reset armed"));
    out.layouts = layouts;

    // A click on the timer leaves the keyboard focus where it was, so the
    // next Space turns the slide and does not press the timer again.
    // Synthetic events carry no default action, so this does what the
    // browser would: a mousedown left alone focuses the button, and a Space
    // released on a focused button presses it.
    var timer = q(".sdoc-presenter-timer");
    var md = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    timer.dispatchEvent(md);
    if (!md.defaultPrevented) timer.focus();
    timer.click();
    var paused = q(".sdoc-presenter").classList.contains("is-paused");
    var hash = location.hash;
    var kd = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    (document.activeElement || document.body).dispatchEvent(kd);
    if (document.activeElement && document.activeElement.tagName === "BUTTON") document.activeElement.click();
    await wait(80);
    out.space = { pausedByClick: paused, pausedAfterSpace: q(".sdoc-presenter").classList.contains("is-paused"),
      focus: document.activeElement === timer, moved: location.hash !== hash };
    // Every other button in the bar and the palette, the same.
    out.keepFocus = [].filter.call(document.querySelectorAll(".sdoc-presenter-bar button, .sdoc-ink-tools button"), function (b) {
      if (b.disabled) return false;
      var ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
      b.dispatchEvent(ev);
      return !ev.defaultPrevented;
    }).map(function (b) { return b.className; });
  }
  function start() { run().catch(function (e) { out.__error = String((e && e.stack) || e); }).then(function () { reportAs("sdoc-ink-controls", out); }); }
  if (document.readyState === "complete") start(); else window.addEventListener("load", start);
})();
`;

test("ink tools in the presenter window: focus, fixed controls, and no stray keyboard focus (browser)", async () => {
  browser.skip();
  const file = presenterPage(PRESENTER_DECK, { opener: true });
  const r = await runHarvest(file, INK_CONTROLS_DRIVE, "sdoc-ink-controls", AS_PRESENTER);
  assert(!r.__error, "the drive threw: " + r.__error);
  assert(r.eraser === "eraser", "E picks the eraser: " + r.eraser);
  assert(!r.clickWithTool, "with a tool chosen, a click on the slide does not enlarge it");
  assert(r.buttonWithTool && !r.buttonBack, "the corner button still does, both ways");
  assert(r.pointer === "pointer" && r.clickWithout, "with the pointer chosen, a click on the slide enlarges it again");
  assert(r.hOn === "highlighter" && r.hOff === "pointer", "H picks the highlighter, and H again puts it down: " + r.hOn + " " + r.hOff);
  assert(r.swatch.tool === "pen" && r.swatch.on.join() === "false,false,true",
    "a colour picks the pen in that colour, and is marked: " + JSON.stringify(r.swatch));
  assert(r.swatch.pen === "rgb(22, 163, 74)", "the pen's own icon shows the colour: " + r.swatch.pen);
  assert(r.cKey.join() === "true,false,false", "C goes on to the next colour: " + r.cKey);
  assert(r.armed, "Clear all asks before it clears");

  const strip = (l) => l.slice(l.indexOf(" | ") + 3);
  const first = strip(r.layouts[0]);
  assert(first.split(" | ")[0].split(" ").length === 15, "every control is in the palette from the start: " + first);
  for (const l of r.layouts) {
    assert(strip(l) === first, "nothing in the palette or the bar moves or resizes (" + l.split(" | ")[0] + "):\n  " + first + "\n  " + strip(l));
  }

  assert(r.space.pausedByClick && r.space.pausedAfterSpace,
    "after a click on the timer, Space does not press it again: " + JSON.stringify(r.space));
  assert(!r.space.focus && r.space.moved, "the focus stayed off it, and Space turned the slide: " + JSON.stringify(r.space));
  assert(r.keepFocus.length === 0, "no button in the bar or the palette takes the focus on a click: " + r.keepFocus);
});

// A pen's colour, changed: a double-click on its swatch opens the choices,
// a choice applies to that pen from the next stroke on, and the colours are
// still there after a reload. Run twice in one window: the first load does
// everything and reloads, the second reads what the first left behind.
const PEN_COLOUR_DRIVE = `
(function () {
  ${DRIVE_HELPERS}
  ${INK_HELPERS}
  var STASH = "sdoc-pen-colour-drive";
  var out = {};
  try { out = JSON.parse(sessionStorage.getItem(STASH) || "{}"); } catch (err) {}
  var chooser = function () { return q(".sdoc-ink-colours"); };
  var isOpen = function () { var c = chooser(); return !!(c && !c.hidden && c.offsetWidth > 0); };
  var swatch = function (i) { return document.querySelectorAll(".sdoc-ink-swatch")[i]; };
  var dots = function () { return [].map.call(document.querySelectorAll(".sdoc-ink-swatch-dot"), function (d) { return getComputedStyle(d).backgroundColor; }); };
  var penOn = function () { return [].map.call(document.querySelectorAll(".sdoc-ink-swatch"), function (b) { return b.classList.contains("is-on"); }).indexOf(true); };
  var inkPen = function () { return getComputedStyle(q(".sdoc-ink-tools")).getPropertyValue("--sdoc-ink-pen").trim(); };
  var layout = function () { return palAt().join(" ") + " | " + barAt().join(" "); };
  var fill = function (id) { var p = q(".sdoc-presenter-slot.is-current svg.sdoc-ink path[data-stroke='" + id + "']"); return p ? p.getAttribute("fill") : null; };
  // A click as the browser makes one, with a double-click after the second
  // when there are two; a mousedown left alone moves the focus, as it would.
  var press = function (b, n) {
    var r = b.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    for (var i = 1; i <= n; i++) {
      var o = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, detail: i };
      b.dispatchEvent(new PointerEvent("pointerdown", Object.assign({ pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 1 }, o)));
      var md = new MouseEvent("mousedown", Object.assign({ buttons: 1 }, o));
      b.dispatchEvent(md);
      if (!md.defaultPrevented) b.focus();
      b.dispatchEvent(new PointerEvent("pointerup", Object.assign({ pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 0 }, o)));
      b.dispatchEvent(new MouseEvent("mouseup", o));
      b.dispatchEvent(new MouseEvent("click", o));
    }
    if (n === 2) b.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, detail: 2 }));
  };
  var begun = function (n0) { return sent("ink").slice(n0).filter(function (m) { return m.op === "begin"; }).map(function (m) { return m.stroke; })[0] || null; };

  async function first() {
    await until(function () { return !!copy(); }, 4000);
    await still();
    out.stored0 = localStorage.getItem("sdocInkPens");
    out.layoutShut = layout();
    from({ type: "position", position: "1" });
    q(".sdoc-presenter-start").click();
    await until(started, 1000);

    // A stroke in the first pen's colour, before anything changes.
    press(swatch(0), 1);
    var n0 = sent("ink").length;
    await drag([0.2, 0.3], [0.6, 0.3]);
    var a = begun(n0);
    out.strokeA = a ? { id: a.id, color: a.color } : null;

    // A single click picks the pen and opens nothing.
    press(swatch(1), 1);
    out.oneClick = { open: isOpen(), pen: penOn() };

    // A double-click opens the choices for that pen, beside the column.
    press(swatch(1), 2);
    var c = chooser(), cr = c.getBoundingClientRect(), pr = q(".sdoc-ink-tools").getBoundingClientRect(), sr = swatch(1).getBoundingClientRect();
    out.opened = { open: isOpen(), expanded: swatch(1).getAttribute("aria-expanded"),
      presets: c.querySelectorAll(".sdoc-ink-colours-preset").length,
      marked: [].map.call(c.querySelectorAll(".sdoc-ink-colours-preset.is-on"), function (b) { return b.getAttribute("data-colour"); }),
      picker: (c.querySelector("input[type=color]") || {}).value || null,
      right: cr.left >= pr.right, level: cr.top <= sr.top + sr.height / 2 && cr.bottom >= sr.top + sr.height / 2,
      inWindow: cr.top >= 0 && cr.bottom <= innerHeight && cr.right <= innerWidth,
      focus: document.activeElement === document.body };
    out.layoutOpen = layout();
    out.presetFocus = [].filter.call(c.querySelectorAll(".sdoc-ink-colours-preset"), function (b) {
      var ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
      b.dispatchEvent(ev);
      return !ev.defaultPrevented;
    }).length;

    // A preset applies at once, to that pen, and closes the choices.
    press(c.querySelector(".sdoc-ink-colours-preset[data-colour='#8b5cf6']"), 1);
    out.picked = { open: isOpen(), dots: dots(), pen: penOn(), inkPen: inkPen(), label: swatch(1).getAttribute("aria-label"),
      stored: localStorage.getItem("sdocInkPens"), focus: document.activeElement === document.body };
    out.layoutPicked = layout();

    // The next stroke is in it; the earlier one keeps its own colour.
    n0 = sent("ink").length;
    await drag([0.2, 0.5], [0.6, 0.5]);
    var b = begun(n0);
    out.strokeB = b ? { id: b.id, color: b.color, fill: fill(b.id) } : null;
    out.strokeAFill = a ? fill(a.id) : null;

    // Escape closes the choices and nothing else: the enlarged slide stays.
    key("z");
    await still();
    press(swatch(2), 2);
    out.escape = { opened: isOpen() };
    key("Escape");
    await still();
    out.escape.open = isOpen();
    out.escape.focused = focused();
    out.escape.expanded = swatch(2).getAttribute("aria-expanded");
    key("z");
    await still();

    // A press on the slide closes them, and does not also draw there.
    press(swatch(2), 2);
    out.outside = { opened: isOpen(), strokes: here().length };
    n0 = sent("ink").length;
    pointer("pointerdown", at(0.5, 0.8));
    pointer("pointermove", at(0.6, 0.8));
    pointer("pointerup", at(0.6, 0.8));
    await wait(60);
    out.outside.open = isOpen();
    out.outside.after = here().length;
    out.outside.sent = sent("ink").length - n0;

    // Any other colour, from the system's picker: applied as it changes,
    // closed once it is settled.
    press(swatch(2), 2);
    var input = chooser().querySelector("input[type=color]");
    input.value = "#123456";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    out.custom = { open: isOpen(), dot: dots()[2] };
    input.dispatchEvent(new Event("change", { bubbles: true }));
    out.custom.closed = !isOpen();
    out.custom.stored = localStorage.getItem("sdocInkPens");

    // C goes round the three as they now are.
    out.cycle = [];
    for (var i = 0; i < 3; i++) { key("c"); out.cycle.push(inkPen()); }

    // The highlighter's colour, the same way.
    var hl = q(".sdoc-ink-tool.is-highlighter");
    var hlColour = function () { return getComputedStyle(hl.querySelector("svg")).color; };
    press(hl, 1);
    out.hlOneClick = { open: isOpen(), tool: toolOn(), colour: hlColour() };
    n0 = sent("ink").length;
    await drag([0.2, 0.3], [0.6, 0.3]);
    var ha = begun(n0);
    out.hlA = ha ? { id: ha.id, color: ha.color } : null;
    var shut = layout();
    press(hl, 2);
    var hc = chooser(), hcr = hc.getBoundingClientRect(), hbr = hl.getBoundingClientRect();
    out.hlOpened = { open: isOpen(), expanded: hl.getAttribute("aria-expanded"), title: hc.querySelector(".sdoc-ink-colours-title").textContent,
      presets: [].map.call(hc.querySelectorAll(".sdoc-ink-colours-preset"), function (b) { return b.getAttribute("data-colour"); }),
      marked: [].map.call(hc.querySelectorAll(".sdoc-ink-colours-preset.is-on"), function (b) { return b.getAttribute("data-colour"); }),
      picker: (hc.querySelector("input[type=color]") || {}).value || null, focus: document.activeElement === document.body,
      level: hcr.top <= hbr.top + hbr.height / 2 && hcr.bottom >= hbr.top + hbr.height / 2 };
    out.hlLayout = [shut, layout()];
    var pink = hc.querySelector(".sdoc-ink-colours-preset[data-colour='#ff6fb5']");
    if (pink) press(pink, 1);
    out.hlPicked = { open: isOpen(), tool: toolOn(), colour: hlColour(), stored: localStorage.getItem("sdocInkHighlight"),
      label: hl.getAttribute("aria-label"), focus: document.activeElement === document.body };
    n0 = sent("ink").length;
    await drag([0.2, 0.6], [0.6, 0.6]);
    var hb = begun(n0);
    out.hlB = hb ? { id: hb.id, color: hb.color, fill: fill(hb.id) } : null;
    out.hlAFill = ha ? fill(ha.id) : null;
    press(hl, 2);
    out.hlEsc = { opened: isOpen() };
    key("Escape");
    out.hlEsc.open = isOpen();

    out.phase = 1;
    sessionStorage.setItem(STASH, JSON.stringify(out));
    location.reload();
  }
  async function second() {
    await until(function () { return !!copy(); }, 4000);
    out.reloaded = { dots: dots(), labels: [].map.call(document.querySelectorAll(".sdoc-ink-swatch"), function (b) { return b.getAttribute("aria-label"); }),
      highlighter: getComputedStyle(q(".sdoc-ink-tool.is-highlighter svg")).color };
    press(swatch(1), 1);
    out.reloaded.inkPen = inkPen();
    out.phase = 2;
  }
  function start() {
    var phase = out.phase || 0;
    (phase ? second() : first()).catch(function (e) { out.__error = String((e && e.stack) || e); out.phase = 2; })
      .then(function () { if (out.phase === 2) reportAs("sdoc-pen-colour", out); });
  }
  if (document.readyState === "complete") start(); else window.addEventListener("load", start);
})();
`;

test("a pen's colour, changed on a double-click and remembered (browser)", async () => {
  browser.skip();
  const file = presenterPage(PRESENTER_DECK, { opener: true });
  const r = await runHarvest(file, PEN_COLOUR_DRIVE, "sdoc-pen-colour", AS_PRESENTER);
  assert(!r.__error, "the drive threw: " + r.__error);
  assert(r.stored0 === null, "a fresh browser has no colours stored: " + r.stored0);
  assert(!r.oneClick.open && r.oneClick.pen === 1, "a single click picks the pen and opens nothing: " + JSON.stringify(r.oneClick));
  assert(r.strokeA && r.strokeA.color === "#ef3434", "the first pen draws in red to begin with: " + JSON.stringify(r.strokeA));

  const o = r.opened;
  assert(o.open && o.expanded === "true", "a double-click opens that pen's colours: " + JSON.stringify(o));
  assert(o.presets === 12 && o.marked.join() === "#2b7cf6" && o.picker === "#2b7cf6",
    "a dozen of them, the pen's own marked, and the picker set to it: " + JSON.stringify(o));
  assert(r.layoutOpen === r.layoutShut && r.layoutPicked === r.layoutShut,
    "nothing in the palette or the bar moves or resizes while the choices are open:\n  " + r.layoutShut + "\n  " + r.layoutOpen + "\n  " + r.layoutPicked);
  assert(o.right && o.level && o.inWindow, "beside the column, level with the colour, inside the window: " + JSON.stringify(o));
  assert(o.focus && r.presetFocus === 0, "neither the swatch nor any colour takes the keyboard focus: " + o.focus + " " + r.presetFocus);

  const p = r.picked;
  assert(!p.open, "a colour chosen closes the choices");
  assert(p.dots[1] === "rgb(139, 92, 246)" && p.dots[0] === "rgb(239, 52, 52)" && p.dots[2] === "rgb(22, 163, 74)",
    "it changes that pen, and only that pen: " + p.dots);
  assert(p.pen === 1 && p.inkPen === "#8b5cf6" && p.label === "Violet pen", "which is the pen in hand, named for its colour: " + JSON.stringify(p));
  assert(p.stored === JSON.stringify(["#ef3434", "#8b5cf6", "#16a34a"]), "and remembered: " + p.stored);
  assert(p.focus, "and the focus is still nowhere");
  assert(r.strokeB && r.strokeB.color === "#8b5cf6" && r.strokeB.fill === "#8b5cf6",
    "the next stroke is in it, sent and drawn: " + JSON.stringify(r.strokeB));
  assert(r.strokeAFill === "#ef3434", "the earlier stroke keeps the colour it was drawn in: " + r.strokeAFill);

  assert(r.escape.opened && !r.escape.open && r.escape.expanded === "false", "Escape closes the choices: " + JSON.stringify(r.escape));
  assert(r.escape.focused, "and only them: the enlarged slide stays enlarged");
  assert(r.outside.opened && !r.outside.open, "a press elsewhere closes them: " + JSON.stringify(r.outside));
  assert(r.outside.after === r.outside.strokes && r.outside.sent === 0, "and one on the slide does not also draw there: " + JSON.stringify(r.outside));
  assert(r.custom.open && r.custom.dot === "rgb(18, 52, 86)", "the system's picker applies as it changes: " + JSON.stringify(r.custom));
  assert(r.custom.closed && r.custom.stored === JSON.stringify(["#ef3434", "#8b5cf6", "#123456"]), "and, settled, closes and is remembered: " + JSON.stringify(r.custom));
  assert(r.cycle.join() === "#ef3434,#8b5cf6,#123456", "C goes round the pens' colours as they now are: " + r.cycle);

  const re = r.reloaded;
  assert(re && re.dots.join(" ") === "rgb(239, 52, 52) rgb(139, 92, 246) rgb(18, 52, 86)",
    "after a reload the pens have the colours chosen: " + JSON.stringify(re));
  assert(re.labels.join() === "Red pen,Violet pen,#123456 pen" && re.inkPen === "#8b5cf6", "named and drawn with as they were: " + JSON.stringify(re));

  // The highlighter's colour.
  assert(!r.hlOneClick.open && r.hlOneClick.tool === "highlighter" && r.hlOneClick.colour === "rgb(255, 214, 10)",
    "a single click on the highlighter picks it, in yellow, and opens nothing: " + JSON.stringify(r.hlOneClick));
  assert(r.hlA && r.hlA.color === "#ffd60a", "it highlights in yellow to begin with: " + JSON.stringify(r.hlA));
  const ho = r.hlOpened;
  assert(ho.open && ho.expanded === "true" && ho.title === "Highlighter colour" && ho.level,
    "a double-click on it opens its colours beside it: " + JSON.stringify(ho));
  assert(ho.presets.length === 6 && ho.presets[0] === "#ffd60a" && ho.marked.join() === "#ffd60a" && ho.picker === "#ffd60a" && ho.focus,
    "six highlighter colours, its own marked, and nothing takes the focus: " + JSON.stringify(ho));
  assert(r.hlLayout[0] === r.hlLayout[1], "nothing moves while they are open:\n  " + r.hlLayout.join("\n  "));
  const hp = r.hlPicked;
  assert(!hp.open && hp.tool === "highlighter" && hp.colour === "rgb(255, 111, 181)" && hp.label === "Highlighter, pink" && hp.focus,
    "a colour chosen closes them and shows on the highlighter: " + JSON.stringify(hp));
  assert(hp.stored === "#ff6fb5" && re.highlighter === "rgb(255, 111, 181)", "and is remembered across a reload: " + hp.stored + " " + re.highlighter);
  assert(r.hlB && r.hlB.color === "#ff6fb5" && r.hlB.fill === "#ff6fb5" && r.hlAFill === "#ffd60a",
    "the next highlight is in it, sent and drawn, and the earlier one keeps its yellow: " + JSON.stringify(r.hlB) + " " + r.hlAFill);
  assert(r.hlEsc.opened && !r.hlEsc.open, "Escape closes them: " + JSON.stringify(r.hlEsc));
});

// A paragraph and a table, to snap to.
const SNAP_DECK = `
# Deck {
    @meta { type: slides }

    # Snapping @s1 {
        The quick brown fox jumps over the lazy dog, twice before breakfast.

        {[table]
            Name | Role | Team
            Ada | Engineer | Core
            Grace | Admiral | Navy
            Linus | Maintainer | Kernel
        }
    }

    # Second @s2 {
        Nothing here.
    }
}
`;

// Measuring a slide the way the tests below need it: boxes in its design
// pixels, read off whatever copy of it is on the page.
const DESIGN_HELPERS = `
  var designOf = function (slideEl, r) {
    var sr = slideEl.getBoundingClientRect(), k = sr.width / slideEl.offsetWidth;
    return { x: (r.left - sr.left) / k, y: (r.top - sr.top) / k, w: r.width / k, h: r.height / k };
  };
  // The first occurrence of a word on the slide, as a box.
  var wordIn = function (slideEl, word) {
    var walker = document.createTreeWalker(slideEl, NodeFilter.SHOW_TEXT), t;
    while ((t = walker.nextNode())) {
      var i = t.data.indexOf(word);
      if (i < 0) continue;
      var r = document.createRange();
      r.setStart(t, i);
      r.setEnd(t, i + word.length);
      return designOf(slideEl, r.getBoundingClientRect());
    }
    return null;
  };
  var unionOf = function (boxes) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    boxes.forEach(function (b) { x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); });
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };
  var columnOf = function (slideEl, i) {
    return unionOf([].map.call(slideEl.querySelectorAll("tr"), function (tr) { return designOf(slideEl, tr.cells[i].getBoundingClientRect()); }));
  };
`;

// Pointing at the current slide in the presenter window in its design
// pixels. Needs INK_HELPERS and DESIGN_HELPERS before it.
const DESIGN_POINTER_HELPERS = `
  var word = function (w) { return wordIn(copy(), w); };
  // A point in design pixels, on screen.
  var scr = function (p) { var c = copy(), cr = c.getBoundingClientRect(), k = cr.width / c.offsetWidth; return { x: cr.left + p[0] * k, y: cr.top + p[1] * k }; };
  // Through each point in turn, in steps.
  var trace = function (pts, steps, o) {
    pointer("pointerdown", scr(pts[0]), o);
    for (var i = 1; i < pts.length; i++) {
      for (var j = 1; j <= steps; j++) {
        pointer("pointermove", scr([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * j / steps, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * j / steps]), o);
      }
    }
    pointer("pointerup", scr(pts[pts.length - 1]), o);
    return wait(60).then(still);
  };
`;

// The highlighter and the rectangle against a real slide in the presenter
// window: what snaps, what does not, and how each goes again.
const SNAP_DRIVE = `
(function () {
  var out = {};
  ${DRIVE_HELPERS}
  ${INK_HELPERS}
  ${DESIGN_HELPERS}
  ${DESIGN_POINTER_HELPERS}
  var n0 = 0;
  var since = function () { var m = sent("ink").slice(n0); n0 = sent("ink").length; return m; };
  var ended = function (msgs) {
    var b = msgs.filter(function (m) { return m.op === "begin"; })[0], rp = msgs.filter(function (m) { return m.op === "replace"; })[0];
    return { ops: msgs.map(function (m) { return m.op; }), id: b ? b.stroke.id : null, tool: b ? b.stroke.tool : null,
      rects: rp ? rp.stroke.rects : null, points: rp ? rp.stroke.points.length : null };
  };
  var pathOf = function (id) { return q(".sdoc-presenter-slot.is-current svg.sdoc-ink path[data-stroke='" + id + "']"); };
  var bbox = function (p) { var b = p.getBBox(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
  async function run() {
    await until(function () { return !!copy(); }, 4000);
    await still();
    var W = copy().offsetWidth, H = copy().offsetHeight;
    out.design = { w: W, h: H };
    from({ type: "position", position: "1" });
    q(".sdoc-presenter-start").click();
    await until(started, 1000);
    n0 = sent("ink").length;
    var quick = word("quick"), brown = word("brown"), fox = word("fox"), jumps = word("jumps"), over = word("over"), lazy = word("lazy"), dog = word("dog");
    out.words = { quick: quick, brown: brown, fox: fox };
    var y = quick.y + quick.h / 2;

    // Along a line of words: the words' box.
    key("h");
    await trace([[quick.x + 0.2 * quick.w, y], [fox.x + 0.8 * fox.w, y]], 12);
    out.hl = ended(since());
    var hp = pathOf(out.hl.id);
    out.hl.drawn = hp ? { cls: hp.getAttribute("class"), box: bbox(hp), fill: hp.getAttribute("fill"), opacity: hp.getAttribute("fill-opacity") } : null;

    // A scribble across two words does not snap.
    var zig = [];
    for (var i = 0; i <= 8; i++) zig.push([i % 2 ? dog.x + dog.w : lazy.x, y + (i % 2 ? -0.6 : 0.6) * lazy.h]);
    await trace(zig, 3);
    out.scribble = ended(since());
    out.scribble.cls = (pathOf(out.scribble.id) || { getAttribute: function () { return null; } }).getAttribute("class");

    // Nor does a straight line drawn with Alt held.
    await trace([[jumps.x + 0.2 * jumps.w, y], [over.x + 0.8 * over.w, y]], 12, { alt: true });
    out.alt = ended(since());

    // A rubber band round the Role column: dashed while it is dragged,
    // then the column's box.
    key("r");
    out.rTool = toolOn();
    var role = columnOf(copy(), 1), u = W / 1280;
    out.role = role;
    var a = [role.x - 8 * u, role.y - 8 * u], b = [role.x + role.w + 8 * u, role.y + role.h + 8 * u];
    pointer("pointerdown", scr(a));
    pointer("pointermove", scr([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]));
    await wait(80);
    var lp = q(".sdoc-presenter-slot.is-current svg.sdoc-ink [data-ink=strokes]").lastChild;
    out.band = { dashed: !!(lp && lp.getAttribute("stroke-dasharray")), stroke: lp && lp.getAttribute("stroke"), fill: lp && lp.getAttribute("fill") };
    pointer("pointermove", scr(b));
    pointer("pointerup", scr(b));
    await wait(60);
    await still();
    out.column = ended(since());
    var cp = pathOf(out.column.id);
    out.column.drawn = cp ? { box: bbox(cp), dashed: !!cp.getAttribute("stroke-dasharray"), stroke: cp.getAttribute("stroke") } : null;

    // The eraser inside the rectangle, away from its outline, leaves it.
    key("e");
    var mid = role.y + role.h / 2;
    await trace([[role.x + 0.3 * role.w, mid], [role.x + 0.7 * role.w, mid]], 6);
    out.insideErase = { msgs: ops(since()), here: here() };
    key("r");

    // Part of a word: the word.
    var adm = word("Admiral");
    out.admiral = adm;
    await trace([[adm.x + 0.3 * adm.w, adm.y + 0.3 * adm.h], [adm.x + 0.7 * adm.w, adm.y + 0.7 * adm.h]], 4);
    out.part = ended(since());
    // Empty space: as drawn.
    out.emptyBand = { x: Math.round(0.3 * W * 10) / 10, y: Math.round(0.8 * H * 10) / 10, w: Math.round(0.5 * W * 10) / 10 - Math.round(0.3 * W * 10) / 10, h: Math.round(0.88 * H * 10) / 10 - Math.round(0.8 * H * 10) / 10 };
    await trace([[0.3 * W, 0.8 * H], [0.5 * W, 0.88 * H]], 4);
    out.empty = ended(since());
    // A click on a word boxes it; a click on nothing leaves nothing.
    var ker = word("Kernel");
    out.kernel = ker;
    await trace([[ker.x + ker.w / 2, ker.y + ker.h / 2]], 1);
    out.click = ended(since());
    var before = here();
    await trace([[0.4 * W, 0.84 * H]], 1);
    var nothing = since();
    out.clickNothing = { ops: nothing.map(function (m) { return m.op; }), before: before, here: here() };
    // Alt: the band as drawn, even round a column.
    var team = columnOf(copy(), 2);
    var ta = [team.x - 8 * u, team.y - 8 * u], tb = [team.x + team.w + 8 * u, team.y + team.h + 8 * u];
    out.teamBand = { x: Math.round(ta[0] * 10) / 10, y: Math.round(ta[1] * 10) / 10, x1: Math.round(tb[0] * 10) / 10, y1: Math.round(tb[1] * 10) / 10 };
    await trace([ta, tb], 4, { alt: true });
    out.altBand = ended(since());

    // What the audience is sent up to here is drawn by the deck below.
    out.checkpoint = sent("ink").length;
    out.kept = here();

    // Undo takes the last; the eraser takes a snapped highlight anywhere on
    // it, and a rectangle where it crosses its outline; Clear takes the rest.
    key("u");
    out.undo = { msgs: ops(since()), here: here() };
    key("e");
    await trace([[brown.x + brown.w / 2, brown.y + 0.2 * brown.h], [brown.x + brown.w / 2, brown.y + 0.8 * brown.h]], 4);
    out.eraseHl = { msgs: ops(since()), here: here() };
    var cx = role.x + role.w / 2;
    await trace([[cx, role.y - 26 * u], [cx, role.y + 2 * u]], 6);
    out.eraseEdge = { msgs: ops(since()), here: here() };
    q(".sdoc-ink-tool.is-clear").click();
    out.cleared = { msgs: ops(since()), here: here() };

    // On another slide, its own words: nothing measured on the first is
    // kept once the slide changes.
    await go("2");
    key("h");
    var nw = word("Nothing"), hw = word("here."), y2 = nw.y + nw.h / 2;
    out.second = { words: unionOf([nw, hw]) };
    await trace([[nw.x + 0.2 * nw.w, y2], [hw.x + 0.8 * hw.w, y2]], 12);
    var sec = ended(since());
    out.second.rects = sec.rects;
    out.msgs = sent("ink");
  }
  function start() { run().catch(function (e) { out.__error = String((e && e.stack) || e); }).then(function () { reportAs("sdoc-snap-drive", out); }); }
  if (document.readyState === "complete") start(); else window.addEventListener("load", start);
})();
`;

// The deck's side of it: the presenter's messages, replayed, drawn on the
// deck's own slide where its own words and cells are.
const audienceSnapDrive = (msgs, upTo) => `
(function () {
  var out = {};
  ${DRIVE_HELPERS}
  ${DESIGN_HELPERS}
  var MSGS = ${JSON.stringify(msgs)}, UP_TO = ${upTo};
  var slide = function () { return document.querySelector("body > .slide.active"); };
  var drawn = function () {
    var l = slide().querySelector(":scope > svg.sdoc-ink");
    return l ? [].map.call(l.querySelectorAll("[data-ink=strokes] > path[data-stroke]"), function (p) {
      var b = p.getBBox();
      return { id: p.getAttribute("data-stroke"), cls: p.getAttribute("class"), box: { x: b.x, y: b.y, w: b.width, h: b.height },
        stroke: p.getAttribute("stroke"), dashed: !!p.getAttribute("stroke-dasharray") };
    }) : [];
  };
  async function run() {
    var i;
    // The presenter window checks in first: the deck hears no other.
    from({ type: "hello", ink: 0 });
    for (i = 0; i < UP_TO; i++) from(MSGS[i]);
    await until(function () { return !document.getAnimations().length; }, 2000);
    out.design = { w: slide().offsetWidth, h: slide().offsetHeight };
    out.scale = slide().getBoundingClientRect().width / slide().offsetWidth;
    out.words = { quick: wordIn(slide(), "quick"), fox: wordIn(slide(), "fox"), admiral: wordIn(slide(), "Admiral") };
    out.role = columnOf(slide(), 1);
    out.paths = drawn();
    out.ghosts = slide().querySelectorAll("svg.sdoc-ink [data-ink=ghosts] > *").length;
    for (i = UP_TO; i < MSGS.length; i++) from(MSGS[i]);
    out.after = drawn().length;
  }
  function start() { run().catch(function (e) { out.__error = String((e && e.stack) || e); }).then(function () {
    var el = document.createElement("script");
    el.type = "application/json";
    el.id = "sdoc-snap-audience";
    el.textContent = JSON.stringify(out) + "\\n/*${SENTINEL}*/";
    document.body.appendChild(el);
  }); }
  if (document.readyState === "complete") start(); else window.addEventListener("load", start);
})();
`;

test("the highlighter and the rectangle snap to the slide, and the deck draws what they snapped to (browser)", async () => {
  browser.skip();
  const r = await runHarvest(presenterPage(SNAP_DECK, { opener: true }), SNAP_DRIVE, "sdoc-snap-drive", AS_PRESENTER);
  assert(!r.__error, "the drive threw: " + r.__error);
  const u = r.design.w / 1280;
  const near = (a, b, t) => Math.abs(a - b) <= t;
  const close = (got, want, t) => !!got && !!want && ["x", "y", "w", "h"].every((k) => near(got[k], want[k], t));
  const grow = (b, p) => ({ x: b.x - p, y: b.y - p, w: b.w + 2 * p, h: b.h + 2 * p });
  const span = (a, b) => ({ x: a.x, y: Math.min(a.y, b.y), w: b.x + b.w - a.x, h: Math.max(a.y + a.h, b.y + b.h) - Math.min(a.y, b.y) });
  const show = (v) => JSON.stringify(v);

  // The highlighter.
  const words = span(r.words.quick, r.words.fox), hl = r.hl;
  assert(hl.tool === "highlighter" && hl.ops[0] === "begin" && hl.ops.includes("end") && hl.ops[hl.ops.length - 1] === "replace",
    "a highlight along a line is drawn as it goes, then replaced: " + hl.ops);
  assert(hl.rects && hl.rects.length === 1 && close(hl.rects[0], grow(words, 2 * u), 1.5),
    "by the box of the words it ran along, quick to fox: " + show(hl.rects) + " against " + show(grow(words, 2 * u)));
  assert(hl.points === 0, "and its points are not sent again: " + hl.points);
  assert(hl.drawn && /is-snapped/.test(hl.drawn.cls) && close(hl.drawn.box, hl.rects[0], 0.5) && hl.drawn.fill === "#ffd60a" && hl.drawn.opacity === "0.4",
    "drawn here as that box, in the highlighter's yellow, translucent: " + show(hl.drawn));
  assert(r.scribble.id && !r.scribble.ops.includes("replace") && r.scribble.cls === "sdoc-ink-highlighter",
    "a scribble across two words stays as it was drawn: " + show(r.scribble));
  assert(r.alt.id && !r.alt.ops.includes("replace"), "so does a straight line drawn with Alt held: " + show(r.alt));

  // The rectangle.
  assert(r.rTool === "rect", "R picks the rectangle: " + r.rTool);
  assert(r.band.dashed && r.band.fill === "none" && /^#/.test(r.band.stroke), "a dashed outline while it is dragged: " + show(r.band));
  const col = r.column;
  assert(col.tool === "rect" && col.ops[col.ops.length - 1] === "replace" && col.rects && close(col.rects[0], grow(r.role, 6 * u), 1.5),
    "a band round a table column is the column: " + show(col.rects) + " against " + show(grow(r.role, 6 * u)));
  assert(col.drawn && !col.drawn.dashed && close(col.drawn.box, col.rects[0], 0.5), "drawn solid, there: " + show(col.drawn));
  assert(r.insideErase.msgs.length === 0 && r.insideErase.here.includes(col.id),
    "the eraser inside a rectangle, away from its outline, leaves it: " + show(r.insideErase));
  assert(r.part.rects && close(r.part.rects[0], grow(r.admiral, 6 * u), 1.5),
    "a band over part of a word is that word: " + show(r.part.rects) + " against " + show(grow(r.admiral, 6 * u)));
  assert(r.empty.rects && close(r.empty.rects[0], r.emptyBand, 0.2), "a band over nothing stays as drawn: " + show(r.empty.rects) + " against " + show(r.emptyBand));
  assert(r.click.rects && close(r.click.rects[0], grow(r.kernel, 6 * u), 1.5),
    "a click on a word boxes the word: " + show(r.click.rects) + " against " + show(grow(r.kernel, 6 * u)));
  assert(r.clickNothing.ops[r.clickNothing.ops.length - 1] === "remove" && r.clickNothing.here.join() === r.clickNothing.before.join(),
    "a click on nothing leaves nothing, here or in the deck: " + show(r.clickNothing));
  const tb = r.teamBand, want = { x: tb.x, y: tb.y, w: tb.x1 - tb.x, h: tb.y1 - tb.y };
  assert(r.altBand.rects && close(r.altBand.rects[0], want, 0.2), "with Alt held, a band round a column stays as drawn: " + show(r.altBand.rects) + " against " + show(want));

  // Each goes again.
  const kept = r.kept;
  assert(kept.length === 8, "eight kept on the slide: " + kept);
  assert(r.undo.msgs.join() === "remove:1=" + r.altBand.id && !r.undo.here.includes(r.altBand.id), "Undo takes the last rectangle: " + show(r.undo));
  assert(r.eraseHl.msgs.join() === "remove:1=" + hl.id, "the eraser takes a snapped highlight it crosses, and nothing else: " + show(r.eraseHl));
  assert(r.eraseEdge.msgs.join() === "remove:1=" + col.id, "and a rectangle whose outline it crosses: " + show(r.eraseEdge));
  assert(r.cleared.msgs.join() === "clear:1" && r.cleared.here.length === 0, "Clear takes the rest: " + show(r.cleared));
  assert(r.second.rects && close(r.second.rects[0], grow(r.second.words, 2 * u), 1.5),
    "on the next slide a highlight snaps to that slide's words: " + show(r.second));

  // The deck, sent the same messages, draws them where its own words and
  // cells are.
  const a = await runHarvest(presenterPage(SNAP_DECK), audienceSnapDrive(r.msgs, r.checkpoint), "sdoc-snap-audience");
  assert(!a.__error, "the audience drive threw: " + a.__error);
  assert(a.design.w === r.design.w && Math.abs(a.scale - 1) > 0.05, "the deck at another scale than its design box: " + a.scale);
  const byId = Object.fromEntries(a.paths.map((p) => [p.id, p]));
  assert(a.paths.map((p) => p.id).join() === kept.join(), "the deck has what the presenter kept, in order: " + a.paths.map((p) => p.id) + " / " + kept);
  const ah = byId[hl.id], ac = byId[col.id], ap = byId[r.part.id];
  assert(ah && /is-snapped/.test(ah.cls) && close(ah.box, grow(span(a.words.quick, a.words.fox), 2 * u), 1.5),
    "the snapped highlight over its own words: " + show(ah) + " against " + show(grow(span(a.words.quick, a.words.fox), 2 * u)));
  assert(ac && !ac.dashed && close(ac.box, grow(a.role, 6 * u), 1.5), "the column's rectangle round its own column: " + show(ac) + " against " + show(grow(a.role, 6 * u)));
  assert(ap && close(ap.box, grow(a.words.admiral, 6 * u), 1.5), "and the word's round its word: " + show(ap));
  assert(byId[r.scribble.id] && byId[r.scribble.id].cls === "sdoc-ink-highlighter", "a highlight that did not snap stays freehand there too");
  assert(a.ghosts === 0, "the shapes they replaced are gone once the change has faded in: " + a.ghosts);
  assert(a.after === 0, "and the undo, the eraser and Clear reach it: " + a.after);
});

// Reading and driving callouts in the presenter window. Needs INK_HELPERS,
// DESIGN_HELPERS and DESIGN_POINTER_HELPERS before it.
const CALLOUT_HELPERS = `
  var n0 = 0;
  var since = function () { var m = sent("ink").slice(n0); n0 = sent("ink").length; return m; };
  var said = function (msgs) { return msgs.map(function (m) { return m.op + (m.stroke && m.stroke.tool === "callout" ? ":" + m.stroke.text : ""); }); };
  var editorEl = function () { return q(".sdoc-ink-editor-text"); };
  var editing = function () { var b = q(".sdoc-ink-editor"); return !!(b && !b.hidden); };
  var type = function (t) { document.execCommand("insertText", false, t); };
  // A key as the keyboard sends it: to whatever has the focus.
  var keyIn = function (k) {
    var ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
    (document.activeElement || document.body).dispatchEvent(ev);
    return ev;
  };
  var lastId = function () { var g = q(".sdoc-presenter-slot.is-current svg.sdoc-ink [data-ink=strokes]"); return g && g.lastChild ? g.lastChild.getAttribute("data-stroke") : null; };
  var calloutG = function (id) { return q(".sdoc-presenter-slot.is-current svg.sdoc-ink g[data-stroke='" + id + "']"); };
  var boxOf = function (id) {
    var g = calloutG(id), r = g && g.querySelector("rect");
    return r ? { x: +r.getAttribute("x"), y: +r.getAttribute("y"), w: +r.getAttribute("width"), h: +r.getAttribute("height") } : null;
  };
  var leaderOf = function (id) {
    var d = (calloutG(id).querySelector("path").getAttribute("d") || "").match(/-?[0-9.]+/g);
    return d ? d.map(Number) : null;
  };
  // A click, or a double-click, as the browser sends them.
  var clickAt = function (p, n) {
    var t = document.elementFromPoint(p.x, p.y);
    for (var i = 1; i <= n; i++) {
      var o = { clientX: p.x, clientY: p.y, bubbles: true, cancelable: true, composed: true, button: 0, detail: i };
      t.dispatchEvent(new PointerEvent("pointerdown", Object.assign({ pointerId: 31, pointerType: "mouse", isPrimary: true, buttons: 1 }, o)));
      t.dispatchEvent(new PointerEvent("pointerup", Object.assign({ pointerId: 31, pointerType: "mouse", isPrimary: true, buttons: 0 }, o)));
      t.dispatchEvent(new MouseEvent("click", o));
    }
    if (n === 2) t.dispatchEvent(new MouseEvent("dblclick", { clientX: p.x, clientY: p.y, bubbles: true, cancelable: true, button: 0, detail: 2 }));
  };
  var layout = function () { return palAt().join(" ") + " | " + barAt().join(" "); };
`;

// Callouts in the presenter window: made by a click on something and by a
// drag, typed into, edited, and taken away again.
const CALLOUT_DRIVE = `
(function () {
  var out = {};
  ${DRIVE_HELPERS}
  ${INK_HELPERS}
  ${DESIGN_HELPERS}
  ${DESIGN_POINTER_HELPERS}
  ${CALLOUT_HELPERS}
  async function run() {
    await until(function () { return !!copy(); }, 4000);
    await still();
    var W = copy().offsetWidth, H = copy().offsetHeight, u = W / 1280;
    out.design = { w: W, h: H };
    out.layoutShut = layout();

    // Before Start: typed here, sent nowhere, and gone at Start.
    key("a");
    out.aTool = toolOn();
    await trace([[0.1 * W, 0.8 * H], [0.4 * W, 0.82 * H]], 3);
    type("Rehearsal");
    await wait(250);
    keyIn("Escape");
    out.rehearsal = { sent: sent("ink").length, here: here().length };
    from({ type: "position", position: "1" });
    q(".sdoc-presenter-start").click();
    await until(started, 1000);
    out.afterStart = here().length;
    out.toolKept = toolOn();
    n0 = sent("ink").length;

    // A click on a word: a callout beside it, a leader to it, the caret in it.
    var eng = word("Engineer");
    out.eng = eng;
    await trace([[eng.x + eng.w / 2, eng.y + eng.h / 2]], 1);
    var cid = lastId();
    out.click = { id: cid, editing: editing(), focus: document.activeElement === editorEl(), sent: since().length };
    out.layoutEditing = layout();
    // Every key goes to the text: none moves the slide, picks a tool or
    // changes the pen.
    var hash = location.hash, pen = getComputedStyle(q(".sdoc-ink-tools")).getPropertyValue("--sdoc-ink-pen");
    var reached = ["ArrowRight", "ArrowDown", " ", "PageDown", "End", "d", "h", "r", "e", "l", "z", "c", "u", "o", "t", "f", "+"].filter(function (k) { keyIn(k); return false; });
    out.keys = { hash: location.hash === hash, tool: toolOn(), focused: focused(), pen: getComputedStyle(q(".sdoc-ink-tools")).getPropertyValue("--sdoc-ink-pen") === pen,
      editing: editing(), overview: !!(window.sdocOverview && window.sdocOverview.isOpen()), reached: reached.length };
    // Typed, it reaches the audience a few times a second, not on every key.
    type("Leads the");
    var now = since().length;
    type(" platform team");
    await wait(250);
    out.live = { immediate: now, first: said(since()) };
    type(" today");
    await wait(250);
    out.live.then = said(since());
    out.clickBox = boxOf(cid);
    out.leader = leaderOf(cid);
    var er = editorEl().getBoundingClientRect(), tl = scr([out.clickBox.x, out.clickBox.y]), br = scr([out.clickBox.x + out.clickBox.w, out.clickBox.y + out.clickBox.h]);
    out.editorOver = [er.left - tl.x, er.top - tl.y, er.right - br.x, er.bottom - br.y];
    keyIn("Escape");
    out.finished = { editing: editing(), said: said(since()), focus: document.activeElement === document.body };
    out.layoutAfter = layout();

    // A drag: the box there, as wide as its text up to the width dragged,
    // then wrapping; as tall as its lines.
    var x0 = 0.1 * W, y0 = 0.76 * H, x1 = 0.4 * W;
    await trace([[x0, y0], [x1, y0 + 40 * u]], 4);
    var did = lastId();
    type("Hi");
    var b1 = boxOf(did);
    type(" there, a little longer");
    var b2 = boxOf(did);
    type(" and then a great deal longer than the box dragged out for it, so that it wraps");
    var b3 = boxOf(did);
    var enter = keyIn("Enter");
    type("\\nLast line");
    var b4 = boxOf(did);
    keyIn("Escape");
    var dm = since().filter(function (m) { return m.stroke; });
    out.drag = { id: did, band: { x: x0, y: y0, w: x1 - x0 }, b1: b1, b2: b2, b3: b3, b4: b4, enterPrevented: enter.defaultPrevented,
      text: dm.length ? dm[dm.length - 1].stroke.text : null };

    // A click on nothing, and nothing typed: nothing kept, nothing sent.
    var before = here();
    await trace([[0.8 * W, 0.86 * H]], 1);
    out.emptyOpened = editing();
    keyIn("Escape");
    out.empty = { before: before, after: here(), sent: since().length, editing: editing() };

    // A double-click on a callout with no tool opens it again; the clicks
    // do not enlarge the slide.
    q(".sdoc-ink-tool.is-pointer").click();
    var cb = boxOf(cid), toggled = 0;
    // Two clicks that each enlarged the slide would end as they began.
    var watch = new MutationObserver(function (records) {
      records.forEach(function (m) { if (/(^| )is-focused( |$)/.test(m.oldValue || "")) toggled++; });
    });
    watch.observe(q(".sdoc-presenter"), { attributes: true, attributeFilter: ["class"], attributeOldValue: true });
    clickAt(scr([cb.x + cb.w / 2, cb.y + cb.h / 2]), 2);
    await still();
    watch.disconnect();
    out.edit = { editing: editing(), focused: focused() || toggled > 0, text: editorEl().innerText, focus: document.activeElement === editorEl() };
    var sel = window.getSelection(), rg = document.createRange();
    rg.selectNodeContents(editorEl());
    rg.collapse(false);
    sel.removeAllRanges();
    sel.addRange(rg);
    type("!");
    keyIn("Escape");
    out.edit.said = said(since());

    // A click elsewhere finishes one, and does nothing else.
    key("a");
    var ker = word("Kernel");
    await trace([[ker.x + ker.w / 2, ker.y + ker.h / 2]], 1);
    var kid = lastId();
    type("Since 1991");
    var count = here().length;
    clickAt(scr([0.5 * W, 0.1 * H]), 1);
    await until(function () { return !editing(); }, 1000);
    out.away = { id: kid, editing: editing(), here: here().length, count: count, said: said(since()), focused: focused() };

    out.checkpoint = sent("ink").length;
    out.kept = here();

    // Undo, the eraser, Clear and Reset take them away.
    key("u");
    out.undo = { msgs: ops(since()), here: here() };
    key("e");
    var db = boxOf(did);
    await trace([[db.x + db.w / 2, db.y - 30 * u], [db.x + db.w / 2, db.y + db.h / 2]], 4);
    out.erase = { msgs: ops(since()), here: here() };
    q(".sdoc-ink-tool.is-clear").click();
    out.clear = { msgs: ops(since()), here: here() };
    key("a");
    await trace([[0.1 * W, 0.8 * H], [0.4 * W, 0.82 * H]], 3);
    type("Before the reset");
    keyIn("Escape");
    q(".sdoc-presenter-reset").click();
    await until(resetArmed, 1000);
    q(".sdoc-presenter-reset").click();
    await until(function () { return !started() && location.hash === "#1"; }, 1000);
    out.reset = { msgs: ops(since()), here: here() };
    out.msgs = sent("ink");
  }
  function start() { run().catch(function (e) { out.__error = String((e && e.stack) || e); }).then(function () { reportAs("sdoc-callout-drive", out); }); }
  if (document.readyState === "complete") start(); else window.addEventListener("load", start);
})();
`;

// The deck's side: the presenter's callouts, replayed, drawn in the deck's
// own slide.
const audienceCalloutDrive = (msgs, upTo) => `
(function () {
  var out = {};
  ${DRIVE_HELPERS}
  ${DESIGN_HELPERS}
  var MSGS = ${JSON.stringify(msgs)}, UP_TO = ${upTo};
  var slide = function () { return document.querySelector("body > .slide.active"); };
  async function run() {
    var i;
    // The presenter window checks in first: the deck hears no other.
    from({ type: "hello", ink: 0 });
    for (i = 0; i < UP_TO; i++) from(MSGS[i]);
    await wait(60);
    out.scale = slide().getBoundingClientRect().width / slide().offsetWidth;
    out.eng = wordIn(slide(), "Engineer");
    out.callouts = [].map.call(slide().querySelectorAll(":scope > svg.sdoc-ink [data-ink=strokes] > g[data-stroke]"), function (g) {
      var r = g.querySelector("rect"), div = g.querySelector("foreignObject > div"), d = (g.querySelector("path").getAttribute("d") || "").match(/-?[0-9.]+/g);
      return { id: g.getAttribute("data-stroke"),
        box: { x: +r.getAttribute("x"), y: +r.getAttribute("y"), w: +r.getAttribute("width"), h: +r.getAttribute("height") },
        stroke: r.getAttribute("stroke"), fill: r.getAttribute("fill"), fillAlpha: parseFloat(getComputedStyle(r).fillOpacity),
        text: div.textContent, shown: designOf(slide(), div.getBoundingClientRect()),
        fits: div.scrollHeight <= div.clientHeight + 1 && div.scrollWidth <= div.clientWidth + 1,
        color: getComputedStyle(div).color, size: parseFloat(getComputedStyle(div).fontSize), leader: d ? d.map(Number) : null };
    });
    for (i = UP_TO; i < MSGS.length; i++) from(MSGS[i]);
    out.after = slide().querySelectorAll("svg.sdoc-ink [data-ink=strokes] > *").length;
  }
  function start() { run().catch(function (e) { out.__error = String((e && e.stack) || e); }).then(function () {
    var el = document.createElement("script");
    el.type = "application/json";
    el.id = "sdoc-callout-audience";
    el.textContent = JSON.stringify(out) + "\\n/*${SENTINEL}*/";
    document.body.appendChild(el);
  }); }
  if (document.readyState === "complete") start(); else window.addEventListener("load", start);
})();
`;

test("callouts: by a click beside what they are about, or by a drag, typed into and mirrored as they are typed (browser)", async () => {
  browser.skip();
  const r = await runHarvest(presenterPage(SNAP_DECK, { opener: true }), CALLOUT_DRIVE, "sdoc-callout-drive", AS_PRESENTER);
  // First, as a key that got through would derail everything after it.
  const k = r.keys;
  assert(k && k.hash && k.tool === "callout" && !k.focused && k.pen && k.editing && !k.overview,
    "keys typed into a callout move no slide, pick no tool, change no pen, open nothing: " + JSON.stringify(k));
  assert(!r.__error, "the drive threw: " + r.__error);
  const u = r.design.w / 1280;
  const near = (a, b, t) => Math.abs(a - b) <= t;
  const close = (got, want, t) => !!got && !!want && ["x", "y", "w", "h"].every((k) => near(got[k], want[k], t));
  const grow = (b, p) => ({ x: b.x - p, y: b.y - p, w: b.w + 2 * p, h: b.h + 2 * p });
  const onEdge = (pt, b, t) => pt[0] >= b.x - t && pt[0] <= b.x + b.w + t && pt[1] >= b.y - t && pt[1] <= b.y + b.h + t &&
    (near(pt[0], b.x, t) || near(pt[0], b.x + b.w, t) || near(pt[1], b.y, t) || near(pt[1], b.y + b.h, t));
  const apart = (a, b) => a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
  const show = (v) => JSON.stringify(v);

  assert(r.aTool === "callout" && r.toolKept === "callout", "A picks the callout: " + r.aTool);
  assert(r.rehearsal.sent === 0 && r.rehearsal.here === 1 && r.afterStart === 0,
    "before Start a callout is typed here, sent nowhere, and Start throws it away: " + show(r.rehearsal) + " " + r.afterStart);

  // By a click on a word.
  assert(r.click.editing && r.click.focus && r.click.sent === 0, "a click on a word opens a callout with the caret in it, and sends nothing yet: " + show(r.click));
  assert(r.live.immediate === 0 && r.live.first.join() === "begin:Leads the platform team",
    "what is typed reaches the deck a moment later, together, not key by key: " + show(r.live));
  assert(r.live.then.join() === "replace:Leads the platform team today", "and goes on doing so: " + show(r.live.then));
  const target = grow(r.eng, 4 * u), box = r.clickBox;
  assert(box && apart(box, target) && (box.x >= target.x + target.w || box.x + box.w <= target.x) && near(box.y + box.h / 2, target.y + target.h / 2, 1.5),
    "the box beside the word, level with it: " + show(box) + " by " + show(target));
  const L = r.leader;
  assert(L && L.length === 4 && onEdge([L[0], L[1]], box, 0.6) && onEdge([L[2], L[3]], target, 0.6),
    "and a leader from the box's edge to the word's: " + show(L));
  assert(r.editorOver.every((d) => Math.abs(d) < 1.5), "the caret's box lies over the callout's on screen: " + r.editorOver);
  assert(!r.finished.editing && r.finished.focus && r.finished.said.join() === "replace:Leads the platform team today,end",
    "Escape finishes it, sends it once more and ends it, and leaves the keyboard focus nowhere: " + show(r.finished));
  assert(r.layoutEditing === r.layoutShut && r.layoutAfter === r.layoutShut,
    "nothing in the palette or the bar moves while a callout is typed:\n  " + r.layoutShut + "\n  " + r.layoutEditing + "\n  " + r.layoutAfter);

  // By a drag.
  const d = r.drag;
  assert(d.b1 && near(d.b1.x, d.band.x, 0.2) && near(d.b1.y, d.band.y, 0.2), "a dragged callout opens where the drag began: " + show(d.b1) + " " + show(d.band));
  assert(d.b1.w < d.b2.w && d.b2.w < d.band.w && d.b1.h === d.b2.h, "it grows with its text, on one line: " + show([d.b1, d.b2]));
  assert(d.b3.w <= d.band.w + 1 && d.b3.w > d.band.w - 40 * u && d.b3.h > d.b2.h * 1.5, "until the width dragged, then wraps: " + show(d.b3) + " in " + d.band.w);
  assert(!d.enterPrevented && d.b4.h > d.b3.h && /\nLast line$/.test(d.text || ""), "Enter is a new line, and it grows a line taller: " + show(d));

  assert(r.emptyOpened && r.empty.after.join() === r.empty.before.join() && r.empty.sent === 0 && !r.empty.editing,
    "a callout left empty is dropped, and was never sent: " + show(r.empty));
  assert(r.edit.editing && r.edit.focus && !r.edit.focused && r.edit.text === "Leads the platform team today",
    "a double-click opens a callout again with its text, and does not enlarge the slide: " + show(r.edit));
  assert(r.edit.said.join() === "replace:Leads the platform team today!,end", "what is added reaches the deck: " + show(r.edit.said));
  assert(!r.away.editing && r.away.here === r.away.count && !r.away.focused && r.away.said.join() === "begin:Since 1991,end",
    "a click elsewhere finishes a callout and does nothing more: " + show(r.away));

  // And go again.
  assert(r.kept.length === 3, "three callouts kept: " + r.kept);
  assert(r.undo.msgs.join() === "remove:1=" + r.away.id, "Undo takes the last: " + show(r.undo));
  assert(r.erase.msgs.join() === "remove:1=" + d.id, "the eraser takes one it crosses: " + show(r.erase));
  assert(r.clear.msgs.join() === "clear:1" && r.clear.here.length === 0, "Clear takes the rest: " + show(r.clear));
  assert(r.reset.here.length === 0 && r.reset.msgs.includes("clear"), "and Reset clears them in both windows: " + show(r.reset));

  // The deck, sent the same messages.
  const a = await runHarvest(presenterPage(SNAP_DECK), audienceCalloutDrive(r.msgs, r.checkpoint), "sdoc-callout-audience");
  assert(!a.__error, "the audience drive threw: " + a.__error);
  assert(Math.abs(a.scale - 1) > 0.05, "the deck at another scale than its design box: " + a.scale);
  assert(a.callouts.map((c) => c.id).join() === r.kept.join(), "the deck has the callouts the presenter kept: " + a.callouts.map((c) => c.id) + " / " + r.kept);
  const ac = a.callouts[0];
  const lastBox = r.msgs.filter((m) => m.stroke && m.stroke.id === r.click.id).pop().stroke.rects[0];
  assert(ac.text === "Leads the platform team today!" && close(ac.box, lastBox, 0.01) && ac.box.w > r.clickBox.w && near(ac.box.x, r.clickBox.x, 0.01),
    "with their text, in the box measured for it, grown to the right for what was added: " + show(ac) + " " + show(lastBox));
  assert(close(ac.shown, ac.box, 1.5), "drawn there on the deck's own slide, in design pixels: " + show(ac.shown) + " against " + show(ac.box));
  assert(near(ac.size, 22 * u, 0.1) && ac.color === "rgb(27, 27, 31)" && ac.fill === "#fffdf5" && /^#/.test(ac.stroke),
    "dark text, " + 22 * u + " design pixels, on a light fill ruled in the pen's colour: " + show(ac));
  assert(ac.leader && onEdge([ac.leader[2], ac.leader[3]], grow(a.eng, 4 * u), 0.6), "its leader at the word on the deck's slide: " + show(ac.leader));
  assert(a.callouts.every((c) => c.fits), "every callout's text fits its box in the deck's window too: " + show(a.callouts.map((c) => c.fits)));
  assert(a.callouts[1].text.includes("\n") && a.callouts[1].box.h > a.callouts[0].box.h * 2, "the dragged one keeps its lines: " + show(a.callouts[1]));
  assert(a.after === 0, "and the undo, the eraser and Clear reach it: " + a.after);
});

// A callout's width: the default it opens at, and its handle.
const CALLOUT_RESIZE_DRIVE = `
(function () {
  var out = {};
  ${DRIVE_HELPERS}
  ${INK_HELPERS}
  ${DESIGN_HELPERS}
  ${DESIGN_POINTER_HELPERS}
  ${CALLOUT_HELPERS}
  var handleEl = function () { return q(".sdoc-ink-handle"); };
  var handleShown = function () { var h = handleEl(); return !!(h && !h.hidden && h.offsetWidth > 0); };
  var widths = function (msgs) { return msgs.filter(function (m) { return m.stroke; }).map(function (m) { return m.op + ":" + m.stroke.width; }); };
  async function run() {
    await until(function () { return !!copy(); }, 4000);
    await still();
    var W = copy().offsetWidth, u = W / 1280;
    out.design = { w: W, h: copy().offsetHeight };
    out.layoutShut = layout();
    from({ type: "position", position: "1" });
    q(".sdoc-presenter-start").click();
    await until(started, 1000);
    key("a");
    n0 = sent("ink").length;

    // A long sentence in a callout opened by a click wraps at its default.
    var eng = word("Engineer");
    await trace([[eng.x + eng.w / 2, eng.y + eng.h / 2]], 1);
    var id = lastId();
    type("This sentence is long enough that it has to wrap somewhere, and where it wraps shows how wide a callout opens.");
    out.opened = { id: id, box: boxOf(id), handle: handleShown() };
    keyIn("Escape");
    await wait(30);
    out.finishedHandle = handleShown();
    since();

    // With the callout tool over it, its handle, on the edge away from the word.
    var b = boxOf(id), right = b.x > eng.x, ex = right ? b.x + b.w : b.x, my = b.y + b.h / 2;
    pointer("pointermove", scr([b.x + b.w / 2, my]), { hover: true });
    await until(handleShown, 1000);
    var hr = handleEl().getBoundingClientRect(), edge = scr([ex, my]);
    out.hover = { shown: handleShown(), off: [hr.left + hr.width / 2 - edge.x, hr.top + hr.height / 2 - edge.y], right: right };
    out.layoutHandle = layout();

    // Dragged 300 design pixels further out: the text wraps again, and the
    // audience hears of it while it is dragged and where it is let go.
    var h = handleEl(), from0 = scr([ex, my]), to = scr([ex + (right ? 300 : -300), my]);
    var pe = function (type, p) {
      h.dispatchEvent(new PointerEvent(type, { clientX: p.x, clientY: p.y, bubbles: true, cancelable: true, pointerId: 41,
        pointerType: "mouse", isPrimary: true, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1 }));
    };
    var at = function (f) { return { x: from0.x + (to.x - from0.x) * f, y: from0.y }; };
    pe("pointerdown", from0);
    pe("pointermove", at(0.25));
    pe("pointermove", at(0.5));
    await wait(250);
    out.midDrag = widths(since());
    pe("pointermove", at(0.75));
    pe("pointermove", at(1));
    pe("pointerup", at(1));
    await wait(30);
    out.resized = { box: boxOf(id), said: widths(since()) };
    out.layoutResized = layout();

    // Another tool: no handle. Away and back: the width it was given.
    key("d");
    out.otherTool = handleShown();
    await go("2");
    await go("1");
    out.back = boxOf(id);
    out.checkpoint = sent("ink").length;
    // Resizing is not an undo step: Undo takes the callout.
    key("u");
    out.undo = { msgs: ops(since()), here: here() };
    out.msgs = sent("ink");
  }
  function start() { run().catch(function (e) { out.__error = String((e && e.stack) || e); }).then(function () { reportAs("sdoc-callout-resize", out); }); }
  if (document.readyState === "complete") start(); else window.addEventListener("load", start);
})();
`;

// sRGB contrast, for the callout's text on its fill over the slide.
function contrastOf(a, b) {
  const lum = (c) => {
    const v = c.map((x) => x / 255).map((x) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)));
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
const rgbOf = (s) => (s.startsWith("#") ? [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16)) : s.match(/\d+/g).slice(0, 3).map(Number));
const over = (fg, alpha, bg) => fg.map((c, i) => c * alpha + bg[i] * (1 - alpha));

test("callouts open a third of the slide wide, show the slide through them, and widen by their handle (browser)", async () => {
  browser.skip();
  const r = await runHarvest(presenterPage(SNAP_DECK, { opener: true }), CALLOUT_RESIZE_DRIVE, "sdoc-callout-resize", AS_PRESENTER);
  assert(!r.__error, "the drive threw: " + r.__error);
  const W = r.design.w, u = W / 1280, font = 22 * u, near = (a, b, t) => Math.abs(a - b) <= t;
  const lines = (b) => Math.round((b.h - 0.7 * font) / (1.3 * font));
  const show = (v) => JSON.stringify(v);
  const b0 = r.opened.box, b1 = r.resized.box;
  assert(near(b0.w, Math.round(0.35 * W), 1) && lines(b0) >= 2,
    "a long sentence wraps at about a third of the slide: " + show(b0) + ", " + lines(b0) + " lines, on " + W);
  assert(r.opened.handle && !r.finishedHandle, "the handle shows on the callout being typed, and goes with it: " + show(r.opened) + " " + r.finishedHandle);
  assert(r.layoutHandle === r.layoutShut && r.layoutResized === r.layoutShut,
    "nothing in the palette or the bar moves for the handle:\n  " + r.layoutShut + "\n  " + r.layoutHandle + "\n  " + r.layoutResized);
  assert(r.hover.shown && Math.abs(r.hover.off[0]) <= 1.5 && Math.abs(r.hover.off[1]) <= 1.5,
    "with the callout tool over a callout, its handle is on its edge: " + show(r.hover));
  assert(near(b1.w, b0.w + 300, 1) && lines(b1) < lines(b0) && (r.hover.right ? near(b1.x, b0.x, 0.1) : near(b1.x + b1.w, b0.x + b0.w, 0.1)),
    "dragged 300 further, the box is 300 wider where it was, and the text takes fewer lines: " + show(b0) + " -> " + show(b1));
  assert(r.midDrag.length >= 1 && r.midDrag.every((m) => /^replace:\d/.test(m)), "the audience hears of it while it is dragged: " + show(r.midDrag));
  const last = r.resized.said[r.resized.said.length - 1];
  assert(last === "replace:" + b1.w, "and where it is let go: " + show(r.resized.said) + " for " + b1.w);
  assert(!r.otherTool, "another tool shows no handle");
  assert(r.back && near(r.back.w, b1.w, 0.01) && near(r.back.h, b1.h, 0.01), "away and back, it keeps its width: " + show(r.back));
  assert(r.undo.msgs.join() === "remove:1=" + r.opened.id && r.undo.here.length === 0, "a resize is not an undo step: Undo takes the callout: " + show(r.undo));

  const a = await runHarvest(presenterPage(SNAP_DECK), audienceCalloutDrive(r.msgs, r.checkpoint), "sdoc-callout-audience");
  assert(!a.__error, "the audience drive threw: " + a.__error);
  const c = a.callouts[0];
  assert(c && near(c.box.w, b1.w, 0.01) && near(c.box.x, b1.x, 0.01) && near(c.box.h, b1.h, 0.01), "the deck draws it at its new width: " + show(c) + " " + show(b1));
  assert(near(c.shown.x, c.box.x, 1.5) && near(c.shown.w, c.box.w, 1.5) && c.fits, "its text laid out in that box, in design pixels: " + show(c.shown));
  assert(c.fillAlpha > 0.5 && c.fillAlpha < 1, "its fill lets the slide show through: " + c.fillAlpha);
  const text = rgbOf(c.color), fill = rgbOf(c.fill);
  const onBlack = contrastOf(text, over(fill, c.fillAlpha, [0, 0, 0])), onWhite = contrastOf(text, over(fill, c.fillAlpha, [255, 255, 255]));
  assert(onBlack >= 7 && onWhite >= 7, "and its text reads on it over a black slide and a white one: " + onBlack.toFixed(1) + " / " + onWhite.toFixed(1));
});

// Drawing in the deck's own window: its palette, its slide, and a presenter
// window it is linked to, stood in for by a frame that keeps what it is sent.
const DECK_INK_DRIVE = `
(function () {
  var out = {};
  ${DRIVE_HELPERS}
  ${DESIGN_HELPERS}
  var q = function (sel) { return document.querySelector(sel); };
  var slide = function () { return q("body > .slide.active"); };
  var word = function (w) { return wordIn(slide(), w); };
  var scr = function (p) { var sl = slide(), r = sl.getBoundingClientRect(), k = r.width / sl.offsetWidth; return { x: r.left + p[0] * k, y: r.top + p[1] * k }; };
  var pe = function (type, p, o) {
    o = o || {};
    (document.elementFromPoint(p.x, p.y) || document.body).dispatchEvent(new PointerEvent(type, {
      clientX: p.x, clientY: p.y, bubbles: true, cancelable: true, composed: true, pointerId: 51,
      pointerType: "mouse", isPrimary: true, button: type === "pointermove" ? -1 : 0,
      buttons: type === "pointerup" || o.hover ? 0 : 1, altKey: !!o.alt }));
  };
  var trace = function (pts, steps) {
    pe("pointerdown", scr(pts[0]));
    for (var i = 1; i < pts.length; i++) {
      for (var j = 1; j <= steps; j++) pe("pointermove", scr([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * j / steps, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * j / steps]));
    }
    pe("pointerup", scr(pts[pts.length - 1]));
    return wait(80);
  };
  // A click as the browser sends one, on whatever is at that point.
  var clickAt = function (p) {
    var t = document.elementFromPoint(p.x, p.y), o = { clientX: p.x, clientY: p.y, bubbles: true, cancelable: true, composed: true, button: 0, detail: 1 };
    t.dispatchEvent(new PointerEvent("pointerdown", Object.assign({ pointerId: 52, pointerType: "mouse", isPrimary: true, buttons: 1 }, o)));
    t.dispatchEvent(new MouseEvent("mousedown", o));
    t.dispatchEvent(new PointerEvent("pointerup", Object.assign({ pointerId: 52, pointerType: "mouse", isPrimary: true, buttons: 0 }, o)));
    t.dispatchEvent(new MouseEvent("mouseup", o));
    t.dispatchEvent(new MouseEvent("click", o));
  };
  var shown = function () { var i = q(".sdoc-deck-ink"); return !!(i && i.classList.contains("is-shown") && getComputedStyle(q(".sdoc-deck-tools")).visibility === "visible"); };
  var inking = function () { return document.documentElement.classList.contains("sdoc-inking"); };
  var palAt = function () {
    return [].map.call(document.querySelectorAll(".sdoc-deck-tools .sdoc-ink-tools > *"), function (n) {
      var r = n.getBoundingClientRect();
      return n.className.split(" ").filter(function (c) { return c !== "is-on" && c !== "is-armed"; }).join(".").replace(/sdoc-(presenter|ink)-/g, "") +
        "@" + Math.round(r.left) + "," + Math.round(r.top) + "+" + Math.round(r.width) + "x" + Math.round(r.height);
    }).join(" ");
  };
  var toolOn = function () { var b = q(".sdoc-deck-tools .sdoc-ink-tool.is-on"); return b ? b.className.split(" ")[1].replace("is-", "") : null; };
  var strokes = function () { return [].map.call(slide().querySelectorAll(":scope > svg.sdoc-ink [data-ink=strokes] > [data-stroke]"), function (n) { return n.getAttribute("data-stroke"); }); };
  var frame = document.createElement("iframe");
  frame.style.cssText = "position:absolute;left:-20px;top:0;width:1px;height:1px;border:0";
  document.body.appendChild(frame);
  var got = [];
  // The window this deck opened, as far as it can tell.
  frame.contentWindow.opener = window;
  frame.contentWindow.addEventListener("message", function (e) { if (e.data && e.data.sdoc === "sdoc-presenter") got.push(JSON.parse(JSON.stringify(e.data))); });
  var fromP = function (msg) { msg.sdoc = "sdoc-presenter"; window.dispatchEvent(new MessageEvent("message", { data: msg, source: frame.contentWindow })); };
  var ink = function () { return got.filter(function (m) { return m.type === "ink"; }); };
  var g0 = 0;
  var since = function () { return wait(40).then(function () { var m = ink().slice(g0); g0 = ink().length; return m; }); };
  var said = function (msgs) { return msgs.map(function (m) { return m.op + (m.slide ? ":" + m.slide : "") + (m.ids ? "=" + m.ids.join(",") : "") + (m.strokes ? "=" + m.strokes.map(function (x) { return x.id; }).join(",") : ""); }); };
  async function run() {
    await wait(100);
    out.before = { ink: !!q(".sdoc-deck-ink"), inking: inking() };
    var W = slide().offsetWidth, H = slide().offsetHeight;
    out.design = { w: W, h: H };
    out.scale = slide().getBoundingClientRect().width / W;
    fromP({ type: "hello" });
    await until(function () { return got.some(function (m) { return m.type === "position"; }); }, 1000);
    got = [];
    var hash = location.hash;

    // C in a deck that has drawn nothing: the next colour, and no tool, so
    // a click still turns the slide.
    key("c");
    out.cKey = { shown: shown(), tool: toolOn(), inking: inking(), pen: [].map.call(document.querySelectorAll(".sdoc-deck-tools .sdoc-ink-swatch"), function (b) { return b.classList.contains("is-on"); }).join() };
    key("c"); key("c");
    // D: the palette, with the pen.
    key("d");
    out.dKey = { shown: shown(), tool: toolOn(), inking: inking() };
    out.layout = [palAt()];
    // A stroke on the slide itself, in its design pixels, sent as it goes.
    await trace([[0.25 * W, 0.85 * H], [0.75 * W, 0.85 * H]], 10);
    var mine = await since(), all = [];
    mine.forEach(function (m) { all = all.concat(m.stroke ? m.stroke.points : (m.points || [])); });
    var begin = mine.filter(function (m) { return m.op === "begin"; })[0];
    out.stroke = { ops: mine.map(function (m) { return m.op; }), id: begin ? begin.stroke.id : null, first: all[0], last: all[all.length - 1], here: strokes() };
    var path = begin && slide().querySelector(":scope > svg.sdoc-ink path[data-stroke='" + begin.stroke.id + "']"), bb = path && path.getBBox();
    out.stroke.bbox = bb ? { x: bb.x, y: bb.y, w: bb.width, h: bb.height } : null;
    // A click on the slide with a tool in hand draws, and turns nothing.
    clickAt(scr([0.8 * W, 0.5 * H]));
    await wait(100);
    out.clickKept = location.hash === hash;
    out.layout.push(palAt());
    // A press at the top edge with a tool in hand draws: it does not pull
    // the overview down.
    var overviewOpen = function () { return !!(window.sdocOverview && window.sdocOverview.isOpen()); };
    var n = strokes().length;
    pe("pointerdown", { x: innerWidth * 0.55, y: 2 });
    for (var i = 1; i <= 8; i++) pe("pointermove", { x: innerWidth * 0.55, y: 2 + i * 45 });
    pe("pointerup", { x: innerWidth * 0.55, y: 362 });
    await until(function () { return strokes().length > n; }, 1000);
    out.topEdge = { overview: overviewOpen(), drawn: strokes().length - n };
    // O still opens the overview, and Escape there closes it and leaves the
    // tool in hand.
    key("o");
    await until(overviewOpen, 1000);
    out.overviewKey = { open: overviewOpen() };
    key("Escape");
    await until(function () { return !overviewOpen(); }, 2500);
    out.overviewKey.closed = !overviewOpen();
    out.overviewKey.tool = toolOn();
    key("r");
    out.layout.push(palAt());
    // The highlighter snaps to the slide's own words.
    key("h");
    out.layout.push(palAt());
    await since();
    var qk = word("quick"), fx = word("fox"), y = qk.y + qk.h / 2;
    await trace([[qk.x + 0.2 * qk.w, y], [fx.x + 0.8 * fx.w, y]], 12);
    var rp = (await since()).filter(function (m) { return m.op === "replace"; })[0];
    out.snap = { rects: rp ? rp.stroke.rects : null, words: unionOf([qk, fx]) };

    // Undo takes this window's own last stroke, not the presenter's.
    fromP({ type: "ink", op: "begin", v: 1, stroke: { id: "pzz-1", slide: "1", tool: "pen", color: "#2b7cf6", size: 8, points: [[100, 100], [300, 120]] } });
    fromP({ type: "ink", op: "end", v: 2, id: "pzz-1" });
    out.withPresenters = strokes();
    key("u");
    out.undo = { here: strokes(), sent: said(await since()) };

    // At the presenter's Start: everything here, to the presenter.
    fromP({ type: "ink-sync" });
    out.sync = said(await since());

    // Escape puts the tool down, and a moment later the palette; then a
    // click turns the slide again.
    key("Escape");
    out.escape = { tool: toolOn(), inking: inking(), shownAtOnce: shown() };
    await until(function () { return !shown(); }, 3000);
    out.escape.later = shown();
    clickAt(scr([0.8 * W, 0.5 * H]));
    await until(function () { return location.hash !== hash; }, 1000);
    out.clickTurns = location.hash !== hash;
    await go("1");

    // Resting at the left edge brings it up again, where it was.
    pe("pointermove", { x: 2, y: innerHeight / 2 }, { hover: true });
    await wait(500);
    var early = shown();
    await wait(700);
    out.edge = { early: early, shown: shown(), tool: toolOn() };
    out.layout.push(palAt());
    // Clear all, asked twice, clears here and is sent.
    var ca = q(".sdoc-deck-tools .sdoc-ink-tool.is-clear-all");
    ca.click();
    out.clearOnce = { here: strokes().length, armed: ca.classList.contains("is-armed") };
    ca.click();
    out.clearAll = { here: strokes(), sent: said(await since()) };
  }
  function start() { run().catch(function (e) { out.__error = String((e && e.stack) || e); }).then(function () {
    var el = document.createElement("script");
    el.type = "application/json";
    el.id = "sdoc-deck-ink";
    el.textContent = JSON.stringify(out) + "\\n/*${SENTINEL}*/";
    document.body.appendChild(el);
  }); }
  if (document.readyState === "complete") start(); else window.addEventListener("load", start);
})();
`;

test("drawing in the deck's own window: its palette, its slide, and the presenter window (browser)", async () => {
  browser.skip();
  const r = await runHarvest(presenterPage(SNAP_DECK), DECK_INK_DRIVE, "sdoc-deck-ink");
  // First, as a slide that turned would derail everything after it.
  assert(r.clickKept !== false, "a click on the slide with a tool in hand does not turn it");
  assert(!r.__error, "the drive threw: " + r.__error);
  const W = r.design.w, H = r.design.h, u = W / 1280;
  const near = (a, b, t) => Math.abs(a - b) <= t;
  const show = (v) => JSON.stringify(v);
  assert(!r.before.ink && !r.before.inking, "nothing of the tools is in the page until they are wanted: " + show(r.before));
  assert(Math.abs(r.scale - 1) > 0.05, "the slide is drawn at another scale than its design box: " + r.scale);
  assert(r.cKey.shown && r.cKey.tool === "pointer" && !r.cKey.inking && r.cKey.pen === "false,true,false",
    "C shows the next pen colour and picks up no tool: " + show(r.cKey));
  assert(r.dKey.shown && r.dKey.tool === "pen" && r.dKey.inking, "D brings up the palette with the pen in hand: " + show(r.dKey));
  const s = r.stroke;
  assert(s.ops[0] === "begin" && s.ops[s.ops.length - 1] === "end" && /^d/.test(s.id) && s.here.includes(s.id),
    "a stroke drawn on the slide is kept there and sent to the presenter window, named as this window's: " + show(s));
  assert(near(s.first[0], 0.25 * W, 2) && near(s.first[1], 0.85 * H, 2) && near(s.last[0], 0.75 * W, 2),
    "its points in the slide's design pixels: " + show([s.first, s.last]) + " on " + W + "x" + H);
  assert(s.bbox && near(s.bbox.x + s.bbox.w / 2, 0.5 * W, 6) && near(s.bbox.y + s.bbox.h / 2, 0.85 * H, 4), "drawn there: " + show(s.bbox));
  assert(r.clickKept, "a click on the slide with a tool in hand does not turn it");
  assert(!r.topEdge.overview && r.topEdge.drawn === 1, "a drag down from the top edge draws, and pulls nothing down: " + show(r.topEdge));
  assert(r.overviewKey.open && r.overviewKey.closed && r.overviewKey.tool === "pen",
    "O still opens the overview, and its Escape leaves the tool in hand: " + show(r.overviewKey));
  assert(r.layout.every((l) => l === r.layout[0]), "the palette keeps its place whatever is chosen or shown:\n  " + r.layout.join("\n  "));
  const grow = (b, p) => ({ x: b.x - p, y: b.y - p, w: b.w + 2 * p, h: b.h + 2 * p });
  const want = grow(r.snap.words, 2 * u);
  assert(r.snap.rects && ["x", "y", "w", "h"].every((k) => near(r.snap.rects[0][k], want[k], 1.5)),
    "the highlighter snaps to the slide's own words: " + show(r.snap.rects) + " against " + show(want));
  assert(r.withPresenters.includes("pzz-1") && !r.undo.here.includes(r.undo.sent.join().split("=")[1]) && r.undo.here.includes("pzz-1") &&
    r.undo.sent.length === 1 && /^remove:1=d/.test(r.undo.sent[0]), "U undoes this window's last stroke, not the presenter's: " + show(r.undo));
  assert(r.sync[0] === "clear" && r.sync.length === 2 && r.sync[1].startsWith("slide:1=") && r.sync[1].includes("pzz-1"),
    "asked at Start, it sends the presenter everything it holds: " + show(r.sync));
  assert(r.escape.tool === "pointer" && !r.escape.inking && r.escape.shownAtOnce && !r.escape.later,
    "Escape puts the tool down, and the palette goes a moment later: " + show(r.escape));
  assert(r.clickTurns, "then a click turns the slide again");
  assert(r.edge.shown && r.edge.tool === "pointer", "resting the pointer at the left edge brings the palette back: " + show(r.edge));
  assert(!r.edge.early, "but not at once: a pointer passing the edge, or pushed there out of the way, does not bring it up");
  assert(r.clearOnce.armed && r.clearOnce.here > 0 && r.clearAll.here.length === 0 && r.clearAll.sent.join() === "clear",
    "Clear all asks first, then clears here and in the presenter window: " + show([r.clearOnce, r.clearAll]));
});

// The presenter window's side of the deck's ink: private before Start, the
// deck's at Start, and both ways after it.
const PRESENTER_DECK_INK_DRIVE = `
(function () {
  var out = {};
  ${DRIVE_HELPERS}
  ${INK_HELPERS}
  var deckStroke = function (id, y) { return { id: id, slide: "1", tool: "pen", color: "#16a34a", size: 8, points: [[200, y], [900, y]] }; };
  async function run() {
    await until(function () { return !!copy(); }, 4000);
    await still();
    from({ type: "position", position: "1" });
    // Before Start: the deck's ink is not shown here, and this window's is
    // its own.
    from({ type: "ink", op: "begin", v: 1, stroke: deckStroke("dab-1", 300) });
    from({ type: "ink", op: "end", v: 2, id: "dab-1" });
    out.privateDeck = here();
    key("d");
    await drag([0.2, 0.6], [0.6, 0.6]);
    out.rehearsal = { here: here(), sent: sent("ink").length };
    // Start: the rehearsal goes, and the deck is asked for its ink.
    q(".sdoc-presenter-start").click();
    await until(started, 1000);
    out.started = { here: here(), sync: sent("ink-sync").length, ink: sent("ink").length };
    from({ type: "ink", op: "clear", v: 3 });
    from({ type: "ink", op: "slide", v: 4, slide: "1", strokes: [deckStroke("dab-1", 300)] });
    out.snapshot = here();
    // After it, both ways.
    from({ type: "ink", op: "begin", v: 5, stroke: deckStroke("dab-2", 500) });
    from({ type: "ink", op: "add", v: 6, id: "dab-2", points: [[1000, 520]] });
    from({ type: "ink", op: "end", v: 7, id: "dab-2" });
    out.live = here();
    var n0 = sent("ink").length;
    await drag([0.2, 0.8], [0.6, 0.8]);
    var mine = sent("ink").slice(n0), b = mine.filter(function (m) { return m.op === "begin"; })[0];
    out.drawn = { ops: mine.map(function (m) { return m.op; }), id: b ? b.stroke.id : null, here: here() };
    // Undo takes this window's own, and then has nothing more to take.
    n0 = sent("ink").length;
    key("u");
    out.undo = { here: here(), ops: ops(sent("ink").slice(n0)), disabled: q(".sdoc-ink-tool.is-undo").disabled };
    key("u");
    out.undoAgain = { here: here(), ops: ops(sent("ink").slice(n0)) };
    // Clear clears the deck's strokes too, in both windows.
    q(".sdoc-ink-tool.is-clear").click();
    out.cleared = { here: here(), ops: ops(sent("ink").slice(n0)) };
  }
  function start() { run().catch(function (e) { out.__error = String((e && e.stack) || e); }).then(function () { reportAs("sdoc-presenter-deck-ink", out); }); }
  if (document.readyState === "complete") start(); else window.addEventListener("load", start);
})();
`;

test("the presenter window takes the deck's ink at Start, and both draw for both after it (browser)", async () => {
  browser.skip();
  const r = await runHarvest(presenterPage(PRESENTER_DECK, { opener: true }), PRESENTER_DECK_INK_DRIVE, "sdoc-presenter-deck-ink", AS_PRESENTER);
  assert(!r.__error, "the drive threw: " + r.__error);
  const show = (v) => JSON.stringify(v);
  assert(r.privateDeck.length === 0, "before Start the deck's ink is not shown here: " + r.privateDeck);
  assert(r.rehearsal.here.length === 1 && /^p/.test(r.rehearsal.here[0]) && r.rehearsal.sent === 0,
    "and this window's is its own, named as this window's, and sent nowhere: " + show(r.rehearsal));
  assert(r.started.here.length === 0 && r.started.sync === 1 && r.started.ink === 0,
    "Start throws the rehearsal away, and asks the deck for its ink instead of clearing it: " + show(r.started));
  assert(r.snapshot.join() === "dab-1", "the deck's ink, sent back, is shown here: " + r.snapshot);
  assert(r.live.join() === "dab-1,dab-2", "and so is what the deck draws after Start, as it is drawn: " + r.live);
  assert(/^p/.test(r.drawn.id) && r.drawn.ops[0] === "begin" && r.drawn.here.join() === "dab-1,dab-2," + r.drawn.id,
    "what this window draws after Start goes to the deck: " + show(r.drawn));
  assert(r.undo.here.join() === "dab-1,dab-2" && r.undo.ops.join() === "remove:1=" + r.drawn.id && r.undo.disabled,
    "Undo takes this window's own stroke, and is then disabled: " + show(r.undo));
  assert(r.undoAgain.here.join() === "dab-1,dab-2" && r.undoAgain.ops.length === 1, "and does not take the deck's: " + show(r.undoAgain));
  assert(r.cleared.here.length === 0 && r.cleared.ops[r.cleared.ops.length - 1] === "clear:1", "Clear clears both windows' ink: " + show(r.cleared));
});

// The deck's side: ink messages drawn on its own slides.
const AUDIENCE_INK_DRIVE = `
(function () {
  var out = {};
  ${DRIVE_HELPERS}
  var heard = [];
  peer().addEventListener("message", function (e) { if (e.data && e.data.sdoc === "sdoc-presenter") heard.push(e.data); });
  var slide = function () { return document.querySelector("body > .slide.active"); };
  var layer = function () { return slide().querySelector(":scope > svg.sdoc-ink"); };
  var ids = function () { var l = layer(); return l ? [].map.call(l.querySelectorAll("path[data-stroke]"), function (p) { return p.getAttribute("data-stroke"); }) : []; };
  function report() {
    var el = document.createElement("script");
    el.type = "application/json";
    el.id = "sdoc-audience-ink";
    el.textContent = JSON.stringify(out) + "\\n/*${SENTINEL}*/";
    document.body.appendChild(el);
  }
  async function run() {
    out.before = document.querySelectorAll("svg.sdoc-ink").length;
    var W = slide().offsetWidth, H = slide().offsetHeight;
    out.design = { w: W, h: H };
    out.scale = slide().getBoundingClientRect().width / W;
    from({ type: "hello", ink: 0 });
    // A stroke a quarter to three quarters across, half way down, in pieces.
    from({ type: "ink", op: "begin", v: 1, stroke: { id: "s1", slide: "1", tool: "pen", color: "#2b7cf6", size: 8, points: [[W / 4, H / 2], [W * 0.35, H / 2]] } });
    out.begun = ids();
    from({ type: "ink", op: "add", v: 2, id: "s1", points: [[W / 2, H / 2], [W * 0.6, H / 2]] });
    from({ type: "ink", op: "add", v: 3, id: "s1", points: [[W * 0.75, H / 2]] });
    from({ type: "ink", op: "end", v: 4, id: "s1" });
    var p = layer().querySelector("path[data-stroke='s1']");
    var bb = p.getBBox();
    out.bbox = { x: bb.x, y: bb.y, w: bb.width, h: bb.height };
    out.fill = p.getAttribute("fill");
    out.viewBox = layer().getAttribute("viewBox");
    var sr = slide().getBoundingClientRect(), lr = layer().getBoundingClientRect(), pr = p.getBoundingClientRect();
    out.cover = [lr.left - sr.left, lr.top - sr.top, lr.width - sr.width, lr.height - sr.height];
    out.onScreen = { left: (pr.left - sr.left) / sr.width, right: (pr.right - sr.left) / sr.width, mid: ((pr.top + pr.bottom) / 2 - sr.top) / sr.height };
    out.z = getComputedStyle(layer()).zIndex;
    out.events = getComputedStyle(layer()).pointerEvents;

    // A highlighter here, and a stroke on another slide.
    from({ type: "ink", op: "begin", v: 5, stroke: { id: "s2", slide: "1", tool: "highlighter", size: 36, points: [[W / 4, H / 4], [W / 2, H / 4]] } });
    from({ type: "ink", op: "end", v: 6, id: "s2" });
    from({ type: "ink", op: "begin", v: 7, stroke: { id: "s3", slide: "3", tool: "pen", color: "#ef3434", size: 8, points: [[100, 100], [300, 300]] } });
    from({ type: "ink", op: "end", v: 8, id: "s3" });
    out.onOne = ids();
    var hp = layer().querySelector("path[data-stroke='s2']");
    out.highlight = hp ? hp.getAttribute("fill-opacity") : null;
    out.highlightFill = hp ? hp.getAttribute("fill") : null;
    await go("3");
    out.onThree = ids();
    await go("1");
    out.backOnOne = ids();
    from({ type: "ink", op: "remove", v: 9, slide: "1", ids: ["s2"] });
    out.removed = ids();

    // The laser: a dot where it points, gone on off.
    from({ type: "laser", slide: "1", points: [[W / 2, H / 3]] });
    await until(function () { return !!layer().querySelector("[data-ink=laser] circle:last-child"); }, 1000);
    var dot = layer().querySelector("[data-ink=laser] circle:last-child");
    out.laser = dot ? [parseFloat(dot.getAttribute("cx")), parseFloat(dot.getAttribute("cy"))] : null;
    from({ type: "laser", off: true });
    out.laserGone = !document.querySelector("[data-ink=laser]");

    // Answering a hello, and reporting a move, it says which page load
    // this is: the same one each time.
    heard = [];
    from({ type: "hello" });
    await until(function () { return heard.some(function (m) { return m.type === "position"; }); }, 1000);
    await go("3");
    await until(function () { return heard.filter(function (m) { return m.type === "position"; }).length > 1; }, 1000);
    await go("1");
    out.loads = heard.filter(function (m) { return m.type === "position"; }).map(function (m) { return m.deck; });

    // Everything again, after a reload: a clear, then each slide's ink.
    from({ type: "ink", op: "clear", v: 10 });
    from({ type: "ink", op: "slide", v: 11, slide: "1", strokes: [{ id: "s7", slide: "1", tool: "pen", color: "#16a34a", size: 8, points: [[10, 10], [200, 10]] }] });
    out.resent = ids();
    await go("3");
    out.resentThree = ids();
    await go("1");
    from({ type: "ink", op: "clear", v: 12, slide: "1" });
    out.cleared = ids();
    // A highlight in the colour it was drawn in.
    from({ type: "ink", op: "begin", v: 13, stroke: { id: "s9", slide: "1", tool: "highlighter", color: "#5cc8ff", size: 36, points: [[10, 10], [200, 10]] } });
    var cp = layer().querySelector("path[data-stroke='s9']");
    out.colouredFill = cp ? cp.getAttribute("fill") : null;
  }
  function start() { run().catch(function (e) { out.__error = String((e && e.stack) || e); }).then(report); }
  if (document.readyState === "complete") start(); else window.addEventListener("load", start);
})();
`;

test("the deck draws the presenter's ink on its own slides, in design pixels (browser)", async () => {
  browser.skip();
  // A 1280x720 design box in a window about 1920 wide, so the deck is drawn
  // larger than its design box, and design pixels are not screen pixels.
  const file = presenterPage(PRESENTER_DECK, { themeConfig: { slide: { width: 1280, height: 720 } } });
  const r = await runHarvest(file, AUDIENCE_INK_DRIVE, "sdoc-audience-ink");
  assert(!r.__error, "the drive threw: " + r.__error);
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  const W = r.design.w, H = r.design.h;
  assert(W === 1280 && H === 720 && r.scale > 1.2, "the deck is drawn larger than its design box: " + W + "x" + H + " at " + r.scale);
  assert(r.before === 0, "no overlay until there is ink");
  assert(r.begun.join() === "s1", "a stroke shows as soon as it begins: " + r.begun);
  assert(r.viewBox === "0 0 " + W + " " + H, "the overlay's viewBox is the design box: " + r.viewBox);
  assert(r.cover.every((d) => Math.abs(d) < 1), "and it covers the slide exactly: " + r.cover);
  const b = r.bbox;
  assert(near(b.x, W / 4, 8) && near(b.x + b.w, W * 0.75, 8) && near(b.y + b.h / 2, H / 2, 3) && b.h <= 14,
    "the path lands where its points say, in design pixels: " + JSON.stringify(b) + " on " + W + "x" + H);
  assert(near(r.onScreen.left, 0.25, 0.01) && near(r.onScreen.right, 0.75, 0.01) && near(r.onScreen.mid, 0.5, 0.01),
    "and on screen, scaled with the slide: " + JSON.stringify(r.onScreen));
  assert(r.fill === "#2b7cf6", "in its colour: " + r.fill);
  assert(r.events === "none" && parseInt(r.z, 10) >= 1000, "above the content and never in the way of a click: " + r.z + " " + r.events);
  assert(r.onOne.join() === "s1,s2" && r.highlight === "0.4", "a translucent highlighter beside it: " + r.onOne + " " + r.highlight);
  assert(r.onThree.join() === "s3" && r.backOnOne.join() === "s1,s2", "each slide keeps its own ink across moves: " + r.onThree + " / " + r.backOnOne);
  assert(r.removed.join() === "s1", "a removed stroke goes: " + r.removed);
  assert(r.laser && near(r.laser[0], W / 2, 0.5) && near(r.laser[1], H / 3, 0.5), "the laser's dot is where it points: " + r.laser);
  assert(r.laserGone, "and goes when it is put away");
  assert(r.loads.length >= 2 && typeof r.loads[0] === "string" && r.loads[0].length >= 6 && r.loads.every((l) => l === r.loads[0]),
    "every position it sends names this page load, the same each time: " + JSON.stringify(r.loads));
  assert(r.resent.join() === "s7" && r.resentThree.length === 0, "a resend replaces everything: " + r.resent + " / " + r.resentThree);
  assert(r.cleared.length === 0, "and a clear of one slide clears it: " + r.cleared);
  assert(r.highlightFill === "#ffd60a" && r.colouredFill === "#5cc8ff",
    "a highlight is yellow when it says no colour, and in its own when it does: " + r.highlightFill + " " + r.colouredFill);
});

// ============================================================
console.log("\n--- Deck-scoped stylesheet ---");

test("a deck's own stylesheet is emitted after the theme's", () => {
  // A theme is shared by every deck built from it, so a deck that wants one
  // slide to differ has nowhere to put that rule. Emitting it last lets it
  // settle a tie on source order rather than by raising specificity.
  const html = parseAndRender("# Deck {\n    # Slide {\n        Body.\n    }\n}", {
    themeCss: ".slide { color: rebeccapurple }",
    deckCss: "/* deck.css */\n#slide h2 { color: teal }",
  });
  const theme = html.indexOf("rebeccapurple");
  // Found by its rule: comments are stripped from the built page.
  const deck = html.indexOf("color: teal");
  assert(theme > 0 && deck > 0, "both stylesheets present");
  assert(deck > theme, "the deck's sheet comes after the theme's");
  assert(deck < html.indexOf("</style>"), "and inside the style tag");
});

test("a deck with no stylesheet of its own is unchanged", () => {
  const html = parseAndRender("# Deck {\n    # Slide {\n        Body.\n    }\n}");
  // Outside the runtimes, whose JavaScript may say undefined and mean it.
  assert(!markupOf(html).includes("undefined"), "no stray value where the sheet would be");
});

test("style-append: is read off the meta the parser already provides", () => {
  // Not a new key: src/sdoc.js has always parsed `style-append:` and the VS
  // Code preview has always honoured it for documents. Slides never read it,
  // which is the gap — adding a second key meaning the same thing would have
  // been the wrong fix.
  const { parseSdoc, extractMeta } = require("../src/sdoc.js");
  const src = "# D {\n    @meta\n    {\n        type: slides\n\n        style-append: deck.css\n    }\n\n    # S {\n        Body.\n    }\n}";
  const { meta } = extractMeta(parseSdoc(src).nodes);
  assert(meta.styleAppendPath === "deck.css", "styleAppendPath: " + meta.styleAppendPath);
  assert(meta.properties.css === undefined, "no separate css: key was invented");
});

// ============================================================
console.log("\n--- Case-sensitive units ---");

function marks(text) {
  return renderInline(text).replace(/<span class="sdoc-unit">([^<]*)<\/span>/g, "[$1]");
}

test("a unit whose case carries meaning is marked", () => {
  // The bug this exists for: a theme uppercasing a kicker turns 40 mW into
  // 40 MW, a factor of a billion, silently.
  assert(marks("40 mW") === "40 [mW]", "milliwatts: " + marks("40 mW"));
  assert(marks("3.3 kV") === "3.3 [kV]", "kilovolts");
  assert(marks("500 ms") === "500 [ms]", "milliseconds");
  assert(marks("2 kWh") === "2 [kWh]", "kilowatt hours");
  assert(marks("12 µs") === "12 [µs]", "microseconds");
  assert(marks("100 mol") === "100 [mol]", "moles");
  assert(marks("40uW") === "40[uW]", "no space needed");
});

test("megabits and megabytes stay different after folding", () => {
  assert(marks("8 Mb") === "8 [Mb]", "the bit is protected");
  assert(marks("8 MB") === "8 MB", "the byte needs no protection");
});

test("a unit already in capitals is not marked", () => {
  // Uppercasing cannot hurt it, and a span would only fragment the text run
  // the exporter measures.
  assert(marks("1 MW") === "1 MW", "megawatts");
  assert(marks("3 GB") === "3 GB", "gigabytes");
  assert(marks("10 Hz") === "10 [Hz]", "but a mixed-case one is");
});

test("ordinary words after a number are left alone", () => {
  // A rule like "any short token after a number" would protect these and stop
  // a deck's kickers uppercasing at all.
  for (const text of [
    "9 am", "3 pm", "flight 5 at noon", "7 as planned",
    "5 Watts", "4 Mandatory fields", "Section 3 A", "we raised 5 M in 2019",
  ]) {
    assert(marks(text) === text, "left alone: " + text + " -> " + marks(text));
  }
});

test("the mark survives into a slide and the stylesheet opts it out", () => {
  const html = parseAndRender("# Deck {\n    # Slide {\n        kicker: measured at 40 mW\n\n        Body.\n    }\n}");
  assert(html.includes(".sdoc-unit { text-transform: none; }"), "the opt-out ships with every deck");
  const body = html.slice(html.indexOf("<body"));
  assert(body.includes('<span class="sdoc-unit">mW</span>'), "marked inside the kicker");
});

// ============================================================
console.log("\n--- Background images ---");

// Just the markup. The structural stylesheet names .slide-bg, transform and
// slide-content-scale too, so a bare includes() on the whole document would
// match the CSS and pass whatever the renderer did.
// The slide markup only. A runtime shipped beside it may well say "transform"
// or "scale(" — the overview's does — and that is not the slide asking for one.
function bgSlide(lines) {
  const html = parseAndRender(`# Deck {\n    # Slide {\n${lines}\n\n        Body copy.\n    }\n}`);
  return markupOf(html.slice(html.indexOf("<body")));
}

test("background: emits an img behind the content", () => {
  const html = bgSlide("        background: photo.png");
  assert(html.includes('class="slide-bg"'), "wrapper emitted");
  assert(html.includes('<img src="photo.png"'), "a real img, so it embeds and exports");
  // Before .slide-content-scale: the harvest reads atoms in DOM order, and the
  // picture has to land at the bottom of the z-order in the .pptx.
  assert(
    html.indexOf('class="slide-bg"') < html.indexOf("slide-content-scale"),
    "background precedes the content"
  );
});

test("a slide with no background emits no wrapper", () => {
  assert(!bgSlide("        kicker: THINGS").includes("slide-bg"), "nothing emitted");
});

test("position and size become object-position and object-fit", () => {
  const html = bgSlide("        background: photo.png\n\n        background-position: right center\n\n        background-size: contain");
  assert(html.includes("object-position:right center"), "position applied");
  assert(html.includes("object-fit:contain"), "size applied");
});

test("size falls back to cover when the word is not one it knows", () => {
  const html = bgSlide("        background: photo.png\n\n        background-size: enormous");
  assert(html.includes("object-fit:cover"), "unknown fit ignored");
});

test("a linear fade becomes a mask on the wrapper, not on the image", () => {
  const html = bgSlide("        background: photo.png\n\n        background-fade: linear angle=90 from=30% to=85% max=0.2");
  assert(html.includes("linear-gradient(90deg, rgba(0,0,0,0.2) 30%, rgba(0,0,0,0) 85%)"), "gradient built");
  // On the wrapper: a transform carries the element's own mask with it, so a
  // fade on the image would mirror the moment the picture was flipped.
  const wrapper = html.slice(html.indexOf('class="slide-bg"'), html.indexOf("<img"));
  assert(wrapper.includes("mask-image"), "the mask sits on the wrapper");
});

test("a radial fade takes a centre, and radius means the same as to", () => {
  const byRadius = bgSlide("        background: photo.png\n\n        background-fade: radial at=80%,30% from=5% radius=55%");
  const byTo = bgSlide("        background: photo.png\n\n        background-fade: radial at=80%,30% from=5% to=55%");
  assert(byRadius.includes("radial-gradient(circle at 80% 30%, rgba(0,0,0,1) 5%, rgba(0,0,0,0) 55%)"), "radial built");
  assert(
    byRadius.slice(byRadius.indexOf("slide-bg")) === byTo.slice(byTo.indexOf("slide-bg")),
    "radius and to are the same setting"
  );
});

test("fade settings are order-free and an unknown one is ignored", () => {
  const a = bgSlide("        background: photo.png\n\n        background-fade: linear from=20% angle=45 max=0.5");
  const b = bgSlide("        background: photo.png\n\n        background-fade: linear max=0.5 angle=45 from=20%");
  const c = bgSlide("        background: photo.png\n\n        background-fade: linear angle=45 from=20% max=0.5 wobble=9");
  assert(a.includes("linear-gradient(45deg, rgba(0,0,0,0.5) 20%"), "built as written");
  assert(a.slice(a.indexOf("slide-bg")) === b.slice(b.indexOf("slide-bg")), "order does not matter");
  assert(a.slice(a.indexOf("slide-bg")) === c.slice(c.indexOf("slide-bg")), "an unknown setting is ignored");
});

test("a fade with no shape word is not a fade", () => {
  const html = bgSlide("        background: photo.png\n\n        background-fade: quite a lot");
  assert(!html.includes("mask-image"), "nothing masked");
});

test("a flip mirrors the placement so the image stays where it was put", () => {
  const html = bgSlide("        background: photo.png\n\n        background-position: right center\n\n        background-flip: horizontal");
  // Placed left and reflected about the slide centre, which lands it on the
  // right. Reflecting about the right edge instead would throw it off the
  // slide entirely: the image lies inside that edge, so its mirror lies
  // outside the box and is clipped away to nothing.
  assert(html.includes("object-position:left center"), "placement mirrored");
  assert(html.includes('class="slide-bg-flip" style="transform:scale(-1,1)"'), "reflected on its own element");
});

test("a mirrored percentage position reflects about the middle", () => {
  const html = bgSlide("        background: photo.png\n\n        background-position: 20% 70%\n\n        background-flip: both");
  assert(html.includes("object-position:80% 30%"), "both axes mirrored");
  assert(html.includes("transform:scale(-1,-1)"), "reflected on both axes");
});

test("a lone vertical keyword keeps its axis", () => {
  const html = bgSlide("        background: photo.png\n\n        background-position: top\n\n        background-flip: vertical");
  assert(html.includes("object-position:center bottom"), "top is a y, not an x");
  assert(html.includes("transform:scale(1,-1)"), "y only");
});

test("scale is anchored where the image sits, and survives a flip", () => {
  const plain = bgSlide("        background: photo.png\n\n        background-position: right center\n\n        background-scale: 0.6");
  assert(plain.includes("transform-origin:right center"), "anchored where it was placed");
  assert(plain.includes("transform:scale(0.6)"), "scaled");

  // With a flip the image is placed left, so the scale anchors there — and the
  // reflection carries both back to the right.
  const flipped = bgSlide("        background: photo.png\n\n        background-position: right center\n\n        background-flip: horizontal\n\n        background-scale: 0.6");
  assert(flipped.includes("transform-origin:left center"), "anchor follows the mirrored placement");
  assert(flipped.includes("slide-bg-flip"), "flip stays a separate element");
});

test("the fade never sits on the flipped element", () => {
  const html = bgSlide("        background: photo.png\n\n        background-flip: horizontal\n\n        background-fade: linear angle=90 from=20% to=80%");
  const wrapper = html.slice(html.indexOf('class="slide-bg"'), html.indexOf("slide-bg-flip"));
  assert(wrapper.includes("mask-image"), "fade on the outer wrapper");
  // Otherwise a fade protecting text on the left would mirror to the right.
  const flipEl = html.slice(html.indexOf("slide-bg-flip"), html.indexOf("<img"));
  assert(!flipEl.includes("mask-image"), "fade does not move with the picture");
});

test("no transform is emitted when nothing asks for one", () => {
  const html = bgSlide("        background: photo.png");
  assert(!html.includes("transform"), "left alone");
  assert(!html.includes("slide-bg-flip"), "no flip element either");
});

test("scale accepts a percentage as well as a multiplier", () => {
  assert(bgSlide("        background: photo.png\n\n        background-scale: 60%").includes("transform:scale(0.6)"), "percentage");
});

test("a background: line that is prose stays prose", () => {
  // The one key here whose name is also an ordinary sentence opener. Taking it
  // would delete the sentence and then try to load it as a picture.
  const html = bgSlide("        background: we started in 2019 with three people.");
  assert(!html.includes("slide-bg"), "no picture invented");
  assert(html.includes("we started in 2019"), "the sentence survives");
});

test("background-flip only takes the line for a word it knows", () => {
  const html = bgSlide("        background: photo.png\n\n        background-flip: the chart was mirrored by mistake.");
  assert(html.includes("the chart was mirrored by mistake"), "the sentence survives");
  assert(!html.includes("transform:scale"), "no flip applied");
});

test("a two-value size sizes the image's own box", () => {
  // No fit keyword says "full height, natural width": cover crops a wide image
  // and contain fits it by width.
  const html = bgSlide("        background: photo.png\n\n        background-size: auto 100%\n\n        background-position: right center");
  assert(html.includes("width:auto;height:100%"), "the pair becomes the box");
  assert(!html.includes("object-fit"), "nothing left for object-fit to decide");
  // Placed by the background-position rule: the point P% across the image is
  // laid against the point P% across the slide.
  assert(html.includes("left:100%;top:50%"), "right centre as percentages");
  assert(html.includes("transform:translate(-100%,-50%)"), "and the matching offset");
});

test("a scale folds into a sized box instead of becoming a transform", () => {
  const html = bgSlide("        background: photo.png\n\n        background-size: auto 100%\n\n        background-scale: 0.5");
  assert(html.includes("height:50%"), "the measurable half halves");
  assert(html.includes("width:auto"), "auto still follows the aspect ratio");
  assert(!html.includes("scale("), "no transform to reconcile with the offset");
});

test("a sized background still flips back to where it was asked for", () => {
  const html = bgSlide("        background: photo.png\n\n        background-size: auto 100%\n\n        background-position: right center\n\n        background-flip: horizontal");
  assert(html.includes("left:0%"), "placed at the mirror");
  assert(html.includes('class="slide-bg-flip" style="transform:scale(-1,1)"'), "reflected back to the right");
});

test("a lone size value is not a pair and leaves the keyword path alone", () => {
  // A lone percentage would mean what background-scale already means.
  const html = bgSlide("        background: photo.png\n\n        background-size: 50%");
  assert(html.includes("object-fit:cover"), "falls back to the default fit");
  assert(!html.includes("position:absolute"), "not the sized path");
});

test("a size pair that is not lengths stays out of the style attribute", () => {
  const html = bgSlide("        background: photo.png\n\n        background-size: rather large");
  assert(html.includes("object-fit:cover"), "not treated as a pair");
});

test("a background path is embedded against the sdoc like any other image", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-bg-"));
  // A 1x1 GIF, so the test owns its fixture rather than reaching for one.
  fs.writeFileSync(path.join(dir, "dot.gif"), Buffer.from("R0lGODlhAQABAAAAACw=", "base64"));
  const html = bgSlide("        background: dot.gif");
  const { html: inlined, missing } = inlineDeckImages(html, dir);
  assert(missing.length === 0, "resolved against the base dir");
  assert(inlined.includes("data:image/gif;base64,"), "embedded in the deck");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ============================================================
console.log("\n--- Baking a background fade for export ---");

const { hasFades } = require("../src/slide-fade-bake.js");

test("a fade carries its parsed spec in the markup, for the export to bake from", () => {
  const html = bgSlide(
    "        background: photo.png\n\n        background-fade: linear angle=200 from=10% to=60% max=0.7"
  );
  assert(html.includes("mask-image:"), "the CSS mask is still what a browser renders");
  const m = /data-fade="([^"]*)"/.exec(html);
  assert(m, "the spec travels with the slide");
  const spec = JSON.parse(m[1].replace(/&quot;/g, '"'));
  // Read back out of the computed mask-image instead, and this is lost: Chrome
  // normalises the gradient and drops an angle of 180deg altogether, it being
  // the default `to bottom`.
  assert(spec.shape === "linear" && spec.angle === 200, "shape and angle survive");
  assert(spec.from === 10 && spec.to === 60 && spec.max === 0.7, "stops and alpha survive");
});

test("a background with no fade carries no spec and needs no browser", () => {
  const html = bgSlide("        background: photo.png");
  assert(!html.includes("data-fade="), "nothing to bake");
  assert(!hasFades(html), "so the export does not launch Chrome for it");
});

test("hasFades sees a deck that needs baking", () => {
  const html = bgSlide(
    "        background: photo.png\n\n        background-fade: linear angle=90 from=25% to=85%"
  );
  assert(hasFades(html), "a fade is work for the export");
});

test("a baked slide drops the mask and every placement rule it already contains", () => {
  const parsed = parseSdoc(
    "# Deck {\n    # Slide {\n        background: photo.png\n\n" +
    "        background-size: contain\n\n        background-position: right bottom\n\n" +
    "        background-flip: horizontal\n\n        background-fade: linear angle=90 from=25% to=85%\n\n" +
    "        Body copy.\n    }\n}"
  );
  assert(parsed.errors.length === 0, "fixture parses");
  const { nodes, meta } = extractMeta(parsed.nodes);
  const baked = renderSlides(nodes, {
    meta,
    bakedFades: { 0: "data:image/jpeg;base64,BAKED" },
  });
  const body = markupOf(baked.slice(baked.indexOf("<body")));
  assert(body.includes("data:image/jpeg;base64,BAKED"), "the baked picture is used");
  // Each of these is already in the baked pixels. Emitting any of them again
  // would apply it twice — the fade doubled, the picture flipped back.
  assert(!body.includes("mask-image:"), "no mask survives into the export");
  assert(!body.includes("data-fade="), "nothing left to bake");
  assert(!body.includes("slide-bg-flip"), "the flip is in the pixels");
  assert(!body.includes("object-fit:contain"), "the fit is in the pixels");
  assert(!/<div class="slide-bg"[^>]*style=/.test(body), "the wrapper carries no mask style");
});

test("an unbaked slide in the same deck keeps its own mask", () => {
  const parsed = parseSdoc(
    "# Deck {\n    # One {\n        background: a.png\n\n" +
    "        background-fade: linear angle=90 from=25% to=85%\n\n        Body.\n    }\n" +
    "    # Two {\n        background: b.png\n\n" +
    "        background-fade: linear angle=90 from=25% to=85%\n\n        Body.\n    }\n}"
  );
  const { nodes, meta } = extractMeta(parsed.nodes);
  // Only the first slide baked, as happens when one slide's image fails to load.
  const html = renderSlides(nodes, { meta, bakedFades: { 0: "data:image/jpeg;base64,BAKED" } });
  const body = markupOf(html.slice(html.indexOf("<body")));
  assert(body.includes("BAKED"), "the baked slide uses its picture");
  assert(body.includes('<img src="b.png"'), "the other slide is untouched");
  assert((body.match(/mask-image:/g) || []).length >= 1, "and keeps its mask");
});

// A graphics-state soft mask is what a CSS mask becomes in Chrome's PDF, and
// what Quartz draws as a hard edge. It has to be counted by inflating the
// streams: pdfimages and friends list only image-level /SMask entries and are
// blind to these, which is how the bug survived — a deck full of them lists as
// two ordinary JPEGs.
function gsSoftMasks(pdfPath) {
  const zlib = require("zlib");
  const raw = fs.readFileSync(pdfPath);
  const latin = raw.toString("latin1");
  const blobs = [Buffer.from(latin, "latin1")];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(latin)) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) continue;
    try { blobs.push(zlib.inflateSync(raw.subarray(start, end))); } catch { /* not flate */ }
  }
  return (Buffer.concat(blobs).toString("latin1").match(/\/SMask\s*<</g) || []).length;
}

test("baking a fade removes the soft mask Preview renders wrong (integration)", async () => {
  const { exportSlidePdf } = require("../src/slide-pdf");
  browser.skip();
  const { bakeFades } = require("../src/slide-fade-bake.js");
  const themeCss = fs.readFileSync(
    path.join(__dirname, "..", "themes", "default", "theme.css"), "utf-8"
  );

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-bake-"));
  fs.writeFileSync(path.join(dir, "pic.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAAEAQMAAACTPww9AAAABlBMVEUzZsz///8N3jmNAAAAC0lEQVQI12BggAAAAAgAAS8g3TEAAAAASUVORK5CYII=", "base64"));

  const parsed = parseSdoc(
    "# Deck {\n    # Slide {\n        background: pic.png\n\n" +
    "        background-fade: linear angle=90 from=25% to=85%\n\n        Body copy.\n    }\n}"
  );
  assert(parsed.errors.length === 0, "fixture parses");
  const { nodes, meta } = extractMeta(parsed.nodes);
  const build = (bakedFades) =>
    inlineDeckImages(renderSlides(nodes, { meta, themeCss, bakedFades }), dir).html;

  const page = { width: 20, height: 11.25 };
  const maskedHtml = path.join(dir, "masked.html");
  const bakedHtml = path.join(dir, "baked.html");
  const maskedPdf = path.join(dir, "masked.pdf");
  const bakedPdf = path.join(dir, "baked.pdf");

  try {
    fs.writeFileSync(maskedHtml, build({}), "utf-8");

    const { baked, warnings } = await bakeFades(maskedHtml);
    assert(
      Object.keys(baked).length === 1,
      "the fade should bake; warnings: " + warnings.join(" | ")
    );
    assert(
      String(baked[0]).startsWith("data:image/jpeg"),
      "an opaque ground composites to a JPEG, which keeps the export small"
    );

    fs.writeFileSync(bakedHtml, build(baked), "utf-8");
    await exportSlidePdf(maskedHtml, maskedPdf, page);
    await exportSlidePdf(bakedHtml, bakedPdf, page);

    // Feature-relative, never absolute. A legitimate cut-out PNG carries an
    // image-level soft mask of its own, so "none anywhere" would fail on any
    // deck that has one. What must hold is that the fade itself adds none.
    const before = gsSoftMasks(maskedPdf);
    const after = gsSoftMasks(bakedPdf);
    assert(before > 0, "the CSS mask does produce the construct (control)");
    assert(after === 0, `baking should remove it, found ${after}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================
// Summary — wait for async tests before reporting
allSettled().then(() => {
  console.log("\n" + "=".repeat(40));
  console.log(`Results: ${pass} passed, ${fail} failed${browser.summary()}`);
  process.exit(fail > 0 ? 1 : 0);
});
