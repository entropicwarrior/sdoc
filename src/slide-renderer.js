// SDOC Slide Renderer — converts parsed SDOC AST to an HTML slide deck.
//
// Usage:
//   const { parseSdoc, extractMeta } = require("./sdoc");
//   const { renderSlides } = require("./slide-renderer");
//   const parsed = parseSdoc(text);
//   const { nodes, meta } = extractMeta(parsed.nodes);
//   const html = renderSlides(nodes, { meta, themeCss, themeJs });

const fs = require("fs");
const path = require("path");
const {
  parseInline, renderKatex, escapeHtml, escapeAttr, sanitizeSvg, svgBlockIds,
  colorSwatchHtml, RESERVED_SCOPE_IDS, getDocumentScope,
} = require("./sdoc");
const { extractConfig, buildBody, accentClass, slug, truthy } = require("./slide-layouts");
const {
  readConnector,
  CONNECTOR_SCOPE_ID,
  CONNECTOR_JS,
  CONNECTOR_CSS,
} = require("./slide-connectors");
// The deck's shared kit, the presenter view and the drawing tools. Each
// module is written as ordinary JavaScript and serialised into the deck with
// toString(), the way the connector routing is; ink, snap, callout and
// strokes are pure and unit-tested in Node.
const { DECK_KIT_JS } = require("./slide-deck-kit");
const { INK_JS } = require("./slide-ink");
const { SNAP_JS } = require("./slide-snap");
const { CALLOUT_JS } = require("./slide-callout");
const { STROKES_JS } = require("./slide-strokes");
const { ANNOTATE_JS } = require("./slide-annotate");
const { PRESENTER_JS } = require("./slide-presenter");

// ---------------------------------------------------------------------------
// Image inlining
//
// renderSlides emits `<img src>` exactly as the document wrote it, and the
// documentation is explicit that those paths are relative to the .sdoc file.
// A built deck, though, is a single file that gets written wherever -o says
// and then moved, mailed and opened from somewhere else entirely, at which
// point a relative path no longer names anything. The PDF and PPTX exporters
// dodged this by reading the deck from a temp copy beside the input; the HTML
// build had no such trick and silently shipped broken images whenever the
// output went to another directory.
//
// Inlining resolves the paths once, against the .sdoc, and makes the question
// of where the file ends up irrelevant for every format. It is the same thing
// loadTheme already does for a theme's fonts and backgrounds, for the same
// reason, and readImage in slide-pptx.js already decodes data: URIs, so the
// PPTX export embeds them exactly as it did loose files.
//
// This reads from disk, so it is not part of renderSlides: the renderer stays
// a pure AST-to-HTML function and the builder calls this afterwards.
// ---------------------------------------------------------------------------

const INLINE_IMAGE_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};

// Returns { html, inlined, missing }. `missing` describes every local image
// that could not be embedded — the silent failure this exists to stop — as
// { src, resolved, reason }, so the caller can say where it looked and not
// just what it wanted. Naming the resolved path is what makes the rule
// visible at the moment it bites: a deck written against a different
// convention otherwise sees only that a file it can see plainly is "missing".
// A remote or data: URI is neither inlined nor missing: nothing to resolve.
function inlineDeckImages(html, baseDir) {
  const inlined = [];
  const missing = [];

  const out = html.replace(/(<img\b[^>]*?\bsrc=")([^"]*)(")/gi, (match, pre, src, post) => {
    const raw = src.trim();
    if (!raw) return match;
    // Already embedded, or somewhere this build cannot reach.
    if (/^data:/i.test(raw)) return match;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) return match;

    // The src sits in an HTML attribute, so entities are decoded before it is
    // read as a path, and any ?query or #fragment dropped.
    const decoded = raw
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/[?#].*$/, "");

    let filePath;
    try {
      filePath = path.isAbsolute(decoded)
        ? decoded
        : path.resolve(baseDir, decodeURIComponent(decoded));
    } catch {
      filePath = path.isAbsolute(decoded) ? decoded : path.resolve(baseDir, decoded);
    }

    const ext = path.extname(filePath).toLowerCase();
    const mime = INLINE_IMAGE_TYPES[ext];
    if (!mime) {
      missing.push({ src: decoded, resolved: filePath, reason: "unsupported-type" });
      return match;
    }

    let data;
    try {
      data = fs.readFileSync(filePath);
    } catch {
      missing.push({ src: decoded, resolved: filePath, reason: "not-found" });
      return match;
    }

    inlined.push(decoded);
    return `${pre}data:${mime};base64,${data.toString("base64")}${post}`;
  });

  return { html: out, inlined, missing };
}

// ---------------------------------------------------------------------------
// Inline rendering — produces clean HTML without sdoc-* classes
// ---------------------------------------------------------------------------

// Units are case-sensitive; themes are not.
//
// A theme that sets `text-transform: uppercase` on a kicker, a label or a
// caption — the built-in one does it in ten places — renders "40 mW" as
// "40 MW". That is a factor of a billion on a power figure, it is silent, and
// nothing downstream can catch it: the document is correct and only its
// rendering is wrong, so every parser, test and gate sees a healthy deck. It
// was found by a person reading a slide.
//
// The fix travels with the content rather than with the stylesheet: the
// renderer marks the unit, and the structural CSS opts that mark out of case
// folding. A theme gets the protection without knowing it exists, which is the
// only version that works — the theme is exactly the thing that got it wrong.
//
// The symbols are deliberately a closed list. A rule like "any short token
// after a number" would protect ordinary words and quietly stop a deck's
// kickers uppercasing at all.
const SI_PREFIX = "(?:da|Y|Z|E|P|T|G|M|k|h|d|c|m|µ|μ|u|n|p|f|a|z|y)";
const SI_UNIT =
  "(?:mol|kat|bps|bar|rad|Hz|Pa|Wb|lm|lx|Bq|Gy|Sv|eV|Wh|Ah|dB|cd|sr|Ω|m|g|s|A|K|N|J|W|C|V|F|S|T|H|L|l|t|B|b)";
const UNIT_RE = new RegExp(
  `(\\d)(\\s| )?(${SI_PREFIX}?${SI_UNIT})(?![A-Za-z0-9])`,
  "g"
);

// Words that happen to parse as a prefixed unit. "9 am" is a time far more
// often than it is nine attometres, and protecting it would leave a lone
// lowercase "am" in an otherwise uppercased line.
const UNIT_BLOCKLIST = new Set(["am", "pm", "at", "as"]);

function protectUnits(html) {
  return html.replace(UNIT_RE, (match, digit, space, unit) => {
    // Nothing to protect when the symbol is already all caps: "1 MW" is
    // megawatts whether it is folded or not, and a span would only fragment
    // the text run the exporter measures.
    if (unit === unit.toUpperCase()) return match;
    if (UNIT_BLOCKLIST.has(unit.toLowerCase())) return match;
    return `${digit}${space || ""}<span class="sdoc-unit">${unit}</span>`;
  });
}

function renderInlineNodes(nodes) {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
          // Escape first: the span below is markup and must survive.
          return protectUnits(escapeHtml(node.value));
        case "code":
          return `<code>${escapeHtml(node.value)}</code>`;
        case "copyable":
          // Slides have no copy handler; render the literal text as monospace.
          return `<code>${escapeHtml(node.value)}</code>`;
        case "color_swatch":
          return colorSwatchHtml(node.value);
        case "em":
          return `<em>${renderInlineNodes(node.children)}</em>`;
        case "strong":
          return `<strong>${renderInlineNodes(node.children)}</strong>`;
        case "strike":
          return `<del>${renderInlineNodes(node.children)}</del>`;
        case "link":
          return `<a href="${escapeAttr(node.href)}" target="_blank" rel="noopener noreferrer">${renderInlineNodes(node.children)}</a>`;
        case "image": {
          const imgParts = [];
          if (node.width) imgParts.push(`width:${escapeAttr(node.width)}`);
          if (node.align === "center") imgParts.push("display:block", "margin-left:auto", "margin-right:auto");
          else if (node.align === "left") imgParts.push("display:block", "float:left", "margin-right:1rem");
          else if (node.align === "right") imgParts.push("display:block", "float:right", "margin-left:1rem");
          const imgStyle = imgParts.length ? ` style="${imgParts.join(";")}"` : "";
          return `<img src="${escapeAttr(node.src)}" alt="${escapeAttr(node.alt)}"${imgStyle} />`;
        }
        case "ref":
          return `@${escapeHtml(node.id)}`;
        case "math_inline":
          return `<span class="sdoc-math sdoc-math-inline">${renderKatex(node.value, false)}</span>`;
        case "math_display":
          return `<span class="sdoc-math sdoc-math-display">${renderKatex(node.value, true)}</span>`;
        default:
          return "";
      }
    })
    .join("");
}

function renderInline(text) {
  return renderInlineNodes(parseInline(text));
}

// ---------------------------------------------------------------------------
// Node rendering — clean slide HTML
// ---------------------------------------------------------------------------

function renderNode(node) {
  switch (node.type) {
    case "paragraph":
      return `<p>${renderInline(node.text)}</p>`;
    case "list":
      return renderList(node);
    case "table":
      return renderTable(node);
    case "code": {
      if (node.lang === "mermaid") {
        return `<pre class="mermaid">${escapeHtml(node.text)}</pre>`;
      }
      if (node.lang === "svg") {
        return `<div class="sdoc-svg-block">${sanitizeSvg(node.text)}</div>`;
      }
      if (node.lang === "math") {
        return `<div class="sdoc-math sdoc-math-block">${renderKatex(node.text, true)}</div>`;
      }
      const langClass = node.lang ? ` class="language-${escapeAttr(node.lang)}"` : "";
      return `<pre><code${langClass}>${escapeHtml(node.text)}</code></pre>`;
    }
    case "blockquote": {
      const paragraphs = node.paragraphs
        .map((text) => `<p>${renderInline(text)}</p>`)
        .join("\n");
      return `<blockquote>${paragraphs}</blockquote>`;
    }
    case "hr":
      return `<hr />`;
    case "scope":
      return renderNestedScope(node);
    default:
      return "";
  }
}

function renderList(list) {
  const tag = list.listType === "number" ? "ol" : "ul";
  const items = list.items
    .map((item) => {
      const text = item.title ? renderInline(item.title) : "";
      const children = item.children
        .map((child) => renderNode(child))
        .join("\n");
      const body = children ? `\n${children}` : "";
      return `<li>${text}${body}</li>`;
    })
    .join("\n");
  return `<${tag}>\n${items}\n</${tag}>`;
}

function renderTable(table) {
  const opts = table.options || {};
  const classes = [];
  if (opts.borderless) classes.push("borderless");
  if (opts.headerless) classes.push("headerless");
  const classAttr = classes.length ? ` class="${classes.join(" ")}"` : "";

  let thead = "";
  if (table.headers.length > 0) {
    const headerCells = table.headers
      .map((cell) => `<th>${renderInline(cell)}</th>`)
      .join("");
    thead = `<thead><tr>${headerCells}</tr></thead>`;
  }

  const bodyRows = table.rows
    .map((row) => {
      const cells = row.map((cell) => `<td>${renderInline(cell)}</td>`).join("");
      return `<tr>${cells}</tr>`;
    })
    .join("\n");
  const tbody = bodyRows ? `<tbody>\n${bodyRows}\n</tbody>` : "";

  const styleParts = [];
  if (opts.width) {
    styleParts.push(`width:${opts.width}`);
    if (opts.width !== "auto") styleParts.push("table-layout:fixed");
  }
  if (opts.align === "center") styleParts.push("margin-left:auto", "margin-right:auto");
  else if (opts.align === "right") styleParts.push("margin-left:auto", "margin-right:0");
  const styleAttr = styleParts.length ? ` style="${styleParts.join(";")}"` : "";

  return `<table${classAttr}${styleAttr}>${thead}${thead ? "\n" : ""}${tbody}</table>`;
}

function renderNestedScope(scope) {
  if (scope.scopeType === "comment") return "";
  const heading = scope.hasHeading !== false && scope.title
    ? `<h3>${renderInline(scope.title)}</h3>`
    : "";
  const typeAttr = scope.scopeType ? ` data-scope-type="${escapeAttr(scope.scopeType)}"` : "";
  // The id reaches the DOM so the scope is addressable, which is what a
  // connector needs of its ends. Without it `collectAnchorIds` and the markup
  // disagreed about what an id is: a connector naming a nested scope passed
  // the build's own check — the check even offered the id in its "the slide
  // has:" list — and then found nothing to attach to in the page, so the line
  // was simply absent. A connector that cannot be drawn must be refused at
  // build time, and the way to keep that promise here is to make the id real
  // rather than to stop collecting it: a figure and its caption wrapped in a
  // scope is a reasonable thing to join a line to.
  const idAttr = scope.id ? ` id="${escapeAttr(scope.id)}"` : "";
  const children = scope.children.map((child) => renderNode(child)).join("\n");
  return `<section${idAttr}${typeAttr}>${heading}\n${children}</section>`;
}

function renderChildren(nodes) {
  return nodes.map((node) => renderNode(node)).join("\n");
}

// Callbacks handed to the layout builders so slide-layouts.js stays free of
// parser and KaTeX dependencies.
const LAYOUT_CONTEXT = { renderChildren, renderInline, escapeHtml };

// Layouts whose bare name is also emitted as a slide class, for themes written
// before `layout-*` existed. New layouts are not added here.
const LEGACY_LAYOUT_CLASSES = new Set(["center", "two-column"]);

// ---------------------------------------------------------------------------
// Slide-level extraction
// ---------------------------------------------------------------------------

// Separates @notes child scope from other children
function extractNotes(children) {
  const notes = [];
  const rest = [];
  for (const child of children) {
    if (child.type === "scope" && child.scopeType === "comment") {
      // :comment scopes are excluded from both notes and content
      continue;
    }
    if (child.type === "scope" && child.id && child.id.toLowerCase() === "notes") {
      notes.push(child);
    } else {
      rest.push(child);
    }
  }
  return { notes, contentNodes: rest };
}

// Every id a connector can anchor to on this slide: a scope's id at any depth
// — the ends are usually cells of a layout nested inside another one — and the
// ids inside a raw `svg` block, which arrive in the page as real elements and
// are no less addressable for not being scopes. A diagram is one block, so two
// boxes inside it cannot be scopes however much a line wants to join them.
//
// The svg ids are read from the SANITISED markup rather than from the block as
// the author wrote it. sanitizeSvg drops <script> and <foreignObject>, so an id
// declared inside one never reaches the DOM — and this set is also the list a
// refused connector prints to say what the slide does have. Collecting an id
// that cannot work would put it in that list and send the author at it, which
// is the defect this function has already caused once.
function collectAnchorIds(nodes, into) {
  for (const node of nodes || []) {
    if (node.type === "code" && node.lang === "svg") {
      for (const id of svgBlockIds(node)) into.add(id);
      continue;
    }
    if (node.type !== "scope") continue;
    if (node.id) into.add(String(node.id));
    collectAnchorIds(node.children, into);
  }
  return into;
}

// Separates the reserved @connectors child scope from other children, and
// reads each of ITS child scopes as one connector.
//
// Written as a scope rather than as slide configuration because a slide has
// several connectors and configuration is one value per key: a second
// "connect:" line would silently replace the first. It is pulled out here for
// the same reason @notes is — a structured layout treats every child scope as
// a cell, so left in place a connectors scope would render as a column.
//
// A connector naming an id the slide has not got is the failure this feature
// exists to prevent, so it is caught here, at build time, rather than
// resolving to nothing in a browser and leaving the line simply absent.
function extractConnectors(children, slideTitle, warnings) {
  const rest = [];
  const specs = [];
  let scope = null;

  for (const child of children) {
    if (child.type === "scope" && child.id && child.id.toLowerCase() === CONNECTOR_SCOPE_ID) {
      scope = child;
    } else {
      rest.push(child);
    }
  }
  if (!scope) return { specs, contentNodes: rest };

  const ids = collectAnchorIds(rest, new Set());
  const cells = (scope.children || []).filter(
    (n) => n.type === "scope" && n.scopeType !== "comment"
  );

  const say = (message) => {
    if (warnings) warnings.push({ slide: slideTitle || "", message });
  };

  if (!cells.length) {
    say("a @connectors scope holds no connectors; each one is a scope of its own inside it");
  }

  cells.forEach((cell, i) => {
    const { config, contentNodes: leftovers } = extractConfig(cell.children, CONNECTOR_SCOPE_ID);
    const { spec, errors } = readConnector(config, i, leftovers);
    for (const message of errors) say(message);
    if (!spec) return;
    for (const end of ["from", "to"]) {
      if (!ids.has(spec[end].id)) {
        say(
          `connector ${i + 1} points "${end}:" at @${spec[end].id}, and nothing on this slide ` +
            `declares that id` +
            (ids.size ? ` (the slide has: ${[...ids].map((d) => "@" + d).join(", ")})` : "")
        );
        return;
      }
    }
    specs.push(spec);
  });

  return { specs, contentNodes: rest };
}

// Separates :detail child scopes (drilldown / vertical slides) from other
// children. Detail scopes are NOT removed from rendering; they are emitted as
// sibling slides positioned vertically under the spine slide.
function extractDetails(children) {
  const details = [];
  const rest = [];
  for (const child of children) {
    if (child.type === "scope" && child.scopeType === "detail") {
      details.push(child);
    } else {
      rest.push(child);
    }
  }
  return { details, contentNodes: rest };
}

// Whether a slide scope carries `optional: true`.
//
// Optional-ness is a slide *property*, not a scope type: a heading carries one
// `:type` annotation and a drilldown has already spent it on `:detail`, so a
// detail slide could not also be annotated optional. Reading it off the
// configuration run keeps the two orthogonal — every combination of
// spine/detail and required/optional is expressible.
//
// The details are pulled out first and the config read without a parent
// layout, exactly as renderSlide() does it, so this answer and the one the
// slide renders under can never disagree.
function isOptionalSlide(scope) {
  const { contentNodes } = extractDetails(scope.children || []);
  const { config } = extractConfig(contentNodes);
  return truthy(config.optional);
}

// ---------------------------------------------------------------------------
// Slide backgrounds
//
// `background:` names an image; the companions place it and blend it into the
// slide. The image is emitted as a real <img>, never as a CSS
// background-image, and that is forced by the pipeline rather than chosen for
// taste: inlineDeckImages() resolves and embeds `<img src>` against the .sdoc,
// the geometry harvest reads an <img> as an image atom, and slide-pptx turns
// that atom into a picture shape. A CSS background would get none of the
// three — it would survive the HTML build and then vanish from the .pptx.
//
// The blend is a *mask* on the image rather than a scrim painted over it. A
// scrim has to know the colour it is fading to, which would put the theme's
// ground colour in the renderer; a mask takes alpha out of the image and lets
// whatever the theme paints behind show through. One mechanism works on a
// white deck and a near-black one, and text stays legible on both.
// ---------------------------------------------------------------------------

const FIT_WORDS = new Set(["cover", "contain", "fill", "none", "scale-down"]);

function fadeNumber(raw, fallback) {
  if (raw === undefined) return fallback;
  const n = parseFloat(String(raw).replace("%", ""));
  return isFinite(n) ? n : fallback;
}

// `background-fade: linear angle=100 from=30% to=85%`
// `background-fade: radial at=70%,40% from=20% radius=70%`
//
// The shape is the first bare word and everything after it is `name=value`, so
// order never matters and a name this does not know is ignored rather than
// shifting the meaning of the one after it — the failure mode of a purely
// positional value like `linear 100 30 85 0 1`, which nobody can read back.
//
// Four knobs mean the same thing in both shapes: `from` and `to` are where the
// falloff starts and finishes, `min` and `max` the alpha at each end. For a
// linear fade those run along `angle`; for a radial one they are radii out
// from `at`. `radius` is accepted as the name a circle wants for `to`.
function parseFade(value) {
  const text = String(value || "").trim();
  if (!text) return null;

  const tokens = text.split(/\s+/);
  const shape = tokens[0].toLowerCase();
  if (shape !== "linear" && shape !== "radial") return null;

  const params = {};
  for (const token of tokens.slice(1)) {
    const eq = token.indexOf("=");
    if (eq < 1) continue;
    params[token.slice(0, eq).toLowerCase()] = token.slice(eq + 1);
  }

  const alpha = (n) => Math.max(0, Math.min(1, n));
  const fade = {
    shape,
    from: fadeNumber(params.from, 0),
    to: fadeNumber(params.radius !== undefined ? params.radius : params.to, 100),
    min: alpha(fadeNumber(params.min, 0)),
    max: alpha(fadeNumber(params.max, 1)),
  };

  if (shape === "linear") {
    fade.angle = fadeNumber(params.angle, 90);
  } else {
    const at = String(params.at === undefined ? "50%,50%" : params.at).split(",");
    fade.x = fadeNumber(at[0], 50);
    fade.y = fadeNumber(at[1], 50);
  }
  return fade;
}

// Black is arbitrary: a mask reads the alpha channel, so only the opacity of
// each stop matters and the colour never shows.
function fadeMask(fade) {
  const stops =
    `rgba(0,0,0,${fade.max}) ${fade.from}%, rgba(0,0,0,${fade.min}) ${fade.to}%`;
  return fade.shape === "linear"
    ? `linear-gradient(${fade.angle}deg, ${stops})`
    : `radial-gradient(circle at ${fade.x}% ${fade.y}%, ${stops})`;
}

// A position split into its two axes, so a flip can mirror one of them.
// `right center` is x then y; `top` alone is a y with x defaulting to centre.
function splitPosition(position) {
  const tokens = String(position).trim().split(/\s+/).filter(Boolean);
  const isY = (t) => t === "top" || t === "bottom";
  if (tokens.length === 0) return { x: "center", y: "center" };
  if (tokens.length === 1) {
    return isY(tokens[0]) ? { x: "center", y: tokens[0] } : { x: tokens[0], y: "center" };
  }
  return isY(tokens[0])
    ? { x: tokens[1], y: tokens[0] }
    : { x: tokens[0], y: tokens[1] };
}

function mirrorAxis(value, low, high) {
  const v = value.toLowerCase();
  if (v === low) return high;
  if (v === high) return low;
  const pct = /^(-?\d*\.?\d+)%$/.exec(v);
  if (pct) return `${100 - parseFloat(pct[1])}%`;
  return value;
}

// Mirroring the placement is what makes a flip stay where it was put.
//
// The reflection itself happens about the slide's centre, because reflecting
// about the placement edge instead throws the picture clean off the slide: an
// image sitting against the right edge lies *inside* that edge, so mirroring
// across it lands the whole thing outside the box, where it is clipped away to
// nothing. Mirroring the position too puts it back: placed left, reflected
// about the centre, it arrives on the right — where the author asked for it,
// facing the other way.
function mirrorPosition(position, flipX, flipY) {
  if (!flipX && !flipY) return position;
  const { x, y } = splitPosition(position);
  return [
    flipX ? mirrorAxis(x, "left", "right") : x,
    flipY ? mirrorAxis(y, "top", "bottom") : y,
  ].join(" ");
}

// A two-value `background-size`, as in `auto 100%`: full height, natural
// width, aspect kept. No `object-fit` keyword can say that — `cover` crops a
// wide image and `contain` fits it by its width — so a pair is given to the
// image's own box instead, and the box then *is* the size that was asked for.
//
// Only a pair takes this route. A lone value would read as a size on a key
// whose other values are keywords, and a lone percentage would mean the same
// thing as `background-scale:` while living somewhere else.
const SIZE_PART = /^(?:auto|-?\d*\.?\d+(?:%|px|em|rem|vh|vw|vmin|vmax))$/;

function parseBgSize(value) {
  const tokens = String(value || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length !== 2) return null;
  if (!tokens.every((t) => SIZE_PART.test(t))) return null;
  return { w: tokens[0], h: tokens[1] };
}

// A scale folds into a sized box rather than becoming a transform: multiply
// what is measurable and leave `auto` to follow the aspect ratio. That keeps
// the sized path free of transforms, so nothing has to reconcile a scale
// origin with a translate.
function scalePart(part, scale) {
  if (part === "auto" || scale === 1) return part;
  const m = /^(-?\d*\.?\d+)(.*)$/.exec(part);
  return m ? `${parseFloat(m[1]) * scale}${m[2]}` : part;
}

// The CSS background-position rule, as percentages: the point P% across the
// image is laid against the point P% across the slide. Keywords are the
// percentages everyone knows them by.
const POSITION_PERCENT = { left: 0, top: 0, center: 50, right: 100, bottom: 100 };

function axisPercent(value) {
  const v = String(value).toLowerCase();
  if (v in POSITION_PERCENT) return POSITION_PERCENT[v];
  const pct = /^(-?\d*\.?\d+)%$/.exec(v);
  return pct ? parseFloat(pct[1]) : 50;
}

// Only what a position can legitimately contain. Everything else in the style
// attribute is a number this file computed, so this is the one author-supplied
// string that reaches CSS — and a value carrying a `;` or a quote would
// otherwise add declarations of its own.
function cssPosition(value, fallback) {
  const text = String(value || "").trim();
  if (!text) return fallback;
  return /^[A-Za-z0-9%.\s-]+$/.test(text) ? text : fallback;
}

// `background-scale: 0.5` or `50%`. Anything else leaves the image alone.
function parseScale(value) {
  const text = String(value || "").trim();
  if (!text) return 1;
  const n = parseFloat(text);
  if (!isFinite(n) || n <= 0) return 1;
  return text.endsWith("%") ? n / 100 : n;
}

function slideBackground(config, baked) {
  const src = String(config.background || "").trim();
  if (!src) return "";

  // An export has already painted the picture, its placement and its fade into
  // one flat image (see src/slide-fade-bake.js), because a CSS mask with a
  // transparent stop is what macOS Preview renders as a hard edge. Everything
  // below is in those pixels now, so emitting any of it a second time — the
  // mask, the object-fit, the flip — would apply it twice.
  if (baked) {
    return `<div class="slide-bg" aria-hidden="true"><img src="${escapeAttr(baked)}"` +
      ` alt="" style="width:100%;height:100%;object-fit:fill" /></div>\n`;
  }

  const fit = String(config["background-size"] || "").trim().toLowerCase();
  const asked = cssPosition(config["background-position"], "center");

  const flip = String(config["background-flip"] || "").trim().toLowerCase();
  const flipX = flip === "horizontal" || flip === "both";
  const flipY = flip === "vertical" || flip === "both";
  const scale = parseScale(config["background-scale"]);

  // Placed at the mirror of where it was asked for; the reflection below then
  // carries it back there, facing the other way. See mirrorPosition.
  const placed = mirrorPosition(asked, flipX, flipY);
  const sized = parseBgSize(config["background-size"]);
  const styles = [];

  if (sized) {
    // The box becomes the size that was asked for, so the image fills it at
    // its own aspect ratio and `object-fit` has nothing left to decide. The
    // element is then placed by the background-position rule rather than by
    // `object-position`, which only moves content *within* a box and has none
    // to move here.
    const { x, y } = splitPosition(placed);
    const px = axisPercent(x);
    const py = axisPercent(y);
    styles.push(
      "position:absolute",
      `width:${scalePart(sized.w, scale)}`,
      `height:${scalePart(sized.h, scale)}`,
      `left:${px}%`,
      `top:${py}%`,
      `transform:translate(${-px}%,${-py}%)`
    );
  } else {
    styles.push(
      `object-position:${placed}`,
      `object-fit:${FIT_WORDS.has(fit) ? fit : "cover"}`
    );

    // Scale is anchored where the image sits, so shrinking one pinned to an
    // edge keeps it pinned there instead of drifting towards the middle. The
    // flip cannot share that origin, so the two are separate transforms on
    // separate elements rather than one composed pair.
    if (scale !== 1) {
      styles.push(`transform-origin:${placed}`, `transform:scale(${scale})`);
    }
  }

  // The fade goes on the wrapper, not on the image, and that split matters as
  // soon as a slide uses both. A transform carries the element's mask with it,
  // so a fade written to protect text on the left would mirror to the right
  // the moment the picture was flipped — silently moving the protection away
  // from the words it was there for. The wrapper never moves: the fade stays
  // in slide space, where the author was thinking, and the flip stays a fact
  // about the picture.
  const fade = parseFade(config["background-fade"]);
  let wrapStyle = "";
  // The parsed spec, carried for the export's bake. Reading it back out of the
  // computed mask-image instead would lose information: Chrome normalises the
  // gradient and drops an angle of 180deg altogether, it being the default
  // `to bottom`.
  let fadeAttr = "";
  if (fade) {
    fadeAttr = ` data-fade="${escapeAttr(JSON.stringify(fade))}"`;
    const mask = fadeMask(fade);
    // Chrome still wants the prefix for mask-image on some versions, and
    // headless Chrome is what builds the PDF.
    wrapStyle = ` style="-webkit-mask-image:${mask};mask-image:${mask}"`;
  }

  // The flip is its own element, between the fade and the image. It cannot go
  // on the fade, which must not move, and it cannot share the image's own
  // transform, whose origin belongs to the scale.
  const img = `<img src="${escapeAttr(src)}" alt="" style="${styles.join(";")}" />`;
  const inner =
    flipX || flipY
      ? `<div class="slide-bg-flip" style="transform:scale(${flipX ? -1 : 1},${flipY ? -1 : 1})">${img}</div>`
      : img;

  // alt is empty and the wrapper is aria-hidden: this is decoration, and a
  // screen reader announcing a filename over every slide is worse than silence.
  return `<div class="slide-bg" aria-hidden="true"${fadeAttr}${wrapStyle}>${inner}</div>\n`;
}

// ---------------------------------------------------------------------------
// Slide rendering
// ---------------------------------------------------------------------------

// position: { spine: 1-based spine index, detail: 0 for spine, 1..N for details,
//             totalSpines: total number of spine slides, hasDetails: bool (spine only) }
function renderSlide(scope, slideIndex, overlayHtml, position, bakedFade, warnings, includeNotes = true) {
  // Pull :detail children out first so they don't appear inline in the spine
  // slide's content; they're rendered as sibling vertical slides instead.
  const { contentNodes: afterDetails } = extractDetails(scope.children);
  const { config, contentNodes: afterConfig } = extractConfig(afterDetails);
  const { notes, contentNodes: afterNotes } = extractNotes(afterConfig);
  const { specs: connectors, contentNodes } = extractConnectors(
    afterNotes, scope.title || scope.id || `slide ${slideIndex + 1}`, warnings
  );

  const layout = config.layout || "";
  const classes = ["slide"];
  if (layout) {
    // `layout-*` is the class themes target. The bare layout name is emitted
    // only for the two layouts that predate it, because themes in the wild
    // are written against `.center` and `.two-column`. It is not emitted for
    // the structured layouts: those put a container class of the same name
    // inside the slide (`.columns`, `.stats`, `.rows`…), and a slide also
    // carrying that class would match the container's own rules.
    if (LEGACY_LAYOUT_CLASSES.has(layout)) classes.push(layout);
    // Slugged, so no configuration value can close the class attribute.
    const layoutSlug = slug(layout);
    if (layoutSlug) classes.push(`layout-${layoutSlug}`);
  }
  const accent = accentClass(config.accent).trim();
  if (accent) classes.push(accent);
  if (position && position.detail === 0 && position.hasDetails) {
    classes.push("slide-has-details");
  }
  if (position && position.detail > 0) {
    classes.push("slide-detail");
  }
  // Present in the HTML build, which is the presenting format; dropped before
  // this point when the deck is rendered for PDF or PPTX export.
  if (truthy(config.optional)) {
    classes.push("slide-optional");
  }

  // On a title slide the kicker sits beneath the statement rather than above
  // it, so the eye lands on the name first.
  const isTitleLayout = layout === "title";
  const kickerHtml = config.kicker
    ? `<div class="kicker">${renderInline(config.kicker)}</div>`
    : "";

  const headParts = [];
  if (kickerHtml && !isTitleLayout) headParts.push(kickerHtml);
  if (scope.hasHeading !== false && scope.title) {
    const tag = isTitleLayout ? "h1" : "h2";
    headParts.push(`<${tag}>${renderInline(scope.title)}</${tag}>`);
  }
  if (config.lede) headParts.push(`<p class="lede">${renderInline(config.lede)}</p>`);
  const title = headParts.length
    ? `<header class="slide-head">\n${headParts.join("\n")}\n</header>`
    : "";

  const bodyInner = buildBody(layout, { config, contentNodes }, LAYOUT_CONTEXT);

  const tailParts = [];
  if (kickerHtml && isTitleLayout) tailParts.push(kickerHtml);
  if (config.status) tailParts.push(`<div class="status">${renderInline(config.status)}</div>`);
  if (config.footnote) tailParts.push(`<div class="footnote">${renderInline(config.footnote)}</div>`);
  const tailHtml = tailParts.length ? `\n${tailParts.join("\n")}` : "";

  const bodyHtml = `<div class="slide-body">\n${bodyInner}\n</div>${tailHtml}`;

  const notesHtml = notes.length && includeNotes
    ? `\n<aside class="notes">${notes.map((n) => renderChildren(n.children)).join("\n")}</aside>`
    : "";

  const idAttr = scope.id ? ` id="${escapeAttr(scope.id)}"` : "";

  // The connectors, as data. They are resolved against the laid-out boxes by
  // the deck's own runtime (see src/slide-connectors.js), which is why nothing
  // here is a coordinate — and why the HTML build and every export get the
  // same answer without any of them re-measuring.
  const connectorAttr = connectors.length
    ? ` data-sdoc-connectors="${escapeAttr(JSON.stringify(connectors))}"`
    : "";

  // Drilldown metadata + slide indicator label (substituted into the footer)
  let dataAttrs = "";
  let indicatorLabel = "";
  if (position) {
    dataAttrs = ` data-spine="${position.spine}" data-detail="${position.detail}"`;
    const denom = position.totalSpines;
    indicatorLabel = position.detail === 0
      ? `${position.spine} / ${denom}`
      : `${position.spine}.${position.detail} / ${denom}`;
  }
  const overlay = (overlayHtml || "").replace("__SLIDE_INDICATOR__", escapeHtml(indicatorLabel));

  // Wrap title + body in a scale container so PDF export can apply
  // transform: scale() to fit the content onto a fixed page size.  In
  // screen mode the wrapper is display:contents (invisible to layout); in
  // print mode it becomes a real block that the beforeprint handler can
  // measure and scale.
  // First child, so the harvest emits its atom before any content and the
  // picture lands at the bottom of the z-order in the exported .pptx.
  const bgHtml = slideBackground(config, bakedFade);

  return `<div class="${classes.join(" ")}"${idAttr}${connectorAttr}${dataAttrs}>\n${bgHtml}<div class="slide-content-scale">\n${title}\n${bodyHtml}\n</div>${notesHtml}${overlay}\n</div>`;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

// Escaped on the way in: a template literal drops an unrecognised escape,
// so `\s` would arrive as `s` and the regex below would delete every letter
// s in every kicker. The source file stays normal JS; this keeps it that way.
const FILMSTRIP_JS = `
// Filmstrip — the story arc of a deck, on demand.
//
// Press T and a strip of every spine slide hides at the bottom edge, rising
// when the pointer reaches for it the way a dock does. It exists for the case
// where two people are working on one slide and need to see where it sits in
// the argument without leaving it.
//
// This is structural rather than part of a theme, because navigation is the
// one thing every theme already implements and none of them should have to
// implement twice. It couples to a theme through the URL hash alone: setting
// the hash is how it navigates, which every theme already listens for. It
// reads the current slide by watching which one carries .active, because a
// theme writes the hash with replaceState and that fires no event.
//
// A thumbnail is the kicker and a very small title. Not a rendering of the
// slide: the point is to recognise a slide's place in the run, and at this
// size a picture of it would be a grey smudge.
(function () {
  // T, for thumbnails. F used to be this; it is full screen now, which is
  // what that key means in every other viewer a presenter has used.
  var KEY = "t";
  var MAX_VISIBLE = 15;
  var STORE = "sdocFilmstrip";

  var slides = [].slice.call(document.querySelectorAll(".slide"));
  var spine = slides.filter(function (s) {
    return (s.getAttribute("data-detail") || "0") === "0";
  });
  // One slide is not a story, and nothing about it is worth a strip. Nor in
  // the presenter window, whose stage already shows the slides either side:
  // a strip there would open out of sight beneath it.
  if (spine.length < 2 || window.sdocDeckKit.presenter) return;

  var HOVER_BAND = 64;
  var strip = document.createElement("div");
  strip.className = "sdoc-filmstrip";
  var track = document.createElement("div");
  track.className = "sdoc-filmstrip-track";
  strip.appendChild(track);
  var hint = document.createElement("div");
  hint.className = "sdoc-filmstrip-hint";

  function textOf(slide, sel) {
    var el = slide.querySelector(sel);
    return el ? el.textContent.replace(/\\s+/g, " ").trim() : "";
  }

  var items = spine.map(function (slide, i) {
    var item = document.createElement("button");
    item.type = "button";
    item.className = "sdoc-filmstrip-item";
    if (slide.classList.contains("slide-has-details")) item.className += " has-details";
    // Out of the tab order on purpose: a deck is driven by arrow keys, and
    // eighteen invisible tab stops behind a hidden strip help nobody.
    item.setAttribute("tabindex", "-1");

    var kicker = textOf(slide, ".kicker");
    var title = textOf(slide, "h1") || textOf(slide, "h2") || textOf(slide, "h3");
    item.setAttribute("aria-label", "Slide " + (i + 1) + (title ? ": " + title : ""));
    item.title = (kicker ? kicker + " — " : "") + (title || "Slide " + (i + 1));

    var n = document.createElement("div");
    n.className = "sdoc-filmstrip-n";
    n.textContent = String(i + 1);
    item.appendChild(n);

    // A slide with no kicker still needs a line of its own here, or the
    // titles of its neighbours sit at different heights and the strip stops
    // reading as a row.
    var k = document.createElement("div");
    k.className = "sdoc-filmstrip-kicker";
    k.textContent = kicker || " ";
    item.appendChild(k);

    if (title) {
      var t = document.createElement("div");
      t.className = "sdoc-filmstrip-title";
      t.textContent = title;
      item.appendChild(t);
    }
    track.appendChild(item);
    return item;
  });

  // The floor is measured, not guessed: a thumbnail is only useful if you can
  // read enough of its kicker to tell slides apart, and how many pixels that
  // takes depends on the typeface the theme chose. So ask the browser how wide
  // MIN_CHARS characters actually are in the kicker's own computed font,
  // rather than picking a number that is right for one theme and wrong for
  // the next.
  var MIN_CHARS = 15;

  function minItemWidth() {
    var sample = items[0] && items[0].querySelector(".sdoc-filmstrip-kicker");
    if (!sample) return 96;
    var cs = getComputedStyle(sample);
    var size = parseFloat(cs.fontSize) || 10;
    var spacing = cs.letterSpacing === "normal" ? 0 : parseFloat(cs.letterSpacing) || 0;
    var text = new Array(MIN_CHARS + 1).join("N");
    var width;
    try {
      var ctx = (minItemWidth.canvas || (minItemWidth.canvas = document.createElement("canvas"))).getContext("2d");
      ctx.font = cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
      width = ctx.measureText(text).width;
    } catch (err) {
      width = 0;
    }
    // A canvas measurement ignores letter-spacing, and an uppercased kicker
    // carries it on every character.
    if (!width) width = text.length * size * 0.62;
    width += spacing * MIN_CHARS;
    // The box around the text: padding both sides, plus its border.
    var item = items[0];
    var ics = getComputedStyle(item);
    var chrome = (parseFloat(ics.paddingLeft) || 0) + (parseFloat(ics.paddingRight) || 0) +
                 (parseFloat(ics.borderLeftWidth) || 0) + (parseFloat(ics.borderRightWidth) || 0);
    return Math.ceil(width + chrome);
  }

  // At most MAX_VISIBLE across the window, and never narrower than the floor —
  // below which the strip stops scrolling and starts just not fitting, which
  // is the right trade: a narrow window shows fewer slides, legibly.
  // Recomputed on resize because the window is the only input.
  function sizeItems() {
    var gap = 8, pad = 24;
    var floor = minItemWidth();
    var across = Math.min(MAX_VISIBLE, spine.length);
    var avail = window.innerWidth - pad;
    var w = Math.floor((avail - gap * (across - 1)) / across);
    items.forEach(function (it) { it.style.width = Math.max(floor, w) + "px"; });
  }

  function currentIndex() {
    for (var i = 0; i < spine.length; i++) if (spine[i].classList.contains("active")) return i;
    // A detail slide is active: its spine is the one before it in document order.
    var active = document.querySelector(".slide.active");
    if (!active) return 0;
    var at = slides.indexOf(active);
    for (var j = at; j >= 0; j--) {
      var k = spine.indexOf(slides[j]);
      if (k !== -1) return k;
    }
    return 0;
  }

  function centreCurrent() {
    var it = items[currentIndex()];
    if (!it) return;
    var target = it.offsetLeft - (track.clientWidth - it.offsetWidth) / 2;
    var most = track.scrollWidth - track.clientWidth;
    track.scrollLeft = Math.max(0, Math.min(target, most));
  }

  function markCurrent() {
    var cur = currentIndex();
    items.forEach(function (it, i) { it.classList.toggle("is-current", i === cur); });
    var it = items[cur];
    if (!it) return;
    // Keep the current slide in view without yanking the strip while someone
    // is dragging it.
    if (dragging) return;
    var left = it.offsetLeft, right = left + it.offsetWidth;
    if (left < track.scrollLeft) track.scrollLeft = left - 12;
    else if (right > track.scrollLeft + track.clientWidth) track.scrollLeft = right - track.clientWidth + 12;
  }

  // Navigate by hash: the one interface every theme already implements.
  var DRAG_SLOP = 4;
  var dragging = false, captured = false, moved = 0, startX = 0, startScroll = 0;

  function goTo(i) { window.location.hash = String(i + 1); }

  // The deck navigates on a click anywhere — left half back, right half
  // forward. Without this, clicking a thumbnail sets the hash and then the
  // deck's own handler runs, flips a slide and rewrites the hash before the
  // hashchange lands: the strip looks broken and the deck looks possessed.
  strip.addEventListener("click", function (e) { e.stopPropagation(); });

  items.forEach(function (item, i) {
    item.addEventListener("click", function (e) {
      e.stopPropagation();
      // A click that ended a drag is not a click on a slide.
      if (moved > DRAG_SLOP) return;
      goTo(i);
    });
  });

  track.addEventListener("pointerdown", function (e) {
    dragging = true; captured = false; moved = 0;
    startX = e.clientX; startScroll = track.scrollLeft;
    // Deliberately NOT capturing yet. Capturing the pointer here retargets
    // the click that follows to this element, so a tap on a thumbnail would
    // never reach the thumbnail and clicking a slide would do nothing.
    // Capture once a drag has actually begun, by which point there is no
    // click to lose.
  });
  track.addEventListener("pointermove", function (e) {
    if (!dragging) return;
    var dx = e.clientX - startX;
    moved = Math.max(moved, Math.abs(dx));
    if (!captured && moved > DRAG_SLOP) {
      captured = true;
      try { track.setPointerCapture(e.pointerId); } catch (err) {}
    }
    if (captured) track.scrollLeft = startScroll - dx;
  });
  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    if (captured) { try { track.releasePointerCapture(e.pointerId); } catch (err) {} }
    captured = false;
  }
  track.addEventListener("pointerup", endDrag);
  track.addEventListener("pointercancel", endDrag);

  // Keyboard reach, for the same reason the thumbnails are clickable: a strip
  // you can see the shape of but not move around in is half a tool.
  items.forEach(function (item, i) {
    item.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); goTo(i); }
    });
  });

  // Edge scrolling: the pointer resting near either end walks the strip along,
  // faster the closer it gets, so a long deck is reachable without a drag.
  var edge = 0, raf = null;
  function step() {
    if (edge !== 0) { track.scrollLeft += edge; raf = requestAnimationFrame(step); }
    else raf = null;
  }
  strip.addEventListener("pointermove", function (e) {
    if (dragging) { edge = 0; return; }
    var r = track.getBoundingClientRect();
    var band = Math.min(120, r.width * 0.12);
    if (e.clientX < r.left + band) edge = -Math.ceil((band - (e.clientX - r.left)) / 8);
    else if (e.clientX > r.right - band) edge = Math.ceil((band - (r.right - e.clientX)) / 8);
    else edge = 0;
    if (edge !== 0 && raf === null) raf = requestAnimationFrame(step);
  });
  strip.addEventListener("pointerleave", function () { edge = 0; });

  // Show and hide. The pointer reaching the bottom edge opens it; leaving
  // the strip itself closes it.
  var enabled = false, pinned = false, openTimer = null;
  function open() {
    clearTimeout(openTimer);
    var wasOpen = strip.classList.contains("is-open");
    strip.classList.add("is-open");
    // Centre only as it comes up. While it is up, markCurrent scrolls the
    // least it can, so the strip stays still under the pointer.
    if (!wasOpen) centreCurrent();
  }
  function close() {
    openTimer = setTimeout(function () { strip.classList.remove("is-open"); edge = 0; }, 180);
  }
  strip.addEventListener("pointerenter", open);
  strip.addEventListener("pointerleave", function () {
    // Leaving it is the dismissal a key reveal never had.
    pinned = false;
    close();
  });
  // Watched on the document rather than through an element laid over the
  // bottom edge: an element there would also swallow every click meant for
  // the nav chevrons and the footer sitting under it.
  document.addEventListener("pointermove", function (e) {
    if (!enabled || dragging) return;
    if (e.clientY >= window.innerHeight - HOVER_BAND) { open(); return; }
    if (pinned) return;
    if (!strip.contains(e.target)) close();
  });

  function say(text) {
    hint.textContent = text;
    hint.classList.add("is-shown");
    setTimeout(function () { hint.classList.remove("is-shown"); }, 1400);
  }

  function setEnabled(on, announce) {
    enabled = on;
    pinned = false;
    if (!on) strip.classList.remove("is-open");
    try { sessionStorage.setItem(STORE, on ? "1" : "0"); } catch (err) {}
    if (announce) say(on ? "Slide strip on" : "Slide strip off");
    if (on) { sizeItems(); markCurrent(); pinned = true; open(); centreCurrent(); }
  }

  document.addEventListener("keydown", function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey || window.sdocDeckKit.editable(e.target)) return;
    if ((e.key || "").toLowerCase() !== KEY) return;
    // Behind the overview it would switch on unseen and turn up on closing.
    if (window.sdocOverview && window.sdocOverview.isOpen()) return;
    e.preventDefault();
    setEnabled(!enabled, true);
  });

  // A theme navigates with replaceState, which fires no event, so the active
  // class is what there is to watch.
  var observer = new MutationObserver(markCurrent);
  slides.forEach(function (s) {
    observer.observe(s, { attributes: true, attributeFilter: ["class"] });
  });
  window.addEventListener("resize", function () { sizeItems(); markCurrent(); });

  document.body.appendChild(strip);
  document.body.appendChild(hint);
  sizeItems();
  markCurrent();

  var remembered = null;
  try { remembered = sessionStorage.getItem(STORE); } catch (err) {}
  setEnabled(remembered === "1", false);

  // A pull up from the bottom edge (the gesture runtime): the strip rises
  // with the pointer, fully up exactly where letting go starts to count, and
  // is switched on as T would switch it if let go there. Short of that it
  // drops back and nothing has changed.
  function place(t) {
    strip.style.transform = "translateY(" + ((1 - t) * 102) + "%)";
  }
  var pulls = 0;
  window.sdocFilmstrip = {
    enabled: function () { return enabled; },
    pull: function () {
      if (enabled) return null;
      var motion = window.sdocMotion;
      var at = 0, mine = ++pulls;
      sizeItems();
      markCurrent();
      centreCurrent();
      // The stylesheet's own transition would lag every move by 160ms.
      strip.style.transition = "none";
      place(0);
      function settle(target, how) {
        var from = strip.style.transform;
        strip.style.transform = "";
        if (target === 1) setEnabled(true, false);
        var done = motion
          ? motion.play(strip, [{ transform: from }, { transform: "translateY(" + ((1 - target) * 102) + "%)" }],
              { duration: how.duration, easing: how.easing })
          : Promise.resolve();
        // Not if another pull has begun since: it needs the transition off.
        done.then(function () { if (mine === pulls) strip.style.transition = ""; });
      }
      return {
        set: function (t) { at = Math.max(0, Math.min(1, t)); place(at); },
        commit: function () { settle(1, motion ? motion.SPRING : {}); },
        cancel: function () { settle(0, motion ? motion.SETTLE : {}); }
      };
    }
  };
})();
`;

// Motion shared by the deck runtimes: the overview, the filmstrip and the pull
// gesture all spring, and one spring keeps them feeling like one thing. On the
// window rather than repeated in each, because each is its own script.
//
// Same escaping rule as the filmstrip: this is a template literal.
const MOTION_JS = `
(function () {
  // A damped spring, sampled into a linear() easing so the browser runs it
  // like any other curve, on the compositor. Underdamped for the way in: a
  // cell overshoots its place by a few percent and settles back, which is
  // what reads as springing into position rather than sliding there. Damped
  // critically for the way out, because overshooting the full-size slide
  // would show its edges past the window.
  var reduced = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  var hasLinear = !!(window.CSS && CSS.supports && CSS.supports("animation-timing-function", "linear(0, 1)"));

  function spring(w0, zeta) {
    if (!hasLinear) {
      return { duration: 420, easing: zeta < 1 ? "cubic-bezier(0.34, 1.4, 0.64, 1)" : "cubic-bezier(0.2, 0.9, 0.2, 1)" };
    }
    // Long enough for the motion to be under half a percent of the travel.
    var settle = zeta < 1
      ? Math.log(200 / Math.sqrt(1 - zeta * zeta)) / (zeta * w0)
      : 7.4 / w0;
    var steps = 48, pts = [];
    for (var i = 0; i <= steps; i++) {
      var t = settle * i / steps, v;
      if (zeta < 1) {
        var wd = w0 * Math.sqrt(1 - zeta * zeta);
        v = 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + (zeta * w0 / wd) * Math.sin(wd * t));
      } else {
        v = 1 - Math.exp(-w0 * t) * (1 + w0 * t);
      }
      pts.push(i === steps ? 1 : Math.round(v * 10000) / 10000);
    }
    return { duration: Math.round(settle * 1000), easing: "linear(" + pts.join(", ") + ")" };
  }

  // Resolves when the animation is over — or when it should have been. A
  // browser producing no frames (a headless one, a tab in the background)
  // never finishes an animation, and the overview changes state when its
  // animations end: without a deadline it would open and never settle, or
  // close and never leave. So at the deadline the animation is finished by
  // hand, which also lands everything where it was going.
  function play(el, frames, timing) {
    if (reduced || !el.animate) return Promise.resolve();
    var a;
    try { a = el.animate(frames, timing); } catch (err) { return Promise.resolve(); }
    return new Promise(function (resolve) {
      var done = false;
      var end = function () { if (!done) { done = true; resolve(); } };
      // A cancelled animation rejects its promise; that is not an error here.
      a.finished.then(end, end);
      setTimeout(function () {
        if (done) return;
        try { a.finish(); } catch (err) {}
        end();
      }, (timing.duration || 0) + (timing.delay || 0) + 150);
    });
  }

  // The transform that makes a box whose natural place is "to" look as if it
  // were at "from", scaled from its top-left corner.
  function fly(from, to) {
    var sx = from.width / to.width, sy = from.height / to.height;
    return "translate(" + (from.left - to.left) + "px, " + (from.top - to.top) + "px) scale(" + sx + ", " + sy + ")";
  }

  window.sdocMotion = {
    reduced: reduced,
    spring: spring,
    SPRING: spring(18, 0.66),
    SETTLE: spring(22, 1),
    play: play,
    fly: fly
  };
})();
`;


// Full screen on F. Structural for the same reason the filmstrip is: every
// theme would otherwise write the same ten lines. A page that may not go full
// screen — an iframe without allowfullscreen, a webview — rejects the request,
// and that is said out loud rather than the key appearing to do nothing.
//
// Same escaping rule as the filmstrip: this is a template literal.
const FULLSCREEN_JS = `
(function () {
  var KEY = "f";
  var kit = window.sdocDeckKit;
  var root = document.documentElement;

  function current() {
    return document.fullscreenElement || document.webkitFullscreenElement ||
      document.webkitCurrentFullScreenElement || null;
  }
  function call(target, names) {
    for (var i = 0; i < names.length; i++) {
      if (typeof target[names[i]] === "function") {
        try { return Promise.resolve(target[names[i]]()); } catch (err) { return Promise.reject(err); }
      }
    }
    return Promise.reject(new Error("unsupported"));
  }

  function refused() { kit.say("Full screen is not available here", 1600); }

  document.addEventListener("keydown", function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || kit.editable(e.target)) return;
    if ((e.key || "").toLowerCase() !== KEY) return;
    e.preventDefault();
    var going = current()
      ? call(document, ["exitFullscreen", "webkitExitFullscreen"])
      : call(root, ["requestFullscreen", "webkitRequestFullscreen"]);
    going.catch(refused);
  });
  // Safari refuses by event rather than by rejecting the request.
  ["fullscreenerror", "webkitfullscreenerror"].forEach(function (type) {
    document.addEventListener(type, refused);
  });
})();
`;

// The overview: every spine slide at once, in a grid that fills the window.
//
// The filmstrip answers "where am I in the argument" without leaving the
// slide. This answers "what does the whole deck look like" and gets you
// anywhere in it in one click, which is what a presenter wants mid-talk and a
// designer wants when checking that thirty slides belong to one deck.
//
// A cell is the slide itself, cloned and scaled down, so the pictures,
// colours and layout are the real ones. Its type is not readable at that
// size, so the kicker and title are set again underneath at a size that is —
// the same text the filmstrip uses. Resting on a cell brings up a larger copy
// beside it, big enough to check it is the one you meant; a click goes there.
//
// Built when it opens and removed when it closes, so nothing that reads a
// built deck — the harvests, print, any export — can ever see it. Couples to a
// theme the way the filmstrip does: the hash to navigate, .active to read.
//
// Same escaping rule as the filmstrip: this is a template literal, so a
// backslash in it has to be written twice.
const OVERVIEW_JS = `
(function () {
  var KEY = "o";

  var slides = [].slice.call(document.querySelectorAll(".slide"));
  var spine = slides.filter(function (s) {
    return (s.getAttribute("data-detail") || "0") === "0";
  });
  if (spine.length < 2) return;

  // ---- What each cell says -------------------------------------------------

  // Shared with the presenter view; see src/slide-deck-kit.js.
  var kit = window.sdocDeckKit;
  var textOf = kit.textOf;
  function detailsUnder(slide) {
    var s = slide.getAttribute("data-spine");
    if (!s) return 0;
    var n = 0;
    for (var i = 0; i < slides.length; i++) {
      if (slides[i].getAttribute("data-spine") === s &&
          (slides[i].getAttribute("data-detail") || "0") !== "0") n++;
    }
    return n;
  }
  var info = spine.map(function (slide) {
    return {
      kicker: textOf(slide, ".kicker"),
      title: textOf(slide, "h1") || textOf(slide, "h2") || textOf(slide, "h3"),
      details: detailsUnder(slide)
    };
  });

  var activeSlide = kit.activeSlide;
  function currentIndex() {
    var active = activeSlide();
    if (!active) return 0;
    var k = spine.indexOf(active);
    if (k !== -1) return k;
    // A detail is up: its spine is the nearest one before it.
    for (var j = slides.indexOf(active); j >= 0; j--) {
      k = spine.indexOf(slides[j]);
      if (k !== -1) return k;
    }
    return 0;
  }
  function goTo(i) { window.location.hash = String(i + 1); }

  var designBox = kit.designBox;

  // ---- Motion --------------------------------------------------------------

  // Shared with the filmstrip and the pull gesture; see MOTION_JS.
  var motion = window.sdocMotion;
  var SPRING = motion.SPRING, SETTLE = motion.SETTLE, play = motion.play, fly = motion.fly;

  // ---- Building ------------------------------------------------------------

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  var miniature = kit.miniature, settleMiniature = kit.settleMiniature;
  function sizeMiniature(box, w, h) { kit.sizeMiniature(box, w, h, design.w); }

  var overlay = null, backdrop = null, grid = null, legend = null;
  var cells = [], cols = 1, design = null, captionH = 0;
  var closing = false, ready = false, hot = -1, hover = -1, keyed = false, stirred = false;
  var keyScroll = false;

  function build() {
    overlay = el("div", "sdoc-overview");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-label", "Slide overview");
    overlay.setAttribute("aria-modal", "true");
    backdrop = el("div", "sdoc-overview-backdrop");
    grid = el("div", "sdoc-overview-grid");
    legend = el("div", "sdoc-overview-legend", "Click a slide to go to it \\u00b7 Arrows and Enter \\u00b7 O or Esc to close");
    overlay.appendChild(backdrop);
    overlay.appendChild(grid);
    overlay.appendChild(legend);

    cells = spine.map(function (slide, i) {
      var d = info[i];
      var cell = el("button", "sdoc-overview-cell");
      cell.type = "button";
      // Out of the tab order, as in the filmstrip: the overview has its own
      // arrow keys, and Tab walking forty buttons is not how anyone uses it.
      cell.setAttribute("tabindex", "-1");
      cell.setAttribute("aria-label", "Slide " + (i + 1) + (d.title ? ": " + d.title : ""));
      if (d.details) cell.classList.add("has-details");
      var mini = miniature(slide);
      mini.appendChild(el("div", "sdoc-overview-n", String(i + 1)));
      if (d.details) {
        mini.appendChild(el("div", "sdoc-overview-more", "+" + d.details));
      }
      cell.appendChild(mini);

      var cap = el("div", "sdoc-overview-caption");
      // A kicker line even when there is no kicker, so every title in a row
      // starts at the same height.
      cap.appendChild(el("div", "sdoc-overview-kicker", d.kicker || "\\u00a0"));
      if (d.title) cap.appendChild(el("div", "sdoc-overview-title", d.title));
      cell.appendChild(cap);
      grid.appendChild(cell);

      cell.setAttribute("data-sdoc-overview", String(i));
      cell.addEventListener("click", function (e) {
        e.stopPropagation();
        close(i);
      });
      return { el: cell, mini: mini, caption: cap, x: 0, y: 0, w: 0, h: 0 };
    });

    // The deck's own handlers navigate on any click, swipe or arrow key.
    // None of that may reach them while the overview is up.
    overlay.addEventListener("click", function (e) {
      e.stopPropagation();
      close(-1);
    });
    ["touchstart", "touchend", "pointerdown"].forEach(function (type) {
      overlay.addEventListener(type, function (e) { e.stopPropagation(); });
    });
    overlay.addEventListener("scroll", function () {
      if (keyScroll) {
        // The grid scrolled to bring the chosen cell into view. Its pending
        // preview stands; only one already up, now in the wrong place, goes.
        keyScroll = false;
        if (peek) { var keep = peekTimer; peekTimer = null; hidePeek(); peekTimer = keep; }
        return;
      }
      hidePeek();
      // What is under a resting pointer has changed; the next move decides.
      hover = -1;
    });
  }

  // The grid that makes the cells as large as they can be. Every column count
  // is tried, because the best one depends on the window's shape as much as
  // on the number of slides. Below a floor the cells stop shrinking and the
  // overview scrolls, since a caption narrower than that tells you nothing.
  var MIN_W = 120;

  function layout() {
    var vw = overlay.clientWidth || window.innerWidth;
    var vh = window.innerHeight;
    var short = Math.min(vw, vh);
    var pad = Math.max(16, Math.min(44, Math.round(short * 0.04)));
    var gap = Math.max(12, Math.min(28, Math.round(short * 0.024)));
    var legendH = legend.offsetHeight || 0;
    var W = vw - 2 * pad, H = vh - 2 * pad - legendH;
    var aspect = design.w / design.h;
    var n = cells.length;
    captionH = cells[0].caption.offsetHeight || 0;

    var best = null;
    for (var c = 1; c <= n; c++) {
      var r = Math.ceil(n / c);
      var w = Math.min((W - gap * (c - 1)) / c, ((H - gap * (r - 1)) / r - captionH) * aspect);
      if (!best || w > best.w + 0.5) best = { cols: c, w: w };
    }
    var cw = best.w;
    cols = best.cols;
    if (cw < MIN_W) {
      cols = Math.max(1, Math.floor((W + gap) / (MIN_W + gap)));
      cw = (W - gap * (cols - 1)) / cols;
    }
    cw = Math.floor(cw);
    var ch = Math.round(cw / aspect);
    var rows = Math.ceil(n / cols);
    var totalW = cols * cw + (cols - 1) * gap;
    var totalH = rows * (ch + captionH) + (rows - 1) * gap;
    var x0 = pad + Math.max(0, (W - totalW) / 2);
    var y0 = pad + Math.max(0, (H - totalH) / 2);

    cells.forEach(function (cell, i) {
      cell.x = Math.round(x0 + (i % cols) * (cw + gap));
      cell.y = Math.round(y0 + Math.floor(i / cols) * (ch + captionH + gap));
      cell.w = cw;
      cell.h = ch;
      var s = cell.el.style;
      s.left = cell.x + "px";
      s.top = cell.y + "px";
      s.width = cw + "px";
      sizeMiniature(cell.mini, cw, ch);
    });
    grid.style.height = Math.ceil(y0 + totalH + pad + legendH) + "px";
  }

  // ---- The larger copy -----------------------------------------------------

  // Rest on a cell and, after a moment, a larger copy grows out of it, centred
  // on it. It holds while the pointer stays inside it, and a click on it goes
  // to that slide. Moving off it shrinks it back into its cell, and the wait
  // starts over: nothing else comes up until the pointer rests again, so
  // crossing the grid on the way somewhere does not set off a run of them.
  // Not offered when the cells are already nearly that big.
  var PEEK_DELAY = 600;
  var peek = null, peekAt = -1, peekRect = null, peekFrom = null, peekTimer = null;

  function peekTarget(r) {
    var vw = window.innerWidth, vh = window.innerHeight, m = 16;
    var aspect = design.w / design.h;
    var w = Math.min(Math.min(vw - 2 * m, (vh - 2 * m) * aspect) * 0.6, design.w);
    if (w < r.width * 1.3) return null;
    var h = w / aspect;
    // Centred on the cell, then kept on screen.
    var x = Math.max(m, Math.min(r.left + r.width / 2 - w / 2, vw - m - w));
    var y = Math.max(m, Math.min(r.top + r.height / 2 - h / 2, vh - m - h));
    return { left: x, top: y, width: w, height: h };
  }
  function within(r, x, y) {
    return x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;
  }
  // The cell under a point, asked of the page as it is now.
  function cellAt(x, y) {
    if (x === null) return -1;
    var under = document.elementFromPoint(x, y);
    var cell = under && under.closest ? under.closest(".sdoc-overview-cell") : null;
    return cell ? parseInt(cell.getAttribute("data-sdoc-overview"), 10) : -1;
  }

  function armPeek(i) {
    clearTimeout(peekTimer);
    if (peek) return;
    peekTimer = setTimeout(function () { showPeek(i); }, PEEK_DELAY);
  }
  function disarmPeek() { clearTimeout(peekTimer); }

  function showPeek(i) {
    if (!overlay || closing || !ready || peek) return;
    var r = cells[i].mini.getBoundingClientRect();
    var t = peekTarget(r);
    if (!t) return;
    var p = el("div", "sdoc-overview-peek");
    p.setAttribute("role", "button");
    p.setAttribute("aria-label", cells[i].el.getAttribute("aria-label"));
    var box = miniature(spine[i]);
    p.appendChild(box);
    p.style.left = t.left + "px";
    p.style.top = t.top + "px";
    p.style.width = t.width + "px";
    p.style.height = t.height + "px";
    p.addEventListener("click", function (e) {
      e.stopPropagation();
      close(i, true);
    });
    overlay.appendChild(p);
    sizeMiniature(box, t.width, t.height);
    settleMiniature(box);
    peek = p;
    peekAt = i;
    peekRect = t;
    peekFrom = r;
    setHot(i, false);
    play(p, [{ transform: fly(r, t) }, { transform: "none" }],
      { duration: SPRING.duration, easing: SPRING.easing });
  }

  // Back down into its cell. It ends exactly on the cell's own miniature,
  // which is the same slide at the same size, so nothing jumps when it goes.
  // When the pointer sent it back, the cell now under the pointer starts its
  // wait from nothing.
  function collapsePeek(fromPointer) {
    clearTimeout(peekTimer);
    if (!peek) return;
    var p = peek, t = peekRect, r = peekFrom;
    peek = null;
    peekAt = -1;
    p.style.pointerEvents = "none";
    play(p, [{ transform: "none" }, { transform: fly(r, t) }],
      { duration: SETTLE.duration, easing: SETTLE.easing, fill: "forwards" })
      .then(function () { if (p.parentNode) p.parentNode.removeChild(p); });
    if (!fromPointer) return;
    hover = cellAt(px, py);
    if (hover !== -1) { setHot(hover, false); armPeek(hover); }
  }

  function hidePeek() {
    clearTimeout(peekTimer);
    if (!peek) return;
    if (peek.parentNode) peek.parentNode.removeChild(peek);
    peek = null;
    peekAt = -1;
  }

  // ---- Choosing with the keyboard ------------------------------------------

  function setHot(i, fromKeys) {
    if (i < 0 || i >= cells.length) return;
    if (fromKeys && !ready) keyed = true;
    if (hot !== -1 && cells[hot]) cells[hot].el.classList.remove("is-hot");
    hot = i;
    cells[i].el.classList.add("is-hot");
    // Focus follows the choice, so a screen reader says which slide it is.
    // Not while the cells are flying in: focusing one can scroll the grid.
    if (ready) focusHot();
    if (fromKeys) {
      if (peek && peekAt !== i) collapsePeek(false);
      var c = cells[i];
      var top = c.y, bottom = c.y + c.h + captionH;
      var before = overlay.scrollTop, to = before;
      if (top < before) to = top - 16;
      else if (bottom > before + overlay.clientHeight) to = bottom - overlay.clientHeight + 16;
      if (to !== before) {
        overlay.scrollTop = to;
        if (overlay.scrollTop !== before) keyScroll = true;
      }
      armPeek(i);
    }
  }
  function focusHot() {
    var c = cells[hot];
    if (!c) return;
    try { c.el.focus({ preventScroll: true }); } catch (err) { c.el.focus(); }
  }

  function step(dx, dy) {
    var i = hot === -1 ? currentIndex() : hot;
    var n = cells.length;
    if (dx) i = Math.max(0, Math.min(n - 1, i + dx));
    if (dy > 0 && i + cols < n) i += cols;
    else if (dy > 0 && Math.floor(i / cols) < Math.floor((n - 1) / cols)) i = n - 1;
    if (dy < 0 && i - cols >= 0) i -= cols;
    setHot(i, true);
  }

  // ---- Opening, by key or by pull ------------------------------------------

  // The whole way in is a function of one number. At 0 the deck is as it
  // was: the slide you were on fills its box and nothing else is visible. At
  // 1 the grid is at rest. A key runs it from 0 on a spring. A pull from the
  // top edge (the gesture runtime) sets it under the pointer, then hands
  // whatever is left to the same spring when let go, or springs it back to 0
  // when not. One description of the motion, so the two cannot drift apart.
  var plan = null, pulling = false;

  var returnFocus = null;
  function setup() {
    returnFocus = document.activeElement;
    keyScroll = false;
    var cur = currentIndex();
    var real = activeSlide();
    var from = real ? real.getBoundingClientRect() : null;
    design = designBox();
    closing = false;
    ready = false;
    hover = -1;
    keyed = false;
    stirred = false;

    build();
    document.body.appendChild(overlay);
    layout();
    cells.forEach(function (c) { settleMiniature(c.mini); });
    setHot(cur, false);
    var g = cells[cur];
    if (overlay.scrollHeight > overlay.clientHeight) {
      overlay.scrollTop = Math.max(0, g.y - (overlay.clientHeight - g.h) / 2);
    }
    var m = g.mini.getBoundingClientRect();
    var gc = cur % cols, gr = Math.floor(cur / cols);
    plan = {
      cur: cur,
      from: from && from.width > 0 && m.width > 0 ? from : null,
      mini: m,
      radius: parseFloat(getComputedStyle(g.mini).borderTopLeftRadius) || 0,
      // How far into the way in each cell waits before it moves: nearest
      // first, so the grid spreads out from the slide you were on.
      lag: cells.map(function (c, i) {
        if (i === cur) return 0;
        var dc = (i % cols) - gc, dr = Math.floor(i / cols) - gr;
        return Math.min(0.4, Math.sqrt(dc * dc + dr * dr) * 0.05);
      })
    };
    g.el.style.zIndex = "2";
  }

  function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }
  function lerp(a, b, t) { return a + (b - a) * t; }

  // Every style the way in touches, at progress p. "at" is the progress at
  // which that piece starts to move, which becomes its delay on a spring.
  function stateAt(p) {
    var out = [], g = cells[plan.cur];
    out.push({ el: backdrop, kind: "fade", at: 0, style: { opacity: String(clamp01(p / 0.4)) } });
    out.push({ el: legend, kind: "fade", at: 0.6, style: { opacity: String(clamp01((p - 0.6) / 0.4)) } });
    // The slide you were on shrinks into its place in the grid ...
    if (plan.from) {
      var f = plan.from, m = plan.mini;
      var r = { left: lerp(f.left, m.left, p), top: lerp(f.top, m.top, p),
                width: lerp(f.width, m.width, p), height: lerp(f.height, m.height, p) };
      // It also fades while it is pulled, so the grid reads through it, and
      // comes back as it lands. A key's way in runs straight from 0 to 1 and
      // never passes through the dip; a held pull sits in it.
      var dim = p >= 1 ? 1 : p < 0.6 ? 1 - 0.85 * (p / 0.6) : p < 0.85 ? 0.15 : 0.15 + 0.85 * ((p - 0.85) / 0.15);
      out.push({ el: g.el, kind: "spring", at: 0, style: { transform: p >= 1 ? "none" : fly(r, m), opacity: String(dim) } });
      out.push({ el: g.mini, kind: "ease", at: 0, style: { borderRadius: (plan.radius * p) + "px" } });
      // Its caption and badges are scaled with it, so until it is nearly
      // home they would be a slide-sized number and a title twice the size
      // of the slide's own. A pull can hold it there; a key never showed it.
      var late = String(clamp01((p - 0.75) / 0.25));
      out.push({ el: g.caption, kind: "fade", at: 0.75, style: { opacity: late } });
      [].forEach.call(g.mini.querySelectorAll(".sdoc-overview-n, .sdoc-overview-more"), function (b) {
        out.push({ el: b, kind: "fade", at: 0.75, style: { opacity: late } });
      });
    }
    // ... and the rest come out from behind it.
    cells.forEach(function (c, i) {
      if (i === plan.cur) return;
      var lag = plan.lag[i];
      var q = clamp01((p - lag) / (1 - lag));
      var sc = lerp(0.55, 1, q), full = c.h + captionH;
      var tx = (g.x - c.x) * 0.35 * (1 - q) + (1 - sc) * c.w / 2;
      var ty = (g.y - c.y) * 0.35 * (1 - q) + (1 - sc) * full / 2;
      out.push({ el: c.el, kind: "spring", at: lag, style: {
        transform: q >= 1 ? "none" : "translate(" + tx + "px, " + ty + "px) scale(" + sc + ")",
        opacity: String(q)
      } });
    });
    return out;
  }
  function applyState(p) {
    stateAt(p).forEach(function (e) { for (var k in e.style) e.el.style[k] = e.style[k]; });
  }
  function clearState() {
    stateAt(1).forEach(function (e) { for (var k in e.style) e.el.style[k] = ""; });
  }

  // From wherever the way in has got to, the rest of it. The page is set to
  // the end state at once and each piece animates from where it was, so a
  // piece that has not started yet still waits its turn.
  function animateIn(pFrom, fromPull) {
    var start = stateAt(pFrom), end = stateAt(1), waits = [];
    clearState();
    start.forEach(function (e, k) {
      var delay = Math.max(0, e.at - pFrom) * 600;
      var timing = e.kind === "spring"
        ? { duration: SPRING.duration, easing: SPRING.easing, delay: delay, fill: "backwards" }
        : e.kind === "fade"
          ? { duration: 220, easing: "ease-out", delay: Math.max(0, e.at - pFrom) * SPRING.duration, fill: "backwards" }
          : { duration: SPRING.duration, easing: "ease-out", delay: delay, fill: "backwards" };
      var to = {};
      for (var key in end[k].style) to[key] = end[k].style[key] === "" ? "none" : end[k].style[key];
      waits.push(play(e.el, [e.style, to], timing));
    });
    var g = cells[plan.cur];
    Promise.all(waits).then(function () {
      if (!overlay || closing) return;
      g.el.style.zIndex = "";
      g.el.classList.add("is-current");
      g.el.setAttribute("aria-current", "true");
      ready = true;
      focusHot();
      // Pulled open, the pointer is where the pull let go. That is not a
      // choice of cell, so nothing comes up until it moves.
      if (fromPull) stirred = false;
      // A choice made with the keys while the cells were still flying in
      // stands. The pointer gets a say only if the keys said nothing, and
      // only if it moved: cells passing under a resting pointer are not
      // somebody choosing one. Which cell it is on is asked now, not taken
      // from mid-flight — the slide you were on shrinks across half the
      // window on its way in, and was under the pointer for most of it.
      if (keyed) armPeek(hot);
      else if (stirred) {
        hover = cellAt(px, py);
        if (hover !== -1) { setHot(hover, false); armPeek(hover); }
      }
    });
  }

  // A pull let go short of the line: back to 0, which leaves the slide you
  // were on exactly over the real one, and then gone.
  function animateOut(pFrom) {
    var start = stateAt(pFrom), end = stateAt(0), waits = [], mine = overlay;
    // Leaving: no key, click or second pull may act on it while it goes.
    closing = true;
    applyState(0);
    start.forEach(function (e, k) {
      waits.push(play(e.el, [e.style, end[k].style], { duration: SETTLE.duration, easing: SETTLE.easing }));
    });
    Promise.all(waits).then(function () { teardown(mine); });
  }

  function open() {
    if (overlay) return;
    setup();
    animateIn(0, false);
  }

  // The handle the gesture runtime drives. set(t) takes the pull's own
  // progress, 0 to 1; it is eased here so the first few pixels of a pull
  // already move the slide, which is what makes it feel attached.
  function pull() {
    if (overlay) return null;
    pulling = true;
    setup();
    var at = 0;
    applyState(0);
    return {
      set: function (t) {
        if (!pulling || !overlay) return;
        var u = clamp01(t);
        at = 1 - (1 - u) * (1 - u);
        applyState(at);
      },
      commit: function () {
        if (!pulling) return;
        pulling = false;
        animateIn(at, true);
      },
      cancel: function () {
        if (!pulling) return;
        pulling = false;
        animateOut(at);
      }
    };
  }

  function teardown(mine) {
    if (mine && mine.parentNode) mine.parentNode.removeChild(mine);
    if (overlay === mine) {
      overlay = backdrop = grid = legend = peek = peekRect = peekFrom = plan = null;
      peekAt = -1;
      cells = [];
      hot = -1;
      closing = false;
      pulling = false;
      // Focus was moved into the overview; give it back to the deck.
      var back = returnFocus;
      returnFocus = null;
      if (back && back !== document.body && document.contains(back) && back.focus) {
        try { back.focus({ preventScroll: true }); } catch (err) {}
      }
    }
  }

  // target: the spine index to go to, or -1 to go back to where you were.
  // fromPeek: chosen on the larger copy, which is then what grows to fill the
  // window, rather than the cell underneath it.
  function close(target, fromPeek) {
    if (!overlay || closing || pulling) return;
    closing = true;
    clearTimeout(peekTimer);
    var grower = fromPeek && peek && peekAt === target ? peek : null;
    if (!grower) hidePeek();
    // Anything still springing in lands where it was going first, so the way
    // out starts from where the cells actually are.
    try {
      overlay.getAnimations({ subtree: true }).forEach(function (a) { a.finish(); });
    } catch (err) {}

    var real = activeSlide();
    var to = real ? real.getBoundingClientRect() : null;
    var i = target >= 0 ? target : currentIndex();
    // Every slide occupies the same box, so the one you were on gives the
    // rect the next one will fill, measured before the theme swaps them.
    if (target >= 0) goTo(target);

    var c = cells[i];
    var mine = overlay, waits = [];
    c.el.classList.remove("is-current", "is-hot");
    if (grower) {
      grower.style.pointerEvents = "none";
      if (to && to.width > 0) {
        waits.push(play(grower, [{ transform: "none", borderRadius: getComputedStyle(grower).borderRadius },
          { transform: fly(to, peekRect), borderRadius: "0px" }],
          { duration: SETTLE.duration, easing: SETTLE.easing, fill: "forwards" }));
      }
    } else {
      c.el.style.zIndex = "3";
      var m = c.mini.getBoundingClientRect();
      if (to && to.width > 0 && m.width > 0) {
        waits.push(play(c.el, [{ transform: "none" }, { transform: fly(to, m) }],
          { duration: SETTLE.duration, easing: SETTLE.easing, fill: "forwards" }));
        play(c.caption, [{ opacity: 1 }, { opacity: 0 }], { duration: 100, fill: "forwards" });
        play(c.mini, [{ borderRadius: getComputedStyle(c.mini).borderRadius }, { borderRadius: "0px" }],
          { duration: SETTLE.duration, fill: "forwards" });
      }
    }
    cells.forEach(function (o, k) {
      if (k === i && !grower) return;
      var s = 0.92, full = o.h + captionH;
      waits.push(play(o.el, [
        { opacity: 1, transform: "none" },
        { opacity: 0, transform: "translate(" + ((1 - s) * o.w / 2) + "px, " + ((1 - s) * full / 2) + "px) scale(" + s + ")" }
      ], { duration: 170, easing: "ease-in", fill: "forwards" }));
    });
    play(legend, [{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: "forwards" });
    waits.push(play(backdrop, [{ opacity: 1 }, { opacity: 0 }], { duration: SETTLE.duration, easing: "ease-in", fill: "forwards" }));

    Promise.all(waits).then(function () { teardown(mine); });
  }

  // ---- The pointer ---------------------------------------------------------

  // Hover is read from movement, not from pointerenter. Cells springing into
  // place, or the grid scrolling under the arrow keys, pass under a pointer
  // that is not moving, and the browser reports each as the pointer entering
  // a cell — which would take the choice away from the keys and hand it to
  // wherever the mouse happened to be resting. A move only counts if the
  // pointer is somewhere it was not.
  var px = null, py = null;
  window.addEventListener("pointermove", function (e) {
    if (e.pointerType === "touch") return;
    var moved = e.clientX !== px || e.clientY !== py;
    px = e.clientX;
    py = e.clientY;
    if (!overlay || closing || pulling || !moved) return;
    // Inside the larger copy, everything stays as it is. Its final box is
    // what counts, not where its animation has got to, so the pointer is not
    // judged to have left a copy that is still growing towards it.
    if (peek) {
      if (!within(peekRect, px, py)) collapsePeek(true);
      return;
    }
    if (!ready) { stirred = true; return; }
    var cell = e.target && e.target.closest ? e.target.closest(".sdoc-overview-cell") : null;
    var i = cell ? parseInt(cell.getAttribute("data-sdoc-overview"), 10) : -1;
    if (i === hover && (i === -1 || i === hot)) return;
    hover = i;
    if (i === -1) { disarmPeek(); return; }
    setHot(i, false);
    armPeek(i);
  }, true);

  // ---- Keys ----------------------------------------------------------------

  // On the window, in the capture phase: that runs before the theme's own
  // listener on the document, so while the overview is up an arrow key moves
  // through the grid instead of turning the slide underneath it.
  window.addEventListener("keydown", function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey || kit.editable(e.target)) return;
    var k = e.key || "";
    // Mid-pull the keys belong to the gesture — this one or the strip's.
    if (pulling || document.documentElement.classList.contains("sdoc-pulling")) return;
    if (!overlay) {
      if (k.toLowerCase() === KEY && !e.repeat) { e.preventDefault(); open(); }
      return;
    }
    if (closing) { e.preventDefault(); e.stopPropagation(); return; }
    // Holding O past the key-repeat delay would close what it just opened.
    if (e.repeat && k.toLowerCase() === KEY) { e.preventDefault(); e.stopPropagation(); return; }
    var handled = true;
    if (k === "Escape" && peek) collapsePeek(false);
    else if (k === "Escape" || k.toLowerCase() === KEY) close(-1);
    else if ((k === "Enter" || k === " ") && peek) close(peekAt, true);
    else if (k === "Enter" || k === " ") close(hot === -1 ? currentIndex() : hot);
    else if (k === "ArrowRight" || k === "PageDown") step(1, 0);
    else if (k === "ArrowLeft" || k === "PageUp") step(-1, 0);
    else if (k === "ArrowDown") step(0, 1);
    else if (k === "ArrowUp") step(0, -1);
    else if (k === "Home") setHot(0, true);
    else if (k === "End") setHot(cells.length - 1, true);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  var queued = false;
  window.addEventListener("resize", function () {
    if (!overlay || closing || pulling || queued) return;
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      if (!overlay || closing) return;
      hidePeek();
      design = designBox();
      layout();
    });
  });

  window.sdocOverview = {
    open: open,
    pull: pull,
    isOpen: function () { return !!overlay; }
  };
})();
`;

// Pull from an edge. Down from the top opens the overview, and the overview's
// own way in follows the pointer as it goes; up from the bottom raises the
// filmstrip. The views themselves are the feedback: the overview's way in
// and the strip both move with the pointer. The cursor says the rest — a
// closed hand while pulling, an open one once letting go would count — so
// nothing else is drawn over the slides. Dragging back past that point calls
// it off.
//
// This is the keyboard-free way to the two views — a touchscreen, a tablet
// presenting — and it has to coexist with a deck that already does things
// with every press and swipe: a click turns the slide, a vertical swipe moves
// through a drilldown column, a drag selects text or drags a picture, and a
// phone's browser reloads on a pull from the top. Each of those is held off
// here for a press that turns into a pull, and left alone for one that does
// not.
//
// It drives the overview and the filmstrip through the handles they publish
// (window.sdocOverview, window.sdocFilmstrip) rather than by faking their
// keys, so a pull can scrub them rather than only switch them on.
//
// Same escaping rule as the filmstrip: this is a template literal.
const GESTURE_JS = `
(function () {
  var overview = window.sdocOverview, film = window.sdocFilmstrip;
  if (!overview && !film) return;
  // The presenter window has a bar at its top and notes at its bottom; a
  // pull there is a click on them.
  if (window.sdocDeckKit.presenter) return;
  var motion = window.sdocMotion;
  var root = document.documentElement;

  var SLOP = 8;
  // The pull's own progress at which the overview's way in is complete.
  // Below 1, so that where letting go starts to count the overview is
  // already most of the way there, and letting go springs the rest.
  var OVERVIEW_SPAN = 1.8;

  function band() { return Math.max(48, window.innerHeight * 0.1); }

  function el(tag, cls) {
    var e = document.createElement(tag);
    e.className = cls;
    return e;
  }

  // ---- What it looks like --------------------------------------------------

  var handles = { top: el("div", "sdoc-pull-handle is-top"), bottom: el("div", "sdoc-pull-handle is-bottom") };
  document.body.appendChild(handles.top);
  document.body.appendChild(handles.bottom);

  // ---- Where a pull may start ----------------------------------------------

  function zoneAt(y) {
    var b = band(), vh = window.innerHeight;
    var up = overview && overview.isOpen();
    if (up) return null;
    if (y <= b && overview) return "top";
    if (y >= vh - b && film && !film.enabled()) return "bottom";
    return null;
  }
  function excluded(target) {
    // While a drawing tool is chosen a press on the slide is ink, and the
    // tools themselves are not the slide either.
    if (root.classList.contains("sdoc-inking")) return true;
    return !!(target && target.closest &&
      target.closest(".sdoc-overview, .sdoc-filmstrip, .sdoc-deck-ink, input, textarea, select, [contenteditable]"));
  }

  // A handle at the edge when the pointer rests in a band, so the gesture
  // can be found with a mouse at all.
  function hint(y, target) {
    var zone = g || excluded(target) ? null : zoneAt(y);
    handles.top.classList.toggle("is-shown", zone === "top");
    handles.bottom.classList.toggle("is-shown", zone === "bottom");
    root.classList.toggle("sdoc-pull-ready", !!zone);
  }
  function unhint() {
    handles.top.classList.remove("is-shown");
    handles.bottom.classList.remove("is-shown");
    root.classList.remove("sdoc-pull-ready");
  }

  // ---- The pull ------------------------------------------------------------

  var g = null, swallowUntil = 0;

  function press(x, y, id, target, touch) {
    if (g) return;
    var zone = zoneAt(y);
    if (!zone || excluded(target)) return;
    var vh = window.innerHeight;
    var fromEdge = zone === "top" ? y : vh - y;
    // Letting go counts once the pointer is a fifth of the window in from the
    // edge — and never less than a short drag from where it was pressed, or a
    // press near that line would be a pull before it moved.
    var counts = Math.max(vh * 0.2, fromEdge + 56);
    g = { zone: zone, id: id, x0: x, y0: y, y: y, touch: touch,
          dragging: false, armed: false, reach: counts - fromEdge, d: 0, ctl: null };
  }

  // false when this press is not a pull after all, and is left to the deck.
  function travel(x, y) {
    var d = g.zone === "top" ? y - g.y0 : g.y0 - y;
    if (!g.dragging) {
      var side = Math.abs(x - g.x0);
      if (Math.max(Math.abs(d), side) < SLOP) return true;
      if (d < SLOP || side > d) { g = null; return false; }
      g.ctl = g.zone === "top" ? overview.pull() : film.pull();
      if (!g.ctl) { g = null; return false; }
      g.dragging = true;
      begin();
    }
    g.d = Math.max(0, d);
    g.y = y;
    draw();
    return true;
  }

  function begin() {
    unhint();
    root.classList.add("sdoc-pulling");
    clearSelection();
  }

  function clearSelection() {
    var sel = window.getSelection && window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed) sel.removeAllRanges();
  }

  function draw() {
    var t = g.d / g.reach;
    clearSelection();
    var armed = t >= 1;
    if (armed !== g.armed) {
      g.armed = armed;
      root.classList.toggle("sdoc-pull-armed", armed);
      // A finger has no cursor; on a phone the moment it counts is a tap.
      if (armed && g.touch && navigator.vibrate) { try { navigator.vibrate(8); } catch (err) {} }
    }
    g.ctl.set(g.zone === "top" ? t / OVERVIEW_SPAN : t);
  }

  function release(letGo) {
    var h = g;
    g = null;
    if (!h || !h.dragging) return false;
    // The click the browser sends straight after a mouse pull is not a click
    // on the slide. A finger's pull sends none, and a window left open would
    // eat the next real tap.
    swallowUntil = h.touch ? 0 : Date.now() + 120;
    root.classList.remove("sdoc-pulling", "sdoc-pull-armed");
    if (letGo && h.armed) h.ctl.commit(); else h.ctl.cancel();
    return true;
  }

  // ---- Mouse and pen -------------------------------------------------------

  window.addEventListener("pointerdown", function (e) {
    if (e.pointerType === "touch" || e.button !== 0) return;
    press(e.clientX, e.clientY, e.pointerId, e.target, false);
  }, true);

  window.addEventListener("pointermove", function (e) {
    if (e.pointerType === "touch") return;
    if (!g) { hint(e.clientY, e.target); return; }
    if (e.pointerId !== g.id) return;
    var was = g.dragging;
    if (!travel(e.clientX, e.clientY)) return;
    if (g && g.dragging) {
      // Every move from here is the pull's: held, so leaving the window does
      // not lose it, and kept from the overview's hover and the strip.
      if (!was) { try { root.setPointerCapture(e.pointerId); } catch (err) {} }
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  window.addEventListener("pointerup", function (e) {
    if (!g || e.pointerId !== g.id) return;
    if (release(true)) {
      try { root.releasePointerCapture(e.pointerId); } catch (err) {}
      e.stopPropagation();
    }
  }, true);
  window.addEventListener("pointercancel", function (e) {
    if (g && e.pointerId === g.id) release(false);
  }, true);

  // A press in a band that never became a pull is an ordinary click and
  // turns the slide as one. A pull's own click does not.
  window.addEventListener("click", function (e) {
    if (Date.now() < swallowUntil) {
      swallowUntil = 0;
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  // Pressing on a picture or a link and moving starts the browser's own drag,
  // which ends every pointer event with a cancel.
  window.addEventListener("dragstart", function (e) { if (g) e.preventDefault(); }, true);

  root.addEventListener("mouseleave", unhint);

  // ---- Touch ---------------------------------------------------------------

  // Touch is read from touch events, not pointer events: a browser that
  // decides a touch is a scroll cancels its pointer events, and only a
  // touchmove can be told not to scroll — or not to pull-to-refresh, which
  // on a phone is this very motion and would reload the deck.
  window.addEventListener("touchstart", function (e) {
    if (e.touches.length !== 1) { if (g && g.touch) release(false); return; }
    var t = e.touches[0];
    press(t.clientX, t.clientY, "touch", e.target, true);
  }, { capture: true, passive: true });

  window.addEventListener("touchmove", function (e) {
    if (!g || !g.touch) return;
    var t = e.touches[0];
    if (!travel(t.clientX, t.clientY)) return;
    // Held from scrolling only once it is heading the pull's way, so a code
    // block or table in the band still scrolls sideways under a finger.
    var d = g.zone === "top" ? t.clientY - g.y0 : g.y0 - t.clientY;
    if (g.dragging || (d > 0 && d >= Math.abs(t.clientX - g.x0))) {
      if (e.cancelable) e.preventDefault();
    }
    if (g && g.dragging) e.stopPropagation();
  }, { capture: true, passive: false });

  window.addEventListener("touchend", function (e) {
    if (!g || !g.touch) return;
    // The theme reads a vertical swipe as a move through a drilldown column.
    if (release(true)) e.stopPropagation();
  }, true);
  window.addEventListener("touchcancel", function () {
    if (g && g.touch) release(false);
  }, true);

  // ---- Calling it off ------------------------------------------------------

  // While a pull is held every key is its: an arrow would turn the slide
  // under a half-open overview, and the cancel would then land on the wrong
  // one. Escape calls it off.
  window.addEventListener("keydown", function (e) {
    if (!g || !g.dragging) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") release(false);
  }, true);
  window.addEventListener("blur", function () { if (g) release(false); });
  // A rotated phone or a resized window invalidates the grid being pulled.
  window.addEventListener("resize", function () { if (g && g.dragging) release(false); });
})();
`;

function renderSlides(nodes, options = {}) {
  const {
    meta = {},
    themeCss = "",
    deckCss = "",
    themeJs = "",
    darkMode = false,
    themeConfig = {},
    fit = null,
    includeOptional = true,
    // false leaves every slide's @notes out of the page. They are hidden on
    // screen either way, but hidden is not absent: they are in the file, for
    // anyone who opens its source, and every export reads them back out of
    // it — the PowerPoint's speaker notes, a Claude Slides <aside>. A deck
    // whose notes are for the presenter alone needs them gone before it is
    // sent anywhere.
    includeNotes = true,
    // slide index -> a data URI with the fade already in its pixels. Only an
    // export fills this in; the HTML build keeps the real CSS mask, which a
    // browser renders correctly and which costs no browser to produce.
    bakedFades = {},
    // An array the caller may pass to be told what the deck asked for and did
    // not get — a connector pointed at an id nothing on the slide declares,
    // say. The renderer is a pure AST-to-HTML function and has nowhere else to
    // put such a thing; a caller that passes nothing gets today's behaviour.
    warnings = null
  } = options;

  // The design box and print page come from the theme (themes/<name>/theme.json).
  // They must agree: the box in CSS pixels is the page in inches at 96 dpi, which
  // is what makes screen and PDF the same geometry.
  const slideW = (themeConfig.slide && themeConfig.slide.width) || 1920;
  const slideH = (themeConfig.slide && themeConfig.slide.height) || 1080;
  const pageW = (themeConfig.page && themeConfig.page.width) || 20;
  const pageH = (themeConfig.page && themeConfig.page.height) || 11.25;

  // How the design box meets a window of a different shape.
  //   contain — scale to fit, letterbox the remainder (the default)
  //   cover   — scale to fill, crop the overflow
  //   stretch — scale each axis independently, distorting the slide
  const FIT_MODES = new Set(["contain", "cover", "stretch"]);
  const requested = (fit || themeConfig.fit || "contain").toLowerCase();
  const fitMode = FIT_MODES.has(requested) ? requested : "contain";

  // The nodes from extractMeta have @meta already stripped.
  // If there's a document scope wrapper, unwrap it to get the slides. The
  // reserved and :comment scopes beside it are not slides, so they can go.
  const deckScope = getDocumentScope(nodes);
  const slideScopes = deckScope ? deckScope.children : nodes;

  // Filter to scope nodes only (skip stray paragraphs, :comment scopes, and the
  // reserved scopes, @meta and the signposts — these describe the document, not slides).
  const slides = slideScopes.filter(
    (n) =>
      n.type === "scope" &&
      n.scopeType !== "comment" &&
      !(n.id && RESERVED_SCOPE_IDS.has(n.id.toLowerCase()))
  );

  // Build per-slide footer:
  //   <  CONFIDENTIAL  ---gap---  Company  N/Total  >
  // The indicator slot is rendered as a literal token here and substituted
  // per-slide inside renderSlide() so all the right-edge elements share one
  // flexbox row (avoids the page number stacking on top of the company name).
  const footerParts = [];
  footerParts.push(`<span class="nav-prev">&lsaquo;</span>`);
  if (meta.confidential) {
    const val = meta.confidential.trim();
    const entity = val.toLowerCase() === "true" ? meta.company : val;
    const text = entity
      ? `CONFIDENTIAL \u2014 ${escapeHtml(entity)}`
      : "CONFIDENTIAL";
    footerParts.push(`<span class="sdoc-confidential-notice">${text}</span>`);
  }
  footerParts.push(`<span class="slide-footer-gap"></span>`);
  if (meta.company) {
    footerParts.push(`<span class="sdoc-company-footer">${escapeHtml(meta.company)}</span>`);
  }
  footerParts.push(`<span class="slide-indicator">__SLIDE_INDICATOR__</span>`);
  footerParts.push(`<span class="nav-next">&rsaquo;</span>`);

  // The vertical pair, stacked up-over-down at bottom centre. Both are emitted
  // on every slide and start hidden; the theme runtime turns each on only when
  // that move exists from the slide you are actually on. That is the same
  // contract as .nav-prev / .nav-next, and it is why these cannot be a CSS
  // pseudo-element on a build-time class: whether you can go up or down is a
  // property of the current position, not of the slide.
  // One chevron path, drawn twice, mirrored for the up arrow. Text arrowheads
  // cannot do this: U+2303 and U+2304 are not designed as a pair and measure
  // ~26% apart in ink width, and because few fonts carry either codepoint the
  // metrics come from whatever the OS falls back to — so the mismatch is not
  // even consistent between platforms. A path is identical by construction
  // everywhere. The viewBox is symmetric about its own centre (y spans
  // 1.25..5.75 of 7), so the mirrored copy occupies the same box.
  const chevronSvg =
    `<svg viewBox="0 0 12 7" aria-hidden="true" focusable="false">` +
    `<path d="M1 1.25 L6 5.75 L11 1.25" fill="none" stroke="currentColor" ` +
    `stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const vertNavHtml =
    `\n<div class="nav-vert">` +
    `<span class="nav-up">${chevronSvg}</span>` +
    `<span class="nav-down">${chevronSvg}</span>` +
    `</div>`;
  const overlayHtml = `\n<div class="slide-footer">${footerParts.join("")}</div>${vertNavHtml}`;

  // Optional slides are for the room, not the file that gets sent on. They are
  // kept in the HTML build (includeOptional defaults to true, so every existing
  // caller sees the deck it saw before) and dropped here when a deck is
  // rendered for export. Dropping them before numbering — rather than hiding
  // them later in print CSS — is what keeps the indicator honest: the
  // denominator counts the spine slides the reader actually has.
  //
  // An optional spine takes its details with it. A detail belongs to its spine;
  // there is nowhere for it to go once the spine is gone.
  const kept = includeOptional ? slides : slides.filter((s) => !isOptionalSlide(s));

  // Build a flat emission order: each spine slide, followed immediately by its
  // :detail children in source order. The flat order matches what we want for
  // PDF export, so PDF needs no special case.
  const totalSpines = kept.length;
  const emitted = [];
  kept.forEach((scope, i) => {
    const spineIndex = i + 1; // 1-based
    const { details: allDetails } = extractDetails(scope.children);
    const details = includeOptional
      ? allDetails
      : allDetails.filter((d) => !isOptionalSlide(d));
    emitted.push({
      scope,
      position: {
        spine: spineIndex,
        detail: 0,
        totalSpines,
        hasDetails: details.length > 0
      }
    });
    details.forEach((detail, j) => {
      emitted.push({
        scope: detail,
        position: {
          spine: spineIndex,
          detail: j + 1,
          totalSpines,
          hasDetails: false
        }
      });
    });
  });

  const slidesHtml = emitted
    .map(({ scope, position }, index) =>
      renderSlide(scope, index, overlayHtml, position, bakedFades[index], warnings, includeNotes))
    .join("\n\n");

  const title = meta.properties?.title
    || (deckScope && deckScope.title ? deckScope.title : "Slides");

  // Structural styles — always injected regardless of theme.
  const structuralCss = `
/* --- Fixed design box + fit-to-window scaling ---------------------------
   Slides are laid out at a fixed design size (1280x720 CSS px, which is
   exactly the 13.333in x 7.5in print page at 96dpi) and then scaled as a
   whole to fill the window.  This is the standard deck technique: the
   author's layout is preserved verbatim at every window size, and screen
   and PDF are the same geometry by construction.

   --sdoc-slide-scale and --sdoc-slide-scale-y are written by the theme
   runtime (fitSlidesToWindow in themes/default/theme.js) on load and on
   resize, according to the fit mode on <html data-sdoc-fit>.  If JS never runs the
   scale stays 1 and the deck renders at its natural design size, which is
   the pre-scaling behaviour rather than a broken one.

   Themes must NOT set width/height/max-width/margin on .slide — those come
   from the design-box variables below.  A theme that wants a different
   aspect ratio should override --sdoc-slide-w / --sdoc-slide-h on :root
   (and the @page size in the print block, if PDF output matters). */
:root {
  --sdoc-slide-w: ${slideW}px;
  --sdoc-slide-h: ${slideH}px;
  --sdoc-slide-scale: 1;
  /* Defaults to the horizontal scale, so a theme shipping its own runtime
     that writes only --sdoc-slide-scale still scales uniformly. Only the
     stretch fit mode ever sets these two to different values. */
  --sdoc-slide-scale-y: var(--sdoc-slide-scale);
  /* The ground behind the slide, seen wherever the window is not the slide's
     shape. A theme that leaves this equal to its slide background gets an
     invisible letterbox: the slide has no edge and anything pinned to its
     bottom looks stranded. */
  --sdoc-letterbox: #000;
}
.slide {
  position: absolute;
  top: 50%;
  left: 50%;
  width: var(--sdoc-slide-w);
  height: var(--sdoc-slide-h);
  transform: translate(-50%, -50%)
             scale(var(--sdoc-slide-scale), var(--sdoc-slide-scale-y));
  transform-origin: center center;
  overflow: hidden;
  /* A background image sits at z-index -1 so it paints above the slide's own
     background and below every bit of content, without the content needing a
     z-index of its own — which matters, because .slide-head and .slide-body
     are display:contents and have no box to carry one. That only works while
     the slide is a stacking context. On screen the transform above makes one,
     but print removes the transform, so this states it outright and the image
     stays behind the text in the PDF instead of dropping out of sight. */
  isolation: isolate;
}
/* Slide background image. Full-bleed by design: it is the one thing on a slide
   that is supposed to reach the edges, which is also why the geometry harvest
   counts it as chrome rather than as content that has overflowed. */
.slide-bg {
  position: absolute;
  inset: 0;
  z-index: -1;
  overflow: hidden;
  pointer-events: none;
}
/* A unit symbol, marked by the renderer so that a theme's uppercasing cannot
   turn "40 mW" into "40 MW". Themes may restyle it, but must not reinstate a
   text-transform on it. */
.sdoc-unit { text-transform: none; }
.slide-bg-flip { width: 100%; height: 100%; }
.slide-bg img { display: block; width: 100%; height: 100%; }
.slide-footer {
  position: absolute; bottom: 30px; left: 48px; right: 48px;
  display: flex; align-items: baseline;
  pointer-events: none;
  /* The spacing between the footer's parts is a gap on the row, not a margin
     on each part. Both render the same here, but an export to a format with
     no margin can carry a gap and cannot carry these — and this is engine
     chrome, so every deck paid for it on every slide. 0.5em because the parts
     it separates are set at 0.7em, where the old 0.8em/0.6em margins came to
     0.56em/0.42em of this row's size. The flex:1 spacer absorbs the rest. */
  gap: 0.5em;
}
.slide-footer-gap { flex: 1; }
.nav-prev, .nav-next {
  font-size: 1.4em; color: #ccc;
  cursor: pointer; pointer-events: auto;
  user-select: none;
}
/* Vertical drilldown pair. The container is anchored by its bottom edge and
   grows upward, so .nav-down keeps the exact position the old pseudo-element
   chevron had and .nav-up stacks above it. */
.nav-vert {
  position: absolute;
  /* 16px, not 18px: the old chevron was a text glyph whose ink ran to the
     bottom of its line box, so an 18px box offset put the visible mark 18px
     up. The SVG carries a little padding below the stroke, so the box sits
     2px lower to land the mark in the same place. Measured, not guessed. */
  bottom: 24px; left: 50%;
  transform: translateX(-50%);
  display: flex; flex-direction: column; align-items: center;
  /* The two arrows are sized by their own boxes now, not by a line box with
     leading around a small glyph, which is where the old slack came from. */
  gap: 0.42em;
  line-height: 0;
  pointer-events: none;
}
.nav-up, .nav-down {
  /* Hidden until a runtime turns them on. A custom theme.js written before
     these elements existed does not know to hide them, and a dead arrowhead
     on every slide is worse than no arrowhead at all, so the safe state is
     the default and the runtime opts in. */
  visibility: hidden;
  display: block;
  font-size: 1.2em; color: #ccc;
  cursor: pointer; pointer-events: auto;
  user-select: none;
}
.nav-up svg, .nav-down svg {
  display: block;
  width: 0.62em; height: auto;
  stroke: currentColor;
}
/* The mirror. Same path, flipped about its own centre, so the pair matches to
   the pixel whatever font or platform the deck is presented on. */
.nav-up svg { transform: scaleY(-1); }
.sdoc-company-footer {
  font-size: 0.7em; color: rgba(0,0,0,0.35);
  letter-spacing: 0.04em;
}
.sdoc-confidential-notice {
  font-size: 0.65em; font-weight: 600;
  letter-spacing: 0.12em; text-transform: uppercase;
  color: rgba(160, 40, 40, 0.6);
}
.slide-indicator {
  font-size: 0.7em; color: rgba(0,0,0,0.35);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.04em;
  pointer-events: none;
  user-select: none;
}
/* Scale wrapper: invisible to layout in screen mode so existing slide
   styles (flex centering, two-column grid, etc.) work as-is.  In print
   mode it becomes a real block element whose transform is set by the
   beforeprint handler to shrink overflowing content to fit the page. */
.slide-content-scale { display: contents; }

/* Head and body wrappers are transparent to layout by default, so a theme
   written before they existed sees exactly the box tree it saw then: the
   heading and the content as direct children of the slide.  A theme that
   wants a real header band or a body that fills the remaining height
   overrides these two rules. */
.slide-head, .slide-body { display: contents; }

/* Filmstrip: the story arc, on demand.
   Off until T is pressed, then it hides at the bottom edge and rises when the
   pointer reaches for it, the way a dock does. It is a screen affordance and
   nothing else: hidden in print, skipped by the geometry harvest, and absent
   from every export.
   A theme may restyle any of this. It must not give .sdoc-filmstrip a
   position other than fixed, or the strip stops tracking the window. */
.sdoc-filmstrip {
  position: fixed; left: 0; right: 0; bottom: 0;
  z-index: 41;
  background: rgba(22, 22, 24, 0.92);
  border-top: 1px solid rgba(255, 255, 255, 0.12);
  padding: 10px 0 12px;
  transform: translateY(102%);
  transition: transform 160ms ease-out;
  user-select: none;
}
.sdoc-filmstrip.is-open { transform: translateY(0); }
.sdoc-filmstrip-track {
  display: flex; gap: 8px; padding: 0 12px;
  overflow-x: auto; scrollbar-width: none;
  scroll-behavior: auto;
}
.sdoc-filmstrip-track::-webkit-scrollbar { display: none; }
.sdoc-filmstrip-item {
  flex: 0 0 auto;
  box-sizing: border-box;
  appearance: none;
  font: inherit;
  font-family: inherit;
  text-align: left;
  margin: 0;
  height: 64px;
  padding: 8px 10px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.04);
  color: rgba(255, 255, 255, 0.62);
  cursor: pointer;
  position: relative;
  overflow: hidden;
  transition: border-color 120ms, background 120ms;
}
.sdoc-filmstrip-item:hover { background: rgba(255, 255, 255, 0.1); }
/* A thumbnail is a button, so clicking it focuses it and the browser rings
   it in blue — noise, next to the highlight that already says which slide is
   current. Dropped for a click and kept for a keyboard, which is the one case
   where a focus ring is the only thing telling you where you are. */
.sdoc-filmstrip-item:focus { outline: none; }
.sdoc-filmstrip-item:focus-visible {
  outline: 2px solid rgba(255, 255, 255, 0.9);
  outline-offset: 1px;
}
.sdoc-filmstrip-item.is-current {
  border-color: rgba(255, 255, 255, 0.85);
  background: rgba(255, 255, 255, 0.16);
  color: #fff;
}
.sdoc-filmstrip-n {
  font-size: 9px; letter-spacing: 0.08em;
  opacity: 0.5; font-variant-numeric: tabular-nums;
}
.sdoc-filmstrip-kicker {
  font-size: 10px; font-weight: 600; letter-spacing: 0.07em;
  text-transform: uppercase; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
  margin-top: 2px;
}
/* Deliberately small. It is there to give the thumbnail a shape you can
   recognise from across the deck, not to be read. */
.sdoc-filmstrip-title {
  font-size: 9px; line-height: 1.25; opacity: 0.68;
  margin-top: 3px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden;
}
/* A spine slide with drilldown details underneath it. */
.sdoc-filmstrip-item.has-details::after {
  content: ""; position: absolute; right: 5px; bottom: 5px;
  width: 4px; height: 4px; border-radius: 50%;
  background: rgba(255, 255, 255, 0.5);
}
.sdoc-filmstrip-hint {
  position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%);
  z-index: 42;
  font: 500 12px/1 system-ui, sans-serif; letter-spacing: 0.04em;
  color: rgba(255, 255, 255, 0.9);
  background: rgba(22, 22, 24, 0.92);
  border-radius: 20px; padding: 8px 16px;
  opacity: 0; transition: opacity 200ms;
  pointer-events: none;
}
.sdoc-filmstrip-hint.is-shown { opacity: 1; }
/* A word from a deck runtime other than the strip — that full screen was
   refused, say. Above the overview, which can be up when it is said. */
.sdoc-deck-hint {
  position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%);
  z-index: 70;
  font: 500 12px/1 system-ui, sans-serif; letter-spacing: 0.04em;
  color: rgba(255, 255, 255, 0.9);
  background: rgba(22, 22, 24, 0.92);
  border-radius: 20px; padding: 8px 16px;
  opacity: 0; transition: opacity 200ms;
  pointer-events: none;
}
.sdoc-deck-hint.is-shown { opacity: 1; }

/* Overview: every spine slide in one grid, on demand (O). Built when it opens
   and removed when it closes, and hidden in print besides, so no export, no
   harvest and no PDF can see it. A theme may restyle the chrome. The rules on
   the cloned .slide are what make a miniature of it and are not a theme's to
   change: without them the clone is a full-size slide centred in the window. */
.sdoc-overview {
  position: fixed; inset: 0; z-index: 60;
  overflow-x: hidden; overflow-y: auto;
  /* Room for a scrollbar that takes space (Windows, Linux) reserved up front:
     the grid is measured before it knows whether it will scroll. */
  scrollbar-gutter: stable;
  overscroll-behavior: contain;
  user-select: none; -webkit-user-select: none;
  /* A stack of offset cards behind a spine slide that has details under it.
     A shadow layer rather than an element, so it costs no layout and every
     state of the cell keeps it. */
  --sdoc-overview-stack: 0 0 0 0 transparent;
}
/* Opaque: at anything less the slide underneath reads through it, and its
   title at full size competes with every caption in the grid. */
.sdoc-overview-backdrop {
  position: fixed; inset: 0;
  background: #0e0e10;
}
.sdoc-overview-grid { position: relative; }
.sdoc-overview-cell {
  position: absolute; display: block;
  margin: 0; padding: 0; border: 0; background: none;
  appearance: none; -webkit-appearance: none;
  font: inherit; color: inherit; text-align: left;
  cursor: pointer;
  /* The open and close animations scale a cell from its top-left corner,
     which is the miniature's, so a slide lands exactly on the real one. */
  transform-origin: 0 0;
}
.sdoc-overview-cell:focus { outline: none; }
.sdoc-overview-cell.has-details {
  --sdoc-overview-stack: 6px 6px 0 -1px rgba(160, 160, 172, 0.32);
}
.sdoc-overview-mini {
  position: relative; overflow: hidden;
  border-radius: 4px;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.14), var(--sdoc-overview-stack),
              0 6px 20px rgba(0, 0, 0, 0.4);
  transition: box-shadow 140ms;
}
/* No :hover here. The runtime decides which cell the pointer has chosen
   from movement, and a ring on whatever sits under a resting pointer would
   mark a second cell beside the one the keys chose. */
.sdoc-overview-cell.is-hot .sdoc-overview-mini {
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.6), var(--sdoc-overview-stack),
              0 8px 26px rgba(0, 0, 0, 0.5);
}
.sdoc-overview-cell.is-current .sdoc-overview-mini {
  box-shadow: 0 0 0 3px #fff, var(--sdoc-overview-stack),
              0 8px 26px rgba(0, 0, 0, 0.5);
}
/* The miniature: the real slide at its design size, scaled from its corner.
   Everything a theme might do to place or hide a slide is undone here. */
.sdoc-overview-mini > .slide {
  position: absolute !important;
  top: 0 !important; left: 0 !important; right: auto !important; bottom: auto !important;
  margin: 0 !important;
  transform: scale(var(--sdoc-overview-k, 0.2)) !important;
  transform-origin: 0 0 !important;
  opacity: 1 !important; visibility: visible !important;
  pointer-events: none !important;
  transition: none !important; animation: none !important;
}
/* Navigation chrome is noise at this size. Opacity rather than display, so
   the footer it sits in keeps its layout. */
.sdoc-overview-mini .nav-prev, .sdoc-overview-mini .nav-next,
.sdoc-overview-mini .nav-vert { opacity: 0 !important; }
.sdoc-overview-n, .sdoc-overview-more {
  position: absolute; top: 6px; z-index: 1;
  font: 600 10px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
  letter-spacing: 0.04em; font-variant-numeric: tabular-nums;
  color: #fff; background: rgba(0, 0, 0, 0.62);
  padding: 4px 6px; border-radius: 9px;
  pointer-events: none;
}
.sdoc-overview-n { left: 6px; }
.sdoc-overview-more { right: 6px; }
/* The caption is the readable part: at this scale the slide's own type is
   texture. Its height is measured by the runtime, so a theme may change it. */
.sdoc-overview-caption {
  height: 54px; padding-top: 8px; box-sizing: border-box; overflow: hidden;
  color: rgba(255, 255, 255, 0.86);
}
.sdoc-overview-kicker {
  font-size: 10px; line-height: 13px; height: 13px; font-weight: 600;
  letter-spacing: 0.08em; text-transform: uppercase;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  opacity: 0.55;
}
.sdoc-overview-title {
  font-size: 13px; line-height: 15px; margin-top: 2px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden;
}
.sdoc-overview-cell.is-current .sdoc-overview-caption { color: #fff; }
.sdoc-overview-legend {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 4;
  padding: 10px 16px 10px;
  text-align: center;
  font: 500 11px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif;
  letter-spacing: 0.04em;
  color: rgba(255, 255, 255, 0.42);
  background: linear-gradient(rgba(14, 14, 16, 0), rgba(14, 14, 16, 0.92) 45%);
  pointer-events: none;
}
/* Presenter view (P): the deck opened again in a second window and laid out
   for the speaker. Above the deck's own slides, which are still there and
   still navigated by the theme; below the overview, which O opens over it. */
html.sdoc-presenting body { overflow: hidden; }
.sdoc-presenter {
  position: fixed; inset: 0; z-index: 50;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr) 18px minmax(0, var(--sdoc-presenter-notes, 38%));
  row-gap: 0; column-gap: 14px; padding: 12px 18px 18px;
  box-sizing: border-box;
  background: #0f0f11; color: #eaeaea;
  font: 15px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
}
/* The bar across the top; the drawing tools in a column down the left of
   everything below it, so they sit in one place whatever the stage and the
   divider are doing. */
.sdoc-presenter-bar { grid-column: 1 / -1; grid-row: 1; }
.sdoc-ink-tools { grid-column: 1; grid-row: 2 / -1; }
.sdoc-presenter-stage { grid-column: 2; grid-row: 2; }
.sdoc-presenter-split { grid-column: 2; grid-row: 3; }
.sdoc-presenter-notes { grid-column: 2; grid-row: 4; }
/* One height for every control in the bar, so they line up on both sides. */
.sdoc-presenter-bar {
  --sdoc-presenter-control: 38px;
  display: flex; align-items: center; gap: 12px; min-height: 44px;
  margin-bottom: 12px;
}
/* The divider between the slides and the notes: a grip to drag. */
.sdoc-presenter-split {
  display: flex; align-items: center; justify-content: center;
  cursor: row-resize; touch-action: none; outline: none;
}
.sdoc-presenter-grip {
  width: 56px; height: 4px; border-radius: 2px;
  background: rgba(255, 255, 255, 0.22);
  transition: background-color 120ms, width 120ms;
}
.sdoc-presenter-split:hover .sdoc-presenter-grip,
.sdoc-presenter-split.is-dragging .sdoc-presenter-grip,
.sdoc-presenter-split:focus-visible .sdoc-presenter-grip { background: rgba(255, 255, 255, 0.6); width: 80px; }
.sdoc-presenter-bar button {
  appearance: none; -webkit-appearance: none; margin: 0;
  box-sizing: border-box; height: var(--sdoc-presenter-control);
  display: inline-flex; align-items: center; justify-content: center;
  font: inherit; color: inherit; line-height: 1;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.16); border-radius: 8px;
  padding: 0 12px; cursor: pointer;
}
.sdoc-presenter-bar button:hover { background: rgba(255, 255, 255, 0.15); }
.sdoc-presenter-bar .sdoc-presenter-start {
  background: #2f7d4f; border-color: #45a46b; color: #fff;
  font-weight: 600; padding: 0 18px;
}
.sdoc-presenter-bar .sdoc-presenter-start:hover { background: #379259; }
/* A control that does not apply now is disabled in place, never hidden, so
   the bar never shifts under the pointer. */
.sdoc-presenter-bar button:disabled {
  opacity: 0.35; cursor: default; pointer-events: none;
}
.sdoc-presenter-bar .sdoc-presenter-timer {
  font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums;
  min-width: 96px; text-align: center;
}
/* Wide enough for both of its labels, so asking to confirm moves nothing. */
.sdoc-presenter-bar .sdoc-presenter-reset { min-width: 9.5em; }
.sdoc-presenter.is-paused .sdoc-presenter-timer { color: #f2c94c; }
.sdoc-presenter-bar .sdoc-presenter-reset.is-armed {
  background: #8a2b2b; border-color: #b84242; color: #fff;
}
.sdoc-presenter-status { color: rgba(255, 255, 255, 0.62); }
/* Before Start the projector does not follow, and that must not be missed. */
.sdoc-presenter-status.is-waiting { color: #f2c94c; font-weight: 600; }
.sdoc-presenter-gap { flex: 1; }
/* The counter, the clock and the notes size: three widgets, boxed and sized
   like the buttons on the left. */
.sdoc-presenter-count, .sdoc-presenter-clock, .sdoc-presenter-sizes {
  box-sizing: border-box; height: var(--sdoc-presenter-control);
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid rgba(255, 255, 255, 0.16); border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
}
.sdoc-presenter-count, .sdoc-presenter-clock {
  padding: 0 12px;
  font-size: 18px; line-height: 1; font-variant-numeric: tabular-nums;
  color: rgba(255, 255, 255, 0.86);
}
/* Room for the longest counter ("12.3 / 40"), so a slide change never
   nudges it. */
.sdoc-presenter-count { min-width: 6.5em; }
.sdoc-presenter-sizes { overflow: hidden; padding: 0; }
.sdoc-presenter-bar .sdoc-presenter-sizes button {
  height: 100%; border: 0; border-radius: 0; background: transparent;
}
.sdoc-presenter-bar .sdoc-presenter-sizes button:hover { background: rgba(255, 255, 255, 0.12); }
.sdoc-presenter-bar .sdoc-presenter-sizes button + button { border-left: 1px solid rgba(255, 255, 255, 0.16); }
/* Previous, current and next across; the next drill-down under the current
   slide — the way the arrow keys move. The runtime sizes each frame, the
   current slide first; the grid only places them. */
.sdoc-presenter-stage {
  position: relative;
  display: grid; min-height: 0; overflow: hidden;
  grid-template-columns: 1fr auto 1fr;
  grid-template-rows: auto auto auto;
  align-content: center;
  column-gap: 18px; row-gap: 14px;
}
/* Focus (Z, or a click on the current slide): that slide alone, centred on
   the stage at the size the runtime gives it. Only the stage changes; the
   bar and the notes are outside it. */
.sdoc-presenter.is-focused .sdoc-presenter-stage {
  display: flex; align-items: center; justify-content: center;
}
.sdoc-presenter.is-focused .sdoc-presenter-slot:not(.is-current),
.sdoc-presenter.is-focused .sdoc-presenter-slot.is-current .sdoc-presenter-label { display: none; }
/* Above the others, which it crosses on its way back into its place. */
.sdoc-presenter-slot.is-current { position: relative; z-index: 1; }
.sdoc-presenter-slot.is-current .sdoc-presenter-frame { cursor: zoom-in; }
.sdoc-presenter.is-focused .sdoc-presenter-slot.is-current .sdoc-presenter-frame { cursor: zoom-out; }
/* One place and one size in both states; only its icon changes. */
.sdoc-presenter-focus {
  position: absolute; z-index: 2; left: 0; top: 0;
  box-sizing: border-box; width: 30px; height: 30px; margin: 0; padding: 0;
  display: flex; align-items: center; justify-content: center;
  appearance: none; -webkit-appearance: none;
  background: rgba(15, 15, 17, 0.72); color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.28); border-radius: 7px;
  cursor: pointer; opacity: 0.78;
  transition: opacity 120ms, background-color 120ms;
}
.sdoc-presenter-focus:hover, .sdoc-presenter-focus:focus-visible { opacity: 1; background: rgba(44, 44, 48, 0.92); }
.sdoc-presenter-focus svg, .sdoc-presenter-chevron svg {
  width: 16px; height: 16px;
  fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round;
}
.sdoc-presenter-focus .is-collapse,
.sdoc-presenter.is-focused .sdoc-presenter-focus .is-expand { display: none; }
.sdoc-presenter.is-focused .sdoc-presenter-focus .is-collapse { display: block; }
/* Where the arrow keys lead from the focused slide: a tab just inside each
   edge that has a neighbour, small enough to sit in the slide's margin. */
.sdoc-presenter-chevron {
  position: absolute; z-index: 2; display: none;
  box-sizing: border-box; margin: 0; padding: 0;
  align-items: center; justify-content: center;
  appearance: none; -webkit-appearance: none;
  background: rgba(15, 15, 17, 0.62); color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.22); border-radius: 999px;
  cursor: pointer; opacity: 0.72;
  transition: opacity 120ms;
}
.sdoc-presenter-chevron:hover { opacity: 1; }
.sdoc-presenter.is-focused .sdoc-presenter-chevron.is-on { display: flex; }
.sdoc-presenter-chevron.is-left, .sdoc-presenter-chevron.is-right { top: 50%; width: 24px; height: 44px; margin-top: -22px; }
.sdoc-presenter-chevron.is-up, .sdoc-presenter-chevron.is-down { left: 50%; width: 44px; height: 24px; margin-left: -22px; }
.sdoc-presenter-chevron.is-left { left: 8px; }
.sdoc-presenter-chevron.is-right { right: 8px; }
.sdoc-presenter-chevron.is-up { top: 8px; }
.sdoc-presenter-chevron.is-down { bottom: 8px; }
.sdoc-presenter-slot { display: flex; flex-direction: column; min-width: 0; }
.sdoc-presenter-slot.is-up { grid-column: 2; grid-row: 1; justify-self: center; }
.sdoc-presenter-slot.is-prev { grid-column: 1; grid-row: 2; justify-self: end; align-self: center; }
.sdoc-presenter-slot.is-current { grid-column: 2; grid-row: 2; }
.sdoc-presenter-slot.is-next { grid-column: 3; grid-row: 2; justify-self: start; align-self: center; }
.sdoc-presenter-slot.is-down { grid-column: 2; grid-row: 3; justify-self: center; }
/* The slide above: its bottom edge, fading out upwards. */
.sdoc-presenter-slot.is-up .sdoc-presenter-frame {
  align-items: flex-end; overflow: hidden;
  -webkit-mask-image: linear-gradient(to bottom, transparent, #000 70%);
  mask-image: linear-gradient(to bottom, transparent, #000 70%);
}
.sdoc-presenter-slot.is-up .sdoc-overview-mini { flex: none; }
.sdoc-presenter-slot.is-up.is-empty { visibility: hidden; }
.sdoc-presenter-label {
  height: 20px; margin-bottom: 6px;
  font-size: 12px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase;
  color: rgba(255, 255, 255, 0.5); white-space: nowrap;
}
.sdoc-presenter-frame {
  flex: none;
  display: flex; align-items: center; justify-content: center;
  text-align: center;
}
.sdoc-presenter-slot:not(.is-current):not(.is-empty) .sdoc-presenter-frame { cursor: pointer; }
.sdoc-presenter-slot.is-current .sdoc-overview-mini {
  box-shadow: 0 0 0 2px #fff, 0 10px 32px rgba(0, 0, 0, 0.55);
}
.sdoc-presenter-slot:not(.is-current) .sdoc-overview-mini { opacity: 0.88; transition: opacity 120ms; }
.sdoc-presenter-slot:not(.is-current) .sdoc-presenter-frame:hover .sdoc-overview-mini { opacity: 1; }
.sdoc-presenter-none { color: rgba(255, 255, 255, 0.38); font-style: italic; margin: 0; white-space: nowrap; }
.sdoc-presenter-notes {
  min-height: 0; overflow: auto;
  background: rgba(255, 255, 255, 0.045);
  border: 1px solid rgba(255, 255, 255, 0.09); border-radius: 10px;
  padding: 18px 26px;
  font-size: var(--sdoc-presenter-notes-size, 30px); line-height: 1.45;
}
/* The notes are the deck's own markup; the theme's type sizes and colours
   are for slides, not for this. */
.sdoc-presenter-notes-body :is(p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th) {
  font-size: 1em; color: inherit; margin: 0 0 0.5em; line-height: inherit;
}
.sdoc-presenter-notes-body :is(ul, ol) { margin: 0 0 0.5em; padding-left: 1.2em; }
.sdoc-presenter-notes-body :is(strong, b) { color: #fff; }
/* The drawing tools. Every one is always there, at one size; the chosen
   tool and pen colour are marked, and what does not apply is disabled. */
.sdoc-ink-tools {
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  min-height: 0; overflow-x: hidden; overflow-y: auto; scrollbar-width: none;
}
.sdoc-ink-tools button {
  position: relative; flex: none;
  box-sizing: border-box; width: 40px; height: 40px; margin: 0; padding: 0;
  display: flex; align-items: center; justify-content: center;
  appearance: none; -webkit-appearance: none;
  font: inherit; color: rgba(255, 255, 255, 0.86);
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 8px;
  cursor: pointer;
}
.sdoc-ink-tools button:hover { background: rgba(255, 255, 255, 0.14); }
.sdoc-ink-tools button.is-on {
  background: rgba(255, 255, 255, 0.2); border-color: #fff; color: #fff;
}
.sdoc-ink-tools button:disabled { opacity: 0.35; cursor: default; pointer-events: none; }
.sdoc-ink-tools button.is-armed { background: #8a2b2b; border-color: #b84242; color: #fff; }
.sdoc-ink-tools svg {
  width: 20px; height: 20px;
  fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
}
.sdoc-ink-tool.is-pen svg, .sdoc-ink-tool.is-rect svg, .sdoc-ink-tool.is-callout svg { color: var(--sdoc-ink-pen, #ef3434); }
/* A callout being typed: over its box on the current slide, scaled with
   it, so the text and the caret sit exactly where the text will be drawn. */
.sdoc-ink-editor { position: fixed; z-index: 4; left: 0; top: 0; transform-origin: 0 0; }
.sdoc-ink-editor[hidden] { display: none; }
/* The handle that makes a callout wider or narrower, on its side edge. */
.sdoc-ink-handle {
  position: fixed; z-index: 5; left: 0; top: 0; box-sizing: border-box;
  width: 10px; height: 24px; border-radius: 5px;
  background: #fff; border: 2px solid var(--sdoc-callout-pen, #ef3434);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
  cursor: ew-resize; touch-action: none;
}
.sdoc-ink-handle[hidden] { display: none; }
.sdoc-ink-tool[data-key]::after {
  content: attr(data-key);
  position: absolute; right: 3px; bottom: 2px;
  font-size: 9px; line-height: 1; font-weight: 600; color: rgba(255, 255, 255, 0.5);
}
.sdoc-ink-swatch-dot {
  width: 18px; height: 18px; border-radius: 50%;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.35);
}
.sdoc-ink-tools-rule { flex: none; width: 24px; height: 1px; margin: 3px 0; background: rgba(255, 255, 255, 0.16); }
.sdoc-ink-swatch[aria-expanded="true"], .sdoc-ink-tool[aria-expanded="true"] { border-color: #fff; }
.sdoc-ink-tool.is-highlighter svg { color: var(--sdoc-ink-highlight, #ffd60a); }
/* A pen's colours, on a double-click: beside the column and over the stage,
   placed by the runtime, so nothing under it moves. */
.sdoc-ink-colours {
  position: fixed; z-index: 5; left: 0; top: 0;
  box-sizing: border-box; width: max-content; padding: 10px 12px 12px;
  display: flex; flex-direction: column; gap: 10px;
  background: #1d1d21; color: #eaeaea;
  border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 10px;
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.6);
  font-size: 13px; line-height: 1.2;
}
.sdoc-ink-colours[hidden] { display: none; }
/* The notch, pointing back at the colour being changed. */
.sdoc-ink-colours::before {
  content: ""; position: absolute; left: -6px; top: var(--sdoc-ink-colours-notch, 50%);
  width: 10px; height: 10px; margin-top: -5px;
  background: inherit; border: inherit; border-width: 0 0 1px 1px; border-radius: 0 0 0 2px;
  transform: rotate(45deg);
}
.sdoc-ink-colours-title {
  font-size: 11px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase;
  color: rgba(255, 255, 255, 0.55);
}
.sdoc-ink-colours-grid { display: grid; grid-template-columns: repeat(4, 28px); gap: 9px; }
.sdoc-ink-colours-preset, .sdoc-ink-colours-input {
  appearance: none; -webkit-appearance: none;
  box-sizing: border-box; width: 28px; height: 28px; margin: 0; padding: 0;
  border: 2px solid #1d1d21; border-radius: 50%;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.3);
  cursor: pointer;
}
.sdoc-ink-colours-preset:hover, .sdoc-ink-colours-input:hover { box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.8); }
.sdoc-ink-colours-preset.is-on { box-shadow: 0 0 0 2px #fff; }
.sdoc-ink-colours-other { display: flex; align-items: center; gap: 9px; cursor: pointer; color: rgba(255, 255, 255, 0.78); }
.sdoc-ink-colours-other:hover { color: #fff; }
.sdoc-ink-colours-input { overflow: hidden; background: none; }
.sdoc-ink-colours-input::-webkit-color-swatch-wrapper { padding: 0; }
.sdoc-ink-colours-input::-webkit-color-swatch { border: 0; border-radius: 50%; }
.sdoc-ink-colours-input::-moz-color-swatch { border: 0; border-radius: 50%; }
/* With a tool chosen, a press on the current slide draws: no zoom cursor,
   no selection, and a pen or a finger does not pan. */
.sdoc-presenter.is-inking .sdoc-presenter-slot.is-current .sdoc-presenter-frame,
.sdoc-presenter.is-focused.is-inking .sdoc-presenter-slot.is-current .sdoc-presenter-frame {
  cursor: crosshair; touch-action: none;
  user-select: none; -webkit-user-select: none;
}
/* Drawing in the deck's own window: the presenter's palette over the left
   edge, up only while it is wanted, above the slides and below the strip
   and the overview. Nothing under it moves when it comes and goes. While a
   tool is chosen, the face takes every press on the page, so none of them
   turns the slide. */
.sdoc-deck-ink {
  position: fixed; inset: 0; z-index: 40; pointer-events: none;
  font: 15px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: #eaeaea;
}
.sdoc-deck-ink > * { pointer-events: auto; }
.sdoc-deck-ink-face {
  position: fixed; inset: 0; display: none;
  cursor: crosshair; touch-action: none; user-select: none; -webkit-user-select: none;
}
html.sdoc-inking .sdoc-deck-ink-face { display: block; }
.sdoc-deck-tools {
  position: fixed; left: 10px; top: 50%; transform: translateY(-50%);
  box-sizing: border-box; max-height: calc(100vh - 20px); display: flex;
  padding: 8px 6px; border-radius: 12px;
  background: rgba(18, 18, 20, 0.9); border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
  visibility: hidden; opacity: 0;
}
.sdoc-deck-ink.is-shown .sdoc-deck-tools { visibility: visible; opacity: 1; transition: opacity 160ms; }
/* The ink itself: an overlay in the slide, in its design pixels, above
   everything on it and never in the way of a click. */
.slide > svg.sdoc-ink {
  position: absolute !important; left: 0 !important; top: 0 !important;
  width: 100% !important; height: 100% !important;
  margin: 0 !important; z-index: 1000; pointer-events: none !important; overflow: hidden;
}

/* Pull from an edge: down from the top for the overview, up from the bottom
   for the filmstrip. Screen-only, like the rest of the deck's chrome. */
html, body { overscroll-behavior: none; }
html.sdoc-pull-ready, html.sdoc-pull-ready body { cursor: grab; }
html.sdoc-pulling, html.sdoc-pulling * {
  cursor: grabbing !important;
  user-select: none !important; -webkit-user-select: none !important;
}
/* Far enough: the hand opens, which is what letting go now does. */
html.sdoc-pulling.sdoc-pull-armed, html.sdoc-pulling.sdoc-pull-armed * {
  cursor: grab !important;
}
.sdoc-pull-handle {
  position: fixed; left: 50%; z-index: 59;
  width: 44px; height: 5px; margin-left: -22px;
  border-radius: 3px;
  background: rgba(120, 120, 130, 0.6);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.4), 0 1px 4px rgba(0, 0, 0, 0.25);
  opacity: 0; transition: opacity 180ms;
  pointer-events: none;
}
.sdoc-pull-handle.is-top { top: 8px; }
.sdoc-pull-handle.is-bottom { bottom: 8px; }
.sdoc-pull-handle.is-shown { opacity: 1; transition-delay: 120ms; }
/* The larger copy that grows out of a cell the pointer rests on. It takes
   the pointer: staying inside it keeps it, and a click on it goes there. */
.sdoc-overview-peek {
  position: fixed; z-index: 5;
  cursor: pointer;
  transform-origin: 0 0;
  border-radius: 6px; overflow: hidden;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.3), 0 24px 80px rgba(0, 0, 0, 0.65);
}
.sdoc-overview-peek .sdoc-overview-mini { border-radius: 0; box-shadow: none; }

/* Scatter: the positioning mechanism, not the styling.  A point carries its
   coordinates as left/bottom percentages, which mean nothing unless the plot
   establishes a containing block and the point is taken out of flow — so those
   two rules live here rather than in a theme, and a theme that has never heard
   of this layout still puts the points where the author put them.

   The height floor is the same kind of guarantee.  Every child of the plot is
   absolutely positioned, so the plot has no content to derive a height from
   and collapses to nothing, stacking every point on one line.  A theme sets
   the real height; this only stops the layout from silently folding flat.
   Everything visible — the dot, the rules, the type, where a label sits
   relative to its point — belongs to the theme. */
.scatter-plot { position: relative; min-height: 360px; }
.scatter-point { position: absolute; }

@media print {
  @page { size: ${pageW}in ${pageH}in; margin: 0; }
  body { overflow: visible; height: auto; }
  .slide {
    /* A column flex box, exactly as on screen. display:block here would be
       cheaper, but it silently changes the layout the theme was written
       against: justify-content goes inert and a margin-top:auto that pins a
       footnote to the foot of the slide computes to 0, so content that is
       centred on screen prints hard against the top of the page. */
    display: flex !important;
    flex-direction: column !important;
    position: relative !important;
    opacity: 1 !important;
    pointer-events: auto !important;
    page-break-after: always; break-after: page;
    /* The design box IS the page (the theme's px box at 96dpi),
       so no fit-to-window scaling applies here — each slide flows as one
       page at its natural size.  Overflowing content is still shrunk by
       the inner .slide-content-scale wrapper (see fitSlidesForPrint). */
    top: auto !important; left: auto !important;
    transform: none !important;
    margin: 0 !important;
    width: var(--sdoc-slide-w); height: var(--sdoc-slide-h); max-width: none;
    overflow: hidden;
    page-break-inside: avoid; break-inside: avoid;
  }
  .slide:last-child { page-break-after: auto; break-after: auto; }
  /* On screen this wrapper is display:contents, so the theme's rules on
     .slide reach the slide's own content directly. In print it must be a real
     box, because fitSlidesForPrint scales it — and a real box swallows those
     rules: .slide is left with one full-height child, so it has nothing to
     distribute and its own justify-content/align-items stop meaning anything.
     The wrapper therefore takes over as the flex container and inherits those
     properties from .slide, so whatever a theme set there still decides the
     layout. Inheriting beats naming layouts (.layout-title and friends): a
     theme that centres every slide, or one with layouts we have never heard
     of, keeps working. */
  .slide-content-scale {
    display: flex !important;
    flex-direction: column !important;
    /* Fill the slide's content box, so an auto margin inside has the slide's
       full height to push against, as it does on screen. min-height:0 lets it
       shrink back when the content is taller than the page — the overflow is
       what fitSlidesForPrint measures. */
    flex: 1 1 auto !important;
    min-height: 0 !important;
    width: 100%;
    justify-content: inherit;
    align-items: inherit;
    gap: inherit;
    transform-origin: top left;
  }
  .nav-prev, .nav-next { display: none !important; }
  .sdoc-filmstrip, .sdoc-filmstrip-hint { display: none !important; }
  .sdoc-overview, .sdoc-deck-hint { display: none !important; }
  .sdoc-pull-handle { display: none !important; }
  .sdoc-presenter { display: none !important; }
  .sdoc-deck-ink { display: none !important; }
  .sdoc-ink { display: none !important; }
  .nav-vert { display: none !important; }
  .notes { display: none; }
}`;

  const darkCss = darkMode ? `
/* Dark mode overrides */
body { background: #1e1e1e; color: #d4d4d4; }
h1, h2 { color: #e0e0e0; }
h3 { color: #b0b0b0; }
p, li { color: #b0b0b0; }
th { color: #9d9d9d; }
th, td { border-bottom-color: rgba(255, 255, 255, 0.1); }
pre { background: rgba(255, 255, 255, 0.06); border-color: rgba(255, 255, 255, 0.1); }
p code, li code { background: rgba(255, 255, 255, 0.08); }
blockquote { border-left-color: #5b9bd5; color: #9d9d9d; }
blockquote p { color: #9d9d9d; }
.nav-prev, .nav-next { color: rgba(255, 255, 255, 0.7); }
.nav-up, .nav-down { color: rgba(255, 255, 255, 0.5); }
.sdoc-company-footer { color: rgba(255, 255, 255, 0.35); }
.sdoc-confidential-notice { color: rgba(235, 120, 120, 0.7); }
.slide-indicator { color: rgba(255, 255, 255, 0.35); }
` : "";

  // The deck's own stylesheet comes last, after the theme and after the dark
  // overrides, so a deck can settle a tie on its own slides without raising
  // specificity. A theme is shared by every deck built from it; this is the
  // escape hatch for the one slide that should not look like the others.
  // Only when a deck actually draws one: a deck with no connectors is emitted
  // exactly as it was before this existed, which is what keeps every checked-in
  // golden honest about what changed.
  const hasConnectors = slidesHtml.includes("data-sdoc-connectors=");
  const connectorCss = hasConnectors ? CONNECTOR_CSS : "";

  // Without comments: they are for whoever reads the stylesheet, and a built
  // deck is read by whoever it is sent to. A deck's own stylesheet can carry a
  // great deal of internal reasoning — one real deck had 264 comments, 149,000
  // characters naming people and decisions — all of it legible in the page's
  // source. A /*! comment stays, by the usual convention for a licence notice.
  const css = stripCssComments(`${structuralCss}\n${connectorCss}${themeCss}\n${darkCss}\n${deckCss}`);
  const cssTag = `<style>\n${css}</style>`;
  const jsTag = themeJs ? `<script>\n${themeJs}\n</script>` : "";
  // Each runtime in a script element of its own, as written: comments and
  // all. Taking the comments out safely needs a JavaScript parser, which this
  // dependency-free renderer does not have.
  const runtimeTag = (js) => `<script>\n${js}\n</script>`;
  // After the theme, so the navigation it couples to already exists.
  const filmstripTag = runtimeTag(FILMSTRIP_JS);
  // Neither knows anything a theme does not already publish: the hash, .active.
  const fullscreenTag = runtimeTag(FULLSCREEN_JS);
  const overviewTag = runtimeTag(OVERVIEW_JS);
  // Before every runtime that springs; after the two it drives.
  const motionTag = runtimeTag(MOTION_JS);
  const kitTag = runtimeTag(DECK_KIT_JS);
  // The drawing tools and the presenter view, each after what it is handed:
  // the pure modules, then the tools made of them, then the two windows.
  const presenterTag = [INK_JS, SNAP_JS, CALLOUT_JS, STROKES_JS, ANNOTATE_JS, PRESENTER_JS].map(runtimeTag).join("");
  const gestureTag = runtimeTag(GESTURE_JS);
  // Last, so the boxes it measures have been laid out by everything above it.
  const connectorTag = hasConnectors ? runtimeTag(CONNECTOR_JS) : "";
  const mermaidCdn = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";
  const mermaidTheme = darkMode ? "dark" : "neutral";
  const mermaidTag = slidesHtml.includes('class="mermaid"')
    ? `\n<script src="${mermaidCdn}"></script>\n<script>mermaid.initialize({startOnLoad:true,theme:"${mermaidTheme}",themeCSS:".node rect, .node polygon, .node circle { rx: 4; ry: 4; }"});</script>`
    : "";
  const katexCssCdn = "https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.css";
  const katexTag = slidesHtml.includes('class="katex"')
    ? `\n<link rel="stylesheet" href="${katexCssCdn}" />`
    : "";

  return `<!DOCTYPE html>
<html lang="en" data-sdoc-fit="${fitMode}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
${cssTag}${katexTag}
</head>
<body>
${slidesHtml}

${jsTag}${motionTag}${kitTag}${filmstripTag}${fullscreenTag}${overviewTag}${gestureTag}${presenterTag}${connectorTag}${mermaidTag}
</body>
</html>`;
}

// CSS without its comments, except /*! ones. A comment inside a string or an
// unquoted url() is not a comment and stays. Where a removed comment was the
// only thing between two words — `1px/**/2px` — a space takes its place, so
// they do not run together; anywhere else nothing does, since a space there
// can change meaning (`a/**/.b` is `a.b`, and `a .b` is something else).
function stripCssComments(css) {
  const word = /[A-Za-z0-9_%-]/;
  let out = "";
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== ch && css[j] !== "\n") j += css[j] === "\\" ? 2 : 1;
      out += css.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if ((ch === "u" || ch === "U") && /^url\(/i.test(css.slice(i, i + 4)) && !word.test(css[i - 1] || "")) {
      // An unquoted url() runs to its closing parenthesis; a quoted one is a
      // string, which the branch above copies as it is.
      let j = i + 4;
      while (j < css.length && /\s/.test(css[j])) j++;
      if (css[j] !== '"' && css[j] !== "'") {
        const close = css.indexOf(")", j);
        const end = close < 0 ? css.length : close + 1;
        out += css.slice(i, end);
        i = end;
        continue;
      }
      out += css.slice(i, j);
      i = j;
      continue;
    }
    if (ch === "/" && css[i + 1] === "*") {
      const close = css.indexOf("*/", i + 2);
      const end = close < 0 ? css.length : close + 2;
      if (css[i + 2] === "!") {
        out += css.slice(i, end);
      } else if (word.test(out[out.length - 1] || "") && word.test(css[end] || "")) {
        out += " ";
      }
      i = end;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

module.exports = {
  stripCssComments,
  renderSlides,
  renderSlide,
  renderNode,
  renderInline,
  isOptionalSlide,
  inlineDeckImages,
  extractConnectors,
};
