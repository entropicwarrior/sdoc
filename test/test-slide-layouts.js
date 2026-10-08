// Structured slide layouts, config lines, theme loading and the geometry
// harvest / PPTX export. Run with: node test/test-slide-layouts.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseSdoc, extractMeta } = require("../src/sdoc.js");
const { overflowReport, SENTINEL } = require("../src/slide-geometry.js");
const { renderSlides } = require("../src/slide-renderer.js");
const { extractConfig } = require("../src/slide-layouts.js");
const { planConnector, parseEndpoint } = require("../src/slide-connectors.js");
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

        kicker: FUNDING

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
            Idle draw per module
        }
    }
}
`);
  // The unit is marked so a theme's uppercasing cannot turn µW into ΜW. See
  // the case-sensitive unit tests in test-slides.js.
  assert(
    html.includes('<div class="stat-value">10<span class="sdoc-unit">µW</span></div>'),
    "figure, with the unit protected from case folding"
  );
  assert(html.includes('<div class="stat-label"><p>Idle draw per module</p></div>'), "caption");
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

test("scatter places a point at the coordinates it is given", () => {
  const html = render(`
# Deck {
    # Slide {
        config: scatter

        # Alder {
            at: 20 80
        }
    }
}
`);
  // bottom, not top: the origin is the bottom-left, so y counts upward and the
  // author writes the axis they named rather than the direction CSS measures.
  assert(html.includes('style="left:20.00%;bottom:80.00%"'), "placed at 20 80 from the bottom-left");
  assert(html.includes('<div class="scatter-dot"></div>'), "the dot is drawn");
  assert(html.includes('<div class="scatter-label">Alder</div>'), "the heading is the label");
});

test("a scatter point written entirely in bold is marked, and loses the markers", () => {
  const html = render(`
# Deck {
    # Slide {
        config: scatter

        # Alder {
            at: 10 10
        }

        # **Ourselves** {
            at: 90 90
        }
    }
}
`);
  assert(html.includes('class="scatter-point is-marked"'), "the bold point is marked");
  assert((html.match(/class="scatter-point"/g) || []).length === 1, "the plain point is not");
  assert(html.includes('<div class="scatter-label">Ourselves</div>'), "markers stripped from the label");
  assert(!html.includes("**"), "no stray emphasis markers");
});

test("scatter names its axes and splits each pair of ends on a bar", () => {
  const html = render(`
# Deck {
    # Slide {
        config: scatter

        x: Cost to run

        y: Work done

        x-ends: cents | pounds

        y-ends: one document | a whole corpus

        # A {
            at: 50 50
        }
    }
}
`);
  assert(html.includes('<div class="scatter-axis-name">Cost to run</div>'), "x axis named");
  assert(html.includes('<div class="scatter-axis-name">Work done</div>'), "y axis named");
  assert(html.includes('scatter-x-low">cents</div>'), "x low end");
  assert(html.includes('scatter-x-high">pounds</div>'), "x high end");
  assert(html.includes('scatter-y-low">one document</div>'), "y low end");
  assert(html.includes('scatter-y-high">a whole corpus</div>'), "y high end");
  // The y gutter reads top to bottom, so the high end is emitted first.
  assert(
    html.indexOf("a whole corpus") < html.indexOf("one document"),
    "the y gutter runs high to low"
  );
});

test("an axis with no bar in its ends keeps them out rather than guessing", () => {
  const html = render(`
# Deck {
    # Slide {
        config: scatter

        x-ends: cents only

        # A {
            at: 50 50
        }
    }
}
`);
  assert(!html.includes("scatter-axis-end"), "one part is not a pair");
});

test("scatter draws quadrant dividers only when asked", () => {
  const withDividers = render(`
# Deck {
    # Slide {
        config: scatter

        quadrants: true

        # A {
            at: 50 50
        }
    }
}
`);
  const without = render(`
# Deck {
    # Slide {
        config: scatter

        # A {
            at: 50 50
        }
    }
}
`);
  assert(withDividers.includes("scatter-divider-v"), "vertical divider");
  assert(withDividers.includes("scatter-divider-h"), "horizontal divider");
  assert(!without.includes("scatter-divider"), "none by default");
});

test("a scatter point clamps to the plot and centres when it has no position", () => {
  const html = render(`
# Deck {
    # Slide {
        config: scatter

        # Off the top {
            at: 150 -40
        }

        # Unplaced {
            Just a note.
        }
    }
}
`);
  assert(html.includes('style="left:100.00%;bottom:0.00%"'), "clamped to the plot");
  // Visible and obviously wrong beats silently missing.
  assert(html.includes('style="left:50.00%;bottom:50.00%"'), "an unplaced point sits at the centre");
});

test("label: places a point's text, and a sentence after it stays content", () => {
  const placed = render(`
# Deck {
    # Slide {
        config: scatter

        # A {
            at: 50 50

            label: left
        }
    }
}
`);
  assert(placed.includes('class="scatter-point label-left"'), "the side becomes a class");

  const prose = render(`
# Deck {
    # Slide {
        config: scatter

        # A {
            at: 50 50

            Label: the axis ends were wrong on the last draft.
        }
    }
}
`);
  assert(!prose.includes("label-"), "prose is not a placement");
  assert(prose.includes("the axis ends were wrong"), "the sentence survives");
});

test("at: means nothing outside a scatter and stays content there", () => {
  const html = render(`
# Deck {
    # Slide {
        config: columns

        # A {
            at: 20 80
        }
    }
}
`);
  assert(html.includes("at: 20 80"), "the line renders as the prose it is");
});

test("a scatter point takes an accent and keeps content the heading did not carry", () => {
  const html = render(`
# Deck {
    # Slide {
        config: scatter

        # A {
            at: 50 50

            accent: secondary

            caption: on demand

            A further note.
        }
    }
}
`);
  assert(html.includes("accent-secondary"), "accent applied to the point");
  assert(html.includes('<div class="scatter-caption">on demand</div>'), "caption rendered");
  assert(html.includes('class="scatter-note"'), "remaining content kept");
  assert(html.includes("A further note."), "nothing dropped");
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
console.log("\n--- Connectors ---");

// A connector is the one thing on a slide whose geometry is not the browser's
// own doing, so these check the arithmetic directly rather than through a
// render: planConnector is pure, takes two boxes and returns rectangles, and
// is the same function the page runs (it is serialised into the deck with
// toString(), so there is one implementation, not two).
//
// Two boxes 100 wide and 50 high, one above the other and offset, used by most
// of what follows. Centres: A (150, 125), B (450, 425).
const BOX_A = { x: 100, y: 100, w: 100, h: 50 };
const BOX_B = { x: 400, y: 400, w: 100, h: 50 };

const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;
function sameBox(got, want, what) {
  assert(
    got && near(got.x, want.x) && near(got.y, want.y) && near(got.w, want.w) && near(got.h, want.h),
    `${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`
  );
}

test("an endpoint is read with or without a sigil, and with either separator", () => {
  for (const written of ["@card-core bottom-center", "#card-core:bottom-center", "card-core bottom-center"]) {
    const end = parseEndpoint(written);
    assert(end && end.id === "card-core" && end.point === "bottom-center",
      `"${written}" -> ${JSON.stringify(end)}`);
  }
  assert(parseEndpoint("@card-core").point === "auto", "no point named means auto");
  assert(parseEndpoint("the customer keeps their data") === null, "a sentence is not an endpoint");
});

test("vh leaves vertically and arrives horizontally, with a mitred corner", () => {
  // A bottom-centre (150, 150) to a top-centre (450, 400): down the x of the
  // start, then across at the y of the end.
  const plan = planConnector(BOX_A, BOX_B, "bottom-center", "top-center", "vh", 4, 0, "none");
  assert(plan.segments.length === 2, "two runs: " + JSON.stringify(plan.segments));
  // The upright starts exactly at the anchor and is extended by half a stroke
  // at the bend only — an end that overshot would miss the box it names.
  sameBox(plan.segments[0], { x: 148, y: 150, w: 4, h: 252 }, "the upright");
  // 302, not 304: the far end stops exactly on the anchor. Only the bend is
  // mitred, because an end that overshot would miss the box it names.
  sameBox(plan.segments[1], { x: 148, y: 398, w: 302, h: 4 }, "the crossing");
});

test("hv is the same route the other way round", () => {
  const plan = planConnector(BOX_A, BOX_B, "bottom-center", "top-center", "hv", 4, 0, "none");
  assert(plan.segments.length === 2, "two runs");
  sameBox(plan.segments[0], { x: 150, y: 148, w: 302, h: 4 }, "the crossing");
  sameBox(plan.segments[1], { x: 448, y: 148, w: 4, h: 252 }, "the upright");
});

test("an elbow leaves on the side the author anchored to", () => {
  // Anchored on a bottom edge, so it leaves downward and crosses at the
  // midpoint — three runs, not two.
  const plan = planConnector(BOX_A, BOX_B, "bottom-center", "top-center", "elbow", 4, 0, "none");
  assert(plan.segments.length === 3, "three runs: " + JSON.stringify(plan.segments));
  const mid = (150 + 400) / 2;
  sameBox(plan.segments[0], { x: 148, y: 150, w: 4, h: mid - 150 + 2 }, "down to the midline");
  sameBox(plan.segments[1], { x: 148, y: mid - 2, w: 304, h: 4 }, "across the midline");
  sameBox(plan.segments[2], { x: 448, y: mid - 2, w: 4, h: 400 - mid + 2 }, "down to the end");
});

test("an elbow anchored on a side leaves sideways instead", () => {
  const plan = planConnector(BOX_A, BOX_B, "right", "left", "elbow", 4, 0, "none");
  assert(plan.segments.length === 3, "three runs");
  // First run is horizontal: it has the stroke for its height, not its width.
  assert(plan.segments[0].h === 4 && plan.segments[0].w > 4,
    "it should leave horizontally: " + JSON.stringify(plan.segments[0]));
});

test("a bend that does not bend is one rectangle, not three", () => {
  // Two boxes in a column with their centres aligned. Drawn literally an elbow
  // here is a zero-length crossing between two collinear uprights, and the two
  // mitres at the ends of that crossing overhang it.
  const below = { x: 100, y: 400, w: 100, h: 50 };
  const plan = planConnector(BOX_A, below, "bottom-center", "top-center", "elbow", 4, 0, "none");
  assert(plan.segments.length === 1, "one run: " + JSON.stringify(plan.segments));
  sameBox(plan.segments[0], { x: 148, y: 150, w: 4, h: 250 }, "the whole run");
});

test("straight between aligned anchors is one rectangle and no rotation", () => {
  const right = { x: 400, y: 100, w: 100, h: 50 };
  const plan = planConnector(BOX_A, right, "right", "left", "straight", 4, 0, "none");
  assert(plan.segments.length === 1, "one run");
  assert(plan.segments[0].angle === undefined, "nothing to rotate");
  sameBox(plan.segments[0], { x: 200, y: 123, w: 200, h: 4 }, "the run");
});

test("straight between anchors that are not aligned is a rotated rectangle", () => {
  // (150, 150) to (450, 400): 300 across, 250 down.
  const plan = planConnector(BOX_A, BOX_B, "bottom-center", "top-center", "straight", 4, 0, "none");
  assert(plan.segments.length === 1, "one run");
  const seg = plan.segments[0];
  const len = Math.sqrt(300 * 300 + 250 * 250);
  assert(near(seg.w, Math.round(len * 100) / 100, 0.02), `length ${seg.w} vs ${len}`);
  assert(seg.h === 4, "the stroke is the height");
  assert(near(seg.angle, (Math.atan2(250, 300) * 180) / Math.PI, 0.02), "the angle: " + seg.angle);
  // Rotated about its own centre, which is the subset's only origin — so the
  // unrotated box has to be centred on the run's midpoint.
  assert(near(seg.x + seg.w / 2, 300) && near(seg.y + seg.h / 2, 275),
    "centred on the midpoint of the run: " + JSON.stringify(seg));
});

test("an unnamed point picks the edges the two boxes face each other across", () => {
  // Nearly under A, so they face each other top to bottom.
  const under = { x: 120, y: 400, w: 100, h: 50 };
  const plan = planConnector(BOX_A, under, "auto", "auto", "vh", 4, 0, "none");
  assert(plan.from.point === "bottom" && plan.to.point === "top",
    `facing edges: ${plan.from.point} -> ${plan.to.point}`);
  // Side by side, they face each other left to right.
  const beside = { x: 400, y: 100, w: 100, h: 50 };
  const across = planConnector(BOX_A, beside, "auto", "auto", "vh", 4, 0, "none");
  assert(across.from.point === "right" && across.to.point === "left",
    `facing edges: ${across.from.point} -> ${across.to.point}`);
  // A dead heat goes to the horizontal. Stated because it is a rule somebody
  // will meet on a square arrangement, and an undecided one would wander.
  const corner = { x: 400, y: 400, w: 100, h: 50 };
  const tie = planConnector(BOX_A, corner, "auto", "auto", "vh", 4, 0, "none");
  assert(tie.from.point === "right", "an exact tie leaves sideways: " + tie.from.point);
});

test("a node is a dot centred exactly on the end it marks", () => {
  const plan = planConnector(BOX_A, BOX_B, "bottom-center", "top-center", "vh", 4, 10, "both");
  assert(plan.dots.length === 2, "two dots");
  sameBox(plan.dots[0], { x: 145, y: 145, w: 10, h: 10 }, "the start dot");
  sameBox(plan.dots[1], { x: 445, y: 395, w: 10, h: 10 }, "the end dot");
  const one = planConnector(BOX_A, BOX_B, "bottom-center", "top-center", "vh", 4, 10, "end");
  assert(one.dots.length === 1, "one dot");
  sameBox(one.dots[0], { x: 445, y: 395, w: 10, h: 10 }, "at the end it names");
  assert(planConnector(BOX_A, BOX_B, "bottom-center", "top-center", "vh", 4, 10, "none").dots.length === 0,
    "none means none");
});

// ---------------------------------------------------------------------------
// What the renderer does with a connectors scope
// ---------------------------------------------------------------------------

const CONNECTOR_DECK = `# Deck
{
    # Wired @wired
    {
        config: columns

        # Alpha @alpha
        {
            One.
        }

        # Beta @beta
        {
            Two.
        }

        # @connectors
        {
            {
                from: @alpha right

                to: @beta left

                shape: straight

                node: both
            }
        }
    }
}`;

test("a cell scope's id reaches the HTML, which is what a connector names", () => {
  const html = render(CONNECTOR_DECK);
  assert(/<div class="column"[^>]*\bid="alpha"/.test(html), "the first column carries its id: " + html.slice(0, 400));
  assert(html.includes('id="beta"'), "and so does the second");
});

test("a connectors scope becomes data on the slide, not a column", () => {
  const html = render(CONNECTOR_DECK);
  const m = /data-sdoc-connectors="([^"]*)"/.exec(html);
  assert(m, "the slide carries the connectors");
  const specs = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
  assert(specs.length === 1, "one connector");
  assert(specs[0].from.id === "alpha" && specs[0].from.point === "right", "its start");
  assert(specs[0].to.id === "beta" && specs[0].to.point === "left", "its end");
  assert(specs[0].shape === "straight" && specs[0].node === "both", "its shape and node");
  // data-count is the layout's own count of cells, and the connectors scope
  // must not be one of them.
  assert(/class="columns cols-2[^"]*" data-count="2"/.test(html),
    "the connectors scope is not a third column: " + (/data-count="\d+"/.exec(html) || [])[0]);
});

test("a deck with no connectors carries neither the runtime nor its styles", () => {
  const html = render("# Deck\n{\n    # Plain @plain\n    {\n        Words.\n    }\n}");
  assert(!html.includes("sdocPlanConnector"), "no runtime");
  assert(!html.includes("sdoc-conn"), "no styles");
  assert(!html.includes("data-sdoc-connectors"), "nothing to resolve");
});

test("a connector pointing at an id the slide has not got is reported, not drawn", () => {
  const warnings = [];
  const html = render(CONNECTOR_DECK.replace("to: @beta left", "to: @gamma left"), { warnings });
  assert(!html.includes("data-sdoc-connectors"), "nothing is emitted for it");
  assert(warnings.some((w) => w.message.includes("@gamma") && w.message.includes("no scope on this slide")),
    "and it is said out loud: " + JSON.stringify(warnings));
  // The ids it DOES have are named, because the usual cause is a typo.
  assert(warnings.some((w) => w.message.includes("@alpha")), "the slide's own ids are listed");
});

test("a line a connector does not understand is reported rather than deleted", () => {
  // A connector scope is pulled out of the slide whole, so anything in it that
  // is not understood would vanish with it — including a misspelt key and a
  // shape that does not exist.
  for (const [bad, needle] of [
    ["shape: straight", "shape: squiggle"],
    ["node: both", "nodes: both"],
  ]) {
    const warnings = [];
    render(CONNECTOR_DECK.replace(bad, needle), { warnings });
    assert(warnings.some((w) => w.message.includes("does not understand")),
      `"${needle}" should be reported: ` + JSON.stringify(warnings));
  }
});

test("a connector joining an element to itself is reported", () => {
  // Both anchors resolve on one box, so the run has no length and nothing is
  // drawn — the silent absence this feature exists to remove, arrived at by a
  // different route.
  const warnings = [];
  const html = render(CONNECTOR_DECK.replace("to: @beta left", "to: @alpha left"), { warnings });
  assert(!html.includes("data-sdoc-connectors"), "nothing is emitted for it");
  assert(warnings.some((w) => w.message.includes("to itself")), JSON.stringify(warnings));
});

test("a connector with no from or no to is reported", () => {
  const warnings = [];
  render(CONNECTOR_DECK.replace("from: @alpha right\n\n                ", ""), { warnings });
  assert(warnings.some((w) => w.message.includes('has no "from:"')), JSON.stringify(warnings));
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
  assert(config.slide.width === 1920 && config.slide.height === 1080, "1920x1080");
  // 1920 CSS px is exactly 20in at 96dpi, which is what keeps screen and
  // PDF the same geometry.
  assert(config.page.width === 20 && config.page.height === 11.25, "20 x 11.25in page");
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
const { spawn } = require("child_process");

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

  // ----------------------------------------------------------------------
  // Runtime navigation. These drive the shipped theme.js in a real browser:
  // the two axes are a behaviour of that script, and nothing else in the
  // suite executes it. Keys go in, the active slide's position comes back.
  // ----------------------------------------------------------------------
  function driveKeys(keys) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-nav-"));
    const file = path.join(dir, "nav.html");
    const theme = loadTheme(path.join(__dirname, "..", "themes", "default"));
    // Spine 2 carries the details; 1 and 3 have none, so a move off either
    // end and a move out of a column are both reachable.
    const src = `
# Nav {
    @meta {
        type: slides
    }

    # One
    {
        Body one.
    }

    # Two
    {
        Body two.

        # D1 :detail
        {
            Detail one.
        }

        # D2 :detail
        {
            Detail two.
        }

        # D3 :detail
        {
            Detail three.
        }
    }

    # Three
    {
        Body three.
    }
}`;
    const parsed = parseSdoc(src);
    assert(parsed.errors.length === 0, "fixture parse errors: " + JSON.stringify(parsed.errors));
    const { nodes, meta } = extractMeta(parsed.nodes);
    const html = renderSlides(nodes, {
      meta, themeCss: theme.themeCss, themeJs: theme.themeJs, themeConfig: theme.themeConfig
    });
    assert(/data-detail="3"/.test(html), "fixture should emit 3 details");

    const probe = `<script>
(function () {
  var keys = ${JSON.stringify(keys)};
  var trail = [];
  function at() {
    var e = document.querySelector(".slide.active");
    return e.getAttribute("data-spine") + "." + e.getAttribute("data-detail");
  }
  trail.push(at());
  keys.forEach(function (k) {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    trail.push(at());
  });
  var pre = document.createElement("pre");
  pre.id = "sdoc-nav-trail";
  pre.textContent = trail.join(" ");
  document.body.appendChild(pre);
})();
</script>`;
    fs.writeFileSync(file, html.replace("</body>", probe + "</body>"), "utf-8");

    return new Promise((resolve, reject) => {
      const child = spawn(findChrome(), [
        "--headless", "--disable-gpu", "--dump-dom",
        "--virtual-time-budget=3000", "file://" + file
      ], { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      child.stdout.on("data", (d) => { out += d.toString(); });
      child.on("error", reject);
      child.on("close", () => {
        const m = /<pre id="sdoc-nav-trail">([^<]*)<\/pre>/.exec(out);
        if (!m) return reject(new Error("navigation probe did not report"));
        resolve(m[1].trim().split(/\s+/));
      });
    });
  }

  test("Right and Left move along the spine, never within a column", async () => {
    // Down twice puts us mid-column at 2.2 — the position Michael reported,
    // where Right used to walk deeper into the column instead of leaving it.
    const trail = await driveKeys(["ArrowRight", "ArrowDown", "ArrowDown", "ArrowRight"]);
    assert(trail.join(" ") === "1.0 2.0 2.1 2.2 3.0",
      "Right from mid-column should land on the next spine, got: " + trail.join(" "));

    const back = await driveKeys(["ArrowRight", "ArrowDown", "ArrowLeft"]);
    assert(back.join(" ") === "1.0 2.0 2.1 1.0",
      "Left from a detail should land on the previous spine, got: " + back.join(" "));
  });

  test("Space walks presentation order rather than the spine", async () => {
    // Inside a column Space continues down it and then leaves at the bottom,
    // which is the one place Space and Right deliberately disagree.
    const trail = await driveKeys(["ArrowRight", "ArrowDown", " ", " ", " "]);
    assert(trail.join(" ") === "1.0 2.0 2.1 2.2 2.3 3.0",
      "Space should walk the column and exit, got: " + trail.join(" "));
  });

  test("Space does not enter a column from a spine slide", async () => {
    const trail = await driveKeys(["ArrowRight", " "]);
    assert(trail.join(" ") === "1.0 2.0 3.0",
      "Space from a spine should skip its details, got: " + trail.join(" "));
  });

  test("Up steps back one detail; Down walks the column", async () => {
    const trail = await driveKeys([
      "ArrowRight", "ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown", "ArrowUp", "ArrowUp"
    ]);
    // The fourth Down is a no-op at the bottom of the column.
    assert(trail.join(" ") === "1.0 2.0 2.1 2.2 2.3 2.3 2.2 2.1",
      "vertical axis should step one at a time, got: " + trail.join(" "));
  });

  // A theme derived from the default before the drilldown chevron became a
  // real element keeps the old pseudo-element rule, and that rule still
  // paints: the deck then shows two chevrons a few pixels apart on every
  // spine slide with details. Nothing else in the build can see this, because
  // one chevron comes from the theme and the other from the renderer.
  test("a theme carrying the old chevron rule is warned about", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-stale-chevron-"));
    fs.writeFileSync(
      path.join(dir, "theme.css"),
      `.slide { background: #fff; }
       .slide-has-details::after {
         content: "\\2304";
         position: absolute;
         bottom: 18px;
       }`
    );
    const warnings = loadTheme(dir, path.join(__dirname, "..", "themes", "default")).warnings;
    assert(
      warnings.some((w) => /slide-has-details::after/.test(w)),
      "expected a stale-chevron warning, got: " + JSON.stringify(warnings)
    );
  });

  test("the shipped theme does not trip the stale chevron warning", () => {
    // Guards the guard: a false positive here would cry wolf on every build.
    const warnings = loadTheme(path.join(__dirname, "..", "themes", "default")).warnings;
    assert(warnings.length === 0, "default theme should load clean, got: " + JSON.stringify(warnings));
  });

  test("a theme that only mentions the old rule in a comment is left alone", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-chevron-comment-"));
    fs.writeFileSync(
      path.join(dir, "theme.css"),
      `/* Was: .slide-has-details::after { content: "x"; } — now .nav-down. */
       .slide { background: #fff; }`
    );
    const warnings = loadTheme(dir, path.join(__dirname, "..", "themes", "default")).warnings;
    assert(warnings.length === 0, "documenting the old rule is not using it: " + JSON.stringify(warnings));
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

  test("a connector is drawn for a slide that was hidden until the harvest asked", async () => {
    // The connectors slide is not the one that is up when the page loads, and
    // a display:none slide has no boxes to measure against — so these exist
    // only because the harvest makes each slide visible and then calls for the
    // lines. A fixture whose connector slide happened to be the active one
    // would pass with the call removed.
    const geometry = await geometryPromise;
    const slide = geometry.slides.find((sl) => sl.id === "connectors-slide");
    assert(slide, "the example deck has a connectors slide");
    const runs = slide.atoms.filter((a) => a.kind === "box" && /\bsdoc-conn\b/.test(a.cls || ""));
    // Not a count of runs. How many a connector becomes is a function of the
    // theme and the example's own layout — under this harness's theme the
    // cards are not columns, so the two neighbour links span the slide and the
    // two elbows collapse to one upright. What this test is for is that
    // resolution ran at all for a slide that was never the active one, so: any
    // run, and one dot per declared node, which routing cannot collapse away.
    const dots = runs.filter((a) => /\bsdoc-conn-dot\b/.test(a.cls || ""));
    assert(runs.length >= 1, `the runs reach the harvest, got ${runs.length}`);
    assert(dots.length === 2, `one dot per declared node, got ${dots.length}`);
    assert(runs.every((a) => a.fill), "each one is painted: " + JSON.stringify(runs.map((a) => a.fill)));
    // Every run is a stroke: thin on one axis, long on the other. A routing
    // failure shows up here as a box that is large both ways.
    assert(
      runs.every((a) => Math.min(a.box.w, a.box.h) <= 12),
      "none of them is a block: " + JSON.stringify(runs.map((a) => [a.box.w, a.box.h]))
    );
    // The colour is the theme's, resolved. This harness's theme declares no
    // accent, so every run falls back through --sdoc-connector-color and
    // --sdoc-accent to the slide's own text colour — which is the chain
    // working, and what a theme that does declare one overrides.
    assert(runs.every((a) => a.fill === "C0C0C0"),
      "the theme's colour reached the runs: " + [...new Set(runs.map((a) => a.fill))].join(", "));
  });

  test("a connector is placed in design pixels whatever the window scale", async () => {
    // A deck is scaled to the window with a transform on .slide, so a client
    // rect is in WINDOW pixels while the boxes an absolutely positioned child
    // is placed with are in design pixels. Reading one as the other is the
    // standing trap in this repo — it is written down against the harvests —
    // and here it would put every connector at a fraction of where it belongs,
    // correctly on a maximised window and wrongly on any other.
    //
    // So the same slide is resolved at three scales and the inline geometry
    // the runtime writes has to come out identical.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-connscale-"));
    const file = path.join(dir, "scale.html");
    const defaultTheme = loadTheme(path.join(__dirname, "..", "themes", "default"));
    const src = `
# Scaled {
    @meta {
        type: slides
    }

    # Pair @pair {
        config: columns

        # Alpha @s-alpha {
            One.
        }

        # Beta @s-beta {
            Two.
        }

        # @connectors {
            {
                from: @s-alpha right

                to: @s-beta left

                shape: straight

                node: both
            }
        }
    }
}`;
    const parsedScale = parseSdoc(src);
    assert(parsedScale.errors.length === 0, "fixture parses");
    const metaScale = extractMeta(parsedScale.nodes);
    fs.writeFileSync(file, renderSlides(metaScale.nodes, {
      meta: metaScale.meta,
      themeCss: defaultTheme.themeCss,
      themeJs: defaultTheme.themeJs,
      themeConfig: defaultTheme.themeConfig,
    }), "utf-8");

    const SCRIPT = `
(function () {
  function run() {
    var slide = document.querySelector(".slide");
    slide.classList.add("active");
    var out = [];
    var scales = ["1", "0.5", "0.37"];
    for (var i = 0; i < scales.length; i++) {
      document.documentElement.style.setProperty("--sdoc-slide-scale", scales[i]);
      document.documentElement.style.setProperty("--sdoc-slide-scale-y", scales[i]);
      window.sdocConnectors.resolve(slide);
      var segs = slide.querySelectorAll(".sdoc-conn");
      var styles = [];
      for (var j = 0; j < segs.length; j++) styles.push(segs[j].getAttribute("style"));
      out.push({ scale: scales[i], styles: styles });
    }
    var el = document.createElement("script");
    el.type = "application/json";
    el.id = "connscale";
    el.textContent = JSON.stringify({ runs: out }) + "\\n/*${SENTINEL}*/";
    document.body.appendChild(el);
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { requestAnimationFrame(run); });
  else requestAnimationFrame(run);
})();
`;
    try {
      const { runHarvest } = require("../src/slide-geometry.js");
      const data = await runHarvest(file, SCRIPT, "connscale", {});
      const runs = data.runs;
      assert(runs.length === 3, "three scales measured");
      assert(runs[0].styles.length >= 3, "the run and its two nodes were drawn: " + runs[0].styles.length);
      for (let i = 1; i < runs.length; i++) {
        assert(
          JSON.stringify(runs[i].styles) === JSON.stringify(runs[0].styles),
          `scale ${runs[i].scale} moved the connector:\n  at 1:   ${runs[0].styles.join(" | ")}\n  at ${runs[i].scale}: ${runs[i].styles.join(" | ")}`
        );
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an accent on a connector beats the theme's default, as it does elsewhere", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-connaccent-"));
    const file = path.join(dir, "accent.html");
    const defaultTheme = loadTheme(path.join(__dirname, "..", "themes", "default"));
    const src = `
# Accented {
    @meta {
        type: slides
    }

    # Two lines @pair {
        config: columns

        # Alpha @a-alpha {
            One.
        }

        # Beta @a-beta {
            Two.
        }

        # @connectors {
            {
                from: @a-alpha right

                to: @a-beta left

                shape: straight
            }

            {
                from: @a-alpha bottom-center

                to: @a-beta bottom-center

                shape: vh

                accent: secondary
            }
        }
    }
}`;
    const parsedAcc = parseSdoc(src);
    assert(parsedAcc.errors.length === 0, "fixture parses");
    const metaAcc = extractMeta(parsedAcc.nodes);
    fs.writeFileSync(file, renderSlides(metaAcc.nodes, {
      meta: metaAcc.meta,
      themeCss: defaultTheme.themeCss,
      themeJs: defaultTheme.themeJs,
      themeConfig: defaultTheme.themeConfig,
    }), "utf-8");
    try {
      const geometry = await harvestGeometry(file);
      const runs = (geometry.slides[0].atoms || [])
        .filter((a) => a.kind === "box" && /\bsdoc-conn\b/.test(a.cls || ""));
      assert(runs.length >= 2, "both connectors drew: " + runs.length);
      const plain = runs.filter((a) => !/accent-secondary/.test(a.cls || ""));
      const accented = runs.filter((a) => /accent-secondary/.test(a.cls || ""));
      assert(plain.length && accented.length, "one of each: " + JSON.stringify(runs.map((a) => a.cls)));
      assert(plain.every((a) => a.fill === plain[0].fill), "the unaccented ones agree");
      assert(accented.every((a) => a.fill === accented[0].fill), "the accented ones agree");
      assert(plain[0].fill !== accented[0].fill,
        `the accent changes the colour: ${plain[0].fill} vs ${accented[0].fill}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a rotated box carries its angle into the PPTX instead of its bounding box", async () => {
    // A diagonal connector is one rectangle rotated about its centre. Measured
    // with getBoundingClientRect it is the axis-aligned box it occupies, which
    // for a long thin bar is most of the slide — and PowerPoint would then be
    // handed a solid block with no rotation and nothing to say so.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-rot-"));
    const file = path.join(dir, "rot.html");
    const defaultTheme = loadTheme(path.join(__dirname, "..", "themes", "default"));
    const src = `
# Rot {
    @meta {
        type: slides
    }

    # Diagonal @diag {
        config: columns

        # Alpha @r-alpha {
            One.
        }

        # Beta @r-beta {
            Two.
        }

        # @connectors {
            {
                from: @r-alpha bottom-center

                to: @r-beta top-left

                shape: straight
            }
        }
    }
}`;
    const parsedRot = parseSdoc(src);
    assert(parsedRot.errors.length === 0, "fixture parses");
    const metaRot = extractMeta(parsedRot.nodes);
    fs.writeFileSync(file, renderSlides(metaRot.nodes, {
      meta: metaRot.meta,
      themeCss: defaultTheme.themeCss,
      themeJs: defaultTheme.themeJs,
      themeConfig: defaultTheme.themeConfig,
    }), "utf-8");
    try {
      const geometry = await harvestGeometry(file);
      const runs = (geometry.slides[0].atoms || [])
        .filter((a) => a.kind === "box" && /\bsdoc-conn\b/.test(a.cls || ""));
      assert(runs.length === 1, "one run: " + JSON.stringify(runs.map((a) => a.box)));
      const bar = runs[0];
      assert(bar.box.rot !== undefined && Math.abs(bar.box.rot) > 0.5,
        "the angle is measured: " + JSON.stringify(bar.box));
      assert(bar.box.h <= 6, "and the box is the upright stroke, not what it covers: " + bar.box.h);

      const { buffer } = buildPptx(geometry, { baseDir: dir, title: "Rot" });
      const zlib = require("zlib");
      const text = buffer.toString("latin1");
      const at = text.indexOf("ppt/slides/slide1.xml");
      assert(at > 0, "slide1 entry found");
      const start = at - 30;
      const size = buffer.readUInt32LE(start + 18);
      const nameLen = buffer.readUInt16LE(start + 26);
      const extraLen = buffer.readUInt16LE(start + 28);
      const body = buffer.slice(start + 30 + nameLen + extraLen, start + 30 + nameLen + extraLen + size);
      const xml = zlib.inflateRawSync(body).toString("utf-8");
      // PowerPoint measures rotation in sixtieth-thousandths of a degree.
      const spun = /<a:xfrm rot="(\d+)"/.exec(xml);
      assert(spun, "a rotated shape reaches the package: " + xml.slice(0, 300));
      const degrees = parseInt(spun[1], 10) / 60000;
      const want = ((bar.box.rot % 360) + 360) % 360;
      assert(Math.abs(degrees - want) < 0.5, `at the measured angle (${want}): ${degrees}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
console.log("\n--- A decorative drawing is not content ---");

if (!findChrome()) {
  console.log("  SKIP: Chrome not found");
} else {
  test("a full-bleed aria-hidden drawing does not report an overflow", async () => {
    // Rasterising an <svg> so it survives the export turned a theme's
    // decorative overlay — connector lines drawn across the whole slide — into
    // a slide-sized content atom. The content extent then became the whole
    // slide, and every side reported an overflow by exactly the padding, on a
    // deck whose layout had not changed by a byte. Same reasoning as the
    // footer and the background: exported, but not counted.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-decor-"));
    writeTestTheme(dir);
    const theme = loadTheme(path.join(dir, "theme"));
    const parsed = parseSdoc(
      "# Deck {\n    # Slide {\n        Body copy well inside the margins.\n\n        ```svg\n" +
      '        <svg viewBox="0 0 1920 1080" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">\n' +
      '        <line x1="0" y1="0" x2="1920" y2="1080" stroke="#888" stroke-width="2"/>\n' +
      "        </svg>\n        ```\n    }\n}"
    );
    assert(parsed.errors.length === 0, "fixture parses");
    const { nodes, meta } = extractMeta(parsed.nodes);
    const htmlPath = path.join(dir, "deck.html");
    fs.writeFileSync(htmlPath, renderSlides(nodes, {
      meta, themeCss: theme.themeCss, themeJs: theme.themeJs, themeConfig: theme.themeConfig,
    }), "utf-8");
    try {
      const geometry = await harvestGeometry(htmlPath);
      const findings = overflowReport(geometry);
      assert(findings.length === 0,
        "a decoration should not overflow: " + JSON.stringify(findings));
      // And it is still exported — not counted is not the same as not carried.
      const atoms = geometry.slides[0].atoms || [];
      const pictures = atoms.filter((a) => a.kind === "image");
      assert(pictures.length >= 1, "the drawing still reaches the export");
      assert(pictures.every((a) => a.chrome === true), "and is marked as chrome");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

// ============================================================
Promise.all(asyncTests).then(() => {
  console.log("\n" + "=".repeat(40));
  console.log(`Results: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
});
