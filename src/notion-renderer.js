// SDOC Notion Renderer — converts parsed SDOC AST to Notion API block objects.
//
// Usage:
//   const { parseSdoc, extractMeta } = require("./sdoc");
//   const { renderNotionBlocks } = require("./notion-renderer");
//   const parsed = parseSdoc(text);
//   const { nodes, meta } = extractMeta(parsed.nodes);
//   const blocks = renderNotionBlocks(nodes);

const { parseInline } = require("./sdoc");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RICH_TEXT_LIMIT = 2000;

const NOTION_LANGUAGES = new Set([
  "abap", "arduino", "bash", "basic", "c", "clojure", "coffeescript", "c++",
  "c#", "css", "dart", "diff", "docker", "elixir", "elm", "erlang",
  "flow", "fortran", "f#", "gherkin", "glsl", "go", "graphql", "groovy",
  "haskell", "html", "java", "javascript", "json", "julia", "kotlin",
  "latex", "less", "lisp", "livescript", "lua", "makefile", "markdown",
  "markup", "matlab", "mermaid", "nix", "objective-c", "ocaml", "pascal",
  "perl", "php", "plain text", "powershell", "prolog", "protobuf",
  "python", "r", "reason", "ruby", "rust", "sass", "scala", "scheme",
  "scss", "shell", "sql", "swift", "typescript", "vb.net", "verilog",
  "vhdl", "visual basic", "webassembly", "xml", "yaml"
]);

const LANGUAGE_ALIASES = {
  "js": "javascript",
  "ts": "typescript",
  "py": "python",
  "rb": "ruby",
  "sh": "shell",
  "yml": "yaml",
  "txt": "plain text",
  "text": "plain text",
  "cs": "c#",
  "cpp": "c++",
  "objc": "objective-c",
  "dockerfile": "docker",
  "make": "makefile",
  "md": "markdown",
  "rs": "rust",
  "kt": "kotlin"
};

// ---------------------------------------------------------------------------
// Rich text helpers
// ---------------------------------------------------------------------------

function defaultAnnotations() {
  return {
    bold: false,
    italic: false,
    strikethrough: false,
    underline: false,
    code: false,
    color: "default"
  };
}

function richText(content, href, annotations) {
  return {
    type: "text",
    text: {
      content: content,
      link: href ? { url: href } : null
    },
    annotations: { ...annotations }
  };
}

function enforceContentLimit(richTexts, limit) {
  const result = [];
  for (const rt of richTexts) {
    const content = rt.text.content;
    if (content.length <= limit) {
      result.push(rt);
      continue;
    }
    for (let i = 0; i < content.length; i += limit) {
      result.push({
        type: rt.type,
        text: { content: content.slice(i, i + limit), link: rt.text.link },
        annotations: { ...rt.annotations }
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Inline AST → Notion rich text (recursive flattener)
// ---------------------------------------------------------------------------

function flattenInlineNodes(nodes, annotations, href) {
  const ann = annotations || defaultAnnotations();
  const result = [];

  for (const node of nodes) {
    switch (node.type) {
      case "text":
        if (node.value) {
          result.push(richText(node.value, href || null, ann));
        }
        break;
      case "strong":
        result.push(...flattenInlineNodes(node.children, { ...ann, bold: true }, href));
        break;
      case "em":
        result.push(...flattenInlineNodes(node.children, { ...ann, italic: true }, href));
        break;
      case "strike":
        result.push(...flattenInlineNodes(node.children, { ...ann, strikethrough: true }, href));
        break;
      case "code":
        result.push(richText(node.value, href || null, { ...ann, code: true }));
        break;
      case "link":
        result.push(...flattenInlineNodes(node.children, ann, node.href));
        break;
      case "ref":
        result.push(richText("@" + node.id, href || null, ann));
        break;
      case "image":
        // Images are extracted at the block level; skip here.
        break;
      default:
        break;
    }
  }

  return result;
}

function flattenInline(text) {
  if (!text) return [];
  const nodes = parseInline(text);
  return enforceContentLimit(flattenInlineNodes(nodes), RICH_TEXT_LIMIT);
}

// ---------------------------------------------------------------------------
// Image extraction from inline content
// ---------------------------------------------------------------------------

function extractImagesFromInline(text) {
  const inlineNodes = parseInline(text);
  const textNodes = [];
  const images = [];

  for (const node of inlineNodes) {
    if (node.type === "image") {
      images.push(node);
    } else {
      textNodes.push(node);
    }
  }

  const rt = enforceContentLimit(flattenInlineNodes(textNodes), RICH_TEXT_LIMIT);
  const hasText = rt.some((r) => r.text.content.trim() !== "");

  const imageBlocks = [];
  for (const img of images) {
    // Notion requires absolute URLs for external images
    if (!/^https?:\/\//i.test(img.src)) continue;
    imageBlocks.push({
      type: "image",
      image: {
        type: "external",
        external: { url: img.src },
        caption: img.alt ? [richText(img.alt, null, defaultAnnotations())] : []
      }
    });
  }

  return { richText: hasText ? rt : [], imageBlocks };
}

// ---------------------------------------------------------------------------
// Language mapping
// ---------------------------------------------------------------------------

function mapNotionLanguage(lang) {
  if (!lang) return "plain text";
  const lower = lang.toLowerCase();
  if (NOTION_LANGUAGES.has(lower)) return lower;
  return LANGUAGE_ALIASES[lower] || "plain text";
}

// ---------------------------------------------------------------------------
// Block factories
// ---------------------------------------------------------------------------

function headingBlock(level, text, children) {
  const key = "heading_" + level;
  const block = {
    type: key,
    [key]: {
      rich_text: flattenInline(text),
      is_toggleable: !!(children && children.length > 0)
    }
  };
  if (children && children.length > 0) {
    block[key].children = children;
  }
  return block;
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

// Notion API allows max 2 levels of block nesting per append request.
// nestLevel tracks position in the Notion block hierarchy (0 = top-level
// in the request, 1 = children of those, 2 = grandchildren). Blocks at
// nestLevel 2 CANNOT have children. This is separate from document depth
// (which determines heading level).
// Notion allows max 2 levels of nesting, but complex block types (tables,
// lists with children) cannot appear at level 2. Setting MAX_NEST to 1
// means only heading_1 is a toggle heading — its children sit at level 1
// where tables and nested lists work correctly.
const MAX_NEST = 1;

function renderNotionBlocks(nodes) {
  // Unwrap document scope wrapper (single root scope)
  if (nodes.length === 1 && nodes[0].type === "scope" && nodes[0].children) {
    const doc = nodes[0];
    if (doc.hasHeading && doc.title) {
      // Document title scope: render as top-level toggle heading
      const childBlocks = renderChildren(doc.children, 2, 1);
      return [headingBlock(1, doc.title, childBlocks)];
    }
    return renderChildren(doc.children, 1, 0);
  }

  return renderChildren(nodes, 1, 0);
}

function renderChildren(nodes, depth, nestLevel) {
  const blocks = [];
  for (const node of nodes) {
    blocks.push(...renderNode(node, depth, nestLevel));
  }
  return blocks;
}

function renderNode(node, depth, nestLevel) {
  switch (node.type) {
    case "scope":
      return renderScope(node, depth, nestLevel);
    case "paragraph":
      return renderParagraph(node);
    case "list":
      return renderList(node, depth, nestLevel);
    case "table":
      return renderTable(node);
    case "code":
      return renderCode(node);
    case "blockquote":
      return renderBlockquote(node);
    case "hr":
      return [{ type: "divider", divider: {} }];
    default:
      return [];
  }
}

function renderScope(scope, depth, nestLevel) {
  const level = Math.min(3, Math.max(1, depth));

  if (scope.hasHeading === false) {
    return renderChildren(scope.children, depth + 1, nestLevel);
  }

  // Can this heading have children (toggle)? Only if we're below the nest limit.
  if (nestLevel < MAX_NEST) {
    const childBlocks = renderChildren(scope.children, depth + 1, nestLevel + 1);
    return [headingBlock(level, scope.title, childBlocks)];
  }

  // At the nest limit: emit flat heading, children as siblings at same level
  const childBlocks = renderChildren(scope.children, depth + 1, nestLevel);
  return [headingBlock(level, scope.title, null), ...childBlocks];
}

function renderParagraph(node) {
  const { richText: rt, imageBlocks } = extractImagesFromInline(node.text);
  const blocks = [];

  if (rt.length > 0) {
    blocks.push({
      type: "paragraph",
      paragraph: { rich_text: rt }
    });
  }

  blocks.push(...imageBlocks);
  return blocks;
}

function renderList(list, depth, nestLevel) {
  const blocks = [];
  for (const item of list.items) {
    if (item.task) {
      blocks.push(renderToDoItem(item, depth, nestLevel));
    } else {
      blocks.push(renderListItem(item, list.listType, depth, nestLevel));
    }
  }
  return blocks;
}

function renderListItem(item, listType, depth, nestLevel) {
  const blockType = listType === "number" ? "numbered_list_item" : "bulleted_list_item";
  const titleRt = flattenInline(item.title);

  const block = {
    type: blockType,
    [blockType]: {
      rich_text: titleRt
    }
  };

  if (item.children && item.children.length > 0 && nestLevel < MAX_NEST) {
    const childBlocks = renderChildren(item.children, depth + 1, nestLevel + 1);
    if (childBlocks.length > 0) {
      block[blockType].children = childBlocks;
    }
  }

  return block;
}

function renderToDoItem(item, depth, nestLevel) {
  const titleRt = flattenInline(item.title);

  const block = {
    type: "to_do",
    to_do: {
      rich_text: titleRt,
      checked: item.task.checked
    }
  };

  if (item.children && item.children.length > 0 && nestLevel < MAX_NEST) {
    const childBlocks = renderChildren(item.children, depth + 1, nestLevel + 1);
    if (childBlocks.length > 0) {
      block.to_do.children = childBlocks;
    }
  }

  return block;
}

function renderTable(table) {
  const hasHeader = table.headers.length > 0;
  const colCount = hasHeader
    ? table.headers.length
    : (table.rows.length > 0 ? table.rows[0].length : 0);
  const rows = [];

  if (hasHeader) {
    rows.push({
      type: "table_row",
      table_row: {
        cells: table.headers.map((cell) => flattenInline(cell))
      }
    });
  }

  for (const row of table.rows) {
    const cells = [];
    for (let i = 0; i < colCount; i++) {
      cells.push(flattenInline(row[i] || ""));
    }
    rows.push({
      type: "table_row",
      table_row: { cells }
    });
  }

  return [{
    type: "table",
    table: {
      table_width: colCount,
      has_column_header: hasHeader,
      has_row_header: false,
      children: rows
    }
  }];
}

function renderCode(code) {
  const text = code.text || "";
  const richTexts = [];
  for (let i = 0; i < text.length; i += RICH_TEXT_LIMIT) {
    richTexts.push({
      type: "text",
      text: { content: text.slice(i, i + RICH_TEXT_LIMIT), link: null },
      annotations: defaultAnnotations()
    });
  }
  // Empty code block: ensure at least one rich text object
  if (richTexts.length === 0) {
    richTexts.push({
      type: "text",
      text: { content: "", link: null },
      annotations: defaultAnnotations()
    });
  }

  return [{
    type: "code",
    code: {
      rich_text: richTexts,
      language: mapNotionLanguage(code.lang)
    }
  }];
}

function renderBlockquote(bq) {
  const richTexts = [];

  for (let i = 0; i < bq.paragraphs.length; i++) {
    if (i > 0) {
      richTexts.push(richText("\n", null, defaultAnnotations()));
    }
    richTexts.push(...flattenInline(bq.paragraphs[i]));
  }

  return [{
    type: "quote",
    quote: {
      rich_text: enforceContentLimit(richTexts, RICH_TEXT_LIMIT)
    }
  }];
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  renderNotionBlocks,
  flattenInline,
  flattenInlineNodes,
  mapNotionLanguage
};
