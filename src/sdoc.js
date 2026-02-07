const COMMAND_HEADING = "#";
const COMMAND_SCOPE_OPEN = "{";
const COMMAND_SCOPE_CLOSE = "}";
const COMMAND_LIST_BULLET = "{[.]";
const COMMAND_LIST_NUMBER = "{[#]";
const COMMAND_CODE_FENCE = "```";

const ESCAPABLE = new Set(["\\", "{", "}", "@", "[", "]", "(", ")", "*", "`", "#", "!", "~", "<", ">"]);

class LineCursor {
  constructor(lines) {
    this.lines = lines;
    this.index = 0;
    this.errors = [];
  }

  eof() {
    return this.index >= this.lines.length;
  }

  current() {
    return this.lines[this.index] ?? "";
  }

  next() {
    this.index += 1;
  }

  error(message) {
    this.errors.push({ message, line: this.index + 1 });
  }
}

function parseSdoc(text) {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const cursor = new LineCursor(normalized.split("\n"));
  const nodes = parseBlock(cursor, "normal");
  return { nodes, errors: cursor.errors };
}

function parseBlock(cursor, kind) {
  const nodes = [];
  let paragraphLines = [];

  const flushParagraph = () => {
    if (!paragraphLines.length) {
      return;
    }
    const text = paragraphLines.join(" ").trim();
    if (text) {
      nodes.push({ type: "paragraph", text });
    }
    paragraphLines = [];
  };

  while (!cursor.eof()) {
    const line = cursor.current();
    const trimmedLeft = line.replace(/^\s+/, "");
    const trimmed = trimmedLeft.trim();

    if (trimmed === "") {
      flushParagraph();
      cursor.next();
      continue;
    }

    if (trimmed === COMMAND_SCOPE_CLOSE) {
      flushParagraph();
      cursor.next();
      break;
    }

    if (trimmed === ",") {
      flushParagraph();
      cursor.next();
      continue;
    }

    if (isHorizontalRule(trimmed)) {
      flushParagraph();
      nodes.push({ type: "hr" });
      cursor.next();
      continue;
    }

    if (isBlockquoteLine(trimmedLeft)) {
      flushParagraph();
      nodes.push(parseBlockquote(cursor));
      continue;
    }

    if (isFenceStart(trimmedLeft)) {
      flushParagraph();
      nodes.push(parseCodeBlock(cursor));
      continue;
    }

    const implicitListInfo = getListItemInfo(trimmedLeft);
    if (implicitListInfo && kind === "normal") {
      flushParagraph();
      nodes.push(parseImplicitListBlock(cursor, implicitListInfo.type));
      continue;
    }

    if (isHeadingLine(trimmedLeft)) {
      flushParagraph();
      nodes.push(parseScope(cursor));
      continue;
    }

    if (trimmed === COMMAND_LIST_BULLET || trimmed === COMMAND_LIST_NUMBER) {
      flushParagraph();
      nodes.push(parseListBlock(cursor, trimmed === COMMAND_LIST_BULLET ? "bullet" : "number"));
      continue;
    }

    if (trimmed === COMMAND_SCOPE_OPEN) {
      flushParagraph();
      cursor.error("Unexpected '{' without a heading.");
      cursor.next();
      continue;
    }

    if (kind === "list") {
      flushParagraph();
      cursor.error("Only scoped list items are allowed inside list blocks.");
      cursor.next();
      continue;
    }

    paragraphLines.push(trimmedLeft.trim());
    cursor.next();
  }

  flushParagraph();
  return nodes;
}

function parseScope(cursor) {
  const headingLine = cursor.current();
  cursor.next();

  const parsedHeading = parseHeading(headingLine);
  const blockResult = parseScopeBlock(cursor);

  if (blockResult.blockType === "list") {
    return {
      type: "scope",
      title: parsedHeading.title,
      id: parsedHeading.id,
      children: [blockResult.children],
      hasHeading: true
    };
  }

  return {
    type: "scope",
    title: parsedHeading.title,
    id: parsedHeading.id,
    children: blockResult.children,
    hasHeading: true
  };
}

function tryParseInlineBlock(trimmed) {
  // Check if line matches pattern { ... }
  if (!trimmed.startsWith(COMMAND_SCOPE_OPEN) || !trimmed.endsWith(COMMAND_SCOPE_CLOSE)) {
    return null;
  }

  // Extract content between { and }
  const content = trimmed.slice(1, -1).trim();

  // Check for nested braces - if there are any unescaped { or }, this isn't a simple inline block
  let depth = 0;
  let i = 0;
  while (i < content.length) {
    if (content[i] === "\\" && i + 1 < content.length && ESCAPABLE.has(content[i + 1])) {
      i += 2;
      continue;
    }
    if (content[i] === "{" || content[i] === "}") {
      depth++;
    }
    i++;
  }

  // If we have nested braces, this isn't a simple inline block
  if (depth > 0) {
    return null;
  }

  // Return the content as text
  return content;
}

function parseScopeBlock(cursor) {
  while (!cursor.eof()) {
    const line = cursor.current();
    const trimmed = line.replace(/^\s+/, "").trim();

    if (trimmed === "") {
      cursor.next();
      continue;
    }

    // Try to parse as inline block: { content }
    const inlineContent = tryParseInlineBlock(trimmed);
    if (inlineContent !== null) {
      cursor.next();
      if (inlineContent === "") {
        return { blockType: "normal", children: [] };
      }
      return { blockType: "normal", children: [{ type: "paragraph", text: inlineContent }] };
    }

    if (trimmed === COMMAND_SCOPE_OPEN) {
      cursor.next();
      return { blockType: "normal", children: parseBlock(cursor, "normal") };
    }

    if (trimmed === COMMAND_LIST_BULLET || trimmed === COMMAND_LIST_NUMBER) {
      cursor.next();
      return {
        blockType: "list",
        children: parseListBody(cursor, trimmed === COMMAND_LIST_BULLET ? "bullet" : "number")
      };
    }

    cursor.error("Expected '{' or list opener after heading.");
    cursor.next();
    return { blockType: "normal", children: [] };
  }

  cursor.error("Unexpected end of file after heading.");
  return { blockType: "normal", children: [] };
}

function parseListBlock(cursor, listType) {
  cursor.next();
  return parseListBody(cursor, listType);
}

function parseListBody(cursor, listType) {
  const items = [];

  while (!cursor.eof()) {
    const line = cursor.current();
    const trimmedLeft = line.replace(/^\s+/, "");
    const trimmed = trimmedLeft.trim();

    if (trimmed === "") {
      cursor.next();
      continue;
    }

    if (trimmed === COMMAND_SCOPE_CLOSE) {
      cursor.next();
      break;
    }

    if (trimmed === ",") {
      cursor.next();
      continue;
    }

    if (isHeadingLine(trimmedLeft)) {
      items.push(parseScope(cursor));
      continue;
    }

    const itemInfo = getListItemInfo(trimmedLeft);
    if (itemInfo) {
      items.push(parseListItemLine(cursor, itemInfo));
      continue;
    }

    if (trimmed === COMMAND_SCOPE_OPEN) {
      items.push(parseAnonymousListItem(cursor));
      continue;
    }

    cursor.error("List items must be scoped headings or shorthand items.");
    cursor.next();
  }

  return { type: "list", listType, items };
}

function parseAnonymousListItem(cursor) {
  const line = cursor.current();
  const trimmed = line.replace(/^\s+/, "").trim();
  if (trimmed !== COMMAND_SCOPE_OPEN) {
    cursor.error("Expected '{' to start an anonymous list item.");
    cursor.next();
    return { type: "scope", title: "", id: undefined, children: [], hasHeading: false };
  }

  cursor.next();
  const children = parseBlock(cursor, "normal");
  return { type: "scope", title: "", id: undefined, children, hasHeading: false };
}

function getListItemInfo(line) {
  const trimmedLeft = line.replace(/^\s+/, "");
  if (trimmedLeft.startsWith("- ")) {
    return { type: "bullet", text: trimmedLeft.slice(1).trim() };
  }
  const numberedMatch = trimmedLeft.match(/^(\d+)[.)]\s+(.*)$/);
  if (numberedMatch) {
    return { type: "number", text: numberedMatch[2] };
  }
  return null;
}

function parseListItemLine(cursor, info) {
  const raw = info.text;
  const task = parseTaskPrefix(raw);
  const parsed = task ? parseHeadingText(task.text) : parseHeadingText(raw);
  cursor.next();

  const block = parseOptionalBlock(cursor);
  if (!block) {
    return {
      type: "scope",
      title: parsed.title,
      id: parsed.id,
      children: [],
      hasHeading: true,
      task: task ? { checked: task.checked } : undefined
    };
  }

  if (block.blockType === "list") {
    return {
      type: "scope",
      title: parsed.title,
      id: parsed.id,
      children: [block.children],
      hasHeading: true,
      task: task ? { checked: task.checked } : undefined
    };
  }

  return {
    type: "scope",
    title: parsed.title,
    id: parsed.id,
    children: block.children,
    hasHeading: true,
    task: task ? { checked: task.checked } : undefined
  };
}

function parseImplicitListBlock(cursor, listType) {
  const items = [];
  while (!cursor.eof()) {
    const line = cursor.current();
    const info = getListItemInfo(line);
    if (!info) {
      break;
    }
    if (info.type !== listType) {
      break;
    }
    items.push(parseListItemLine(cursor, info));
  }
  return { type: "list", listType, items };
}

function parseOptionalBlock(cursor) {
  while (!cursor.eof()) {
    const line = cursor.current();
    const trimmed = line.replace(/^\s+/, "").trim();

    if (trimmed === "") {
      cursor.next();
      continue;
    }

    // Try to parse as inline block: { content }
    const inlineContent = tryParseInlineBlock(trimmed);
    if (inlineContent !== null) {
      cursor.next();
      if (inlineContent === "") {
        return { blockType: "normal", children: [] };
      }
      return { blockType: "normal", children: [{ type: "paragraph", text: inlineContent }] };
    }

    if (trimmed === COMMAND_SCOPE_OPEN) {
      cursor.next();
      return { blockType: "normal", children: parseBlock(cursor, "normal") };
    }

    if (trimmed === COMMAND_LIST_BULLET || trimmed === COMMAND_LIST_NUMBER) {
      cursor.next();
      return {
        blockType: "list",
        children: parseListBody(cursor, trimmed === COMMAND_LIST_BULLET ? "bullet" : "number")
      };
    }

    return null;
  }

  return null;
}

function parseTaskPrefix(raw) {
  const match = raw.match(/^\[( |x|X)\]\s*(.*)$/);
  if (!match) {
    return null;
  }
  return { checked: match[1].toLowerCase() === "x", text: match[2] };
}

function parseCodeBlock(cursor) {
  const line = cursor.current();
  const trimmedLeft = line.replace(/^\s+/, "");
  const lang = trimmedLeft.slice(COMMAND_CODE_FENCE.length).trim() || undefined;
  cursor.next();

  const contentLines = [];

  while (!cursor.eof()) {
    const nextLine = cursor.current();
    const nextTrimmed = nextLine.replace(/^\s+/, "");
    if (nextTrimmed.startsWith(COMMAND_CODE_FENCE)) {
      cursor.next();
      return { type: "code", lang, text: contentLines.join("\n") };
    }
    contentLines.push(nextLine);
    cursor.next();
  }

  cursor.error("Unterminated code fence.");
  return { type: "code", lang, text: contentLines.join("\n") };
}

function parseBlockquote(cursor) {
  const paragraphs = [];
  let paragraphLines = [];

  const flushParagraph = () => {
    if (!paragraphLines.length) {
      return;
    }
    const text = paragraphLines.join(" ").trim();
    if (text) {
      paragraphs.push(text);
    }
    paragraphLines = [];
  };

  while (!cursor.eof()) {
    const line = cursor.current();
    const trimmedLeft = line.replace(/^\s+/, "");
    if (!isBlockquoteLine(trimmedLeft)) {
      break;
    }
    let content = trimmedLeft.slice(1);
    if (content.startsWith(" ")) {
      content = content.slice(1);
    }
    if (content.trim() === "") {
      flushParagraph();
      cursor.next();
      continue;
    }
    paragraphLines.push(content.trim());
    cursor.next();
  }

  flushParagraph();
  return { type: "blockquote", paragraphs };
}

function parseHeading(line) {
  const trimmedLeft = line.replace(/^\s+/, "");
  const raw = stripHeadingToken(trimmedLeft);
  return parseHeadingText(raw);
}

function parseHeadingText(raw) {
  const split = splitTrailingId(raw);
  return { title: split.text.trimEnd(), id: split.id ? split.id.slice(1) : undefined };
}

function stripHeadingToken(line) {
  let i = 0;
  while (i < line.length && line[i] === "#") {
    i += 1;
  }
  return line.slice(i).trim();
}

function splitTrailingId(raw) {
  let i = raw.length - 1;
  while (i >= 0 && /\s/.test(raw[i])) {
    i -= 1;
  }

  const end = i;
  while (i >= 0 && isIdentChar(raw[i])) {
    i -= 1;
  }

  if (i >= 0 && raw[i] === "@" && end > i && isIdentStart(raw[i + 1])) {
    if (!isEscaped(raw, i)) {
      if (i === 0 || /\s/.test(raw[i - 1])) {
        const id = raw.slice(i, end + 1);
        const text = raw.slice(0, i).trimEnd();
        return { text, id };
      }
    }
  }

  return { text: raw };
}

function isHeadingLine(line) {
  const trimmedLeft = line.replace(/^\s+/, "");
  if (trimmedLeft.startsWith("\\#")) {
    return false;
  }
  return trimmedLeft.startsWith(COMMAND_HEADING);
}

function isBlockquoteLine(line) {
  const trimmedLeft = line.replace(/^\s+/, "");
  if (trimmedLeft.startsWith("\\>")) {
    return false;
  }
  return trimmedLeft.startsWith(">");
}

function isHorizontalRule(trimmed) {
  const compact = trimmed.replace(/\s+/g, "");
  if (compact.length < 3) {
    return false;
  }
  if (!/^[-*_]+$/.test(compact)) {
    return false;
  }
  const char = compact[0];
  for (let i = 1; i < compact.length; i += 1) {
    if (compact[i] !== char) {
      return false;
    }
  }
  return true;
}

function isFenceStart(line) {
  const trimmedLeft = line.replace(/^\s+/, "");
  return trimmedLeft.startsWith(COMMAND_CODE_FENCE);
}

function isIdentStart(ch) {
  return /[A-Za-z_]/.test(ch);
}

function isIdentChar(ch) {
  return /[A-Za-z0-9_-]/.test(ch);
}

function isEscaped(text, index) {
  let count = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (text[i] === "\\") {
      count += 1;
    } else {
      break;
    }
  }
  return count % 2 === 1;
}

function parseInline(text) {
  const nodes = [];
  let buffer = "";
  let i = 0;

  const flush = () => {
    if (buffer) {
      nodes.push({ type: "text", value: buffer });
      buffer = "";
    }
  };

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === "\\" && next && ESCAPABLE.has(next)) {
      buffer += next;
      i += 2;
      continue;
    }

    if (ch === "`") {
      const end = findUnescaped(text, i + 1, "`");
      if (end !== -1) {
        flush();
        nodes.push({ type: "code", value: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    if (text.startsWith("**", i)) {
      const end = findUnescaped(text, i + 2, "**");
      if (end !== -1) {
        flush();
        const inner = parseInline(text.slice(i + 2, end));
        nodes.push({ type: "strong", children: inner });
        i = end + 2;
        continue;
      }
    }

    if (text.startsWith("~~", i)) {
      const end = findUnescaped(text, i + 2, "~~");
      if (end !== -1) {
        flush();
        const inner = parseInline(text.slice(i + 2, end));
        nodes.push({ type: "strike", children: inner });
        i = end + 2;
        continue;
      }
    }

    if (ch === "*") {
      const end = findUnescaped(text, i + 1, "*");
      if (end !== -1) {
        flush();
        const inner = parseInline(text.slice(i + 1, end));
        nodes.push({ type: "em", children: inner });
        i = end + 1;
        continue;
      }
    }

    if (ch === "!" && next === "[") {
      const endLabel = findUnescaped(text, i + 2, "]");
      if (endLabel !== -1 && text[endLabel + 1] === "(") {
        const endUrl = findUnescaped(text, endLabel + 2, ")");
        if (endUrl !== -1) {
          const label = text.slice(i + 2, endLabel);
          const url = text.slice(endLabel + 2, endUrl).trim();
          if (url) {
            flush();
            nodes.push({ type: "image", alt: label, src: url });
            i = endUrl + 1;
            continue;
          }
        }
      }
    }

    if (ch === "[") {
      const endLabel = findUnescaped(text, i + 1, "]");
      if (endLabel !== -1 && text[endLabel + 1] === "(") {
        const endUrl = findUnescaped(text, endLabel + 2, ")");
        if (endUrl !== -1) {
          const label = text.slice(i + 1, endLabel);
          const url = text.slice(endLabel + 2, endUrl).trim();
          if (url) {
            flush();
            nodes.push({ type: "link", href: url, children: parseInline(label) });
            i = endUrl + 1;
            continue;
          }
        }
      }
    }

    if (ch === "<") {
      const end = findUnescaped(text, i + 1, ">");
      if (end !== -1) {
        const url = text.slice(i + 1, end).trim();
        if (/^(https?:\/\/|mailto:)/i.test(url)) {
          flush();
          nodes.push({ type: "link", href: url, children: [{ type: "text", value: url }] });
          i = end + 1;
          continue;
        }
      }
    }

    if (ch === "@" && next && isIdentStart(next)) {
      let j = i + 1;
      while (j < text.length && isIdentChar(text[j])) {
        j += 1;
      }
      const id = text.slice(i + 1, j);
      flush();
      nodes.push({ type: "ref", id });
      i = j;
      continue;
    }

    buffer += ch;
    i += 1;
  }

  flush();
  return nodes;
}

function findUnescaped(text, start, token) {
  if (!token) {
    return -1;
  }
  for (let i = start; i <= text.length - token.length; i += 1) {
    if (text.startsWith(token, i) && !isEscaped(text, i)) {
      return i;
    }
  }
  return -1;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

function renderInline(text) {
  const nodes = parseInline(text);
  return renderInlineNodes(nodes);
}

function renderInlineNodes(nodes) {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
          return escapeHtml(node.value);
        case "ref": {
          const href = `#${escapeAttr(node.id)}`;
          return `<a class="sdoc-ref" href="${href}">@${escapeHtml(node.id)}</a>`;
        }
        case "code":
          return `<code class="sdoc-inline-code">${escapeHtml(node.value)}</code>`;
        case "em":
          return `<em>${renderInlineNodes(node.children)}</em>`;
        case "strong":
          return `<strong>${renderInlineNodes(node.children)}</strong>`;
        case "strike":
          return `<del>${renderInlineNodes(node.children)}</del>`;
        case "link":
          return `<a class="sdoc-link" href="${escapeAttr(node.href)}" target="_blank" rel="noopener noreferrer">${renderInlineNodes(
            node.children
          )}</a>`;
        case "image":
          return `<img class="sdoc-image" src="${escapeAttr(node.src)}" alt="${escapeAttr(node.alt)}" />`;
        default:
          return "";
      }
    })
    .join("");
}

function renderScope(scope, depth, isTitleScope = false) {
  const level = Math.min(6, Math.max(1, depth));
  const idAttr = scope.id ? ` id="${escapeAttr(scope.id)}"` : "";
  const heading = `<h${level}${idAttr} class="sdoc-heading sdoc-depth-${level}">${renderInline(scope.title)}</h${level}>`;
  const children = scope.children.map((child) => renderNode(child, depth + 1)).join("\n");
  const rootClass = isTitleScope ? " sdoc-root" : "";
  return `<section class="sdoc-scope${rootClass}">${heading}${children ? `\n${children}` : ""}</section>`;
}

function renderList(list, depth) {
  return renderListFromItems(list.listType, list.items, depth);
}

function renderListFromItems(listType, items, depth) {
  const tag = listType === "number" ? "ol" : "ul";
  const renderedItems = items
    .map((item) => `<li class="sdoc-list-item">${renderListItem(item, listType, depth + 1)}</li>`)
    .join("\n");
  return `<${tag} class="sdoc-list sdoc-list-${listType}">${renderedItems}</${tag}>`;
}

function renderListItem(scope, listType, depth) {
  const level = Math.min(6, Math.max(1, depth));
  const task = scope.task ? scope.task : null;
  const hasHeading = scope.hasHeading !== false && (scope.title.trim() !== "" || task);
  const idAttr = scope.id ? ` id="${escapeAttr(scope.id)}"` : "";
  let headingInner = renderInline(scope.title);
  if (task) {
    const checked = task.checked ? " checked" : "";
    headingInner = `<span class="sdoc-task"><input class="sdoc-task-box" type="checkbox"${checked} disabled /><span class="sdoc-task-label">${headingInner}</span></span>`;
  }
  const isSimple = hasHeading && scope.children.length === 0;
  let heading;
  if (!hasHeading) {
    heading = "";
  } else if (isSimple) {
    heading = `<span${idAttr} class="sdoc-list-item-text">${headingInner}</span>`;
  } else {
    heading = `<h${level}${idAttr} class="sdoc-heading sdoc-depth-${level}">${headingInner}</h${level}>`;
  }
  const bodyParts = [];
  let pendingScopes = [];

  const flushPending = () => {
    if (!pendingScopes.length) {
      return;
    }
    bodyParts.push(renderListFromItems(listType, pendingScopes, depth + 1));
    pendingScopes = [];
  };

  for (const child of scope.children) {
    if (child.type === "scope") {
      pendingScopes.push(child);
      continue;
    }

    flushPending();
    bodyParts.push(renderNode(child, depth + 1));
  }

  flushPending();

  const body = bodyParts.join("\n");
  const bodyWrapper = body ? `\n<div class="sdoc-list-item-body">${body}</div>` : "";
  const scopeClass = hasHeading ? "sdoc-scope" : "sdoc-scope sdoc-scope-noheading";
  return `<section class="${scopeClass}">${heading}${bodyWrapper}</section>`;
}

function renderNode(node, depth) {
  switch (node.type) {
    case "scope":
      return renderScope(node, depth);
    case "list":
      return renderList(node, depth);
    case "blockquote": {
      const paragraphs = node.paragraphs
        .map((text) => `<p class="sdoc-paragraph">${renderInline(text)}</p>`)
        .join("\n");
      return `<blockquote class="sdoc-blockquote">${paragraphs}</blockquote>`;
    }
    case "hr":
      return `<hr class="sdoc-rule" />`;
    case "paragraph":
      return `<p class="sdoc-paragraph">${renderInline(node.text)}</p>`;
    case "code": {
      const langClass = node.lang ? ` class="language-${escapeAttr(node.lang)}"` : "";
      return `<pre class="sdoc-code"><code${langClass}>${escapeHtml(node.text)}</code></pre>`;
    }
    default:
      return "";
  }
}

function renderErrors(errors) {
  if (!errors.length) {
    return "";
  }
  const items = errors
    .map((error) => `<li>Line ${error.line}: ${escapeHtml(error.message)}</li>`)
    .join("\n");
  return `<aside class="sdoc-errors"><strong>SDOC parse warnings</strong><ul>${items}</ul></aside>`;
}

function extractMeta(nodes) {
  let metaIndex = -1;
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (node.type === "scope" && node.id && node.id.toLowerCase() === "meta") {
      metaIndex = i;
      break;
    }
  }

  if (metaIndex === -1) {
    return { nodes, meta: {} };
  }

  const metaNode = nodes[metaIndex];
  const meta = {
    stylePath: null,
    styleAppendPath: null,
    headerNodes: null,
    footerNodes: null
  };

  for (const child of metaNode.children) {
    if (child.type !== "scope") {
      continue;
    }
    const key = child.title.trim().toLowerCase();
    if (key === "style") {
      meta.stylePath = collectParagraphText(child.children);
    } else if (key === "styleappend" || key === "style-append") {
      meta.styleAppendPath = collectParagraphText(child.children);
    } else if (key === "header") {
      meta.headerNodes = child.children;
    } else if (key === "footer") {
      meta.footerNodes = child.children;
    }
  }

  const bodyNodes = nodes.filter((_, index) => index !== metaIndex);
  return { nodes: bodyNodes, meta };
}

function collectParagraphText(nodes) {
  return nodes
    .filter((node) => node.type === "paragraph")
    .map((node) => node.text)
    .join("\n")
    .trim();
}

function renderTextParagraphs(text) {
  if (!text) {
    return "";
  }
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  return paragraphs.map((chunk) => `<p class="sdoc-paragraph">${renderInline(chunk)}</p>`).join("\n");
}

function renderFragment(nodes, depth = 2) {
  return nodes.map((node) => renderNode(node, depth)).join("\n");
}

const DEFAULT_STYLE = `
  :root {
    --sdoc-bg: #ffffff;
    --sdoc-fg: #2a2a2a;
    --sdoc-muted: #555555;
    --sdoc-accent: #c1662f;
    --sdoc-accent-soft: rgba(193, 102, 47, 0.12);
    --sdoc-border: rgba(127, 120, 112, 0.35);
  }

  body {
    margin: 0;
    color: var(--sdoc-fg);
    font-family: "Source Sans 3", "Noto Sans", "Segoe UI", "Helvetica Neue", "Arial", sans-serif;
    background: var(--sdoc-bg);
    height: 100vh;
    overflow: hidden;
  }

  .sdoc-shell {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .sdoc-page-header,
  .sdoc-page-footer {
    background: var(--sdoc-bg);
    border-bottom: 1px solid var(--sdoc-border);
    padding: 16px 24px;
  }

  .sdoc-page-footer {
    border-top: 1px solid var(--sdoc-border);
    border-bottom: none;
    color: var(--sdoc-muted);
  }

  .sdoc-main {
    flex: 1;
    overflow: auto;
  }

  main {
    width: 100%;
    max-width: none;
    margin: 0;
    padding: clamp(20px, 2.5vw, 36px) clamp(24px, 4vw, 72px) clamp(28px, 4vw, 56px);
    box-sizing: border-box;
  }

  .sdoc-heading {
    margin: 1.6rem 0 0.5rem;
    font-weight: 700;
    letter-spacing: 0.01em;
  }

  .sdoc-depth-1 { font-size: 2.2rem; border-bottom: 2px solid var(--sdoc-border); padding-bottom: 0.4rem; }
  .sdoc-depth-2 { font-size: 1.8rem; color: var(--sdoc-fg); }
  .sdoc-depth-3 { font-size: 1.5rem; color: var(--sdoc-fg); }
  .sdoc-depth-4 { font-size: 1.2rem; color: var(--sdoc-muted); letter-spacing: 0.04em; }
  .sdoc-depth-5, .sdoc-depth-6 { font-size: 1rem; color: var(--sdoc-muted); letter-spacing: 0.04em; }

  .sdoc-paragraph {
    margin: 0.6rem 0;
    line-height: 1.6;
  }

  .sdoc-scope > .sdoc-scope {
    margin-left: 1.4rem;
  }

  .sdoc-root > .sdoc-scope {
    margin-left: 0;
  }

  .sdoc-list-item-body > .sdoc-paragraph:first-child {
    margin-top: 0.2rem;
  }

  .sdoc-scope-noheading .sdoc-list-item-body > .sdoc-paragraph:first-child {
    margin-top: 0;
  }

  .sdoc-blockquote {
    border-left: 3px solid var(--sdoc-border);
    padding: 0.4rem 1rem;
    margin: 1rem 0;
    color: var(--sdoc-muted);
  }

  .sdoc-blockquote .sdoc-paragraph {
    margin: 0.4rem 0;
  }

  .sdoc-rule {
    border: none;
    border-top: 1px solid var(--sdoc-border);
    margin: 1.4rem 0;
  }

  .sdoc-task {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
  }

  .sdoc-task-box {
    width: 1rem;
    height: 1rem;
    margin: 0;
    accent-color: var(--sdoc-accent);
  }

  .sdoc-task-label {
    display: inline-block;
  }

  .sdoc-list {
    margin: 0.8rem 0 0.8rem;
  }

  .sdoc-list-bullet {
    padding-left: 1.4rem;
    list-style: disc;
  }

  .sdoc-list-bullet .sdoc-list-bullet {
    list-style: circle;
  }

  .sdoc-list-number {
    list-style: none;
    padding-left: 0;
    margin-left: 0;
    counter-reset: sdoc-item;
  }

  .sdoc-list-number .sdoc-list-number {
    margin-left: 1.4rem;
  }

  .sdoc-list-number > .sdoc-list-item {
    counter-increment: sdoc-item;
    position: relative;
    padding-left: 2rem;
    margin: 0.4rem 0 0.8rem;
  }

  .sdoc-list-number > .sdoc-list-item::before {
    content: counters(sdoc-item, ".") ".";
    position: absolute;
    left: 0;
    top: 0.2rem;
    color: var(--sdoc-muted);
    font-weight: 600;
  }

  .sdoc-list-item {
    margin: 0.4rem 0 0.8rem;
  }

  .sdoc-list-item-text {
    line-height: 1.6;
  }

  .sdoc-ref {
    color: var(--sdoc-accent);
    text-decoration: none;
    border-bottom: 1px solid var(--sdoc-accent-soft);
  }

  .sdoc-ref:hover {
    border-bottom-color: var(--sdoc-accent);
  }

  .sdoc-link {
    color: var(--sdoc-accent);
    text-decoration: underline;
    text-decoration-color: var(--sdoc-accent-soft);
    text-underline-offset: 2px;
  }

  .sdoc-link:hover {
    text-decoration-color: var(--sdoc-accent);
  }

  .sdoc-inline-code {
    font-family: "JetBrains Mono", "Fira Code", "Source Code Pro", monospace;
    font-size: 0.95em;
    background: rgba(0, 0, 0, 0.06);
    border: 1px solid var(--sdoc-border);
    border-radius: 4px;
    padding: 0 0.2em;
  }

  .sdoc-image {
    display: inline-block;
    max-width: 100%;
    border-radius: 10px;
    border: 1px solid var(--sdoc-border);
    margin: 0.4rem 0;
  }

  .sdoc-code {
    background: rgba(22, 21, 19, 0.06);
    border: 1px solid var(--sdoc-border);
    border-radius: 10px;
    padding: 12px 14px;
    overflow-x: auto;
    font-family: "JetBrains Mono", "Fira Code", "Source Code Pro", monospace;
    font-size: 0.9rem;
  }

  .sdoc-code code {
    background: none;
    border: none;
    padding: 0;
  }

  .sdoc-errors {
    background: rgba(187, 112, 68, 0.12);
    border: 1px solid rgba(187, 112, 68, 0.4);
    padding: 12px 16px;
    border-radius: 10px;
    margin-bottom: 1.5rem;
  }

  .sdoc-errors ul {
    margin: 0.6rem 0 0;
    padding-left: 1.2rem;
  }
`;

function renderHtmlDocumentFromParsed(parsed, title, options = {}) {
  const body = parsed.nodes
    .map((node, index) => {
      if (node.type === "scope" && index === 0) {
        return renderScope(node, 1, true);
      }
      return renderNode(node, 1);
    })
    .join("\n");
  const errorHtml = renderErrors(parsed.errors);

  const meta = options.meta ?? {};
  const config = options.config ?? {};
  const headerHtml = meta.headerNodes ? renderFragment(meta.headerNodes, 2) : renderTextParagraphs(config.header);
  const footerHtml = meta.footerNodes ? renderFragment(meta.footerNodes, 2) : renderTextParagraphs(config.footer);

  const cssBase = options.cssOverride ?? DEFAULT_STYLE;
  const cssAppend = options.cssAppend ? `\n${options.cssAppend}` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
<style>
${cssBase}${cssAppend}
</style>
</head>
<body>
  <div class="sdoc-shell">
    ${headerHtml ? `<header class="sdoc-page-header">${headerHtml}</header>` : ""}
    <div class="sdoc-main">
      <main>
        ${errorHtml}
        ${body}
      </main>
    </div>
    ${footerHtml ? `<footer class="sdoc-page-footer">${footerHtml}</footer>` : ""}
  </div>
</body>
</html>`;
}

function renderHtmlDocument(text, title, options = {}) {
  const parsed = parseSdoc(text);
  const metaResult = extractMeta(parsed.nodes);
  return renderHtmlDocumentFromParsed({ nodes: metaResult.nodes, errors: parsed.errors }, title, {
    ...options,
    meta: metaResult.meta
  });
}

module.exports = {
  parseSdoc,
  extractMeta,
  renderFragment,
  renderTextParagraphs,
  renderHtmlDocumentFromParsed,
  renderHtmlDocument
};
