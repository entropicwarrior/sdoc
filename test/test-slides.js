const fs = require("fs");
const path = require("path");
const os = require("os");
const { parseSdoc, extractMeta } = require("../src/sdoc.js");
const { renderSlides, renderSlide, renderNode, renderInline, isOptionalSlide, inlineDeckImages } = require("../src/slide-renderer.js");

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-img-"));
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
  assert(html.includes("display: block !important"), "should force slides visible in print");
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

test("findChrome returns a string or null", () => {
  const { findChrome } = require("../src/slide-pdf");
  const result = findChrome();
  assert(result === null || typeof result === "string", "should return string or null");
  if (result) {
    assert(fs.existsSync(result), "returned path should exist: " + result);
  }
});

test("exportPdf produces a file (integration)", async () => {
  const { exportSlidePdf, findChrome } = require("../src/slide-pdf");
  if (!findChrome()) {
    console.log("    SKIP: Chrome not found");
    return;
  }

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
  assert(!html.includes("/ 4"), "the excluded spine is not still counted");
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
  assert(html.includes('var KEY = "f"'), "bound to F");
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
  const deck = html.indexOf("/* deck.css */");
  assert(theme > 0 && deck > 0, "both stylesheets present");
  assert(deck > theme, "the deck's sheet comes after the theme's");
  assert(deck < html.indexOf("</style>"), "and inside the style tag");
});

test("a deck with no stylesheet of its own is unchanged", () => {
  const html = parseAndRender("# Deck {\n    # Slide {\n        Body.\n    }\n}");
  assert(!html.includes("undefined"), "no stray value where the sheet would be");
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
function bgSlide(lines) {
  const html = parseAndRender(`# Deck {\n    # Slide {\n${lines}\n\n        Body copy.\n    }\n}`);
  return html.slice(html.indexOf("<body"));
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
// Summary — wait for async tests before reporting
Promise.all(asyncTests).then(() => {
  console.log("\n" + "=".repeat(40));
  console.log(`Results: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
});
