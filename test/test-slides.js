const { parseSdoc, extractMeta } = require("../src/sdoc.js");
const { renderSlides, renderSlide, renderNode, renderInline } = require("../src/slide-renderer.js");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log("  PASS: " + name); }
  catch (e) { fail++; console.log("  FAIL: " + name + " — " + e.message); }
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
  assert(html.includes('<div class="slide">'), "should have slide div");
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
  const slideCount = (html.match(/<div class="slide/g) || []).length;
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
  const slideCount = (html.match(/<div class="slide/g) || []).length;
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
  assert(html.includes('class="slide center"'), "should have center class");
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
  assert(html.includes('class="slide two-column"'), "should have two-column class");
  assert(html.includes('class="columns"'), "should have columns container");
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
  assert(!html.includes("center"), "should not have center");
  assert(!html.includes("two-column"), "should not have two-column");
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
  // Notes should not appear inside the main slide content flow
  const slideDiv = html.match(/<div class="slide">([\s\S]*?)<\/div>/);
  assert(slideDiv, "should have slide div");
  assert(slideDiv[1].includes("Content."), "content in slide");
  assert(slideDiv[1].includes('<aside class="notes">'), "notes in slide as aside");
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
  assert(html.includes("<html lang=\"en\">"), "should have html tag");
  assert(html.includes("<head>"), "should have head");
  assert(html.includes("<body>"), "should have body");
  assert(html.includes("</html>"), "should close html");
});

test("includes controls div", () => {
  const html = parseAndRender(`
# Deck {
    # Slide {
        Hello.
    }
}
`);
  assert(html.includes('class="controls"'), "should have controls");
  assert(html.includes('id="counter"'), "should have counter");
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
  assert(html.includes('<div class="slide">'), "should still render slide");
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
  assert(html.includes('class="slide center"'), "should handle whitespace in config");
});

// ============================================================
// Summary
console.log("\n" + "=".repeat(40));
console.log(`Results: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
