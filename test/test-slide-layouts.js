// Structured slide layouts, config lines, theme loading and the geometry
// harvest / PPTX export. Run with: node test/test-slide-layouts.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseSdoc, extractMeta } = require("../src/sdoc.js");
const { overflowReport } = require("../src/slide-geometry.js");
const { renderSlides } = require("../src/slide-renderer.js");
const { extractConfig } = require("../src/slide-layouts.js");
const { inlineCssAssets, readThemeConfig } = require("../src/theme.js");

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

function render(sdoc, options = {}) {
  const parsed = parseSdoc(sdoc);
  assert(parsed.errors.length === 0, "parse errors: " + parsed.errors.map((e) => e.message).join(", "));
  const { nodes, meta } = extractMeta(parsed.nodes);
  return renderSlides(nodes, { meta, ...options });
}

// ============================================================
console.log("--- Config lines ---");

test("a known key before content is config, not content", () => {
  const { config, contentNodes } = extractConfig([
    { type: "paragraph", text: "kicker: THE APPROACH" },
    { type: "paragraph", text: "Body copy." },
  ]);
  assert(config.kicker === "THE APPROACH", "kicker captured");
  assert(contentNodes.length === 1, "one content node left");
});

test("an unknown key is content", () => {
  const { config, contentNodes } = extractConfig([
    { type: "paragraph", text: "Result: the loop closes." },
  ]);
  assert(Object.keys(config).length === 0, "nothing captured as config");
  assert(contentNodes.length === 1, "paragraph stays content");
});

test("a key this context cannot use stays content instead of vanishing", () => {
  // `value:` means something on a rows or bars child and nothing on a plain
  // slide. Consuming it there deleted the sentence from the deck in silence.
  const { config, contentNodes } = extractConfig([
    { type: "paragraph", text: "Value: the customer keeps their data." },
    { type: "paragraph", text: "Body copy." },
  ]);
  assert(config.value === undefined, "not captured");
  assert(contentNodes.length === 2, "both paragraphs survive");
  assert(contentNodes[0].text.startsWith("Value:"), "and in source order");
});

test("a cell key is config only under the layout that reads it", () => {
  const asCell = extractConfig([{ type: "paragraph", text: "value: Layer 1" }], "rows");
  assert(asCell.config.value === "Layer 1", "a rows child understands value:");
  const asSlide = extractConfig([{ type: "paragraph", text: "value: Layer 1" }]);
  assert(asSlide.config.value === undefined, "a slide does not");
  assert(asSlide.contentNodes.length === 1, "and keeps it as content");
});

test("a container key is config only under the layout that reads it", () => {
  const onSplit = extractConfig([
    { type: "paragraph", text: "config: split" },
    { type: "paragraph", text: "weights: 48 52" },
  ]);
  assert(onSplit.config.weights === "48 52", "split reads weights:");
  const onColumns = extractConfig([
    { type: "paragraph", text: "config: columns" },
    { type: "paragraph", text: "weights: 48 52" },
  ]);
  assert(onColumns.config.weights === undefined, "columns does not");
  assert(onColumns.contentNodes.length === 1, "and keeps it as content");
});

test("config: is found even when another key precedes it", () => {
  const { config } = extractConfig([
    { type: "paragraph", text: "numbered: true" },
    { type: "paragraph", text: "config: columns" },
  ]);
  assert(config.layout === "columns", "layout resolved");
  assert(config.numbered === "true", "the earlier key is kept once the layout is known");
});

test("optional: is understood by every scope, whatever layout it names", () => {
  // It has to be a common key: it marks spine slides, detail slides and slides
  // under any layout, and none of those share a layout to hang it off.
  const plain = extractConfig([{ type: "paragraph", text: "optional: true" }]);
  assert(plain.config.optional === "true", "a plain slide understands optional:");
  assert(plain.contentNodes.length === 0, "and consumes the line");
  const laidOut = extractConfig([
    { type: "paragraph", text: "config: columns" },
    { type: "paragraph", text: "optional: true" },
  ]);
  assert(laidOut.config.optional === "true", "so does a slide naming a layout");
});

test("a boolean key only takes the line when the value is a boolean word", () => {
  // Every other key renders the text it is given, so consuming the line shows
  // up in the output. A boolean key discards what it cannot read, which would
  // delete an opening sentence from the deck without saying so.
  const prose = extractConfig([
    { type: "paragraph", text: "Optional: a second seat costs nothing." },
    { type: "paragraph", text: "Body." },
  ]);
  assert(prose.config.optional === undefined, "not read as configuration");
  assert(prose.contentNodes.length === 2, "the sentence survives as content");
  assert(prose.contentNodes[0].text.startsWith("Optional:"), "in source order");

  for (const word of ["true", "yes", "on", "1", "false", "no", "off", "0", "TRUE"]) {
    const { config, contentNodes } = extractConfig([
      { type: "paragraph", text: `optional: ${word}` },
    ]);
    assert(config.optional !== undefined, `optional: ${word} is configuration`);
    assert(contentNodes.length === 0, `optional: ${word} consumes the line`);
  }
});

test("a known key after content is content", () => {
  const { config, contentNodes } = extractConfig([
    { type: "paragraph", text: "Body copy." },
    { type: "paragraph", text: "label: not config down here" },
  ]);
  assert(config.label === undefined, "label not captured");
  assert(contentNodes.length === 2, "both paragraphs are content");
});

test("config: and layout: are synonyms for the layout", () => {
  assert(extractConfig([{ type: "paragraph", text: "config: stats" }]).config.layout === "stats");
  assert(extractConfig([{ type: "paragraph", text: "layout: stats" }]).config.layout === "stats");
});

test("a multi-line paragraph is never config", () => {
  const { config } = extractConfig([{ type: "paragraph", text: "value: one\nand a second line" }]);
  assert(config.value === undefined, "multi-line paragraph stays content");
});

test("kicker, lede and footnote render in the right places", () => {
  const html = render(`
# Deck {
    # Slide {
        config: columns

        kicker: THE APPROACH

        lede: A standfirst.

        footnote: Small print.

        # One {
            Content.
        }
    }
}
`);
  assert(html.includes('<div class="kicker">THE APPROACH</div>'), "kicker");
  assert(html.includes('<p class="lede">A standfirst.</p>'), "lede");
  assert(html.includes('<div class="footnote">Small print.</div>'), "footnote");
  assert(html.indexOf("kicker") < html.indexOf("<h2>"), "kicker precedes the title");
  assert(html.indexOf("footnote") > html.indexOf("slide-body"), "footnote follows the body");
});

test("a title slide puts the kicker after the statement and uses h1", () => {
  const html = render(`
# Deck {
    # Northwind {
        config: title

        kicker: SEED ROUND

        A subtitle.
    }
}
`);
  assert(html.includes("<h1>Northwind</h1>"), "h1 not h2");
  assert(html.indexOf('class="kicker"') > html.indexOf("<h1>"), "kicker follows the statement");
});

test("accent becomes a class on the slide", () => {
  const html = render(`
# Deck {
    # Slide {
        config: columns

        accent: secondary

        # One {
            Content.
        }
    }
}
`);
  assert(/class="slide layout-columns accent-secondary"/.test(html), "accent class on slide");
});

// ============================================================
console.log("\n--- Layout class names ---");

test("structured layouts do not emit the bare layout name as a slide class", () => {
  // A slide also carrying `.columns` would match the container's own rules.
  const html = render(`
# Deck {
    # Slide {
        config: columns

        # One {
            Content.
        }
    }
}
`);
  assert(html.includes('class="slide layout-columns"'), "layout- class only");
  assert(!/class="slide columns/.test(html), "no bare columns class on the slide");
});

test("center and two-column keep their bare class for older themes", () => {
  const centered = render(`
# Deck {
    # S {
        config: center

        Text.
    }
}
`);
  assert(centered.includes('class="slide center layout-center"'), "center keeps both");
  const columns = render(`
# Deck {
    # S {
        config: two-column

        # A {
            x
        }

        # B {
            y
        }
    }
}
`);
  assert(columns.includes('class="slide two-column layout-two-column"'), "two-column keeps both");
});

// ============================================================
console.log("\n--- Structured layouts ---");

test("columns numbers its children when asked", () => {
  const html = render(`
# Deck {
    # Slide {
        config: columns

        numbered: true

        # A {
            one
        }

        # B {
            two
        }

        # C {
            three
        }
    }
}
`);
  assert(html.includes('class="columns cols-3"'), "column count in the class");
  assert(html.includes('<div class="col-index">01</div>'), "01");
  assert(html.includes('<div class="col-index">03</div>'), "03");
});

test("stats uses the scope title as the figure", () => {
  const html = render(`
# Deck {
    # Slide {
        config: stats

        # 10µW {
            A bumble bee brain
        }
    }
}
`);
  assert(html.includes('<div class="stat-value">10µW</div>'), "figure");
  assert(html.includes('<div class="stat-label"><p>A bumble bee brain</p></div>'), "caption");
});

test("a pipeline marks bold steps and leaves the rest neutral", () => {
  const html = render(`
# Deck {
    # Slide {
        config: pipeline

        # Cached {
            accent: primary

            {[.]
                - **Edge hit**
                - Origin
                - **Response**
            }
        }
    }
}
`);
  assert(html.includes('class="pipe-row accent-primary"'), "row accent");
  assert(html.includes('<div class="pipe-step is-marked"><span>Edge hit</span></div>'), "marked step");
  assert(html.includes('<div class="pipe-step"><span>Origin</span></div>'), "neutral step");
  assert((html.match(/pipe-arrow/g) || []).length === 2, "one arrow between each pair");
  assert(html.includes('<div class="pipe-label">Cached</div>'), "row label");
});

test("a pipeline step keeps its markup out of the label text", () => {
  const html = render(`
# Deck {
    # S {
        config: pipeline

        # R {
            {[.]
                - **ASR**
            }
        }
    }
}
`);
  assert(!html.includes("**"), "asterisks consumed, not rendered");
  assert(!html.includes("<strong>"), "a marked step is not also bolded");
});

test("a step with two bold spans is not treated as one marked step", () => {
  // `**A** and **B**` opens and closes with `**`; stripping the outer pair
  // leaves `A** and **B`, which re-parses with its emphasis inverted.
  const html = render(`
# Deck {
    # S {
        config: pipeline

        # R {
            {[.]
                - **Encode** then **Decode**
            }
        }
    }
}
`);
  assert(!html.includes("is-marked"), "not marked");
  assert(
    html.includes("<strong>Encode</strong> then <strong>Decode</strong>"),
    "both spans keep their emphasis"
  );
});

test("the pipeline arrow is set by arrow:, and rule: is left to stack", () => {
  const withRule = render(`
# Deck {
    # S {
        config: pipeline

        rule: true

        # R {
            {[.]
                - A
                - B
            }
        }
    }
}
`);
  assert(withRule.includes('aria-hidden="true">\u2192</div>'), "rule: does not become the glyph");
  assert(withRule.includes("<p>rule: true</p>"), "and is not swallowed either");

  const withArrow = render(`
# Deck {
    # S {
        config: pipeline

        arrow: >

        # R {
            {[.]
                - A
                - B
            }
        }
    }
}
`);
  assert(withArrow.includes('aria-hidden="true">&gt;</div>'), "arrow: sets the glyph");
});

test("matrix alternates header accents and can highlight the last row", () => {
  const html = render(`
# Deck {
    # Slide {
        config: matrix

        highlight: last

        {[table]
            Who | What
            Them | Conversion
            Us | None
        }
    }
}
`);
  assert(html.includes('<th class="col-a">Who</th>'), "first header track");
  assert(html.includes('<th class="col-b">What</th>'), "second header track");
  assert(html.includes('<tr class="is-highlight">'), "last row highlighted");
  assert((html.match(/is-highlight/g) || []).length === 1, "only one row highlighted");
});

test("matrix can highlight by name instead of position", () => {
  const html = render(`
# Deck {
    # Slide {
        config: matrix

        highlight: Northwind

        {[table]
            Who | What
            Northwind | None
            Them | Conversion
        }
    }
}
`);
  const firstRow = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>")).split("\n")[1];
  assert(firstRow.includes("is-highlight"), "named row highlighted, not the last one");
});

test("rows carry an index, a label, a body and a value", () => {
  const html = render(`
# Deck {
    # Slide {
        config: rows

        numbered: true

        # Tools {
            value: Layer 1

            Simulation sold as a capability.
        }
    }
}
`);
  assert(html.includes('<div class="row-index">01</div>'), "index");
  assert(html.includes('<div class="row-label">Tools</div>'), "label");
  assert(html.includes('<div class="row-value">Layer 1</div>'), "value");
  assert(html.includes('<div class="row-body"><p>Simulation sold as a capability.</p></div>'), "body");
});

test("bars scale against the largest value", () => {
  const html = render(`
# Deck {
    # Slide {
        config: bars

        # A {
            value: 100
        }

        # B {
            value: 50
        }

        # C {
            value: 0
        }
    }
}
`);
  assert(html.includes('style="width:100.00%"'), "largest is full");
  assert(html.includes('style="width:50.00%"'), "half");
  assert(html.includes('style="width:0.00%"'), "zero");
});

test("bars accept an explicit fill and parse a value written with units", () => {
  const html = render(`
# Deck {
    # Slide {
        config: bars

        # A {
            value: 4,200 docs

            fill: 62
        }
    }
}
`);
  assert(html.includes('style="width:62.00%"'), "explicit fill wins");
  assert(html.includes('<div class="bar-value">4,200 docs</div>'), "value rendered as written");
});

test("split renders two panes and honours weights", () => {
  const html = render(`
# Deck {
    # Slide {
        config: split

        weights: 48 52

        # @a {
            Left.
        }

        # @b {
            Right.
        }
    }
}
`);
  assert(html.includes('style="flex:48 1 0"'), "first weight");
  assert(html.includes('style="flex:52 1 0"'), "second weight");
  assert((html.match(/class="pane"/g) || []).length === 2, "two panes");
});

test("a split pane can name its own layout", () => {
  const html = render(`
# Deck {
    # Slide {
        config: split

        # @a {
            Prose.
        }

        # @b {
            config: rows

            variant: mono

            # Sep 2026 {
                First milestone.
            }
        }
    }
}
`);
  assert(html.includes('class="block layout-rows"'), "pane block carries its layout");
  assert(html.includes('class="rows variant-mono"'), "variant reaches the container");
  assert(html.includes('<div class="row-label">Sep 2026</div>'), "row inside the pane");
});

test("stack renders each child as its own block", () => {
  const html = render(`
# Deck {
    # Slide {
        config: stack

        rule: true

        # @top {
            config: pipeline

            # R {
                {[.]
                    - **A**
                }
            }
        }

        # @bottom {
            config: columns

            # One {
                x
            }
        }
    }
}
`);
  assert(html.includes('class="stack is-ruled"'), "ruled stack");
  assert((html.match(/class="stack-block"/g) || []).length === 2, "two blocks");
  assert(html.indexOf("pipeline") < html.indexOf('class="columns'), "source order preserved");
});

test("a configuration value cannot break out of the class attribute", () => {
  const html = render(`
# Deck {
    # S {
        config: columns

        variant: card" onclick="boom()

        # A {
            x
        }
    }
}
`);
  assert(!/onclick\s*=/.test(html), "no attribute smuggled in");
  assert(html.includes('class="columns cols-1 variant-cardonclickboom"'), "reduced to a class name");

  const layout = render(`
# Deck {
    # S {
        config: plain" onclick="boom()

        Text.
    }
}
`);
  assert(!/onclick\s*=/.test(layout), "a layout name cannot smuggle one either");
});

test("an unknown layout falls back to plain content", () => {
  const html = render(`
# Deck {
    # S {
        config: nonsense

        Just text.
    }
}
`);
  assert(html.includes("<p>Just text.</p>"), "content still renders");
  assert(html.includes("layout-nonsense"), "class still emitted for the theme");
});

// ============================================================
console.log("\n--- Theme loading ---");

test("relative url() in theme CSS is inlined as a data: URI", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-theme-"));
  fs.mkdirSync(path.join(dir, "fonts"));
  fs.writeFileSync(path.join(dir, "fonts", "x.woff2"), Buffer.from([1, 2, 3, 4]));
  const { css, inlined, missing } = inlineCssAssets(
    '@font-face { src: url("fonts/x.woff2") format("woff2"); }',
    dir
  );
  assert(css.includes("data:font/woff2;base64,AQIDBA=="), "inlined as base64");
  assert(inlined.length === 1 && missing.length === 0, "one inlined, none missing");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("absolute and data: URLs are left alone", () => {
  const source = "a{background:url(https://example.com/x.png)}b{background:url(data:image/png;base64,AA==)}";
  const { css, inlined } = inlineCssAssets(source, os.tmpdir());
  assert(css === source, "unchanged");
  assert(inlined.length === 0, "nothing inlined");
});

test("a url() escaping the theme directory is refused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-theme-"));
  const { css, missing } = inlineCssAssets("a{src:url(../../etc/passwd)}", dir);
  assert(css.includes("../../etc/passwd"), "left as written");
  assert(missing.length === 1, "reported as missing");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a theme with no theme.json gets the default design box", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-theme-"));
  const { config } = readThemeConfig(dir);
  assert(config.slide.width === 1280 && config.slide.height === 720, "1280x720");
  assert(config.page.width === 13.333, "13.333in page");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the theme design box reaches the structural CSS and the print page", () => {
  const html = render(`# Deck { # S { Text. } }`, {
    themeConfig: { slide: { width: 1920, height: 1080 }, page: { width: 20, height: 11.25 } },
  });
  assert(html.includes("--sdoc-slide-w: 1920px"), "design box width");
  assert(html.includes("--sdoc-slide-h: 1080px"), "design box height");
  assert(html.includes("@page { size: 20in 11.25in; margin: 0; }"), "print page matches");
});

// ============================================================
console.log("\n--- Aspect ratio and fit modes ---");

test("a deck letterboxes by default", () => {
  const html = render(`# Deck { # S { Text. } }`);
  assert(html.includes('data-sdoc-fit="contain"'), "contain is the default");
});

test("the fit mode reaches the document element", () => {
  for (const mode of ["contain", "cover", "stretch"]) {
    const html = render(`# Deck { # S { Text. } }`, { fit: mode });
    assert(html.includes(`data-sdoc-fit="${mode}"`), `${mode} carried through`);
  }
});

test("an unrecognised fit mode falls back to contain", () => {
  const html = render(`# Deck { # S { Text. } }`, { fit: "squish" });
  assert(html.includes('data-sdoc-fit="contain"'), "unknown mode is not honoured");
});

test("a theme can declare the fit mode, and --fit overrides it", () => {
  const fromTheme = render(`# Deck { # S { Text. } }`, { themeConfig: { fit: "cover" } });
  assert(fromTheme.includes('data-sdoc-fit="cover"'), "theme default honoured");
  const overridden = render(`# Deck { # S { Text. } }`, { themeConfig: { fit: "cover" }, fit: "contain" });
  assert(overridden.includes('data-sdoc-fit="contain"'), "explicit fit wins");
});

test("the vertical scale defaults to the horizontal one", () => {
  // A theme shipping its own runtime writes only --sdoc-slide-scale. Without
  // this default such a deck would render squashed to a 1x vertical scale.
  const html = render(`# Deck { # S { Text. } }`);
  assert(
    html.includes("--sdoc-slide-scale-y: var(--sdoc-slide-scale);"),
    "scale-y falls back to scale"
  );
  assert(
    /scale\(var\(--sdoc-slide-scale\), var\(--sdoc-slide-scale-y\)\)/.test(html),
    "both axes used in the transform"
  );
});

test("a slide with nothing on it reports no overflow", () => {
  // With no content atoms the extent reads as all zeros, which used to be
  // reported as content sitting outside the left and top margins.
  const findings = overflowReport({
    box: { w: 1280, h: 720 },
    slides: [
      {
        spine: 1,
        detail: 0,
        id: "blank",
        layout: null,
        padding: { top: 60, right: 100, bottom: 60, left: 100 },
        extent: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
        atoms: [],
      },
    ],
  });
  assert(findings.length === 0, "no finding: " + JSON.stringify(findings));
});

test("the structural CSS names a letterbox colour", () => {
  const html = render(`# Deck { # S { Text. } }`);
  assert(html.includes("--sdoc-letterbox:"), "letterbox variable defined");
});

// ============================================================
console.log("\n--- Accent cascade ---");

// The two browser tests further down prove the cascade end to end, but only
// for the elements they name. This one is the invariant behind it, checked
// statically against the stylesheet: every rule in the theme that assigns
// --sdoc-accent is either an explicit `.accent-*` choice, which must carry
// specificity, or a per-layout default, which must not. A new layout default
// added later is covered the moment it is written, with nobody remembering to
// extend a test, and it needs no browser so it cannot flake.
test("the theme's accent rules keep explicit choices above layout defaults", () => {
  const css = fs.readFileSync(
    path.join(__dirname, "..", "themes", "default", "theme.css"),
    "utf-8"
  );

  // Every `selector { ... --sdoc-accent: ... }` rule in the file.
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    if (!/--sdoc-accent\s*:/.test(m[2])) continue;
    rules.push(m[1].split("*/").pop().trim());
  }
  assert(rules.length > 5, `expected the accent rules to be found, got ${rules.length}`);

  // Classify by what the selector *targets*, with any :where() wrapper taken
  // off first. Reading the wrapper as part of the identity is the mistake
  // this test exists to catch: a `:where(.accent-*)` rule would otherwise
  // look like a well-formed default and pass.
  const explicit = [];
  const defaults = [];
  for (const selector of rules) {
    // `:root` declares the variables themselves rather than choosing a value.
    if (/^:root\b/.test(selector)) continue;
    const wrapped = selector.startsWith(":where(") && selector.endsWith(")");
    const target = wrapped ? selector.slice(7, -1).trim() : selector;
    (/^\.accent-[a-z0-9-]+$/.test(target) ? explicit : defaults).push({ selector, wrapped });
  }

  const names = (list) => list.map((r) => r.selector).join(", ");
  assert(explicit.length >= 4, `expected the .accent-* rules, got ${names(explicit)}`);
  assert(defaults.length >= 4, `expected per-layout defaults, got ${names(defaults)}`);

  for (const rule of explicit) {
    assert(
      !rule.wrapped,
      `.accent-* must carry specificity or a later zero-specificity default ` +
        `silently outranks the author's choice: ${rule.selector}`
    );
  }
  for (const rule of defaults) {
    assert(
      rule.wrapped,
      `a per-layout accent default must be wrapped in :where() so an explicit ` +
        `accent: can override it: ${rule.selector}`
    );
  }
});

// ============================================================
console.log("\n--- Geometry harvest and PPTX export ---");

const { harvestGeometry } = require("../src/slide-geometry.js");
const { buildPptx } = require("../src/slide-pptx.js");
const { loadTheme } = require("../src/theme.js");
const { findChrome } = require("../src/slide-pdf.js");

const EXAMPLE = path.join(__dirname, "..", "examples", "layouts-example.sdoc");

// A throwaway theme with values the assertions can name exactly: a 1920x1080
// box, a 100px gutter and one known accent. Asserting against a shipped theme
// would make these tests break every time that theme was restyled.
function writeTestTheme(dir) {
  fs.mkdirSync(path.join(dir, "theme"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "theme", "theme.json"),
    JSON.stringify({
      name: "test",
      slide: { width: 1920, height: 1080 },
      page: { width: 20, height: 11.25 },
    })
  );
  fs.writeFileSync(
    path.join(dir, "theme", "theme.css"),
    `* { margin: 0; padding: 0; box-sizing: border-box; }
     body { background: #101010; color: #C0C0C0; overflow: hidden; height: 100vh; }
     .slide { display: none; flex-direction: column; background: #101010;
              padding: 100px 100px 84px; }
     .slide.active { display: flex; }
     .slide-head { display: block; flex: 0 0 auto;
                   padding-bottom: 58px; border-bottom: 1px solid #303030; margin-bottom: 48px; }
     .slide-body { display: block; flex: 1 1 auto; min-height: 0; }
     .kicker { font-size: 26px; line-height: 1; text-transform: uppercase; color: #3366CC; }
     h2 { font-size: 68px; font-weight: 400; line-height: 1.06; color: #F0F0F0; margin-top: 32px; }
     .slide-footer { bottom: 30px; left: 100px; right: 100px; }
     .notes { display: none; }`
  );
  return path.join(dir, "theme");
}

if (!findChrome()) {
  console.log("  SKIP: Chrome not found — geometry and PPTX tests need it");
} else {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-geom-test-"));
  const htmlPath = path.join(tmpDir, "deck.html");
  const theme = loadTheme(writeTestTheme(tmpDir), path.join(__dirname, "..", "themes", "default"));
  const parsed = parseSdoc(fs.readFileSync(EXAMPLE, "utf-8"));
  const { nodes, meta } = extractMeta(parsed.nodes);
  fs.writeFileSync(
    htmlPath,
    renderSlides(nodes, { meta, themeCss: theme.themeCss, themeJs: theme.themeJs, themeConfig: theme.themeConfig }),
    "utf-8"
  );

  const geometryPromise = harvestGeometry(htmlPath);

  test("harvest reports the design box and one record per slide", async () => {
    const geometry = await geometryPromise;
    assert(geometry.box.w === 1920 && geometry.box.h === 1080, "design box measured");
    assert(geometry.slides.length >= 10, "every slide measured");
    assert(geometry.slides.every((s) => s.atoms.length > 0), "no empty slide");
  });

  test("harvest places the kicker on the theme's grid", async () => {
    const geometry = await geometryPromise;
    const slide = geometry.slides.find((s) => s.layout === "pipeline");
    const kicker = slide.atoms.find((a) => a.kind === "text" && a.cls === "kicker");
    assert(Math.abs(kicker.box.x - 100) < 0.5, "100px gutter");
    assert(Math.abs(kicker.box.y - 100) < 0.5, "100px top line");
    assert(kicker.runs[0].text === "PIPELINE", "text-transform applied to the run");
    assert(kicker.runs[0].color === "3366CC", "accent colour resolved");
  });

  test("harvest reads a partial border from the side that has width", async () => {
    const geometry = await geometryPromise;
    const slide = geometry.slides.find((s) => s.layout === "pipeline");
    const head = slide.atoms.find((a) => a.kind === "box" && /slide-head/.test(a.cls));
    assert(head.border.sides.join() === "bottom", "bottom edge only");
    assert(head.border.colour === "303030", "rule colour, not currentColor");
  });

  test("nav chevrons are not measured — they mean nothing off-screen", async () => {
    const geometry = await geometryPromise;
    for (const slide of geometry.slides) {
      const nav = slide.atoms.filter((a) => /nav-(prev|next)/.test(a.cls || ""));
      assert(nav.length === 0, `slide ${slide.spine} measured a chevron`);
      const glyphs = slide.atoms.filter(
        (a) => a.kind === "text" && a.runs.some((r) => /[\u2039\u203a]/.test(r.text))
      );
      assert(glyphs.length === 0, `slide ${slide.spine} exported a chevron glyph`);
    }
  });

  test("footer chrome is measured but excluded from the content extent", async () => {
    const geometry = await geometryPromise;
    const slide = geometry.slides[0];
    assert(slide.atoms.some((a) => a.chrome), "chrome atoms present");
    assert(slide.extent.maxY <= geometry.box.h - slide.padding.bottom + 1, "extent stops at the margin");
  });

  test("the example deck overflows no margin", async () => {
    const geometry = await geometryPromise;
    const findings = overflowReport(geometry);
    assert(findings.length === 0, "overflow: " + JSON.stringify(findings));
  });

  // These two assert against themes/default, not the throwaway theme: the
  // claim under test is the shipped theme's cascade, and it is a claim the
  // authoring guide makes to deck authors.
  const accentDeck = (() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-accent-"));
    const file = path.join(dir, "accent.html");
    const defaultTheme = loadTheme(path.join(__dirname, "..", "themes", "default"));
    const src = `
# Accents {
    @meta {
        type: slides
    }

    # Explicit {
        config: pipeline

        # Row one {
            accent: tertiary

            {[.]
                - Step
            }
        }
    }

    # Default {
        config: pipeline

        # Row one {
            {[.]
                - Step
            }
        }

        # Row two {
            {[.]
                - Step
            }
        }
    }
}
`;
    const parsedAccent = parseSdoc(src);
    const extracted = extractMeta(parsedAccent.nodes);
    fs.writeFileSync(
      file,
      renderSlides(extracted.nodes, {
        meta: extracted.meta,
        themeCss: defaultTheme.themeCss,
        themeJs: defaultTheme.themeJs,
        themeConfig: defaultTheme.themeConfig,
      }),
      "utf-8"
    );
    return { dir, promise: harvestGeometry(file) };
  })();

  function labelColours(slide) {
    return slide.atoms
      .filter((a) => a.kind === "text" && /pipe-label/.test(a.cls || ""))
      .map((a) => a.runs[0].color);
  }

  test("an explicit accent: beats the theme's own per-layout default", async () => {
    // Both sides set --sdoc-accent on the same element. If the accent classes
    // are wrapped in :where() like the defaults are, the two sit at equal
    // (zero) specificity and source order decides — and the defaults come
    // later in theme.css, so the author's explicit choice loses in silence.
    const geometry = await accentDeck.promise;
    const colours = labelColours(geometry.slides[0]);
    assert(colours.length === 1, "one labelled row");
    assert(colours[0] === "B45309", `accent: tertiary should win, got ${colours[0]}`);
  });

  test("the theme still alternates accents where the deck states none", async () => {
    const geometry = await accentDeck.promise;
    const colours = labelColours(geometry.slides[1]);
    assert(colours.length === 2, "two labelled rows");
    assert(colours[0] === "2563EB", `first row default, got ${colours[0]}`);
    assert(colours[1] === "0891B2", `second row default, got ${colours[1]}`);
    fs.rmSync(accentDeck.dir, { recursive: true, force: true });
  });

  test("PPTX export produces a package with one slide part per slide", async () => {
    const geometry = await geometryPromise;
    const { buffer } = buildPptx(geometry, { baseDir: tmpDir, title: "Test" });
    assert(buffer.length > 5000, "non-trivial archive");
    assert(buffer.slice(0, 2).toString() === "PK", "zip magic");
    const text = buffer.toString("latin1");
    for (let i = 1; i <= geometry.slides.length; i++) {
      assert(text.includes(`ppt/slides/slide${i}.xml`), `slide${i}.xml present`);
    }
    assert(text.includes("[Content_Types].xml"), "content types present");
    assert(text.includes("ppt/notesMasters/notesMaster1.xml"), "notes master present");
  });

  test("PPTX slide XML carries the harvested geometry in EMU", async () => {
    const geometry = await geometryPromise;
    const { buildPptx: build } = require("../src/slide-pptx.js");
    const { buffer } = build(geometry, { baseDir: tmpDir });
    // Unpack the first slide part with the same deflate Node used to write it.
    const zlib = require("zlib");
    const text = buffer.toString("latin1");
    const marker = "ppt/slides/slide1.xml";
    const at = text.indexOf(marker);
    assert(at > 0, "slide1 entry found");
    const start = at - 30;
    const compressedSize = buffer.readUInt32LE(start + 18);
    const nameLen = buffer.readUInt16LE(start + 26);
    const extraLen = buffer.readUInt16LE(start + 28);
    const body = buffer.slice(start + 30 + nameLen + extraLen, start + 30 + nameLen + extraLen + compressedSize);
    const xml = zlib.inflateRawSync(body).toString("utf-8");
    assert(xml.includes("<p:sld "), "a slide part");
    assert(xml.includes('<a:off x="952500"'), "100px gutter is 952500 EMU");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
}

// ============================================================
Promise.all(asyncTests).then(() => {
  console.log("\n" + "=".repeat(40));
  console.log(`Results: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
});
