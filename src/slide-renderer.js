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
const { parseInline, renderKatex, escapeHtml, escapeAttr, sanitizeSvg, colorSwatchHtml } = require("./sdoc");
const { extractConfig, buildBody, accentClass, slug, truthy } = require("./slide-layouts");

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
  const children = scope.children.map((child) => renderNode(child)).join("\n");
  return `<section${typeAttr}>${heading}\n${children}</section>`;
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

function slideBackground(config) {
  const src = String(config.background || "").trim();
  if (!src) return "";

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
  if (fade) {
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
  return `<div class="slide-bg" aria-hidden="true"${wrapStyle}>${inner}</div>\n`;
}

// ---------------------------------------------------------------------------
// Slide rendering
// ---------------------------------------------------------------------------

// position: { spine: 1-based spine index, detail: 0 for spine, 1..N for details,
//             totalSpines: total number of spine slides, hasDetails: bool (spine only) }
function renderSlide(scope, slideIndex, overlayHtml, position) {
  // Pull :detail children out first so they don't appear inline in the spine
  // slide's content; they're rendered as sibling vertical slides instead.
  const { contentNodes: afterDetails } = extractDetails(scope.children);
  const { config, contentNodes: afterConfig } = extractConfig(afterDetails);
  const { notes, contentNodes } = extractNotes(afterConfig);

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
  const bgHtml = slideBackground(config);

  return `<div class="${classes.join(" ")}"${idAttr}${dataAttrs}>\n${bgHtml}<div class="slide-content-scale">\n${title}\n${bodyHtml}\n</div>${notesHtml}${overlay}\n</div>`;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

function renderSlides(nodes, options = {}) {
  const {
    meta = {},
    themeCss = "",
    themeJs = "",
    darkMode = false,
    themeConfig = {},
    fit = null,
    includeOptional = true
  } = options;

  // The design box and print page come from the theme (themes/<name>/theme.json).
  // They must agree: the box in CSS pixels is the page in inches at 96 dpi, which
  // is what makes screen and PDF the same geometry.
  const slideW = (themeConfig.slide && themeConfig.slide.width) || 1280;
  const slideH = (themeConfig.slide && themeConfig.slide.height) || 720;
  const pageW = (themeConfig.page && themeConfig.page.width) || 13.333;
  const pageH = (themeConfig.page && themeConfig.page.height) || 7.5;

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
    .map(({ scope, position }, index) => renderSlide(scope, index, overlayHtml, position))
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
  position: absolute; bottom: 20px; left: 32px; right: 32px;
  display: flex; align-items: baseline;
  pointer-events: none;
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
  bottom: 16px; left: 50%;
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
  margin-right: 0.8em;
}
.sdoc-confidential-notice {
  font-size: 0.65em; font-weight: 600;
  letter-spacing: 0.12em; text-transform: uppercase;
  color: rgba(160, 40, 40, 0.6);
  margin-left: 0.8em;
}
.slide-indicator {
  font-size: 0.7em; color: rgba(0,0,0,0.35);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.04em;
  pointer-events: none;
  user-select: none;
  margin-right: 0.6em;
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

@media print {
  @page { size: ${pageW}in ${pageH}in; margin: 0; }
  body { overflow: visible; height: auto; }
  .slide {
    display: block !important;
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
  .slide-content-scale {
    display: block;
    width: 100%;
    transform-origin: top left;
  }
  .nav-prev, .nav-next { display: none !important; }
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

  const cssTag = `<style>\n${structuralCss}\n${themeCss}\n${darkCss}</style>`;
  const jsTag = themeJs ? `<script>\n${themeJs}\n</script>` : "";
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

${jsTag}${mermaidTag}
</body>
</html>`;
}

module.exports = { renderSlides, renderSlide, renderNode, renderInline, isOptionalSlide, inlineDeckImages };
