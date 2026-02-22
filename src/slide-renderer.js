// SDOC Slide Renderer — converts parsed SDOC AST to an HTML slide deck.
//
// Usage:
//   const { parseSdoc, extractMeta } = require("./sdoc");
//   const { renderSlides } = require("./slide-renderer");
//   const parsed = parseSdoc(text);
//   const { nodes, meta } = extractMeta(parsed.nodes);
//   const html = renderSlides(nodes, { meta, themeCss, themeJs });

const { parseInline, escapeHtml, escapeAttr } = require("./sdoc");

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
        case "image":
          return `<img src="${escapeAttr(node.src)}" alt="${escapeAttr(node.alt)}" />`;
        case "ref":
          return `@${escapeHtml(node.id)}`;
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
  const headerCells = table.headers
    .map((cell) => `<th>${renderInline(cell)}</th>`)
    .join("");
  const thead = `<thead><tr>${headerCells}</tr></thead>`;

  const bodyRows = table.rows
    .map((row) => {
      const cells = row.map((cell) => `<td>${renderInline(cell)}</td>`).join("");
      return `<tr>${cells}</tr>`;
    })
    .join("\n");
  const tbody = bodyRows ? `<tbody>\n${bodyRows}\n</tbody>` : "";

  return `<table>${thead}\n${tbody}</table>`;
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

  // Build per-slide overlay (company + confidential) embedded inside each slide
  const overlayParts = [];
  if (meta.company) {
    overlayParts.push(`<div class="sdoc-company-footer">${escapeHtml(meta.company)}</div>`);
  }
  if (meta.confidential) {
    const val = meta.confidential.trim();
    const entity = val.toLowerCase() === "true" ? meta.company : val;
    const text = entity
      ? `CONFIDENTIAL \u2014 ${escapeHtml(entity)}`
      : "CONFIDENTIAL";
    overlayParts.push(`<div class="sdoc-confidential-notice">${text}</div>`);
  }
  const overlayHtml = overlayParts.length
    ? `\n<div class="slide-overlay">${overlayParts.join("\n")}</div>`
    : "";

  const slidesHtml = slides
    .map((scope, index) => renderSlide(scope, index, overlayHtml))
    .join("\n\n");

  const title = meta.properties?.title
    || (nodes.length === 1 && nodes[0].title ? nodes[0].title : "Slides");

  // Structural styles — always injected regardless of theme.
  const structuralCss = `
.slide { position: relative; }
.slide-overlay { position: absolute; bottom: 0; left: 0; right: 0; pointer-events: none; }
.sdoc-company-footer {
  position: absolute; bottom: 20px; left: 32px;
  font-size: 0.7em; color: rgba(0,0,0,0.35);
  letter-spacing: 0.04em;
}
.sdoc-confidential-notice {
  text-align: center; padding: 5px 0;
  font-size: 0.65em; font-weight: 600;
  letter-spacing: 0.12em; text-transform: uppercase;
  color: rgba(160, 40, 40, 0.6);
}
@media print {
  @page { size: 13.333in 7.5in; margin: 0; }
  body { overflow: visible; height: auto; }
  .slide {
    display: flex !important;
    page-break-after: always; break-after: page;
    width: 100vw; height: 100vh; max-width: none;
    page-break-inside: avoid; break-inside: avoid;
  }
  .slide:last-child { page-break-after: auto; break-after: auto; }
  .controls { display: none; }
  .notes { display: none; }
}`;

  const cssTag = `<style>\n${themeCss}\n${structuralCss}\n</style>`;
  const jsTag = themeJs ? `<script>\n${themeJs}\n</script>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
${cssTag}
</head>
<body>
${slidesHtml}

<div class="controls">
  <span id="counter"></span>
</div>

${jsTag}
</body>
</html>`;
}

module.exports = { renderSlides, renderSlide, renderNode, renderInline };
