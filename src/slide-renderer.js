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
const { parseInline, renderKatex, escapeHtml, escapeAttr, sanitizeSvg, svgBlockIds, colorSwatchHtml } = require("./sdoc");
const { extractConfig, buildBody, accentClass, slug, truthy } = require("./slide-layouts");
const {
  readConnector,
  CONNECTOR_SCOPE_ID,
  CONNECTOR_JS,
  CONNECTOR_CSS,
} = require("./slide-connectors");

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
function renderSlide(scope, slideIndex, overlayHtml, position, bakedFade, warnings) {
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

  const notesHtml = notes.length
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
  var KEY = "f";
  var MAX_VISIBLE = 15;
  var STORE = "sdocFilmstrip";

  var slides = [].slice.call(document.querySelectorAll(".slide"));
  var spine = slides.filter(function (s) {
    return (s.getAttribute("data-detail") || "0") === "0";
  });
  // One slide is not a story, and nothing about it is worth a strip.
  if (spine.length < 2) return;

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
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target;
    if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName || ""))) return;
    if ((e.key || "").toLowerCase() !== KEY) return;
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
  // If there's a document scope wrapper, unwrap it to get the slides.
  let slideScopes;
  if (nodes.length === 1 && nodes[0].type === "scope" && nodes[0].children) {
    slideScopes = nodes[0].children;
  } else {
    slideScopes = nodes;
  }

  // Filter to scope nodes only (skip stray paragraphs, :comment scopes, and the
  // reserved @meta / @about metadata scopes — these are document metadata, not slides).
  const RESERVED_SCOPE_IDS = new Set(["meta", "about"]);
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
      renderSlide(scope, index, overlayHtml, position, bakedFades[index], warnings))
    .join("\n\n");

  const title = meta.properties?.title
    || (nodes.length === 1 && nodes[0].title ? nodes[0].title : "Slides");

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

  const cssTag = `<style>\n${structuralCss}\n${connectorCss}${themeCss}\n${darkCss}\n${deckCss}</style>`;
  const jsTag = themeJs ? `<script>\n${themeJs}\n</script>` : "";
  // After the theme, so the navigation it couples to already exists.
  const filmstripTag = `<script>\n${FILMSTRIP_JS}\n</script>`;
  // Last, so the boxes it measures have been laid out by everything above it.
  const connectorTag = hasConnectors ? `<script>\n${CONNECTOR_JS}\n</script>` : "";
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

${jsTag}${filmstripTag}${connectorTag}${mermaidTag}
</body>
</html>`;
}

module.exports = {
  renderSlides,
  renderSlide,
  renderNode,
  renderInline,
  isOptionalSlide,
  inlineDeckImages,
  extractConnectors,
};
