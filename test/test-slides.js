const fs = require("fs");
const path = require("path");
const os = require("os");
const { parseSdoc, extractMeta } = require("../src/sdoc.js");
const { renderSlides, renderSlide, renderNode, renderInline, isOptionalSlide } = require("../src/slide-renderer.js");

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
  assert(html.includes("--sdoc-slide-w: 1280px"), "design box width defined");
  assert(html.includes("--sdoc-slide-h: 720px"), "design box height defined");
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
  assert(!html.includes("<script"), "should strip script from slide SVG");
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
  assert(!html.includes("slide-has-details"), "no has-details class for 1D deck");
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
  assert(full.includes("slide-has-details"), "the chevron is there while presenting");
  const exported = parseAndRender(deck, { includeOptional: false });
  assert(!exported.includes("slide-has-details"), "no chevron pointing at nothing on export");
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
// Summary — wait for async tests before reporting
Promise.all(asyncTests).then(() => {
  console.log("\n" + "=".repeat(40));
  console.log(`Results: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
});
