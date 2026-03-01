// SDOC Slide Renderer — converts parsed SDOC AST to an HTML slide deck.
//
// Usage:
//   const { parseSdoc, extractMeta } = require("./sdoc");
//   const { renderSlides } = require("./slide-renderer");
//   const parsed = parseSdoc(text);
//   const { nodes, meta } = extractMeta(parsed.nodes);
//   const html = renderSlides(nodes, { meta, themeCss, themeJs });

const { parseInline, renderKatex, escapeHtml, escapeAttr } = require("./sdoc");

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

  return `<table${classAttr}>${thead}${thead ? "\n" : ""}${tbody}</table>`;
}

function renderNestedScope(scope) {
  const heading = scope.hasHeading !== false && scope.title
    ? `<h3>${renderInline(scope.title)}</h3>`
    : "";
  const children = scope.children.map((child) => renderNode(child)).join("\n");
  return `<section>${heading}\n${children}</section>`;
}

function renderChildren(nodes) {
  return nodes.map((node) => renderNode(node)).join("\n");
}

// ---------------------------------------------------------------------------
// Slide-level extraction
// ---------------------------------------------------------------------------

// Extracts config: lines from the beginning of a scope's children.
// Returns { config: { key: value, ... }, contentNodes: [...] }
function extractSlideConfig(children) {
  const config = {};
  const contentNodes = [];
  let pastConfig = false;

  for (const child of children) {
    if (!pastConfig && child.type === "paragraph") {
      const match = child.text.match(/^config\s*:\s*(.+)$/i);
      if (match) {
        const value = match[1].trim();
        // Support multiple config lines; last one wins for the same key
        // For now, config values are simple strings; primary use is layout
        config.layout = value;
        continue;
      }
    }
    pastConfig = true;
    contentNodes.push(child);
  }

  return { config, contentNodes };
}

// Separates @notes child scope from other children
function extractNotes(children) {
  const notes = [];
  const rest = [];
  for (const child of children) {
    if (child.type === "scope" && child.id && child.id.toLowerCase() === "notes") {
      notes.push(child);
    } else {
      rest.push(child);
    }
  }
  return { notes, contentNodes: rest };
}

// ---------------------------------------------------------------------------
// Slide rendering
// ---------------------------------------------------------------------------

function renderSlide(scope, slideIndex, overlayHtml) {
  const { config, contentNodes: afterConfig } = extractSlideConfig(scope.children);
  const { notes, contentNodes } = extractNotes(afterConfig);

  const classes = ["slide"];
  if (config.layout) {
    classes.push(config.layout);
  }

  const title = scope.hasHeading !== false && scope.title
    ? `<h2>${renderInline(scope.title)}</h2>`
    : "";

  let bodyHtml;
  if (config.layout === "two-column") {
    // In two-column layout, child scopes become columns
    const columns = contentNodes.filter((n) => n.type === "scope");
    const nonColumns = contentNodes.filter((n) => n.type !== "scope");
    const preamble = nonColumns.length ? renderChildren(nonColumns) : "";
    const columnsHtml = columns
      .map((col) => {
        const colTitle = col.hasHeading !== false && col.title
          ? `<h3>${renderInline(col.title)}</h3>`
          : "";
        const colContent = renderChildren(col.children);
        return `<div class="column">${colTitle}\n${colContent}</div>`;
      })
      .join("\n");
    bodyHtml = preamble + `\n<div class="columns">\n${columnsHtml}\n</div>`;
  } else {
    bodyHtml = renderChildren(contentNodes);
  }

  const notesHtml = notes.length
    ? `\n<aside class="notes">${notes.map((n) => renderChildren(n.children)).join("\n")}</aside>`
    : "";

  const idAttr = scope.id ? ` id="${escapeAttr(scope.id)}"` : "";
  const overlay = overlayHtml || "";

  return `<div class="${classes.join(" ")}"${idAttr}>\n${title}\n${bodyHtml}${notesHtml}${overlay}\n</div>`;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

function renderSlides(nodes, options = {}) {
  const {
    meta = {},
    themeCss = "",
    themeJs = ""
  } = options;

  // The nodes from extractMeta have @meta already stripped.
  // If there's a document scope wrapper, unwrap it to get the slides.
  let slideScopes;
  if (nodes.length === 1 && nodes[0].type === "scope" && nodes[0].children) {
    slideScopes = nodes[0].children;
  } else {
    slideScopes = nodes;
  }

  // Filter to scope nodes only (skip stray paragraphs at top level)
  const slides = slideScopes.filter((n) => n.type === "scope");

  // Build per-slide footer: <  CONFIDENTIAL  ---gap---  Company  >
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
  footerParts.push(`<span class="nav-next">&rsaquo;</span>`);
  const overlayHtml = `\n<div class="slide-footer">${footerParts.join("")}</div>`;

  const slidesHtml = slides
    .map((scope, index) => renderSlide(scope, index, overlayHtml))
    .join("\n\n");

  const title = meta.properties?.title
    || (nodes.length === 1 && nodes[0].title ? nodes[0].title : "Slides");

  // Structural styles — always injected regardless of theme.
  const structuralCss = `
.slide { position: relative; }
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
@media print {
  @page { size: 13.333in 7.5in; margin: 0; }
  body { overflow: visible; height: auto; }
  .slide {
    display: flex !important;
    position: relative !important;
    opacity: 1 !important;
    pointer-events: auto !important;
    page-break-after: always; break-after: page;
    width: 100vw; height: 100vh; max-width: none;
    page-break-inside: avoid; break-inside: avoid;
  }
  .slide:last-child { page-break-after: auto; break-after: auto; }
  .nav-prev, .nav-next { display: none !important; }
  .notes { display: none; }
}`;

  const cssTag = `<style>\n${structuralCss}\n${themeCss}\n</style>`;
  const jsTag = themeJs ? `<script>\n${themeJs}\n</script>` : "";
  const mermaidCdn = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";
  const mermaidTag = slidesHtml.includes('class="mermaid"')
    ? `\n<script src="${mermaidCdn}"></script>\n<script>mermaid.initialize({startOnLoad:true,theme:"neutral",themeCSS:".node rect, .node polygon, .node circle { rx: 4; ry: 4; }"});</script>`
    : "";
  const katexCssCdn = "https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.css";
  const katexTag = slidesHtml.includes('class="katex"')
    ? `\n<link rel="stylesheet" href="${katexCssCdn}" />`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
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

module.exports = { renderSlides, renderSlide, renderNode, renderInline };
