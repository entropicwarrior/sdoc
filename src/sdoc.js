const SDOC_FORMAT_VERSION = "0.2";

const KNOWN_SCOPE_TYPES = [
  "schema", "example", "requirement", "specification", "definition",
  "note", "warning", "test", "task", "api", "config", "deprecated", "comment"
];

const COMMAND_HEADING = "#";
const COMMAND_SCOPE_OPEN = "{";
const COMMAND_SCOPE_CLOSE = "}";
const COMMAND_LIST_BULLET = "{[.]";
const COMMAND_LIST_NUMBER = "{[#]";
const COMMAND_TABLE = "{[table]";
const COMMAND_CITATIONS = "{[citations]";
const COMMAND_CODE_FENCE = "```";

const ESCAPABLE = new Set(["\\", "{", "}", "@", "[", "]", "(", ")", "*", "`", "#", "!", "~", "<", ">", "$", "+", "=", "-", "^", "?", "|"]);

let _katex = null;
let _katexLoaded = false;

function getKatex() {
  if (!_katexLoaded) {
    _katexLoaded = true;
    try {
      _katex = require(require("path").join(__dirname, "..", "vendor", "katex.min.js"));
    } catch { _katex = null; }
  }
  return _katex;
}

function renderKatex(latex, displayMode) {
  const katex = getKatex();
  if (katex) {
    return katex.renderToString(latex, { displayMode, throwOnError: false });
  }
  const cls = displayMode ? "sdoc-math-fallback sdoc-math-display-fallback" : "sdoc-math-fallback";
  return `<code class="${cls}">${escapeHtml(latex)}</code>`;
}

function isTableCommand(text) {
  return /^\{\[table(?:\s+[^\]]*?)?\]$/.test(text);
}

function isCitationsCommand(text) {
  return text === COMMAND_CITATIONS;
}

function parseTableOptions(text) {
  const match = text.match(/^\{\[table(?:\s+(.*))?\]$/);
  if (!match) return {};
  const flagStr = (match[1] || "").trim();
  const flags = flagStr ? flagStr.split(/\s+/) : [];
  const options = { borderless: false, headerless: false };
  for (const flag of flags) {
    if (flag === "borderless") options.borderless = true;
    else if (flag === "headerless") options.headerless = true;
    else if (flag === "auto") options.width = "auto";
    else if (/^\d+(?:\.\d+)?%$/.test(flag)) options.width = flag;
    else if (/^\d+px$/.test(flag)) options.width = flag;
    else if (flag === "center" || flag === "left" || flag === "right") options.align = flag;
  }
  return options;
}

// ── Column directive row (alignment + format) ──────────────────────────

function isDirectiveRow(cells) {
  if (cells.length === 0) return false;
  const pattern = /^([<>=])?\s*(\$(?:\.\d+)?|,(?:\.\d+)?|\.\d+|%(?:\.\d+)?)?$/;
  let hasDirective = false;
  for (const cell of cells) {
    const trimmed = cell.trim();
    if (trimmed === "") continue;
    if (!pattern.test(trimmed)) return false;
    hasDirective = true;
  }
  return hasDirective;
}

function parseFormatSpec(spec) {
  if (!spec) return null;
  if (spec.startsWith("$")) {
    const decimals = spec.includes(".") ? parseInt(spec.slice(spec.indexOf(".") + 1), 10) : 0;
    return { prefix: "$", thousands: true, decimals, percent: false };
  }
  if (spec.startsWith("%")) {
    const decimals = spec.includes(".") ? parseInt(spec.slice(spec.indexOf(".") + 1), 10) : -1;
    return { prefix: "", thousands: false, decimals, percent: true };
  }
  if (spec.startsWith(",")) {
    const decimals = spec.includes(".") ? parseInt(spec.slice(spec.indexOf(".") + 1), 10) : 0;
    return { prefix: "", thousands: true, decimals, percent: false };
  }
  if (spec.startsWith(".")) {
    const decimals = parseInt(spec.slice(1), 10);
    return { prefix: "", thousands: false, decimals, percent: false };
  }
  return null;
}

function parseDirectiveRow(cells) {
  const align = [];
  const format = [];
  let hasAlign = false;
  let hasFormat = false;
  const fmtPattern = /(\$(?:\.\d+)?|,(?:\.\d+)?|\.\d+|%(?:\.\d+)?)$/;

  for (const cell of cells) {
    const trimmed = cell.trim();
    const alignMatch = trimmed.match(/^([<>=])/);
    const fmtMatch = trimmed.match(fmtPattern);

    let a = null;
    if (alignMatch) {
      a = alignMatch[1] === "<" ? "left" : alignMatch[1] === ">" ? "right" : "center";
      hasAlign = true;
    }
    align.push(a);

    let f = null;
    if (fmtMatch) {
      f = parseFormatSpec(fmtMatch[1]);
      hasFormat = true;
    }
    format.push(f);
  }

  return {
    align: hasAlign ? align : null,
    format: hasFormat ? format : null,
  };
}

function formatNumber(value, spec) {
  if (spec.percent) {
    const pct = value * 100;
    if (spec.decimals < 0) {
      return (Number.isInteger(pct) ? pct.toString() : pct.toFixed(2).replace(/\.?0+$/, "")) + "%";
    }
    return pct.toFixed(spec.decimals) + "%";
  }

  const negative = value < 0;
  const absVal = Math.abs(value);
  let result;

  if (spec.decimals > 0) {
    result = absVal.toFixed(spec.decimals);
  } else {
    result = Math.round(absVal).toString();
  }

  if (spec.thousands) {
    const parts = result.split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    result = parts.join(".");
  }

  return (negative ? "-" : "") + spec.prefix + result;
}

// ── End column directive row ────────────────────────────────────────────

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

  // Check for implicit root: first non-blank line is a heading, next non-blank is NOT a block opener
  const implicitRoot = detectImplicitRoot(cursor);
  if (implicitRoot) {
    const scopeStartLine = cursor.index + 1;
    const parsedHeading = parseHeading(cursor.current());
    cursor.next();
    const children = parseBlock(cursor, "normal");
    const rootNode = makeScopeNode(parsedHeading, children, true, scopeStartLine, cursor.index);
    return { nodes: [rootNode], errors: cursor.errors };
  }

  const nodes = parseBlock(cursor, "normal");
  return { nodes, errors: cursor.errors };
}

function detectImplicitRoot(cursor) {
  const saved = cursor.index;
  // Find first non-blank line
  while (!cursor.eof()) {
    const trimmed = cursor.current().trim();
    if (trimmed !== "") break;
    cursor.next();
  }
  if (cursor.eof()) { cursor.index = saved; return false; }

  const firstLine = cursor.current();
  const trimmedLeft = firstLine.replace(/^\s+/, "");
  if (!isHeadingLine(trimmedLeft)) { cursor.index = saved; return false; }

  // Check if heading has trailing opener (K&R style) — if so, it's explicit
  const stripped = stripHeadingToken(trimmedLeft);
  const trailing = extractTrailingOpener(stripped);
  if (trailing) { cursor.index = saved; return false; }

  // Peek at the next non-blank line after the heading
  const headingIndex = cursor.index;
  cursor.index = headingIndex + 1;
  while (!cursor.eof()) {
    const trimmed = cursor.current().trim();
    if (trimmed !== "") break;
    cursor.next();
  }

  let isImplicit = false;
  if (cursor.eof()) {
    // Heading followed by nothing — implicit root with no content
    isImplicit = true;
  } else {
    const nextTrimmed = cursor.current().replace(/^\s+/, "").trim();
    // If next non-blank is a block opener, it's explicit
    if (nextTrimmed === COMMAND_SCOPE_OPEN ||
        nextTrimmed === COMMAND_LIST_BULLET ||
        nextTrimmed === COMMAND_LIST_NUMBER ||
        isTableCommand(nextTrimmed) ||
        isCitationsCommand(nextTrimmed)) {
      isImplicit = false;
    } else if (tryParseInlineBlock(nextTrimmed) !== null) {
      isImplicit = false;
    } else {
      isImplicit = true;
    }
  }

  // Restore cursor to first non-blank (the heading line)
  cursor.index = headingIndex;
  if (!isImplicit) {
    cursor.index = saved;
  }
  return isImplicit;
}

const BARE_DIRECTIVES = new Set(["meta", "about"]);

function parseBareDirective(trimmed) {
  // Match @meta, @about, @meta {, @about {
  if (!trimmed.startsWith("@")) return null;
  const withoutAt = trimmed.slice(1);
  // Check for "@directive {" (K&R style)
  const spaceIdx = withoutAt.indexOf(" ");
  if (spaceIdx === -1) {
    // Bare "@directive" with no trailing brace — only valid if next line is "{"
    return BARE_DIRECTIVES.has(withoutAt) ? { id: withoutAt, hasOpenBrace: false } : null;
  }
  const name = withoutAt.slice(0, spaceIdx);
  const rest = withoutAt.slice(spaceIdx).trim();
  if (!BARE_DIRECTIVES.has(name)) return null;
  if (rest === COMMAND_SCOPE_OPEN) return { id: name, hasOpenBrace: true };
  return null;
}

function parseBareScope(cursor, directive) {
  const scopeStartLine = cursor.index + 1;
  cursor.next();

  if (directive.hasOpenBrace) {
    // Brace was on the same line — parse contents until closing }
    const children = parseBlock(cursor, "normal");
    return { type: "scope", title: "", id: directive.id, children, hasHeading: false, lineStart: scopeStartLine, lineEnd: cursor.index };
  }

  // Brace should be on the next non-blank line
  const saved = cursor.index;
  while (!cursor.eof() && cursor.current().trim() === "") {
    cursor.next();
  }
  if (!cursor.eof() && cursor.current().trim() === COMMAND_SCOPE_OPEN) {
    cursor.next();
    const children = parseBlock(cursor, "normal");
    return { type: "scope", title: "", id: directive.id, children, hasHeading: false, lineStart: scopeStartLine, lineEnd: cursor.index };
  }

  // No opening brace found — treat as braceless scope (content until next heading, }, or EOF)
  cursor.index = saved;
  const children = parseBracelessBlock(cursor);
  return { type: "scope", title: "", id: directive.id, children, hasHeading: false, lineStart: scopeStartLine, lineEnd: cursor.index };
}

function parseBlock(cursor, kind) {
  const nodes = [];
  let paragraphLines = [];
  let paragraphStartLine = 0;

  const flushParagraph = () => {
    if (!paragraphLines.length) {
      return;
    }
    const text = paragraphLines.join(" ").trim();
    if (text) {
      nodes.push({ type: "paragraph", text, lineStart: paragraphStartLine, lineEnd: cursor.index });
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

    // Line comments — skip, don't flush paragraph (invisible to AST)
    if (trimmedLeft.startsWith("//")) {
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
      const hrLine = cursor.index + 1;
      nodes.push({ type: "hr", lineStart: hrLine, lineEnd: hrLine });
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

    const bareDirective = parseBareDirective(trimmed);
    if (bareDirective) {
      flushParagraph();
      nodes.push(parseBareScope(cursor, bareDirective));
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

    if (isTableCommand(trimmed)) {
      flushParagraph();
      nodes.push(parseTableBlock(cursor));
      continue;
    }

    if (isCitationsCommand(trimmed)) {
      flushParagraph();
      nodes.push(parseCitationsBlock(cursor));
      continue;
    }

    if (trimmed === COMMAND_SCOPE_OPEN) {
      flushParagraph();
      const scopeStartLine = cursor.index + 1;
      cursor.next();
      const children = parseBlock(cursor, "normal");
      nodes.push({ type: "scope", title: "", id: undefined, children, hasHeading: false, lineStart: scopeStartLine, lineEnd: cursor.index });
      continue;
    }

    if (kind === "list") {
      flushParagraph();
      cursor.error("Only scoped list items are allowed inside list blocks.");
      cursor.next();
      continue;
    }

    if (!paragraphLines.length) {
      paragraphStartLine = cursor.index + 1;
    }
    paragraphLines.push(trimmedLeft.trim());
    cursor.next();
  }

  flushParagraph();
  return nodes;
}

function extractTrailingOpener(text) {
  const trimmed = text.trimEnd();
  // Don't match if the line also ends with } (inline block like "{ content }")
  if (trimmed.endsWith(COMMAND_SCOPE_CLOSE)) {
    return null;
  }
  // Check for table command with optional flags: {[table ...]}
  const tableMatch = trimmed.match(/\{\[table(?:\s+[^\]]*?)?\]$/);
  if (tableMatch) {
    const pos = tableMatch.index;
    if (!(pos > 0 && trimmed[pos - 1] === "\\")) {
      return { text: trimmed.slice(0, pos).trimEnd(), opener: tableMatch[0] };
    }
  }
  // Check for citations command: {[citations]
  if (trimmed.endsWith(COMMAND_CITATIONS)) {
    const pos = trimmed.length - COMMAND_CITATIONS.length;
    if (!(pos > 0 && trimmed[pos - 1] === "\\")) {
      return { text: trimmed.slice(0, pos).trimEnd(), opener: COMMAND_CITATIONS };
    }
  }
  // Check other openers
  const openers = [COMMAND_LIST_NUMBER, COMMAND_LIST_BULLET, COMMAND_SCOPE_OPEN];
  for (const opener of openers) {
    if (trimmed.endsWith(opener)) {
      const pos = trimmed.length - opener.length;
      // Don't match escaped braces
      if (pos > 0 && trimmed[pos - 1] === "\\") {
        continue;
      }
      return { text: trimmed.slice(0, pos).trimEnd(), opener };
    }
  }
  return null;
}

function makeScopeNode(parsedHeading, children, hasHeading, lineStart, lineEnd, extra) {
  const node = {
    type: "scope",
    title: parsedHeading.title,
    id: parsedHeading.id,
    children,
    hasHeading,
    lineStart,
    lineEnd
  };
  if (parsedHeading.scopeType) node.scopeType = parsedHeading.scopeType;
  if (extra) Object.assign(node, extra);
  return node;
}

function parseScope(cursor) {
  const scopeStartLine = cursor.index + 1;
  const headingLine = cursor.current();
  cursor.next();

  const trimmedLeft = headingLine.replace(/^\s+/, "");
  const stripped = stripHeadingToken(trimmedLeft);
  const trailing = extractTrailingOpener(stripped);

  if (trailing) {
    const parsedHeading = parseHeadingText(trailing.text);
    let children;
    if (trailing.opener === COMMAND_LIST_BULLET || trailing.opener === COMMAND_LIST_NUMBER) {
      const listBody = parseListBody(cursor, trailing.opener === COMMAND_LIST_BULLET ? "bullet" : "number");
      children = [listBody];
    } else if (isTableCommand(trailing.opener)) {
      const tableOpts = parseTableOptions(trailing.opener);
      children = [parseTableBody(cursor, scopeStartLine, tableOpts)];
    } else if (isCitationsCommand(trailing.opener)) {
      children = [parseCitationsBody(cursor, scopeStartLine)];
    } else {
      children = parseBlock(cursor, "normal");
    }
    return makeScopeNode(parsedHeading, children, true, scopeStartLine, cursor.index);
  }

  const parsedHeading = parseHeading(headingLine);
  const blockResult = parseScopeBlock(cursor);

  if (blockResult.blockType === "braceless") {
    const children = parseBracelessBlock(cursor);
    return makeScopeNode(parsedHeading, children, true, scopeStartLine, cursor.index);
  }

  if (blockResult.blockType === "list") {
    return makeScopeNode(parsedHeading, [blockResult.children], true, scopeStartLine, cursor.index);
  }

  return makeScopeNode(parsedHeading, blockResult.children, true, scopeStartLine, cursor.index);
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

function parseBracelessBlock(cursor) {
  const nodes = [];
  let paragraphLines = [];
  let paragraphStartLine = 0;

  const flushParagraph = () => {
    if (!paragraphLines.length) return;
    const text = paragraphLines.join(" ").trim();
    if (text) {
      nodes.push({ type: "paragraph", text, lineStart: paragraphStartLine, lineEnd: cursor.index });
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

    // Stop on } — parent owns it, don't advance
    if (trimmed === COMMAND_SCOPE_CLOSE) {
      flushParagraph();
      break;
    }

    // Stop on # heading — becomes sibling, don't advance
    if (isHeadingLine(trimmedLeft)) {
      flushParagraph();
      break;
    }

    // Stop on bare @meta / @about — becomes sibling, don't advance
    if (parseBareDirective(trimmed)) {
      flushParagraph();
      break;
    }

    // Line comments — skip, don't flush paragraph
    if (trimmedLeft.startsWith("//")) {
      cursor.next();
      continue;
    }

    if (trimmed === ",") {
      flushParagraph();
      cursor.next();
      continue;
    }

    if (isHorizontalRule(trimmed)) {
      flushParagraph();
      const hrLine = cursor.index + 1;
      nodes.push({ type: "hr", lineStart: hrLine, lineEnd: hrLine });
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
    if (implicitListInfo) {
      flushParagraph();
      nodes.push(parseImplicitListBlock(cursor, implicitListInfo.type));
      continue;
    }

    // Headingless scopes { ... }
    if (trimmed === COMMAND_SCOPE_OPEN) {
      flushParagraph();
      const scopeStartLine = cursor.index + 1;
      cursor.next();
      const children = parseBlock(cursor, "normal");
      nodes.push({ type: "scope", title: "", id: undefined, children, hasHeading: false, lineStart: scopeStartLine, lineEnd: cursor.index });
      continue;
    }

    if (trimmed === COMMAND_LIST_BULLET || trimmed === COMMAND_LIST_NUMBER) {
      flushParagraph();
      nodes.push(parseListBlock(cursor, trimmed === COMMAND_LIST_BULLET ? "bullet" : "number"));
      continue;
    }

    if (isTableCommand(trimmed)) {
      flushParagraph();
      nodes.push(parseTableBlock(cursor));
      continue;
    }

    if (isCitationsCommand(trimmed)) {
      flushParagraph();
      nodes.push(parseCitationsBlock(cursor));
      continue;
    }

    if (!paragraphLines.length) {
      paragraphStartLine = cursor.index + 1;
    }
    paragraphLines.push(trimmedLeft.trim());
    cursor.next();
  }

  flushParagraph();
  return nodes;
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
      const inlineLine = cursor.index + 1;
      cursor.next();
      if (inlineContent === "") {
        return { blockType: "normal", children: [] };
      }
      return { blockType: "normal", children: [{ type: "paragraph", text: inlineContent, lineStart: inlineLine, lineEnd: inlineLine }] };
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

    if (isTableCommand(trimmed)) {
      return { blockType: "normal", children: [parseTableBlock(cursor)] };
    }

    if (isCitationsCommand(trimmed)) {
      return { blockType: "normal", children: [parseCitationsBlock(cursor)] };
    }

    // No block opener found — braceless scope
    return { blockType: "braceless" };
  }

  // EOF after heading — braceless scope with no content
  return { blockType: "braceless" };
}

function parseListBlock(cursor, listType) {
  cursor.next();
  return parseListBody(cursor, listType);
}

function parseListBody(cursor, listType) {
  const listStartLine = cursor.index + 1;
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
      items.push(parseListItemLine(cursor, itemInfo, true));
      continue;
    }

    if (trimmed === COMMAND_SCOPE_OPEN) {
      items.push(parseAnonymousListItem(cursor));
      continue;
    }

    cursor.error("Orphaned text in list block (no preceding list item).");
    cursor.next();
  }

  return { type: "list", listType, items, lineStart: listStartLine, lineEnd: cursor.index };
}

function parseAnonymousListItem(cursor) {
  const itemStartLine = cursor.index + 1;
  const line = cursor.current();
  const trimmed = line.replace(/^\s+/, "").trim();
  if (trimmed !== COMMAND_SCOPE_OPEN) {
    cursor.error("Expected '{' to start an anonymous list item.");
    cursor.next();
    return { type: "scope", title: "", id: undefined, children: [], hasHeading: false, lineStart: itemStartLine, lineEnd: cursor.index };
  }

  cursor.next();
  const children = parseBlock(cursor, "normal");
  return { type: "scope", title: "", id: undefined, children, hasHeading: false, lineStart: itemStartLine, lineEnd: cursor.index };
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

function isListContinuationLine(trimmedLeft) {
  const trimmed = trimmedLeft.trim();
  if (trimmed === "") return false;
  if (trimmed === COMMAND_SCOPE_CLOSE) return false;
  if (trimmed === COMMAND_SCOPE_OPEN) return false;
  if (trimmed === COMMAND_LIST_BULLET) return false;
  if (trimmed === COMMAND_LIST_NUMBER) return false;
  if (isTableCommand(trimmed)) return false;
  if (isCitationsCommand(trimmed)) return false;
  if (trimmed === ",") return false;
  if (isHeadingLine(trimmedLeft)) return false;
  if (isBlockquoteLine(trimmedLeft)) return false;
  if (isFenceStart(trimmedLeft)) return false;
  if (isHorizontalRule(trimmed)) return false;
  if (getListItemInfo(trimmedLeft)) return false;
  if (tryParseInlineBlock(trimmed) !== null) return false;
  return true;
}

function parseListItemLine(cursor, info, allowContinuation = false) {
  const itemStartLine = cursor.index + 1;
  const raw = info.text;
  const task = parseTaskPrefix(raw);
  const textForOpener = task ? task.text : raw;
  const trailing = extractTrailingOpener(textForOpener);

  const listExtra = { shorthand: true };
  if (task) listExtra.task = { checked: task.checked };

  if (trailing) {
    const parsed = parseHeadingText(trailing.text);
    cursor.next();

    let children;
    if (trailing.opener === COMMAND_LIST_BULLET || trailing.opener === COMMAND_LIST_NUMBER) {
      const listBody = parseListBody(cursor, trailing.opener === COMMAND_LIST_BULLET ? "bullet" : "number");
      children = [listBody];
    } else if (isTableCommand(trailing.opener)) {
      const tableOpts = parseTableOptions(trailing.opener);
      children = [parseTableBody(cursor, itemStartLine, tableOpts)];
    } else if (isCitationsCommand(trailing.opener)) {
      children = [parseCitationsBody(cursor, itemStartLine)];
    } else {
      children = parseBlock(cursor, "normal");
    }

    return makeScopeNode(parsed, children, true, itemStartLine, cursor.index, listExtra);
  }

  cursor.next();

  // Collect continuation lines in explicit list blocks
  let fullText = task ? task.text : raw;
  if (allowContinuation) {
    while (!cursor.eof()) {
      const nextLine = cursor.current();
      const nextTrimmedLeft = nextLine.replace(/^\s+/, "");
      if (!isListContinuationLine(nextTrimmedLeft)) break;
      fullText += " " + nextTrimmedLeft.trim();
      cursor.next();
    }
  }

  const parsed = parseHeadingText(fullText);

  const block = parseOptionalBlock(cursor);
  if (!block) {
    return makeScopeNode(parsed, [], true, itemStartLine, cursor.index, listExtra);
  }

  if (block.blockType === "list") {
    return makeScopeNode(parsed, [block.children], true, itemStartLine, cursor.index, listExtra);
  }

  return makeScopeNode(parsed, block.children, true, itemStartLine, cursor.index, listExtra);
}

function parseImplicitListBlock(cursor, listType) {
  const listStartLine = cursor.index + 1;
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
  return { type: "list", listType, items, lineStart: listStartLine, lineEnd: cursor.index };
}

function parseTableBlock(cursor) {
  const tableStartLine = cursor.index + 1;
  const options = parseTableOptions(cursor.current().trim());
  cursor.next();
  return parseTableBody(cursor, tableStartLine, options);
}

function parseTableBody(cursor, tableStartLine, options) {
  options = options || {};
  const rows = [];

  while (!cursor.eof()) {
    const line = cursor.current();
    const trimmed = line.replace(/^\s+/, "").trim();

    if (trimmed === "") {
      cursor.next();
      continue;
    }

    if (trimmed === COMMAND_SCOPE_CLOSE) {
      cursor.next();
      break;
    }

    const cells = trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
    rows.push(cells);
    cursor.next();
  }

  // Detect column directive row (alignment / formatting)
  // For headerless tables: check rows[0]; for normal tables: check rows[1] (after header)
  const directiveIndex = options.headerless ? 0 : 1;
  let columnAlign = null;
  let columnFormat = null;
  if (rows.length > directiveIndex && isDirectiveRow(rows[directiveIndex])) {
    const directives = parseDirectiveRow(rows[directiveIndex]);
    columnAlign = directives.align;
    columnFormat = directives.format;
    rows.splice(directiveIndex, 1);
  }

  const hasOptions = options.borderless || options.headerless || options.width || options.align;

  let tableNode;
  if (options.headerless) {
    tableNode = { type: "table", headers: [], rows, lineStart: tableStartLine, lineEnd: cursor.index };
  } else {
    const headers = rows.length > 0 ? rows[0] : [];
    const body = rows.slice(1);
    tableNode = { type: "table", headers, rows: body, lineStart: tableStartLine, lineEnd: cursor.index };
  }
  if (hasOptions) tableNode.options = options;
  if (columnAlign) tableNode.columnAlign = columnAlign;
  if (columnFormat) tableNode.columnFormat = columnFormat;
  return tableNode;
}

function parseCitationsBlock(cursor) {
  const startLine = cursor.index + 1;
  cursor.next();
  return parseCitationsBody(cursor, startLine);
}

function parseCitationsBody(cursor, startLine) {
  const entries = [];

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

    // Citation items: - @key free-form text
    const citationMatch = trimmed.match(/^-\s+@([A-Za-z_][A-Za-z0-9_-]*)\s+([\s\S]*)$/);
    if (citationMatch) {
      const entryStartLine = cursor.index + 1;
      const key = citationMatch[1];
      let text = citationMatch[2].trim();
      cursor.next();

      // Collect continuation lines (indented text not starting with - @key or })
      while (!cursor.eof()) {
        const nextLine = cursor.current();
        const nextTrimmedLeft = nextLine.replace(/^\s+/, "");
        const nextTrimmed = nextTrimmedLeft.trim();

        if (nextTrimmed === "") break;
        if (nextTrimmed === COMMAND_SCOPE_CLOSE) break;
        if (/^-\s+@[A-Za-z_]/.test(nextTrimmed)) break;

        text += " " + nextTrimmed;
        cursor.next();
      }

      entries.push({ key, text, lineStart: entryStartLine, lineEnd: cursor.index });
      continue;
    }

    cursor.error("Invalid citation entry (expected '- @key text').");
    cursor.next();
  }

  return { type: "citations", entries, lineStart: startLine, lineEnd: cursor.index };
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
      const inlineLine = cursor.index + 1;
      cursor.next();
      if (inlineContent === "") {
        return { blockType: "normal", children: [] };
      }
      return { blockType: "normal", children: [{ type: "paragraph", text: inlineContent, lineStart: inlineLine, lineEnd: inlineLine }] };
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

    if (isTableCommand(trimmed)) {
      return { blockType: "normal", children: [parseTableBlock(cursor)] };
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

function parseFenceMetadata(meta) {
  if (!meta) return {};
  const tokens = meta.split(/\s+/).filter(Boolean);
  let lang, src, lines, data = false;
  for (const token of tokens) {
    if (token.startsWith("src:")) {
      src = token.slice(4);
    } else if (token.startsWith("lines:")) {
      const range = token.slice(6);
      const match = range.match(/^(\d+)-(\d+)$/);
      if (match) {
        lines = { start: parseInt(match[1], 10), end: parseInt(match[2], 10) };
      }
    } else if (token === ":data") {
      data = true;
    } else if (!lang) {
      lang = token;
    }
  }
  return { lang, src, lines, data };
}

function parseCodeBlock(cursor) {
  const codeStartLine = cursor.index + 1;
  const line = cursor.current();
  const trimmedLeft = line.replace(/^\s+/, "");
  const fenceMatch = trimmedLeft.match(/^(`{3,})/);
  const fenceLen = fenceMatch ? fenceMatch[1].length : 3;
  const metaStr = trimmedLeft.slice(fenceLen).trim();
  const fenceMeta = parseFenceMetadata(metaStr);
  const lang = fenceMeta.lang || undefined;
  // Indentation of the opening fence — strip this much from content lines.
  const fenceIndent = line.length - trimmedLeft.length;
  cursor.next();

  const contentLines = [];

  function buildCodeNode() {
    const node = { type: "code", lang, text: stripIndent(contentLines, fenceIndent), lineStart: codeStartLine, lineEnd: cursor.index };
    if (fenceMeta.src) node.src = fenceMeta.src;
    if (fenceMeta.lines) node.lines = fenceMeta.lines;
    if (fenceMeta.data) {
      node.dataFlag = true;
      if (lang === "json" && !node.src) {
        try {
          node.data = JSON.parse(node.text);
        } catch {
          cursor.error("Invalid JSON in :data code block.");
        }
      }
    }
    return node;
  }

  while (!cursor.eof()) {
    const nextLine = cursor.current();
    const nextTrimmed = nextLine.replace(/^\s+/, "");
    const closeMatch = nextTrimmed.match(/^(`{3,})\s*$/);
    if (closeMatch && closeMatch[1].length >= fenceLen) {
      cursor.next();
      return buildCodeNode();
    }
    contentLines.push(nextLine);
    cursor.next();
  }

  cursor.error("Unterminated code fence.");
  return buildCodeNode();
}

/**
 * Strip up to `indent` leading whitespace characters from each line.
 * Preserves any extra indentation beyond the baseline.
 */
function stripIndent(lines, indent) {
  const re = new RegExp(`^\\s{0,${indent}}`);
  return lines.map((l) => l.replace(re, "")).join("\n");
}

function parseBlockquote(cursor) {
  const bqStartLine = cursor.index + 1;
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
  return { type: "blockquote", paragraphs, lineStart: bqStartLine, lineEnd: cursor.index };
}

function parseHeading(line) {
  const trimmedLeft = line.replace(/^\s+/, "");
  const raw = stripHeadingToken(trimmedLeft);
  const result = parseHeadingText(raw);
  return result;
}

function parseHeadingText(raw) {
  const split = splitTrailingId(raw);
  const result = { title: split.text.trimEnd(), id: split.id ? split.id.slice(1) : undefined };
  if (split.scopeType) result.scopeType = split.scopeType;
  return result;
}

function stripHeadingToken(line) {
  let i = 0;
  while (i < line.length && line[i] === "#") {
    i += 1;
  }
  return line.slice(i).trim();
}

function splitTrailingId(raw) {
  let id = undefined;
  let scopeType = undefined;
  let remaining = raw;

  // Make up to two passes to extract trailing @id and :type in any order
  for (let pass = 0; pass < 2; pass++) {
    let i = remaining.length - 1;
    while (i >= 0 && /\s/.test(remaining[i])) {
      i -= 1;
    }
    if (i < 0) break;

    const end = i;
    while (i >= 0 && isIdentChar(remaining[i])) {
      i -= 1;
    }
    if (i < 0 || end === i) break;

    if (remaining[i] === "@" && !id && isIdentStart(remaining[i + 1])) {
      if (!isEscaped(remaining, i)) {
        if (i === 0 || /\s/.test(remaining[i - 1])) {
          id = remaining.slice(i, end + 1);
          remaining = remaining.slice(0, i).trimEnd();
          continue;
        }
      }
    }

    if (remaining[i] === ":" && !scopeType && isIdentStart(remaining[i + 1])) {
      if (i === 0 || /\s/.test(remaining[i - 1])) {
        scopeType = remaining.slice(i + 1, end + 1);
        remaining = remaining.slice(0, i).trimEnd();
        continue;
      }
    }

    break;
  }

  const result = { text: remaining };
  if (id) result.id = id;
  if (scopeType) result.scopeType = scopeType;
  return result;
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

function parseImageWidth(raw) {
  const match = raw.match(/^(.*)\s+=(\d+(?:\.\d+)?(?:%|px))(?:\s+(center|left|right))?$/);
  if (match) {
    const result = { src: match[1].trim(), width: match[2] };
    if (match[3]) result.align = match[3];
    return result;
  }
  return { src: raw };
}

function parseCitationKeys(inner) {
  // Parse "@key1, @key2, ..." — returns array of keys or null if invalid
  const parts = inner.split(",");
  const keys = [];
  for (const part of parts) {
    const match = part.trim().match(/^@([A-Za-z_][A-Za-z0-9_-]*)$/);
    if (!match) return null;
    keys.push(match[1]);
  }
  return keys.length > 0 ? keys : null;
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

    // Display math $$...$$ (must come before $ check)
    if (text.startsWith("$$", i)) {
      const end = findUnescaped(text, i + 2, "$$");
      if (end !== -1 && end > i + 2) {
        flush();
        nodes.push({ type: "math_display", value: text.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }

    // Inline math $...$ (require non-whitespace after open and before close)
    if (ch === "$" && next && next !== " " && next !== "\t" && next !== "$") {
      const end = findUnescaped(text, i + 1, "$");
      if (end !== -1 && end > i + 1 && text[end - 1] !== " " && text[end - 1] !== "\t") {
        flush();
        nodes.push({ type: "math_inline", value: text.slice(i + 1, end) });
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

    if (ch === "{") {
      const mc = next;
      let mt = null;
      if (mc === "+") mt = "mark_positive";
      else if (mc === "=") mt = "mark_neutral";
      else if (mc === "^") mt = "mark_note";
      else if (mc === "?") mt = "mark_caution";
      else if (mc === "!") mt = "mark_warning";
      else if (mc === "-") mt = "mark_negative";
      else if (mc === "~") mt = "mark_highlight";
      if (mt) {
        const end = findUnescaped(text, i + 2, mc + "}");
        if (end !== -1) {
          flush();
          nodes.push({ type: mt, children: parseInline(text.slice(i + 2, end)) });
          i = end + 2;
          continue;
        }
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
          const rawUrl = text.slice(endLabel + 2, endUrl).trim();
          if (rawUrl) {
            flush();
            const { src: imgSrc, width: imgWidth, align: imgAlign } = parseImageWidth(rawUrl);
            const imgNode = { type: "image", alt: label, src: imgSrc };
            if (imgWidth) imgNode.width = imgWidth;
            if (imgAlign) imgNode.align = imgAlign;
            nodes.push(imgNode);
            i = endUrl + 1;
            continue;
          }
        }
      }
    }

    // Citation references: [@key] or [@key1, @key2]
    if (ch === "[" && text[i + 1] === "@") {
      const endBracket = findUnescaped(text, i + 1, "]");
      if (endBracket !== -1) {
        const inner = text.slice(i + 1, endBracket).trim();
        const keys = parseCitationKeys(inner);
        if (keys) {
          flush();
          nodes.push({ type: "citation_ref", keys });
          i = endBracket + 1;
          continue;
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

    if (ch === "h" && text.slice(i, i + 8).match(/^https?:\/\//)) {
      let j = i;
      while (j < text.length && !/[\s)\]}>]/.test(text[j])) j++;
      // Strip trailing punctuation that is likely sentence-level, not part of the URL
      while (j > i && /[.,;:!?]/.test(text[j - 1])) j--;
      const url = text.slice(i, j);
      if (url.length > 8) {
        flush();
        nodes.push({ type: "link", href: url, children: [{ type: "text", value: url }] });
        i = j;
        continue;
      }
    }

    if (ch === "m" && text.slice(i, i + 7) === "mailto:") {
      let j = i + 7;
      while (j < text.length && !/[\s)\]}>]/.test(text[j])) j++;
      while (j > i && /[.,;:!?]/.test(text[j - 1])) j--;
      const url = text.slice(i, j);
      if (url.length > 7) {
        flush();
        nodes.push({ type: "link", href: url, children: [{ type: "text", value: url }] });
        i = j;
        continue;
      }
    }

    // Bare email autolink: local@domain.tld
    if (ch === "@" && next && /[A-Za-z0-9]/.test(next)) {
      const prevCh = i > 0 ? text[i - 1] : "";
      if (/[A-Za-z0-9._+-]/.test(prevCh)) {
        // Scan forward for domain part (letters, digits, dots, hyphens)
        let j = i + 1;
        while (j < text.length && /[A-Za-z0-9.-]/.test(text[j])) j++;
        // Strip trailing dots/hyphens
        while (j > i + 1 && /[.-]/.test(text[j - 1])) j--;
        const domain = text.slice(i + 1, j);
        // Must have at least one dot with content on both sides
        if (/^[A-Za-z0-9]([A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/.test(domain)) {
          // Extract local part from buffer
          let k = buffer.length;
          while (k > 0 && /[A-Za-z0-9._+\-]/.test(buffer[k - 1])) k--;
          const local = buffer.slice(k);
          if (local.length > 0) {
            buffer = buffer.slice(0, k);
            const email = local + "@" + domain;
            flush();
            nodes.push({ type: "link", href: "mailto:" + email, children: [{ type: "text", value: email }] });
            i = j;
            continue;
          }
        }
      }
    }

    if (ch === "@" && next && isIdentStart(next) && !(i > 0 && /[A-Za-z0-9._+-]/.test(text[i - 1]))) {
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

let _renderOptions = {};

// --- Citation numbering ---
// Built before rendering; maps citation key → { number, anchorId }
// anchorId is the id of the first inline citation_ref for back-linking
let _citationNumbering = new Map();
let _citationDefinitions = new Map(); // key → { text, lineStart, lineEnd }

function buildCitationNumbering(nodes) {
  const numbering = new Map();
  const definitions = new Map();
  let counter = 0;

  // First pass: collect all citation_ref keys in document order to assign numbers
  function walkInlineNodes(inlineNodes) {
    for (const node of inlineNodes) {
      if (node.type === "citation_ref") {
        for (const key of node.keys) {
          if (!numbering.has(key)) {
            counter += 1;
            numbering.set(key, { number: counter, anchorId: `citeref-${key}` });
          }
        }
      }
      if (node.children) walkInlineNodes(node.children);
    }
  }

  function walkInlineText(text) {
    walkInlineNodes(parseInline(text));
  }

  function walk(nodeList) {
    for (const node of nodeList) {
      if (node.type === "paragraph" && node.text) {
        walkInlineText(node.text);
      } else if (node.type === "blockquote" && node.paragraphs) {
        for (const para of node.paragraphs) {
          walkInlineText(para);
        }
      } else if (node.type === "scope") {
        if (node.title) walkInlineText(node.title);
        if (node.children) walk(node.children);
      } else if (node.type === "list" && node.items) {
        walk(node.items);
      } else if (node.type === "table") {
        if (node.headers) {
          for (const cell of node.headers) walkInlineText(cell);
        }
        if (node.rows) {
          for (const row of node.rows) {
            for (const cell of row) walkInlineText(cell);
          }
        }
      } else if (node.type === "citations") {
        // Collect definitions
        for (const entry of node.entries) {
          if (!definitions.has(entry.key)) {
            definitions.set(entry.key, { text: entry.text, lineStart: entry.lineStart, lineEnd: entry.lineEnd });
          }
        }
      }
    }
  }
  walk(nodes);

  // Assign numbers to defined-but-unreferenced citations (appended after referenced ones)
  for (const [key, def] of definitions) {
    if (!numbering.has(key)) {
      counter += 1;
      numbering.set(key, { number: counter, anchorId: null });
    }
  }

  return { numbering, definitions };
}

function dataLineAttrs(node) {
  if (node.lineStart == null) {
    return "";
  }
  let attrs = ` data-line="${node.lineStart}"`;
  if (node.lineEnd != null && node.lineEnd !== node.lineStart) {
    attrs += ` data-line-end="${node.lineEnd}"`;
  }
  return attrs;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sanitizeSvg(svg) {
  if (typeof svg !== "string") return "";

  // Enforce a single <svg> root — discard anything outside it.
  const openMatch = svg.match(/<svg[\s>]/i);
  const closeMatch = svg.match(/<\/svg\s*>/i);
  if (!openMatch || !closeMatch) return "";
  const start = svg.indexOf(openMatch[0]);
  const end = svg.indexOf(closeMatch[0], start) + closeMatch[0].length;
  let s = svg.slice(start, end);

  // Strip <script> and <foreignObject> elements (including self-closing).
  s = s.replace(/<script[\s>][\s\S]*?<\/script\s*>/gi, "");
  s = s.replace(/<script\b[^>]*\/\s*>/gi, "");
  s = s.replace(/<foreignObject[\s>][\s\S]*?<\/foreignObject\s*>/gi, "");
  s = s.replace(/<foreignObject\b[^>]*\/\s*>/gi, "");

  // Strip event-handler attributes (onload, onclick, etc.).
  s = s.replace(/\s+on[a-z]+\s*=\s*(".*?"|'.*?'|[^\s>]+)/gi, "");

  // Neutralize javascript: URLs in href and xlink:href.
  s = s.replace(
    /(\s+(?:xlink:)?href\s*=\s*)(["'])(\s*javascript:)/gi,
    function (_match, prefix, quote) { return prefix + quote + "#"; }
  );

  return s;
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
          if (_renderOptions.brokenRefIds && _renderOptions.brokenRefIds.has(node.id)) {
            return `<a class="sdoc-ref sdoc-broken-ref" href="${href}"><span class="sdoc-broken-icon">\u26A0</span>@${escapeHtml(node.id)}</a>`;
          }
          return `<a class="sdoc-ref" href="${href}">@${escapeHtml(node.id)}</a>`;
        }
        case "citation_ref": {
          if (!_renderOptions._citationRefSeen) _renderOptions._citationRefSeen = new Set();
          const parts = node.keys.map((key) => {
            const info = _citationNumbering.get(key);
            const isBroken = !_citationDefinitions.has(key);
            if (isBroken) {
              // Undefined citation — render with warning
              const num = info ? info.number : escapeHtml(key);
              return `<a class="sdoc-citation-ref sdoc-broken-ref" href="#cite-${escapeAttr(key)}"><span class="sdoc-broken-icon">\u26A0</span>${num}</a>`;
            }
            // Only the first occurrence of each key gets the back-link anchor id
            const isFirst = !_renderOptions._citationRefSeen.has(key);
            if (isFirst) _renderOptions._citationRefSeen.add(key);
            const idAttr = isFirst ? ` id="citeref-${escapeAttr(key)}"` : "";
            return `<a class="sdoc-citation-ref"${idAttr} href="#cite-${escapeAttr(key)}">${info.number}</a>`;
          });
          return `<sup class="sdoc-citation-group">[${parts.join(", ")}]</sup>`;
        }
        case "code":
          return `<code class="sdoc-inline-code">${escapeHtml(node.value)}</code>`;
        case "em":
          return `<em>${renderInlineNodes(node.children)}</em>`;
        case "strong":
          return `<strong>${renderInlineNodes(node.children)}</strong>`;
        case "strike":
          return `<del>${renderInlineNodes(node.children)}</del>`;
        case "mark_positive":
          return `<span class="sdoc-mark sdoc-mark-positive">${renderInlineNodes(node.children)}</span>`;
        case "mark_neutral":
          return `<span class="sdoc-mark sdoc-mark-neutral">${renderInlineNodes(node.children)}</span>`;
        case "mark_note":
          return `<span class="sdoc-mark sdoc-mark-note">${renderInlineNodes(node.children)}</span>`;
        case "mark_caution":
          return `<span class="sdoc-mark sdoc-mark-caution">${renderInlineNodes(node.children)}</span>`;
        case "mark_warning":
          return `<span class="sdoc-mark sdoc-mark-warning">${renderInlineNodes(node.children)}</span>`;
        case "mark_negative":
          return `<span class="sdoc-mark sdoc-mark-negative">${renderInlineNodes(node.children)}</span>`;
        case "mark_highlight":
          return `<mark class="sdoc-mark sdoc-mark-highlight">${renderInlineNodes(node.children)}</mark>`;
        case "link":
          if (_renderOptions.brokenLinkHrefs && _renderOptions.brokenLinkHrefs.has(node.href)) {
            return `<a class="sdoc-link sdoc-broken-link" href="${escapeAttr(node.href)}" target="_blank" rel="noopener noreferrer"><span class="sdoc-broken-icon">\u26A0</span>${renderInlineNodes(
              node.children
            )}</a>`;
          }
          return `<a class="sdoc-link" href="${escapeAttr(node.href)}" target="_blank" rel="noopener noreferrer">${renderInlineNodes(
            node.children
          )}</a>`;
        case "image": {
          const imgParts = [];
          if (node.width) imgParts.push(`width:${escapeAttr(node.width)}`);
          if (node.align === "center") imgParts.push("display:block", "margin-left:auto", "margin-right:auto");
          else if (node.align === "left") imgParts.push("display:block", "float:left", "margin-right:1rem");
          else if (node.align === "right") imgParts.push("display:block", "float:right", "margin-left:1rem");
          const imgStyle = imgParts.length ? ` style="${imgParts.join(";")}"` : "";
          return `<img class="sdoc-image" src="${escapeAttr(node.src)}" alt="${escapeAttr(node.alt)}"${imgStyle} />`;
        }
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

function renderScope(scope, depth, isTitleScope = false) {
  // :comment scopes are not rendered
  if (scope.scopeType === "comment") return "";

  const isAbout = scope.id && scope.id.toLowerCase() === "about";
  // Skip empty/whitespace-only @about — no point rendering an empty meta box.
  if (isAbout && isAboutEmpty(scope)) return "";

  const level = Math.min(6, Math.max(1, depth));
  const children = scope.children.map((child) => renderNode(child, depth + 1)).join("\n");
  const rootClass = isTitleScope ? " sdoc-root" : "";
  const dl = dataLineAttrs(scope);
  const typeAttr = scope.scopeType ? ` data-scope-type="${escapeAttr(scope.scopeType)}"` : "";
  const typeClass = scope.scopeType ? ` sdoc-scope-type-${scope.scopeType}` : "";
  const metaClass = isAbout ? " sdoc-meta-section" : "";

  if (scope.hasHeading === false) {
    return `<section class="sdoc-scope sdoc-scope-noheading${rootClass}${typeClass}${metaClass}"${typeAttr}${dl}>${children}</section>`;
  }

  const idAttr = scope.id ? ` id="${escapeAttr(scope.id)}"` : "";
  const hasChildren = scope.children.length > 0;
  const toggle = hasChildren ? `<span class="sdoc-toggle"></span>` : "";
  const heading = `<h${level}${idAttr} class="sdoc-heading sdoc-depth-${level}"${dl}>${toggle}${renderInline(scope.title)}</h${level}>`;
  const childrenHtml = children ? `\n<div class="sdoc-scope-children">${children}</div>` : "";
  return `<section class="sdoc-scope${rootClass}${typeClass}${metaClass}"${typeAttr}>${heading}${childrenHtml}</section>`;
}

function renderCitations(node) {
  const dl = dataLineAttrs(node);

  // Build entries sorted by assigned citation number
  const sorted = [];
  for (const entry of node.entries) {
    const info = _citationNumbering.get(entry.key);
    if (info) {
      sorted.push({ key: entry.key, text: entry.text, number: info.number, anchorId: info.anchorId });
    } else {
      // Defined but no number (shouldn't happen if buildCitationNumbering ran, but be safe)
      sorted.push({ key: entry.key, text: entry.text, number: Infinity, anchorId: null });
    }
  }
  sorted.sort((a, b) => a.number - b.number);

  const items = sorted.map((entry) => {
    const backLink = entry.anchorId
      ? ` <a class="sdoc-citation-backlink" href="#${escapeAttr(entry.anchorId)}" title="Back to text">\u21A9</a>`
      : "";
    const unreferenced = entry.anchorId === null ? " sdoc-citation-unreferenced" : "";
    return `<li id="cite-${escapeAttr(entry.key)}" class="sdoc-citation-entry${unreferenced}" value="${entry.number}"><span class="sdoc-citation-text">${renderInline(entry.text)}</span>${backLink}</li>`;
  }).join("\n");

  return `<ol class="sdoc-citations"${dl}>${items}</ol>`;
}

function renderList(list, depth) {
  return renderListFromItems(list.listType, list.items, depth, list);
}

function renderListFromItems(listType, items, depth, list) {
  const tag = listType === "number" ? "ol" : "ul";
  const dl = list ? dataLineAttrs(list) : "";
  const renderedItems = items
    .map((item) => `<li class="sdoc-list-item">${renderListItem(item, listType, depth + 1)}</li>`)
    .join("\n");
  return `<${tag} class="sdoc-list sdoc-list-${listType}"${dl}>${renderedItems}</${tag}>`;
}

function renderListItem(scope, listType, depth) {
  const level = Math.min(6, Math.max(1, depth));
  const task = scope.task ? scope.task : null;
  const hasHeading = scope.hasHeading !== false && (scope.title.trim() !== "" || task);
  const idAttr = scope.id ? ` id="${escapeAttr(scope.id)}"` : "";
  const dl = dataLineAttrs(scope);
  let headingInner = renderInline(scope.title);
  if (task) {
    const checked = task.checked ? " checked" : "";
    headingInner = `<span class="sdoc-task"><input class="sdoc-task-box" type="checkbox"${checked} disabled /><span class="sdoc-task-label">${headingInner}</span></span>`;
  }
  const isShorthand = scope.shorthand === true;
  const hasChildren = scope.children.length > 0;
  let heading;
  if (!hasHeading) {
    heading = "";
  } else if (isShorthand || !hasChildren) {
    heading = `<span${idAttr} class="sdoc-list-item-text"${dl}>${headingInner}</span>`;
  } else {
    const toggle = `<span class="sdoc-toggle"></span>`;
    heading = `<h${level}${idAttr} class="sdoc-heading sdoc-depth-${level}"${dl}>${toggle}${headingInner}</h${level}>`;
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
  const bodyWrapper = body ? `\n<div class="sdoc-list-item-body sdoc-scope-children">${body}</div>` : "";
  const scopeClass = hasHeading ? "sdoc-scope" : "sdoc-scope sdoc-scope-noheading";
  return `<section class="${scopeClass}">${heading}${bodyWrapper}</section>`;
}

// ── Table formula engine ──────────────────────────────────────────────

function isFormulaCell(text) {
  const t = text.trim();
  return t.length > 1 && t[0] === "=" && t[1] !== "=" && !t.startsWith("\\=");
}

function parseCellRef(ref) {
  const m = ref.match(/^([A-Z])(\d+)$/);
  if (!m) return null;
  return { col: m[1].charCodeAt(0) - 65, row: parseInt(m[2], 10) - 1 };
}

function expandRange(rangeStr) {
  const parts = rangeStr.split(":");
  if (parts.length !== 2) return null;
  const start = parseCellRef(parts[0]);
  const end = parseCellRef(parts[1]);
  if (!start || !end) return null;
  const refs = [];
  for (let r = start.row; r <= end.row; r++) {
    for (let c = start.col; c <= end.col; c++) {
      refs.push({ col: c, row: r });
    }
  }
  return refs;
}

function parseCellValue(text) {
  const t = text.trim();
  if (/^-?\d+(\.\d+)?%$/.test(t)) {
    return { value: parseFloat(t) / 100, isPercent: true };
  }
  // Strip commas for numbers like 1,000,000
  const stripped = t.replace(/,/g, "");
  if (/^-?\d+(\.\d+)?$/.test(stripped)) {
    return { value: parseFloat(stripped), isPercent: false };
  }
  return { value: NaN, isPercent: false };
}

function buildCellGrid(rows) {
  return rows.map((row) => row.map((cell) => {
    if (isFormulaCell(cell)) return { value: NaN, isPercent: false, formula: cell.trim().slice(1) };
    return parseCellValue(cell);
  }));
}

function resolveRef(grid, ref) {
  if (ref.row < 0 || ref.row >= grid.length) return null;
  if (ref.col < 0 || ref.col >= grid[ref.row].length) return null;
  return grid[ref.row][ref.col];
}

function resolveRefs(grid, refs) {
  const values = [];
  for (const ref of refs) {
    const cell = resolveRef(grid, ref);
    if (!cell || isNaN(cell.value)) return null;
    values.push(cell);
  }
  return values;
}

function tokenizeFormula(expr) {
  const tokens = [];
  let i = 0;
  while (i < expr.length) {
    if (/\s/.test(expr[i])) { i++; continue; }
    // Function name
    if (/[A-Z]/.test(expr[i]) && i + 1 < expr.length && /[A-Z]/.test(expr[i + 1])) {
      let j = i;
      while (j < expr.length && /[A-Z]/.test(expr[j])) j++;
      tokens.push({ type: "func", value: expr.slice(i, j) });
      i = j;
      continue;
    }
    // Cell ref or range (e.g. A1, A1:B3)
    if (/[A-Z]/.test(expr[i]) && i + 1 < expr.length && /\d/.test(expr[i + 1])) {
      let j = i;
      while (j < expr.length && /[A-Z0-9:]/.test(expr[j])) j++;
      tokens.push({ type: "ref", value: expr.slice(i, j) });
      i = j;
      continue;
    }
    // Number
    if (/[\d.]/.test(expr[i])) {
      let j = i;
      while (j < expr.length && /[\d.]/.test(expr[j])) j++;
      const numStr = expr.slice(i, j);
      if ((numStr.match(/\./g) || []).length > 1) return { error: "#SYNTAX!" };
      if (j < expr.length && expr[j] === "%") {
        tokens.push({ type: "num", value: parseFloat(numStr) / 100, isPercent: true });
        j++;
      } else {
        tokens.push({ type: "num", value: parseFloat(numStr), isPercent: false });
      }
      i = j;
      continue;
    }
    if ("+-*/(),".includes(expr[i])) {
      tokens.push({ type: "op", value: expr[i] });
      i++;
      continue;
    }
    return { error: "#SYNTAX!" };
  }
  return { tokens };
}

function evaluateFormula(formula, grid) {
  const { tokens, error } = tokenizeFormula(formula);
  if (error) return { value: NaN, isPercent: false, error };

  let pos = 0;
  const peek = () => pos < tokens.length ? tokens[pos] : null;
  const consume = () => tokens[pos++];

  function resolveArg() {
    const tok = peek();
    if (!tok) return null;
    if (tok.type === "ref") {
      consume();
      if (tok.value.includes(":")) {
        const refs = expandRange(tok.value);
        if (!refs) return { error: "#REF!" };
        const cells = resolveRefs(grid, refs);
        if (!cells) return { error: "#VALUE!" };
        return { cells };
      } else {
        const ref = parseCellRef(tok.value);
        if (!ref) return { error: "#REF!" };
        const cell = resolveRef(grid, ref);
        if (!cell || isNaN(cell.value)) return { error: "#VALUE!" };
        return { cells: [cell] };
      }
    }
    return null;
  }

  function parseFuncArgs() {
    const allCells = [];
    if (!peek() || peek().value !== "(") return { error: "#SYNTAX!" };
    consume(); // (
    while (peek() && peek().value !== ")") {
      const arg = resolveArg();
      if (!arg) return { error: "#SYNTAX!" };
      if (arg.error) return arg;
      allCells.push(...arg.cells);
      if (peek() && peek().value === ",") consume();
    }
    if (!peek() || peek().value !== ")") return { error: "#SYNTAX!" };
    consume(); // )
    return { cells: allCells };
  }

  function parseAtom() {
    const tok = peek();
    if (!tok) return { error: "#SYNTAX!" };

    if (tok.type === "func") {
      const fname = consume().value;
      const args = parseFuncArgs();
      if (args.error) return args;
      const allPercent = args.cells.every((c) => c.isPercent);
      const vals = args.cells.map((c) => c.value);
      if (fname === "SUM") {
        return { value: vals.reduce((a, b) => a + b, 0), isPercent: allPercent };
      } else if (fname === "AVG") {
        if (vals.length === 0) return { error: "#DIV/0!" };
        return { value: vals.reduce((a, b) => a + b, 0) / vals.length, isPercent: allPercent };
      } else if (fname === "COUNT") {
        return { value: vals.length, isPercent: false };
      }
      return { error: "#NAME!" };
    }

    if (tok.type === "num") {
      consume();
      return { value: tok.value, isPercent: tok.isPercent };
    }

    if (tok.type === "ref") {
      consume();
      const ref = parseCellRef(tok.value);
      if (!ref) return { error: "#REF!" };
      const cell = resolveRef(grid, ref);
      if (!cell || isNaN(cell.value)) return { error: "#VALUE!" };
      return { value: cell.value, isPercent: cell.isPercent };
    }

    if (tok.type === "op" && tok.value === "(") {
      consume();
      const result = parseExpr();
      if (result.error) return result;
      if (!peek() || peek().value !== ")") return { error: "#SYNTAX!" };
      consume();
      return result;
    }

    // Unary minus
    if (tok.type === "op" && tok.value === "-") {
      consume();
      const operand = parseAtom();
      if (operand.error) return operand;
      return { value: -operand.value, isPercent: operand.isPercent };
    }

    return { error: "#SYNTAX!" };
  }

  function parseTerm() {
    let left = parseAtom();
    if (left.error) return left;
    while (peek() && (peek().value === "*" || peek().value === "/")) {
      const op = consume().value;
      const right = parseAtom();
      if (right.error) return right;
      if (op === "/") {
        if (right.value === 0) return { error: "#DIV/0!" };
        left = { value: left.value / right.value, isPercent: false };
      } else {
        left = { value: left.value * right.value, isPercent: false };
      }
    }
    return left;
  }

  function parseExpr() {
    let left = parseTerm();
    if (left.error) return left;
    while (peek() && (peek().value === "+" || peek().value === "-")) {
      const op = consume().value;
      const right = parseTerm();
      if (right.error) return right;
      const bothPercent = left.isPercent && right.isPercent;
      left = {
        value: op === "+" ? left.value + right.value : left.value - right.value,
        isPercent: bothPercent,
      };
    }
    return left;
  }

  const result = parseExpr();
  if (result.error) return { value: NaN, isPercent: false, error: result.error };
  if (peek()) return { value: NaN, isPercent: false, error: "#SYNTAX!" };
  return { value: result.value, isPercent: result.isPercent, error: null };
}

function evaluateGrid(grid) {
  // Track which cells started as formulas for circular reference detection
  const formulaCells = [];
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      if (grid[r][c].formula) formulaCells.push([r, c]);
    }
  }
  // Topological evaluation: resolve formulas that depend on other formulas
  const maxPasses = formulaCells.length + 1;
  for (let pass = 0; pass < maxPasses; pass++) {
    let pending = false;
    for (let r = 0; r < grid.length; r++) {
      for (let c = 0; c < grid[r].length; c++) {
        const cell = grid[r][c];
        if (!cell.formula) continue;
        const result = evaluateFormula(cell.formula, grid);
        if (result.error === "#VALUE!" && pass < maxPasses - 1) {
          // Might resolve on a later pass when dependencies are computed
          pending = true;
          continue;
        }
        cell.value = result.value;
        cell.isPercent = result.isPercent;
        cell.error = result.error;
        delete cell.formula;
      }
    }
    if (!pending) break;
  }
  // Any formula cells still showing #VALUE! after all passes are circular
  for (const [r, c] of formulaCells) {
    if (grid[r][c].error === "#VALUE!") {
      grid[r][c].error = "#CIRCULAR!";
    }
  }
  return grid;
}

function formatFormulaResult(cell) {
  if (cell.error) return cell.error;
  if (cell.isPercent) {
    const pct = cell.value * 100;
    return (Number.isInteger(pct) ? pct.toString() : pct.toFixed(2).replace(/\.?0+$/, "")) + "%";
  }
  if (Number.isInteger(cell.value)) return cell.value.toLocaleString();
  return cell.value.toFixed(2).replace(/\.?0+$/, "");
}

// ── End formula engine ───────────────────────────────────────────────

function renderTable(table) {
  const dl = dataLineAttrs(table);
  const opts = table.options || {};
  const colAlign = table.columnAlign || [];
  const colFormat = table.columnFormat || [];
  const classes = ["sdoc-table"];
  if (opts.borderless) classes.push("sdoc-table-borderless");
  if (opts.headerless) classes.push("sdoc-table-headerless");
  const classAttr = classes.join(" ");

  function cellStyle(colIndex) {
    const align = colAlign[colIndex];
    if (!align || align === "left") return "";
    return ` style="text-align:${align}"`;
  }

  let thead = "";
  if (table.headers.length > 0) {
    const headerCells = table.headers
      .map((cell, c) => `<th class="sdoc-table-th"${cellStyle(c)}>${renderInline(cell)}</th>`)
      .join("");
    thead = `<thead class="sdoc-table-head"><tr>${headerCells}</tr></thead>`;
  }

  // Formula evaluation
  const grid = evaluateGrid(buildCellGrid(table.rows));

  const bodyRows = table.rows
    .map((row, r) => {
      const cells = row
        .map((cell, c) => {
          const style = cellStyle(c);
          const fmt = colFormat[c] || null;

          if (isFormulaCell(cell)) {
            const result = grid[r][c];
            let display;
            if (!result.error && fmt) {
              display = escapeHtml(formatNumber(result.value, fmt));
            } else {
              display = escapeHtml(formatFormulaResult(result));
            }
            const formula = escapeAttr(cell.trim());
            if (result.error) {
              return `<td class="sdoc-table-td sdoc-formula-error"${style} title="${formula}">${display}</td>`;
            }
            return `<td class="sdoc-table-td sdoc-formula-cell"${style} title="${formula}">${display}</td>`;
          }

          // Apply column format to numeric data cells
          if (fmt) {
            const parsed = parseCellValue(cell);
            if (!isNaN(parsed.value)) {
              return `<td class="sdoc-table-td"${style}>${escapeHtml(formatNumber(parsed.value, fmt))}</td>`;
            }
          }

          return `<td class="sdoc-table-td"${style}>${renderInline(cell)}</td>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("\n");
  const tbody = bodyRows ? `<tbody class="sdoc-table-body">${bodyRows}</tbody>` : "";

  const styleParts = [];
  if (opts.width) {
    styleParts.push(`width:${opts.width}`);
    if (opts.width !== "auto") styleParts.push("table-layout:fixed");
  }
  if (opts.align === "center") styleParts.push("margin-left:auto", "margin-right:auto");
  else if (opts.align === "right") styleParts.push("margin-left:auto", "margin-right:0");
  const styleAttr = styleParts.length ? ` style="${styleParts.join(";")}"` : "";

  return `<table class="${classAttr}"${dl}${styleAttr}>${thead}${thead ? "\n" : ""}${tbody}</table>`;
}

function renderNode(node, depth) {
  const dl = dataLineAttrs(node);
  switch (node.type) {
    case "scope":
      return renderScope(node, depth);
    case "list":
      return renderList(node, depth);
    case "table":
      return renderTable(node);
    case "blockquote": {
      const paragraphs = node.paragraphs
        .map((text) => `<p class="sdoc-paragraph">${renderInline(text)}</p>`)
        .join("\n");
      return `<blockquote class="sdoc-blockquote"${dl}>${paragraphs}</blockquote>`;
    }
    case "hr":
      return `<hr class="sdoc-rule"${dl} />`;
    case "paragraph": {
      const editable = _renderOptions.editable ? ` contenteditable="true"` : "";
      return `<p class="sdoc-paragraph"${dl}${editable}>${renderInline(node.text)}</p>`;
    }
    case "citations":
      return renderCitations(node);
    case "code": {
      if (node.lang === "mermaid") {
        return `<pre class="mermaid"${dl}>${escapeHtml(node.text)}</pre>`;
      }
      if (node.lang === "svg") {
        return `<div class="sdoc-svg-block"${dl}>${sanitizeSvg(node.text)}</div>`;
      }
      if (node.lang === "math") {
        return `<div class="sdoc-math sdoc-math-block"${dl}>${renderKatex(node.text, true)}</div>`;
      }
      const langClass = node.lang ? ` class="language-${escapeAttr(node.lang)}"` : "";
      const dataLabel = node.dataFlag ? `<span class="sdoc-data-label">data</span>` : "";
      return `<div class="sdoc-code-wrap"${dl}>${dataLabel}<pre class="sdoc-code"><code${langClass}>${escapeHtml(node.text)}</code></pre><button class="sdoc-copy-btn" title="Copy code">\u29C9</button></div>`;
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
  const doc = getDocumentScope(nodes);
  const searchNodes = doc ? doc.children : nodes;

  let metaIndex = -1;
  for (let i = 0; i < searchNodes.length; i += 1) {
    const node = searchNodes[i];
    if (node.type === "scope" && node.id && node.id.toLowerCase() === "meta") {
      metaIndex = i;
      break;
    }
  }

  if (metaIndex === -1) {
    return { nodes, meta: {}, warnings: [] };
  }

  const metaNode = searchNodes[metaIndex];
  const meta = {
    stylePath: null,
    styleAppendPath: null,
    headerNodes: null,
    footerNodes: null,
    headerText: null,
    footerText: null,
    properties: {}
  };

  // First pass: sub-scope syntax (takes precedence)
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

  // Second pass: key:value syntax from paragraph nodes (only if not already set by sub-scope)
  const kvPattern = /^([\w][\w-]*)\s*:\s+(.+)$/;
  for (const child of metaNode.children) {
    if (child.type !== "paragraph") continue;
    const match = child.text.match(kvPattern);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === "style") {
      if (!meta.stylePath) meta.stylePath = value;
    } else if (key === "styleappend" || key === "style-append") {
      if (!meta.styleAppendPath) meta.styleAppendPath = value;
    } else if (key === "header") {
      if (!meta.headerNodes && !meta.headerText) meta.headerText = value;
    } else if (key === "footer") {
      if (!meta.footerNodes && !meta.footerText) meta.footerText = value;
    } else {
      if (!(key in meta.properties)) meta.properties[key] = value;
    }
  }

  // Promote well-known Lexica properties
  meta.uuid = meta.properties.uuid || null;
  meta.type = meta.properties.type || null;
  meta.tags = meta.properties.tags
    ? meta.properties.tags.split(",").map((t) => t.trim()).filter(Boolean)
    : [];
  meta.company = meta.properties.company || null;
  meta.confidential = meta.properties.confidential || null;

  const warnings = [];
  if (!meta.properties["sdoc-version"]) {
    warnings.push("Missing sdoc-version in @meta (current format version is " + SDOC_FORMAT_VERSION + ")");
  }

  if (doc) {
    // @meta was inside the document scope — strip it from children
    const filteredChildren = doc.children.filter((_, index) => index !== metaIndex);
    const stripped = { ...doc, children: filteredChildren };
    return { nodes: [stripped], meta, warnings };
  }
  const bodyNodes = nodes.filter((_, index) => index !== metaIndex);
  return { nodes: bodyNodes, meta, warnings };
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

function buildConfidentialHtml(meta) {
  if (!meta || !meta.confidential) return "";
  const val = meta.confidential.trim();
  if (!val) return "";
  const entity = val.toLowerCase() === "true" ? meta.company : val;
  const text = entity
    ? `CONFIDENTIAL \u2014 ${escapeHtml(entity)}`
    : "CONFIDENTIAL";
  return `<div class="sdoc-confidential-notice">${text}</div>`;
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

  .sdoc-confidential-notice {
    background: rgba(187, 68, 68, 0.08);
    border-bottom: 1px solid rgba(187, 68, 68, 0.2);
    color: rgba(160, 40, 40, 0.85);
    text-align: center;
    padding: 5px 24px;
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
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

  .sdoc-scope-children > .sdoc-scope {
    padding-left: 1.5rem;
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

  .sdoc-table {
    border-collapse: separate;
    border-spacing: 0;
    width: 100%;
    margin: 1rem 0;
    border: 1px solid var(--sdoc-border);
    border-radius: 10px;
    overflow: hidden;
  }

  .sdoc-table-th {
    background: rgba(0, 0, 0, 0.06);
    font-weight: 600;
    text-align: left;
    padding: 10px 14px;
    border-bottom: 1px solid var(--sdoc-border);
  }

  .sdoc-table-td {
    padding: 8px 14px;
    border-bottom: 1px solid rgba(127, 120, 112, 0.15);
  }

  .sdoc-table-body tr:nth-child(even) {
    background: rgba(0, 0, 0, 0.025);
  }

  .sdoc-table-body tr:last-child .sdoc-table-td {
    border-bottom: none;
  }

  td.sdoc-formula-cell {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    color: #2a7a8a !important;
    cursor: help;
    border-bottom: 1px dotted #2a7a8a40;
  }
  td.sdoc-formula-error {
    color: #c33 !important;
    font-style: italic;
    cursor: help;
  }

  .sdoc-table-borderless,
  .sdoc-table-borderless th,
  .sdoc-table-borderless td {
    border: none;
  }

  .sdoc-table-borderless tr:nth-child(even) td {
    background: none;
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

  .sdoc-mark {
    border-radius: 3px;
    padding: 0.05em 0.3em;
    font-weight: 500;
  }
  .sdoc-mark-positive  { background-color: rgba(34, 139, 34, 0.15); color: #166016; }
  .sdoc-mark-neutral   { background-color: rgba(59, 130, 195, 0.15); color: #245d8a; }
  .sdoc-mark-note      { background-color: rgba(190, 170, 0, 0.15); color: #6b5d00; }
  .sdoc-mark-caution   { background-color: rgba(217, 130, 10, 0.18); color: #8a5000; }
  .sdoc-mark-warning   { background-color: rgba(245, 115, 0, 0.20); color: #c05600; }
  .sdoc-mark-negative  { background-color: rgba(210, 25, 25, 0.18); color: #a81414; }
  .sdoc-mark-highlight { background-color: rgba(255, 255, 0, 0.75); }

  .sdoc-broken-ref, .sdoc-link.sdoc-broken-link {
    color: #c33;
    text-decoration: wavy underline #c33;
    text-underline-offset: 2px;
    background: rgba(204, 51, 51, 0.08);
    border-radius: 2px;
    padding: 0 0.15em;
  }
  .sdoc-broken-icon {
    font-size: 0.75em;
    margin-right: 0.15em;
  }

  .sdoc-citation-group {
    font-size: 0.8em;
    line-height: 1;
    vertical-align: super;
  }

  .sdoc-citation-ref {
    color: var(--sdoc-accent);
    text-decoration: none;
    cursor: pointer;
  }

  .sdoc-citation-ref:hover {
    text-decoration: underline;
  }

  .sdoc-citations {
    margin: 1.5rem 0;
    padding: 1rem 0 0.5rem 0;
    border-top: 1px solid var(--sdoc-border);
    list-style: none;
    counter-reset: none;
  }

  .sdoc-citation-entry {
    margin: 0.4rem 0;
    padding-left: 2.5rem;
    position: relative;
    line-height: 1.6;
    font-size: 0.92em;
  }

  .sdoc-citation-entry::before {
    content: "[" attr(value) "]";
    position: absolute;
    left: 0;
    color: var(--sdoc-muted);
    font-weight: 600;
    font-size: 0.9em;
  }

  .sdoc-citation-unreferenced {
    opacity: 0.6;
  }

  .sdoc-citation-backlink {
    color: var(--sdoc-accent);
    text-decoration: none;
    margin-left: 0.3em;
    font-size: 0.85em;
  }

  .sdoc-citation-backlink:hover {
    text-decoration: underline;
  }

  .sdoc-image {
    display: inline-block;
    max-width: 100%;
    border-radius: 10px;
    border: 1px solid var(--sdoc-border);
    margin: 0.4rem 0;
    vertical-align: top;
  }

  .sdoc-image + .sdoc-image {
    margin-left: 0.5%;
  }

  .sdoc-svg-block {
    margin: 0.6rem 0;
    text-align: center;
  }

  .sdoc-svg-block svg {
    max-width: 100%;
    height: auto;
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

  .sdoc-data-label {
    position: absolute;
    top: 6px;
    left: 8px;
    z-index: 1;
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 1px 5px;
    border-radius: 3px;
    background: rgba(59, 130, 195, 0.15);
    color: #3b82c3;
    pointer-events: none;
  }

  /* Collapsible scope toggles */
  .sdoc-heading:has(.sdoc-toggle) {
    position: relative;
  }

  .sdoc-toggle {
    position: absolute;
    left: -1.4em;
    top: 0;
    bottom: 0;
    width: 1.2em;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.15s;
  }

  .sdoc-toggle::before {
    content: '';
    display: block;
    width: 0.45em;
    height: 0.45em;
    border-right: 2px solid var(--sdoc-muted);
    border-bottom: 2px solid var(--sdoc-muted);
    transition: transform 0.15s;
    transform: rotate(45deg);
    position: absolute;
    top: 0.18em;
    left: 50%;
    margin-left: -0.3em;
  }

  .sdoc-scope:hover > .sdoc-heading > .sdoc-toggle {
    opacity: 1;
  }

  .sdoc-scope.sdoc-collapsed > .sdoc-heading > .sdoc-toggle {
    opacity: 0.6;
  }

  .sdoc-scope.sdoc-collapsed > .sdoc-heading > .sdoc-toggle::before {
    transform: rotate(-45deg);
    margin-left: -0.15em;
  }

  .sdoc-scope.sdoc-collapsed > .sdoc-scope-children {
    display: none;
  }

  /* Meta sections (@about) — rendered with a distinct, subdued style
     so readers can tell at a glance this is document metadata, not body content. */
  .sdoc-scope.sdoc-meta-section {
    position: relative;
    margin: 1.2rem 3rem 1.6rem 3rem;
    padding: 0.7rem 1rem 0.7rem 1rem;
    background: rgba(127, 120, 112, 0.06);
    border: 1px dashed var(--sdoc-border);
    border-left: 3px solid var(--sdoc-muted);
    border-radius: 6px;
    color: var(--sdoc-muted);
    font-size: 0.95em;
  }

  .sdoc-meta-section .sdoc-heading {
    margin-top: 0.2rem;
    color: var(--sdoc-muted);
    font-weight: 600;
    border-bottom: none;
  }

  .sdoc-meta-section .sdoc-paragraph {
    margin: 0.3rem 0;
    font-style: italic;
  }

  .sdoc-meta-section .sdoc-scope-children > .sdoc-scope {
    padding-left: 0;
  }

  /* Place the collapse toggle in the gutter to the LEFT of the meta
     box (in the space created by margin-left), not on the colored
     left border. Default is left: -1.4em which lands on the border. */
  .sdoc-meta-section > .sdoc-heading > .sdoc-toggle {
    left: -2.6em;
  }

`;

const PRINT_STYLE = `
  .sdoc-code-wrap {
    position: relative;
  }
  .sdoc-copy-btn {
    position: absolute;
    top: 6px;
    right: 6px;
    z-index: 1;
    background: transparent;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.85rem;
    line-height: 1;
    padding: 2px 6px;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .sdoc-code-wrap:hover .sdoc-copy-btn {
    opacity: 0.75;
  }
  .sdoc-copy-btn:hover {
    opacity: 1 !important;
  }
  @media print {
    html {
      font-size: 80%;
    }
    .sdoc-copy-btn, .sdoc-toggle {
      display: none;
    }
    .sdoc-scope.sdoc-collapsed > .sdoc-scope-children {
      display: block;
    }
    body {
      height: auto;
      overflow: visible;
    }
    .sdoc-shell {
      height: auto;
    }
    .sdoc-main {
      overflow: visible;
    }
    .sdoc-code {
      white-space: pre-wrap;
      word-wrap: break-word;
      overflow-x: visible;
    }
    .sdoc-code code {
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    .sdoc-mark { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .sdoc-table { break-inside: avoid; }
    .sdoc-code { break-inside: avoid; }
    .sdoc-blockquote { break-inside: avoid; }
  }
`;

const COLLAPSE_SCRIPT = `document.addEventListener("click",function(e){if(!e.target.classList.contains("sdoc-toggle"))return;e.stopPropagation();var s=e.target.closest(".sdoc-scope");if(s)s.classList.toggle("sdoc-collapsed")});`;

const COPY_SCRIPT = `document.addEventListener("click",function(e){if(!e.target.classList.contains("sdoc-copy-btn"))return;e.stopPropagation();e.preventDefault();var w=e.target.closest(".sdoc-code-wrap");if(!w)return;var c=w.querySelector("code");if(!c)return;var t=c.textContent;var b=e.target;if(navigator.clipboard){navigator.clipboard.writeText(t).then(function(){b.textContent="\\u2713";setTimeout(function(){b.textContent="\\u29C9"},1500)})}else{var a=document.createElement("textarea");a.value=t;a.style.position="fixed";a.style.opacity="0";document.body.appendChild(a);a.select();document.execCommand("copy");document.body.removeChild(a);b.textContent="\\u2713";setTimeout(function(){b.textContent="\\u29C9"},1500)}});`;

const MERMAID_CDN = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";
const KATEX_CDN_CSS = "https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.css";
const HLJS_CDN = "https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.11.1/highlight.min.js";

// Custom highlight.js grammar for SDOC language – registered before highlightElement calls
const HLJS_SDOC_GRAMMAR = `hljs.registerLanguage('sdoc',function(hljs){return{name:'SDOC',aliases:['sdoc'],contains:[
hljs.COMMENT('^\\\\s*//','$'),
{className:'section',begin:'^\\\\s*#+\\\\s+',end:'$',contains:[
  {className:'symbol',begin:'@[A-Za-z_][A-Za-z0-9_-]*'}
]},
{className:'meta',begin:'^\\\\s*@[A-Za-z_][A-Za-z0-9_-]*',end:'(?=\\\\s*\\\\{|$)'},
{className:'code',begin:'\`\`\`',end:'\`\`\`',contains:[hljs.BACKSLASH_ESCAPE]},
{className:'code',begin:'\`[^\`]+\`'},
{className:'string',begin:'\\\\[',end:'\\\\]\\\\([^)]*\\\\)',contains:[
  {className:'link',begin:'\\\\(',end:'\\\\)'}
]},
{className:'keyword',begin:'\\\\{[!?+\\\\-=~^]',end:'[!?+\\\\-=~^]\\\\}'},
{className:'keyword',begin:'\\\\{\\\\[(?:\\\\.|#|\\\\d+|table|citations)\\\\]'},
{className:'strong',begin:'\\\\*\\\\*',end:'\\\\*\\\\*'},
{className:'emphasis',begin:'(?<!\\\\*)\\\\*(?!\\\\*)',end:'\\\\*(?!\\\\*)'},
{className:'deletion',begin:'~~',end:'~~'},
{className:'bullet',begin:'^\\\\s*[-]\\\\s'},
{className:'bullet',begin:'^\\\\s*\\\\d+[.)]\\\\ '},
{className:'quote',begin:'^\\\\s*>',end:'$'},
{className:'symbol',begin:'(?<!\\\\\\\\)@[A-Za-z_][A-Za-z0-9_-]*'},
{className:'attr',begin:'[A-Za-z_][A-Za-z0-9_-]*(?=\\\\s*:)',end:':',excludeEnd:true}
]}});`;

// Highlight.js GitHub light theme (inline so it works inside shadow DOM in the web viewer)
const HLJS_LIGHT_CSS = "pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#24292e;background:#fff}.hljs-doctag,.hljs-keyword,.hljs-meta .hljs-keyword,.hljs-template-tag,.hljs-template-variable,.hljs-type,.hljs-variable.language_{color:#d73a49}.hljs-title,.hljs-title.class_,.hljs-title.class_.inherited__,.hljs-title.function_{color:#6f42c1}.hljs-attr,.hljs-attribute,.hljs-literal,.hljs-meta,.hljs-number,.hljs-operator,.hljs-selector-attr,.hljs-selector-class,.hljs-selector-id,.hljs-variable{color:#005cc5}.hljs-meta .hljs-string,.hljs-regexp,.hljs-string{color:#032f62}.hljs-built_in,.hljs-symbol{color:#e36209}.hljs-code,.hljs-comment,.hljs-formula{color:#6a737d}.hljs-name,.hljs-quote,.hljs-selector-pseudo,.hljs-selector-tag{color:#22863a}.hljs-subst{color:#24292e}.hljs-section{color:#005cc5;font-weight:700}.hljs-bullet{color:#735c0f}.hljs-emphasis{color:#24292e;font-style:italic}.hljs-strong{color:#24292e;font-weight:700}.hljs-addition{color:#22863a;background-color:#f0fff4}.hljs-deletion{color:#b31d28;background-color:#ffeef0}";
// Highlight.js GitHub dark theme color overrides (used in @media and VS Code dark-mode CSS)
const HLJS_DARK_COLORS_CSS = ".hljs{color:#c9d1d9;background:transparent}.hljs-doctag,.hljs-keyword,.hljs-meta .hljs-keyword,.hljs-template-tag,.hljs-template-variable,.hljs-type,.hljs-variable.language_{color:#ff7b72}.hljs-title,.hljs-title.class_,.hljs-title.class_.inherited__,.hljs-title.function_{color:#d2a8ff}.hljs-attr,.hljs-attribute,.hljs-literal,.hljs-meta,.hljs-number,.hljs-operator,.hljs-selector-attr,.hljs-selector-class,.hljs-selector-id,.hljs-variable{color:#79c0ff}.hljs-meta .hljs-string,.hljs-regexp,.hljs-string{color:#a5d6ff}.hljs-built_in,.hljs-symbol{color:#ffa657}.hljs-code,.hljs-comment,.hljs-formula{color:#8b949e}.hljs-name,.hljs-quote,.hljs-selector-pseudo,.hljs-selector-tag{color:#7ee787}.hljs-subst{color:#c9d1d9}.hljs-section{color:#1f6feb;font-weight:700}.hljs-bullet{color:#f2cc60}.hljs-emphasis{color:#c9d1d9;font-style:italic}.hljs-strong{color:#c9d1d9;font-weight:700}.hljs-addition{color:#aff5b4;background-color:#033a16}.hljs-deletion{color:#ffdcd7;background-color:#67060c}";

function hasMermaidBlocks(nodes) {
  for (const node of nodes) {
    if (node.type === "code" && node.lang === "mermaid") return true;
    if (node.children && hasMermaidBlocks(node.children)) return true;
    if (node.items) {
      for (const item of node.items) {
        if (item.children && hasMermaidBlocks(item.children)) return true;
      }
    }
  }
  return false;
}

function hasHighlightableCodeBlocks(nodes) {
  for (const node of nodes) {
    if (node.type === "code" && node.lang && node.lang !== "mermaid" && node.lang !== "math" && node.lang !== "svg") return true;
    if (node.children && hasHighlightableCodeBlocks(node.children)) return true;
    if (node.items) {
      for (const item of node.items) {
        if (item.children && hasHighlightableCodeBlocks(item.children)) return true;
      }
    }
  }
  return false;
}

function renderBodyNodes(nodes) {
  return nodes
    .map((node, index) => {
      if (node.type === "scope" && index === 0) {
        return renderScope(node, 1, true);
      }
      return renderNode(node, 1);
    })
    .join("\n");
}

function renderHtmlBody(text) {
  const parsed = parseSdoc(text);
  const metaResult = extractMeta(parsed.nodes);
  const savedOptions = _renderOptions;
  _renderOptions = {};
  const citationData = buildCitationNumbering(metaResult.nodes);
  _citationNumbering = citationData.numbering;
  _citationDefinitions = citationData.definitions;
  const result = renderBodyNodes(metaResult.nodes);
  _citationNumbering = new Map();
  _citationDefinitions = new Map();
  _renderOptions = savedOptions;
  return result;
}

function renderHtmlDocumentFromParsed(parsed, title, options = {}) {
  _renderOptions = options.renderOptions ?? {};
  const citationData = buildCitationNumbering(parsed.nodes);
  _citationNumbering = citationData.numbering;
  _citationDefinitions = citationData.definitions;
  const body = renderBodyNodes(parsed.nodes);
  _citationNumbering = new Map();
  _citationDefinitions = new Map();
  _renderOptions = {};
  const errorHtml = renderErrors(parsed.errors);

  const meta = options.meta ?? {};
  const config = options.config ?? {};
  const confidentialHtml = buildConfidentialHtml(meta);
  const headerHtml = meta.headerNodes ? renderFragment(meta.headerNodes, 2)
    : meta.headerText ? renderTextParagraphs(meta.headerText)
    : renderTextParagraphs(config.header);
  const companyHtml = meta.company
    ? `<span class="sdoc-company-footer">${escapeHtml(meta.company)}</span>`
    : "";
  const footerHtml = meta.footerNodes ? renderFragment(meta.footerNodes, 2)
    : meta.footerText ? renderTextParagraphs(meta.footerText)
    : renderTextParagraphs(config.footer);
  const footerContent = [footerHtml, companyHtml].filter(Boolean).join("\n");

  const cssBase = options.cssOverride ?? DEFAULT_STYLE;
  const cssAppend = options.cssAppend ? `\n${options.cssAppend}\n${PRINT_STYLE}` : `\n${PRINT_STYLE}`;
  const builtinScript = COLLAPSE_SCRIPT + COPY_SCRIPT;
  const scriptTag = options.script ? `\n<script>${options.script}</script>` : `\n<script>${builtinScript}</script>`;
  const mermaidTheme = options.mermaidTheme ?? "neutral";
  const mermaidInit = mermaidTheme === "auto"
    ? `var isDark=window.matchMedia("(prefers-color-scheme:dark)").matches;mermaid.initialize({startOnLoad:true,theme:isDark?"dark":"neutral",themeCSS:".node rect, .node polygon, .node circle { rx: 4; ry: 4; }"});`
    : `mermaid.initialize({startOnLoad:true,theme:"${mermaidTheme}",themeCSS:".node rect, .node polygon, .node circle { rx: 4; ry: 4; }"});`;
  const mermaidScript = hasMermaidBlocks(parsed.nodes)
    ? `\n<script src="${MERMAID_CDN}"></script>\n<script>${mermaidInit}</script>`
    : "";
  const katexCssTag = body.includes('class="katex"')
    ? `\n<link rel="stylesheet" href="${KATEX_CDN_CSS}" />`
    : "";
  const hasHljs = hasHighlightableCodeBlocks(parsed.nodes);
  // Highlight.js CSS is inlined (not a <link>) so it is extracted by parseDocHtml in the web viewer
  // and applied inside shadow DOM. The @media query handles dark mode in browsers.
  const hljsCssInline = hasHljs
    ? `\n${HLJS_LIGHT_CSS}\n.sdoc-code code.hljs{padding:0;background:transparent}\n@media (prefers-color-scheme:dark){${HLJS_DARK_COLORS_CSS}}`
    : "";
  const hljsScript = hasHljs
    ? `\n<script src="${HLJS_CDN}"></script>\n<script>${HLJS_SDOC_GRAMMAR}\ndocument.querySelectorAll('pre.sdoc-code code[class*="language-"]').forEach(function(b){hljs.highlightElement(b);});</script>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
<style>
${cssBase}${cssAppend}${hljsCssInline}
</style>${katexCssTag}
</head>
<body>
  <div class="sdoc-shell">
    ${confidentialHtml}
    ${headerHtml ? `<header class="sdoc-page-header">${headerHtml}</header>` : ""}
    <div class="sdoc-main">
      <main>
        ${errorHtml}
        ${body}
      </main>
    </div>
    ${footerContent ? `<footer class="sdoc-page-footer">${footerContent}</footer>` : ""}
  </div>${scriptTag}${mermaidScript}${hljsScript}
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

function formatSdoc(text, indentStr = "    ") {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const result = [];
  let depth = 0;
  let inCodeBlock = false;
  let codeFenceLen = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // Blank lines — emit empty, no depth change
    if (trimmed === "") {
      result.push("");
      continue;
    }

    // Inside code block — pass through raw
    if (inCodeBlock) {
      const closeMatch = trimmed.match(/^(`{3,})\s*$/);
      if (closeMatch && closeMatch[1].length >= codeFenceLen) {
        inCodeBlock = false;
        codeFenceLen = 0;
        result.push(indentStr.repeat(depth) + trimmed);
      } else {
        result.push(line);
      }
      continue;
    }

    // Code fence opening
    if (isFenceStart(trimmed)) {
      const openMatch = trimmed.match(/^(`{3,})/);
      codeFenceLen = openMatch ? openMatch[1].length : 3;
      result.push(indentStr.repeat(depth) + trimmed);
      inCodeBlock = true;
      continue;
    }

    // Closing brace — decrement first, then indent
    if (trimmed === COMMAND_SCOPE_CLOSE) {
      depth = Math.max(0, depth - 1);
      result.push(indentStr.repeat(depth) + trimmed);
      continue;
    }

    // Inline block { content }
    if (tryParseInlineBlock(trimmed) !== null) {
      result.push(indentStr.repeat(depth) + trimmed);
      continue;
    }

    // Standalone opener: {, {[.], {[#], {[table], {[citations]
    if (trimmed === COMMAND_SCOPE_OPEN ||
        trimmed === COMMAND_LIST_BULLET ||
        trimmed === COMMAND_LIST_NUMBER ||
        isTableCommand(trimmed) ||
        isCitationsCommand(trimmed)) {
      result.push(indentStr.repeat(depth) + trimmed);
      depth++;
      continue;
    }

    // K&R line — heading or list item ending with opener
    const trailing = extractTrailingOpener(trimmed);
    if (trailing) {
      result.push(indentStr.repeat(depth) + trimmed);
      depth++;
      continue;
    }

    // Everything else — indent at current depth
    result.push(indentStr.repeat(depth) + trimmed);
  }

  return result.join("\n");
}

// --- Lexica utility functions ---

const KNOWN_TYPES = ["skill", "doc"];

function inferType(filename, meta) {
  if (meta && meta.type) return meta.type;
  const base = filename.replace(/\.sdoc$/i, "");
  const prefix = base.split("-")[0].toLowerCase();
  if (KNOWN_TYPES.includes(prefix)) return prefix;
  return null;
}

function slugify(text) {
  return text
    .replace(/[*~`_]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getDocumentScope(nodes) {
  if (nodes.length === 1 && nodes[0].type === "scope" && nodes[0].children) {
    return nodes[0];
  }
  return null;
}

function getContentScopes(nodes) {
  const doc = getDocumentScope(nodes);
  const children = doc ? doc.children : nodes;
  return children.filter(
    (n) => n.type === "scope" && (!n.id || (n.id.toLowerCase() !== "meta" && n.id.toLowerCase() !== "about"))
  );
}

function collectPlainText(nodes) {
  const parts = [];
  for (const node of nodes) {
    if (node.type === "paragraph") {
      parts.push(node.text);
    } else if (node.type === "list") {
      for (const item of node.items || []) {
        if (item.title) parts.push(item.title);
        if (item.children) parts.push(collectPlainText(item.children));
      }
    } else if (node.type === "scope" && node.children) {
      parts.push(collectPlainText(node.children));
    } else if (node.type === "code" && node.content) {
      parts.push(node.content);
    } else if (node.type === "blockquote" && node.text) {
      parts.push(node.text);
    } else if (node.type === "table") {
      if (node.headers) parts.push(node.headers.join(" | "));
      if (node.rows) {
        for (const row of node.rows) parts.push(row.join(" | "));
      }
    }
  }
  return parts.filter(Boolean).join("\n\n");
}

function firstParagraphPreview(nodes, maxLen) {
  for (const node of nodes) {
    if (node.type === "paragraph" && node.text) {
      const text = node.text.trim();
      if (text.length <= maxLen) return text;
      const truncated = text.substring(0, maxLen);
      const lastSpace = truncated.lastIndexOf(" ");
      return (lastSpace > maxLen * 0.5 ? truncated.substring(0, lastSpace) : truncated) + "...";
    }
  }
  return "";
}

/**
 * Recursively collect all tagged (has @id) scope nodes from the content tree.
 * Skips @meta and @about. Used for deep section discovery — lets MCP clients
 * find sections nested inside top-level scopes (e.g. @pass-terminology inside
 * @pedantic-review inside @writing).
 */
function getAllTaggedScopes(nodes) {
  const result = [];
  function walk(nodeList) {
    for (const node of nodeList) {
      if (node.type === "scope" && node.hasHeading) {
        const id = (node.id || "").toLowerCase();
        if (id !== "meta" && id !== "about") {
          result.push(node);
        }
        if (node.children) walk(node.children);
      }
    }
  }
  const doc = getDocumentScope(nodes);
  walk(doc ? doc.children : nodes);
  return result;
}

function listSections(nodes) {
  return getAllTaggedScopes(nodes).map((node) => ({
    id: node.id || null,
    derivedId: slugify(node.title),
    title: node.title,
    scopeType: node.scopeType || null,
    preview: firstParagraphPreview(node.children || [], 100)
  }));
}

function collectDataBlocks(children) {
  const data = [];
  for (const child of children) {
    if (child.type === "code" && child.dataFlag && child.data !== undefined) {
      data.push(child.data);
    }
  }
  return data;
}

function extractSection(nodes, sectionId) {
  const scopes = getAllTaggedScopes(nodes);

  function buildResult(node) {
    const data = collectDataBlocks(node.children || []);
    const result = { title: node.title, content: collectPlainText(node.children || []) };
    if (data.length) result.data = data;
    return result;
  }

  // First pass: match explicit @id (case-sensitive)
  for (const node of scopes) {
    if (node.id && node.id === sectionId) {
      return buildResult(node);
    }
  }

  // Second pass: match derived slug (case-insensitive)
  const lowerTarget = sectionId.toLowerCase();
  for (const node of scopes) {
    if (slugify(node.title).toLowerCase() === lowerTarget) {
      return buildResult(node);
    }
  }

  return null;
}

function extractDataBlocks(nodes) {
  const results = [];
  function walk(nodeList, scopeId, scopeType, scopeTitle) {
    for (const node of nodeList) {
      if (node.type === "code" && node.dataFlag && node.data !== undefined) {
        results.push({
          scopeId: scopeId || null,
          scopeType: scopeType || null,
          scopeTitle: scopeTitle || null,
          data: node.data
        });
      }
      if (node.type === "scope") {
        walk(node.children || [], node.id, node.scopeType, node.title);
      }
      if (node.type === "list" && node.items) {
        for (const item of node.items) {
          if (item.type === "scope") {
            walk(item.children || [], item.id, item.scopeType, item.title);
          }
        }
      }
    }
  }
  walk(nodes, null, null, null);
  return results;
}

function extractAbout(nodes) {
  const doc = getDocumentScope(nodes);
  const children = doc ? doc.children : nodes;

  for (const node of children) {
    if (node.type === "scope" && node.id && node.id.toLowerCase() === "about") {
      const texts = (node.children || [])
        .filter((c) => c.type === "paragraph")
        .map((c) => c.text.trim());
      return texts.length ? texts.join(" ") : null;
    }
  }
  return null;
}

// True when an @about scope has no meaningful content. Renderers use this to
// skip emitting an empty meta-section / callout. Whitespace-only paragraphs
// count as empty.
function isAboutEmpty(scope) {
  if (!scope || !scope.children || scope.children.length === 0) return true;
  return scope.children.every(
    (child) => child.type === "paragraph" && (!child.text || child.text.trim() === "")
  );
}

function collectAllIds(nodes) {
  const ids = new Set();
  function walk(nodeList) {
    for (const node of nodeList) {
      if (node.type === "scope") {
        if (node.id) ids.add(node.id);
        if (node.title) ids.add(slugify(node.title));
      }
      if (node.children) walk(node.children);
      if (node.type === "list" && node.items) {
        walk(node.items);
      }
    }
  }
  walk(nodes);
  return ids;
}

function collectInlineRefs(nodes) {
  const refs = [];
  const links = [];
  const citationRefs = [];

  function walkInlineNodes(inlineNodes, lineStart, lineEnd) {
    for (const node of inlineNodes) {
      if (node.type === "ref") {
        refs.push({ id: node.id, lineStart, lineEnd });
      } else if (node.type === "link") {
        links.push({ href: node.href, lineStart, lineEnd });
      } else if (node.type === "citation_ref") {
        for (const key of node.keys) {
          citationRefs.push({ key, lineStart, lineEnd });
        }
      }
      if (node.children) {
        walkInlineNodes(node.children, lineStart, lineEnd);
      }
    }
  }

  function processText(text, lineStart, lineEnd) {
    const inlineNodes = parseInline(text);
    walkInlineNodes(inlineNodes, lineStart, lineEnd);
  }

  function walk(nodeList) {
    for (const node of nodeList) {
      if (node.type === "paragraph" && node.text) {
        processText(node.text, node.lineStart, node.lineEnd);
      } else if (node.type === "blockquote" && node.paragraphs) {
        for (const para of node.paragraphs) {
          processText(para, node.lineStart, node.lineEnd);
        }
      } else if (node.type === "scope") {
        if (node.title) {
          processText(node.title, node.lineStart, node.lineStart);
        }
        if (node.children) walk(node.children);
      } else if (node.type === "list" && node.items) {
        walk(node.items);
      } else if (node.type === "table") {
        if (node.headers) {
          for (const cell of node.headers) {
            processText(cell, node.lineStart, node.lineEnd);
          }
        }
        if (node.rows) {
          for (const row of node.rows) {
            for (const cell of row) {
              processText(cell, node.lineStart, node.lineEnd);
            }
          }
        }
      }
      // Handle list items (no type field, but have title/children)
      if (!node.type) {
        if (node.title) processText(node.title, node.lineStart || 0, node.lineEnd || node.lineStart || 0);
        if (node.children) walk(node.children);
      }
    }
  }
  walk(nodes);
  return { refs, links, citationRefs };
}

function collectCitationDefinitions(nodes) {
  const defs = [];
  function walk(nodeList) {
    for (const node of nodeList) {
      if (node.type === "citations") {
        for (const entry of node.entries) {
          defs.push({ key: entry.key, lineStart: entry.lineStart, lineEnd: entry.lineEnd });
        }
      }
      if (node.children) walk(node.children);
      if (node.type === "list" && node.items) walk(node.items);
    }
  }
  walk(nodes);
  return defs;
}

function validateRefs(nodes, options = {}) {
  const ids = collectAllIds(nodes);
  const externalIds = options.externalIds || new Set();
  const { refs, links } = collectInlineRefs(nodes);
  const warnings = [];

  for (const ref of refs) {
    if (!ids.has(ref.id) && !externalIds.has(ref.id)) {
      warnings.push({
        type: "broken-ref",
        id: ref.id,
        message: `Broken reference: @${ref.id} does not match any scope ID or title`,
        lineStart: ref.lineStart,
        lineEnd: ref.lineEnd
      });
    }
  }

  for (const link of links) {
    const href = link.href;
    if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href) || href.startsWith("#") || href.startsWith("data:")) {
      continue;
    }
    if (options.resolveFilePath) {
      const filePath = href.split("#")[0].split("?")[0];
      if (!filePath) continue;
      if (!options.resolveFilePath(filePath)) {
        warnings.push({
          type: "broken-link",
          href,
          message: `Broken link: file not found — ${href}`,
          lineStart: link.lineStart,
          lineEnd: link.lineEnd
        });
      }
    }
  }

  return warnings;
}

function validateCitations(nodes) {
  const { citationRefs } = collectInlineRefs(nodes);
  const defs = collectCitationDefinitions(nodes);
  const warnings = [];

  const definedKeys = new Set(defs.map((d) => d.key));
  const referencedKeys = new Set(citationRefs.map((r) => r.key));

  // Citation referenced but not defined
  for (const ref of citationRefs) {
    if (!definedKeys.has(ref.key)) {
      warnings.push({
        type: "broken-citation",
        key: ref.key,
        message: `Broken citation: [@${ref.key}] is not defined in any {[citations] block`,
        lineStart: ref.lineStart,
        lineEnd: ref.lineEnd
      });
    }
  }

  // Citation defined but never referenced
  for (const def of defs) {
    if (!referencedKeys.has(def.key)) {
      warnings.push({
        type: "unused-citation",
        key: def.key,
        message: `Unused citation: @${def.key} is defined but never referenced with [@${def.key}]`,
        lineStart: def.lineStart,
        lineEnd: def.lineEnd
      });
    }
  }

  return warnings;
}

async function resolveIncludes(nodes, resolverFn) {
  for (const node of nodes) {
    if (node.type === "code" && node.src) {
      try {
        let text = await resolverFn(node.src);
        if (node.lines) {
          const allLines = text.split("\n");
          text = allLines.slice(node.lines.start - 1, node.lines.end).join("\n");
        }
        node.text = text;
        // Re-parse JSON for :data blocks after include resolution
        if (node.dataFlag && node.lang === "json") {
          try {
            node.data = JSON.parse(node.text);
          } catch { /* leave node.data undefined — caller can check */ }
        }
      } catch (err) {
        node.text = `// Error: Could not read ${node.src} — ${err.message}`;
      }
    }
    if (node.children) {
      await resolveIncludes(node.children, resolverFn);
    }
    if (node.items) {
      await resolveIncludes(node.items, resolverFn);
    }
  }
}

module.exports = {
  SDOC_FORMAT_VERSION,
  parseSdoc,
  extractMeta,
  resolveIncludes,
  renderFragment,
  renderTextParagraphs,
  renderHtmlBody,
  renderHtmlDocumentFromParsed,
  renderHtmlDocument,
  formatSdoc,
  slugify,
  inferType,
  listSections,
  extractSection,
  extractAbout,
  isAboutEmpty,
  extractDataBlocks,
  KNOWN_SCOPE_TYPES,
  // Validation
  collectAllIds,
  collectInlineRefs,
  collectCitationDefinitions,
  validateRefs,
  validateCitations,
  // Low-level helpers for custom renderers (e.g. slide-renderer)
  parseInline,
  renderKatex,
  escapeHtml,
  escapeAttr,
  sanitizeSvg
};
