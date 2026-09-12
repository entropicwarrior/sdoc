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
]);

const LAYOUT_KEYS = {
  columns: ["numbered", "variant"],
  "two-column": ["numbered", "variant"],
  stats: [],
  pipeline: ["arrow"],
  matrix: ["highlight"],
  rows: ["numbered", "variant"],
  bars: [],
  split: ["weights"],
  stack: ["rule"],
};

const CELL_KEYS = {
  columns: ["caption"],
  "two-column": ["caption"],
  rows: ["value"],
  bars: ["value", "fill"],
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
      return `<div class="column${accentClass(cell.config.accent)}">${parts.join("\n")}</div>`;
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
      return `<div class="stat${accentClass(cell.config.accent)}">${parts.join("\n")}</div>`;
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
      return `<div class="pipe-row${accentClass(cell.config.accent)}">${label}\n<div class="pipe-steps">${pieces.join("")}</div>${restHtml}</div>`;
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
      return `<div class="row${accentClass(cell.config.accent)}">${parts.join("\n")}</div>`;
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
        `<div class="bar${accentClass(cell.config.accent)}">`,
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
      return `<div class="pane" style="flex:${weight} 1 0">${renderBlock(cell, ctx)}</div>`;
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
    .map((cell) => `<div class="stack-block">${renderBlock(cell, ctx)}</div>`)
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
  CONFIG_KEYS,
  STRUCTURED_LAYOUTS,
  extractConfig,
  buildBody,
  accentClass,
  slug,
  truthy,
};
