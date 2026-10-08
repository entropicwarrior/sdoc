// SDOC Slide Layouts — structured layout builders.
//
// A slide's `config:` line names a layout. The default, `center` and
// `two-column` layouts need no structure beyond the content itself; the
// layouts in this module consume the slide's *child scopes* and arrange them
// into a known shape (columns, stats, a pipeline, a comparison matrix, and so
// on). Every builder emits plain semantic HTML with stable class names; all
// visual decisions belong to the theme.
//
// Layouts compose. `split` renders two child scopes as panes and `stack`
// renders each child scope as a block, and in both cases the child scope may
// name its own layout with its own `config:` line. That is how a slide carries
// a pipeline above a set of numbered columns without a bespoke layout for the
// combination.
//
// The renderer injects its own callbacks (renderChildren, renderInline,
// escapeHtml) so this module stays free of parser and KaTeX dependencies.

const { RE_ENDPOINT } = require("./slide-connectors");

// Configuration is a leading run of `key: value` paragraphs. Which keys a
// scope actually understands depends on where it sits, and a key it does not
// understand stays content rather than disappearing — a slide opening with
// "Value: the customer keeps their data." is prose, not configuration.
//
// COMMON_KEYS   every scope understands, whatever layout it names
// LAYOUT_KEYS   a scope understands because of the layout it names itself
// CELL_KEYS     a scope understands because of the layout its *parent* names
const COMMON_KEYS = new Set([
  "config",
  "layout",
  "kicker",
  "lede",
  "footnote",
  "accent",
  "status",
  "optional",
  // A background is slide furniture, like a kicker or a footnote: it belongs
  // to the slide rather than to the shape its content is arranged in, so it
  // lives here and works under every layout instead of being listed against a
  // handful of them.
  "background",
  "background-position",
  "background-size",
  "background-fade",
  "background-flip",
  "background-scale",
]);

const LAYOUT_KEYS = {
  columns: ["numbered", "variant"],
  "two-column": ["numbered", "variant"],
  stats: [],
  pipeline: ["arrow"],
  matrix: ["highlight"],
  rows: ["numbered", "variant"],
  bars: [],
  scatter: ["x", "y", "x-ends", "y-ends", "quadrants"],
  split: ["weights"],
  stack: ["rule"],
};

const CELL_KEYS = {
  columns: ["caption"],
  // A connector, which is a cell of the reserved @connectors scope. That scope
  // names no layout of its own, so the renderer reads its children with
  // "connectors" as the parent layout and these keys are understood there and
  // nowhere else — a slide opening "To: the board" is still prose.
  connectors: ["from", "to", "shape", "node"],
  "two-column": ["caption"],
  rows: ["value"],
  bars: ["value", "fill"],
  scatter: ["at", "caption", "label"],
};

// Keys whose value is a boolean. Every other key renders the text it is given,
// so consuming the line is visible in the output; a boolean key discards
// anything it does not recognise, which would make an opening sentence
// disappear. These therefore only take the line when the value is a word they
// actually understand — "Optional: a second seat costs nothing" is prose.
const BOOLEAN_KEYS = new Set(["optional", "numbered", "rule", "quadrants"]);
const BOOLEAN_WORDS = new Set([
  "true", "yes", "on", "1",
  "false", "no", "off", "0",
]);

// The same guard, generalised twice over.
//
// ENUM_KEYS: the value must be one of a fixed set of words. `label:` on a
// scatter point names a side, so "Label: the legend is wrong" stays the prose
// it is rather than becoming a dead class, and "Background-flip: the chart was
// mirrored by mistake" does the same.
//
// VALUE_SHAPES: the value must look like the kind of thing the key takes.
// `background:` is the one key here whose name is also an ordinary English
// sentence opener — "Background: we started in 2019." is a line a deck really
// does contain — and swallowing it would delete the sentence and then try to
// load it as a picture. A background only takes the line when the value names
// an image: a file with a picture extension, a data: URI, or a URL.
const ENUM_KEYS = {
  label: new Set(["above", "below", "left", "right"]),
  shape: new Set(["vh", "hv", "elbow", "straight"]),
  node: new Set(["none", "start", "end", "both"]),
  "background-flip": new Set(["horizontal", "vertical", "both", "none"]),
};

const VALUE_SHAPES = {
  // "From:" and "To:" are ordinary English sentence openers, so they take the
  // line only when the value is an element and a point rather than a phrase.
  // The pattern is the connector module's own rather than a copy of it: two
  // readings of what an endpoint looks like would be one to get wrong.
  from: RE_ENDPOINT,
  to: RE_ENDPOINT,
  background: /(?:\.(?:png|jpe?g|gif|svg|webp|avif|bmp|ico)(?:[?#].*)?$)|^data:image\/|^(?:https?:)?\/\//i,
  "background-scale": /^\d*\.?\d+%?$/,
};

// Every key any scope might understand. A leading paragraph opening with one
// of these is a configuration *candidate*; whether it is kept depends on the
// context resolved below.
const CONFIG_KEYS = new Set([
  ...COMMON_KEYS,
  ...Object.values(LAYOUT_KEYS).flat(),
  ...Object.values(CELL_KEYS).flat(),
]);

// Layouts that consume child scopes as structure rather than rendering them
// inline as nested sections.
const STRUCTURED_LAYOUTS = new Set(Object.keys(LAYOUT_KEYS));

function truthy(value) {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  const v = value.trim().toLowerCase();
  return v === "true" || v === "yes" || v === "on" || v === "1";
}

function escapeAttrValue(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// An author-supplied word reduced to something safe to concatenate into a
// class name. Anything outside [a-z0-9-] is dropped, so no configuration value
// can close the attribute it lands in.
function slug(value) {
  if (!value) return "";
  return String(value).trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
}

// The id an author declared on a cell scope, as an attribute, or "" when they
// declared none. This is what makes a cell addressable: a connector names its
// ends by id, and before this the only id in a built deck was the slide's.
function idAttr(cell) {
  const id = cell && cell.scope && cell.scope.id ? String(cell.scope.id).trim() : "";
  return id ? ` id="${escapeAttrValue(id)}"` : "";
}

// The class for a named variant of a layout, or "" when none was named.
function variantClass(value) {
  const name = slug(value);
  return name ? ` variant-${name}` : "";
}

// Splits a leading run of `key: value` paragraphs off a scope's children.
//
// Two passes, because which keys are meaningful depends on the layout the
// scope names and the layout its parent named, and `config:` may come after
// another key. Pass one collects candidates; pass two keeps the ones this
// context understands and hands the rest back as content, in source order.
// Nothing an author wrote is ever dropped on the floor.
//
// `parentLayout` is the layout of the scope this one is a cell of, or null
// for a slide (which is nobody's cell).
function extractConfig(children, parentLayout) {
  const candidates = [];
  const contentNodes = [];
  let pastConfig = false;

  for (const child of children || []) {
    if (!pastConfig && child.type === "paragraph") {
      // No `s` or `m` flag: a paragraph spanning several source lines is
      // content, never configuration.
      const match = child.text.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.+)$/);
      if (match && CONFIG_KEYS.has(match[1].toLowerCase())) {
        candidates.push({ key: match[1].toLowerCase(), value: match[2].trim(), node: child });
        continue;
      }
    }
    pastConfig = true;
    contentNodes.push(child);
  }

  // Last one wins, the same rule the assignment loop below follows, so the
  // keys allowed and the layout finally set can never disagree.
  const named = candidates.filter((c) => c.key === "config" || c.key === "layout").pop();
  const layout = named ? named.value.toLowerCase() : "";

  const allowed = new Set(COMMON_KEYS);
  for (const key of LAYOUT_KEYS[layout] || []) allowed.add(key);
  for (const key of CELL_KEYS[parentLayout] || []) allowed.add(key);

  const config = {};
  const rejected = [];
  for (const candidate of candidates) {
    if (!allowed.has(candidate.key)) {
      rejected.push(candidate.node);
      continue;
    }
    if (
      BOOLEAN_KEYS.has(candidate.key) &&
      !BOOLEAN_WORDS.has(candidate.value.trim().toLowerCase())
    ) {
      rejected.push(candidate.node);
      continue;
    }
    const words = ENUM_KEYS[candidate.key];
    if (words && !words.has(candidate.value.trim().toLowerCase())) {
      rejected.push(candidate.node);
      continue;
    }
    const shape = VALUE_SHAPES[candidate.key];
    if (shape && !shape.test(candidate.value.trim())) {
      rejected.push(candidate.node);
      continue;
    }
    if (candidate.key === "config" || candidate.key === "layout") {
      config.layout = candidate.value.toLowerCase();
    } else {
      config[candidate.key] = candidate.value;
    }
  }

  return { config, contentNodes: rejected.concat(contentNodes) };
}

// A child scope, read as a structural cell of `parentLayout`: its own config,
// its own content.
function readCell(scope, parentLayout) {
  const { config, contentNodes } = extractConfig(scope.children, parentLayout);
  return {
    scope,
    config,
    contentNodes,
    title: scope.hasHeading !== false && scope.title ? scope.title : null,
  };
}

// Child scopes of a structured layout, excluding comment scopes. Speaker notes
// and drilldown details are removed by the renderer before a builder sees the
// slide, but only at slide level: a `@notes` scope nested inside a cell is an
// ordinary nested scope and renders visibly, as it always has.
function cellsOf(contentNodes, parentLayout) {
  return contentNodes
    .filter((n) => n.type === "scope" && n.scopeType !== "comment")
    .map((scope) => readCell(scope, parentLayout));
}

function nonCellsOf(contentNodes) {
  return contentNodes.filter((n) => n.type !== "scope" || n.scopeType === "comment");
}

function twoDigit(n) {
  return n < 10 ? "0" + n : String(n);
}

// ---------------------------------------------------------------------------
// Builders
//
// Each builder receives ({ config, contentNodes }, ctx) where ctx carries the
// renderer callbacks, and returns the HTML for the slide body.
// ---------------------------------------------------------------------------

function accentClass(value) {
  const name = slug(value);
  return name ? ` accent-${name}` : "";
}

// columns — N child scopes side by side.
//   numbered: true   prefix each column with 01, 02, 03…
//   variant: card    a bordered panel per column
//   variant: panel   a filled panel per column
function buildColumns({ config, contentNodes }, ctx) {
  const cells = cellsOf(contentNodes, "columns");
  const preamble = ctx.renderChildren(nonCellsOf(contentNodes));
  const numbered = truthy(config.numbered);
  const variant = variantClass(config.variant);

  const columns = cells
    .map((cell, i) => {
      const parts = [];
      if (numbered) {
        parts.push(`<div class="col-index">${twoDigit(i + 1)}</div>`);
      }
      if (cell.config.kicker) {
        parts.push(`<div class="col-kicker">${ctx.renderInline(cell.config.kicker)}</div>`);
      }
      if (cell.title) {
        parts.push(`<h3>${ctx.renderInline(cell.title)}</h3>`);
      }
      parts.push(ctx.renderChildren(cell.contentNodes));
      if (cell.config.caption) {
        parts.push(`<div class="col-caption">${ctx.renderInline(cell.config.caption)}</div>`);
      }
      return `<div class="column${accentClass(cell.config.accent)}"${idAttr(cell)}>${parts.join("\n")}</div>`;
    })
    .join("\n");

  const body = `<div class="columns cols-${cells.length}${variant}" data-count="${cells.length}">\n${columns}\n</div>`;
  return preamble ? preamble + "\n" + body : body;
}

// stats — N child scopes as figure + caption.
// The scope title is the figure; its content is the caption beneath it.
function buildStats({ config, contentNodes }, ctx) {
  const cells = cellsOf(contentNodes, "stats");
  const trailing = ctx.renderChildren(nonCellsOf(contentNodes));

  const stats = cells
    .map((cell) => {
      const parts = [];
      if (cell.title) {
        parts.push(`<div class="stat-value">${ctx.renderInline(cell.title)}</div>`);
      }
      const caption = ctx.renderChildren(cell.contentNodes);
      if (caption) parts.push(`<div class="stat-label">${caption}</div>`);
      return `<div class="stat${accentClass(cell.config.accent)}"${idAttr(cell)}>${parts.join("\n")}</div>`;
    })
    .join("\n");

  const body = `<div class="stats stats-${cells.length}" data-count="${cells.length}">\n${stats}\n</div>`;
  return trailing ? body + "\n" + trailing : body;
}

// pipeline — one or more chains of steps, drawn as pills joined by arrows.
//   arrow: >    the glyph between steps (default →)
//
// Each child scope is a row: its title is the row label, its bullet list the
// steps. A step written entirely in bold is *marked* and takes the row's
// accent; every other step is neutral. The distinction is semantic — where a
// slide sets two paths against each other, the marks are the steps a path
// cannot avoid — so authors mark meaning and the theme supplies the colour.
// A step is marked when the whole of it is one bold span. `**A** and **B**`
// also opens and closes with `**`, so the interior is checked too: stripping
// the outer pair there would leave `A** and **B`, which re-parses with its
// emphasis inverted.
function markedText(text) {
  if (!/^\*\*[\s\S]+\*\*$/.test(text)) return null;
  const inner = text.slice(2, -2);
  return inner.includes("**") ? null : inner.trim();
}

function stepsOfRow(cell) {
  const list = cell.contentNodes.find((n) => n.type === "list");
  if (!list) return [];
  return list.items.map((item) => {
    const text = (item.title || "").trim();
    const marked = markedText(text);
    return { text: marked === null ? text : marked, marked: marked !== null };
  });
}

function buildPipeline({ config, contentNodes }, ctx) {
  const cells = cellsOf(contentNodes, "pipeline");
  const preamble = ctx.renderChildren(nonCellsOf(contentNodes));
  // `arrow:`, not `rule:` — `rule:` is the stack's hairline flag, and one key
  // meaning a boolean in one layout and a glyph in another put the word
  // "true" between every step.
  const arrow = config.arrow && config.arrow.trim() ? config.arrow.trim() : "→";

  const rows = cells
    .map((cell) => {
      const steps = stepsOfRow(cell);
      const pieces = [];
      steps.forEach((step, i) => {
        if (i > 0) pieces.push(`<div class="pipe-arrow" aria-hidden="true">${ctx.escapeHtml(arrow)}</div>`);
        pieces.push(
          `<div class="pipe-step${step.marked ? " is-marked" : ""}"><span>${ctx.renderInline(step.text)}</span></div>`
        );
      });
      const label = cell.title
        ? `<div class="pipe-label">${ctx.renderInline(cell.title)}</div>`
        : "";
      // Content other than the step list (a note under the row, say) follows.
      const rest = ctx.renderChildren(cell.contentNodes.filter((n) => n.type !== "list"));
      const restHtml = rest ? `\n<div class="pipe-note">${rest}</div>` : "";
      return `<div class="pipe-row${accentClass(cell.config.accent)}"${idAttr(cell)}>${label}\n<div class="pipe-steps">${pieces.join("")}</div>${restHtml}</div>`;
    })
    .join("\n");

  const body = `<div class="pipeline">\n${rows}\n</div>`;
  return preamble ? preamble + "\n" + body : body;
}

// matrix — a comparison table whose column headers alternate accents and in
// which one row may be highlighted.
//   highlight: last            highlight the final row
//   highlight: Our company     highlight the row whose first cell contains this
function buildMatrix({ config, contentNodes }, ctx) {
  const table = contentNodes.find((n) => n.type === "table");
  if (!table) return ctx.renderChildren(contentNodes);
  const rest = ctx.renderChildren(contentNodes.filter((n) => n !== table));

  const highlight = (config.highlight || "").trim();
  const highlightLast = highlight.toLowerCase() === "last";
  const needle = highlightLast ? null : highlight.toLowerCase();

  const thead = table.headers.length
    ? `<thead><tr>${table.headers
        .map((cell, i) => `<th class="col-${i % 2 === 0 ? "a" : "b"}">${ctx.renderInline(cell)}</th>`)
        .join("")}</tr></thead>`
    : "";

  const lastIndex = table.rows.length - 1;
  const tbody = table.rows
    .map((row, r) => {
      const first = (row[0] || "").toLowerCase();
      const isHighlight =
        (highlightLast && r === lastIndex) || (needle && needle.length > 0 && first.includes(needle));
      const cells = row
        .map((cell, i) => `<td class="col-${i % 2 === 0 ? "a" : "b"}">${ctx.renderInline(cell)}</td>`)
        .join("");
      return `<tr${isHighlight ? ' class="is-highlight"' : ""}>${cells}</tr>`;
    })
    .join("\n");

  const body = `<div class="matrix"><table>${thead}\n<tbody>\n${tbody}\n</tbody></table></div>`;
  return rest ? body + "\n" + rest : body;
}

// rows — a stack of label / body / value rows separated by hairlines.
//   numbered: true     prefix each row with 01, 02, 03…
//   variant: mono      the label is a monospace accent (a date, a node, a stage)
// Each child scope: title is the label, `value:` the right-hand figure, the
// remaining content the description.
function buildRows({ config, contentNodes }, ctx) {
  const cells = cellsOf(contentNodes, "rows");
  const preamble = ctx.renderChildren(nonCellsOf(contentNodes));
  const numbered = truthy(config.numbered);
  const variant = variantClass(config.variant);

  const rows = cells
    .map((cell, i) => {
      const parts = [];
      if (numbered) parts.push(`<div class="row-index">${twoDigit(i + 1)}</div>`);
      if (cell.title) parts.push(`<div class="row-label">${ctx.renderInline(cell.title)}</div>`);
      const body = ctx.renderChildren(cell.contentNodes);
      if (body) parts.push(`<div class="row-body">${body}</div>`);
      if (cell.config.value) {
        parts.push(`<div class="row-value">${ctx.renderInline(cell.config.value)}</div>`);
      }
      return `<div class="row${accentClass(cell.config.accent)}"${idAttr(cell)}>${parts.join("\n")}</div>`;
    })
    .join("\n");

  const body = `<div class="rows${variant}" data-count="${cells.length}">\n${rows}\n</div>`;
  return preamble ? preamble + "\n" + body : body;
}

// bars — labelled quantities drawn as proportional bars.
// Each child scope: title is the label, `value:` the figure shown at the right,
// `fill:` the bar length as a percentage, and the content a note beneath.
// With no `fill:`, bars are scaled against the largest numeric `value:`.
function parseNumber(text) {
  if (!text) return null;
  const match = String(text).replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return match ? parseFloat(match[0]) : null;
}

function buildBars({ config, contentNodes }, ctx) {
  const cells = cellsOf(contentNodes, "bars");
  const preamble = ctx.renderChildren(nonCellsOf(contentNodes));

  const magnitudes = cells.map((cell) => parseNumber(cell.config.value));
  const peak = Math.max(...magnitudes.filter((n) => typeof n === "number" && isFinite(n)), 0);

  const bars = cells
    .map((cell, i) => {
      let fill = parseNumber(cell.config.fill);
      if (fill === null) {
        const magnitude = magnitudes[i];
        fill = peak > 0 && magnitude !== null ? (magnitude / peak) * 100 : 0;
      }
      fill = Math.max(0, Math.min(100, fill));
      const head = [];
      if (cell.title) head.push(`<div class="bar-label">${ctx.renderInline(cell.title)}</div>`);
      if (cell.config.value) head.push(`<div class="bar-value">${ctx.renderInline(cell.config.value)}</div>`);
      const note = ctx.renderChildren(cell.contentNodes);
      return [
        `<div class="bar${accentClass(cell.config.accent)}"${idAttr(cell)}>`,
        `<div class="bar-head">${head.join("")}</div>`,
        `<div class="bar-track"><div class="bar-fill" style="width:${fill.toFixed(2)}%"></div></div>`,
        note ? `<div class="bar-note">${note}</div>` : "",
        `</div>`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");

  const body = `<div class="bars" data-count="${cells.length}">\n${bars}\n</div>`;
  return preamble ? preamble + "\n" + body : body;
}

// scatter — labelled points placed on two named axes: the positioning chart.
//   x: / y:            the axis names
//   x-ends: / y-ends:  the two ends of an axis, low | high
//   quadrants: true    dividers through the midpoint
// Each child scope is a point: its heading is the label, `at: X Y` its
// position, `caption:` a line under the label, and `label:` the side the text
// sits on when two points would otherwise collide.
//
// A point whose heading is entirely bold is *marked*, the same rule a pipeline
// step follows and for the same reason: on a positioning chart, which point is
// yours is the argument the slide makes, so it lives in the source as a mark
// rather than as a colour the author picks. Restyling the deck cannot lose it.
//
// Coordinates are percentages of the plot area with the origin at the
// bottom-left, so y counts *upward* — the author writes the axis they named,
// not the direction CSS happens to measure in. The point is emitted with
// `bottom:`, so no arithmetic stands between the source and the box.
//
// Everything here is a div. The geometry harvest reads boxes, text and images,
// so an axis drawn in SVG would export to PowerPoint as nothing at all, and
// rotated text would export as horizontal text in a tall narrow box. The axis
// rules are therefore borders and the y-axis labels sit horizontally in a
// gutter beside the plot.
function axisEnds(value) {
  if (!value) return null;
  const parts = String(value).split("|").map((p) => p.trim());
  if (parts.length < 2) return null;
  return { low: parts[0], high: parts[1] };
}

// `at: 20 80` — two numbers, separated the way `weights:` separates its own.
// A point with nothing usable sits at the centre: an author can see and move a
// point in the middle of the plot, where one silently dropped is just missing.
function parsePosition(value) {
  const parts = String(value || "")
    .split(/[\s,/]+/)
    .map((p) => parseFloat(p))
    .filter((n) => isFinite(n));
  const clamp = (n) => Math.max(0, Math.min(100, n));
  return {
    x: parts.length > 0 ? clamp(parts[0]) : 50,
    y: parts.length > 1 ? clamp(parts[1]) : 50,
  };
}

function buildScatter({ config, contentNodes }, ctx) {
  const cells = cellsOf(contentNodes, "scatter");
  const preamble = ctx.renderChildren(nonCellsOf(contentNodes));

  const points = cells
    .map((cell) => {
      const { x, y } = parsePosition(cell.config.at);
      const title = cell.title || "";
      const marked = markedText(title);
      const placement = slug(cell.config.label);

      const classes = ["scatter-point"];
      if (marked !== null) classes.push("is-marked");
      if (placement) classes.push(`label-${placement}`);
      const accent = accentClass(cell.config.accent).trim();
      if (accent) classes.push(accent);

      const text = [];
      if (title) {
        text.push(
          `<div class="scatter-label">${ctx.renderInline(marked === null ? title : marked)}</div>`
        );
      }
      if (cell.config.caption) {
        text.push(`<div class="scatter-caption">${ctx.renderInline(cell.config.caption)}</div>`);
      }
      // Content other than the heading and the caption (a note on the point)
      // follows inside the same text block, so nothing an author wrote is lost.
      const rest = ctx.renderChildren(cell.contentNodes);
      if (rest) text.push(`<div class="scatter-note">${rest}</div>`);

      return (
        `<div class="${classes.join(" ")}"${idAttr(cell)} style="left:${x.toFixed(2)}%;bottom:${y.toFixed(2)}%">` +
        `<div class="scatter-dot"></div>` +
        (text.length ? `<div class="scatter-text">${text.join("")}</div>` : "") +
        `</div>`
      );
    })
    .join("\n");

  const dividers = truthy(config.quadrants)
    ? `<div class="scatter-divider scatter-divider-v" aria-hidden="true"></div>` +
      `<div class="scatter-divider scatter-divider-h" aria-hidden="true"></div>`
    : "";

  const xEnds = axisEnds(config["x-ends"]);
  const yEnds = axisEnds(config["y-ends"]);

  // The y gutter reads top to bottom, so the high end comes first.
  const yParts = [];
  if (yEnds) yParts.push(`<div class="scatter-axis-end scatter-y-high">${ctx.renderInline(yEnds.high)}</div>`);
  if (config.y) yParts.push(`<div class="scatter-axis-name">${ctx.renderInline(config.y)}</div>`);
  if (yEnds) yParts.push(`<div class="scatter-axis-end scatter-y-low">${ctx.renderInline(yEnds.low)}</div>`);

  const xParts = [];
  if (xEnds) xParts.push(`<div class="scatter-axis-end scatter-x-low">${ctx.renderInline(xEnds.low)}</div>`);
  if (config.x) xParts.push(`<div class="scatter-axis-name">${ctx.renderInline(config.x)}</div>`);
  if (xEnds) xParts.push(`<div class="scatter-axis-end scatter-x-high">${ctx.renderInline(xEnds.high)}</div>`);

  const body =
    `<div class="scatter" data-count="${cells.length}">\n` +
    `<div class="scatter-axis scatter-axis-y">${yParts.join("")}</div>\n` +
    `<div class="scatter-plot">${dividers}\n${points}\n</div>\n` +
    `<div class="scatter-axis scatter-axis-x">${xParts.join("")}</div>\n` +
    `</div>`;

  return preamble ? preamble + "\n" + body : body;
}

// split — two panes side by side, each a block with its own layout.
//   weights: 55 45   the ratio between them (default 50 50)
function buildSplit({ config, contentNodes }, ctx) {
  const cells = cellsOf(contentNodes, "split");
  const preamble = ctx.renderChildren(nonCellsOf(contentNodes));

  const weights = (config.weights || "")
    .split(/[\s,/]+/)
    .map((w) => parseFloat(w))
    .filter((w) => isFinite(w) && w > 0);

  const panes = cells
    .map((cell, i) => {
      const weight = weights[i] || 1;
      return `<div class="pane"${idAttr(cell)} style="flex:${weight} 1 0">${renderBlock(cell, ctx)}</div>`;
    })
    .join("\n");

  const body = `<div class="split" data-count="${cells.length}">\n${panes}\n</div>`;
  return preamble ? preamble + "\n" + body : body;
}

// stack — child scopes rendered one under another, each with its own layout.
//   rule: true   draw a hairline between blocks
function buildStack({ config, contentNodes }, ctx) {
  const cells = cellsOf(contentNodes, "stack");
  const preamble = ctx.renderChildren(nonCellsOf(contentNodes));
  const ruled = truthy(config.rule) ? " is-ruled" : "";

  const blocks = cells
    .map((cell) => `<div class="stack-block"${idAttr(cell)}>${renderBlock(cell, ctx)}</div>`)
    .join("\n");

  const body = `<div class="stack${ruled}" data-count="${cells.length}">\n${blocks}\n</div>`;
  return preamble ? preamble + "\n" + body : body;
}

const BUILDERS = {
  columns: buildColumns,
  "two-column": buildColumns,
  stats: buildStats,
  pipeline: buildPipeline,
  matrix: buildMatrix,
  rows: buildRows,
  bars: buildBars,
  scatter: buildScatter,
  split: buildSplit,
  stack: buildStack,
};

// Renders a block: a heading if the scope has one, then its layout's body.
// Used for split panes and stack children, which are slides-within-a-slide.
function renderBlock(cell, ctx) {
  const layout = cell.config.layout;
  const parts = [];

  if (cell.config.kicker) {
    parts.push(`<div class="kicker">${ctx.renderInline(cell.config.kicker)}</div>`);
  }
  if (cell.title) {
    parts.push(`<h3>${ctx.renderInline(cell.title)}</h3>`);
  }
  if (cell.config.lede) {
    parts.push(`<p class="lede">${ctx.renderInline(cell.config.lede)}</p>`);
  }

  parts.push(buildBody(layout, cell, ctx));

  if (cell.config.footnote) {
    parts.push(`<div class="footnote">${ctx.renderInline(cell.config.footnote)}</div>`);
  }

  const classes = ["block"];
  const layoutSlug = slug(layout);
  if (layoutSlug) classes.push(`layout-${layoutSlug}`);
  const accent = accentClass(cell.config.accent).trim();
  if (accent) classes.push(accent);

  return `<div class="${classes.join(" ")}"${layout ? ` data-layout="${escapeAttrValue(layout)}"` : ""}>${parts
    .filter(Boolean)
    .join("\n")}</div>`;
}

// The body of a layout: a structured builder if one is named, otherwise the
// content rendered as it stands.
function buildBody(layout, cell, ctx) {
  const builder = layout ? BUILDERS[layout] : null;
  if (builder) return builder(cell, ctx);
  return ctx.renderChildren(cell.contentNodes);
}

module.exports = {
  BOOLEAN_KEYS,
  CONFIG_KEYS,
  STRUCTURED_LAYOUTS,
  extractConfig,
  buildBody,
  accentClass,
  slug,
  truthy,
};
