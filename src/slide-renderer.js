// SDOC Slide Renderer — converts parsed SDOC AST to an HTML slide deck.
//
// Usage:
//   const { parseSdoc, extractMeta } = require("./sdoc");
//   const { renderSlides } = require("./slide-renderer");
//   const parsed = parseSdoc(text);
//   const { nodes, meta } = extractMeta(parsed.nodes);
//   const html = renderSlides(nodes, { meta, themeCss, themeJs });

const { parseInline, renderKatex, escapeHtml, escapeAttr, sanitizeSvg, colorSwatchHtml } = require("./sdoc");
const { extractConfig, buildBody, accentClass, slug, truthy } = require("./slide-layouts");

// ---------------------------------------------------------------------------
// Inline rendering — produces clean HTML without sdoc-* classes
// ---------------------------------------------------------------------------

function renderInlineNodes(nodes) {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
          return escapeHtml(node.value);
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
  return `<div class="${classes.join(" ")}"${idAttr}${dataAttrs}>\n<div class="slide-content-scale">\n${title}\n${bodyHtml}\n</div>${notesHtml}${overlay}\n</div>`;
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
  const overlayHtml = `\n<div class="slide-footer">${footerParts.join("")}</div>`;

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
}
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

module.exports = { renderSlides, renderSlide, renderNode, renderInline, isOptionalSlide };
