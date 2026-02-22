const COMMAND_HEADING = "#";
const COMMAND_SCOPE_OPEN = "{";
const COMMAND_SCOPE_CLOSE = "}";
const COMMAND_LIST_BULLET = "{[.]";
const COMMAND_LIST_NUMBER = "{[#]";
const COMMAND_TABLE = "{[table]";
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

  // Check for implicit root: first non-blank line is a heading, next non-blank is NOT a block opener
  const implicitRoot = detectImplicitRoot(cursor);
  if (implicitRoot) {
    const scopeStartLine = cursor.index + 1;
    const parsedHeading = parseHeading(cursor.current());
    cursor.next();
    const children = parseBlock(cursor, "normal");
    const rootNode = {
      type: "scope",
      title: parsedHeading.title,
      id: parsedHeading.id,
      children,
      hasHeading: true,
      lineStart: scopeStartLine,
      lineEnd: cursor.index
    };
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
        nextTrimmed === COMMAND_TABLE) {
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

    if (trimmed === COMMAND_TABLE) {
      flushParagraph();
      nodes.push(parseTableBlock(cursor));
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
  // Check longest openers first to avoid partial matches
  const openers = [COMMAND_TABLE, COMMAND_LIST_NUMBER, COMMAND_LIST_BULLET, COMMAND_SCOPE_OPEN];
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
    } else if (trailing.opener === COMMAND_TABLE) {
      children = [parseTableBody(cursor, scopeStartLine)];
    } else {
      children = parseBlock(cursor, "normal");
    }
    return {
      type: "scope",
      title: parsedHeading.title,
      id: parsedHeading.id,
      children,
      hasHeading: true,
      lineStart: scopeStartLine,
      lineEnd: cursor.index
    };
  }

  const parsedHeading = parseHeading(headingLine);
  const blockResult = parseScopeBlock(cursor);

  if (blockResult.blockType === "braceless") {
    const children = parseBracelessBlock(cursor);
    return {
      type: "scope",
      title: parsedHeading.title,
      id: parsedHeading.id,
      children,
      hasHeading: true,
      lineStart: scopeStartLine,
      lineEnd: cursor.index
    };
  }

  if (blockResult.blockType === "list") {
    return {
      type: "scope",
      title: parsedHeading.title,
      id: parsedHeading.id,
      children: [blockResult.children],
      hasHeading: true,
      lineStart: scopeStartLine,
      lineEnd: cursor.index
    };
  }

  return {
    type: "scope",
    title: parsedHeading.title,
    id: parsedHeading.id,
    children: blockResult.children,
    hasHeading: true,
    lineStart: scopeStartLine,
    lineEnd: cursor.index
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

    if (trimmed === COMMAND_TABLE) {
      flushParagraph();
      nodes.push(parseTableBlock(cursor));
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

    if (trimmed === COMMAND_TABLE) {
      return { blockType: "normal", children: [parseTableBlock(cursor)] };
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
  if (trimmed === COMMAND_TABLE) return false;
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

  if (trailing) {
    const parsed = parseHeadingText(trailing.text);
    cursor.next();

    let children;
    if (trailing.opener === COMMAND_LIST_BULLET || trailing.opener === COMMAND_LIST_NUMBER) {
      const listBody = parseListBody(cursor, trailing.opener === COMMAND_LIST_BULLET ? "bullet" : "number");
      children = [listBody];
    } else if (trailing.opener === COMMAND_TABLE) {
      children = [parseTableBody(cursor, itemStartLine)];
    } else {
      children = parseBlock(cursor, "normal");
    }

    return {
      type: "scope",
      title: parsed.title,
      id: parsed.id,
      children,
      hasHeading: true,
      shorthand: true,
      task: task ? { checked: task.checked } : undefined,
      lineStart: itemStartLine,
      lineEnd: cursor.index
    };
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
    return {
      type: "scope",
      title: parsed.title,
      id: parsed.id,
      children: [],
      hasHeading: true,
      shorthand: true,
      task: task ? { checked: task.checked } : undefined,
      lineStart: itemStartLine,
      lineEnd: cursor.index
    };
  }

  if (block.blockType === "list") {
    return {
      type: "scope",
      title: parsed.title,
      id: parsed.id,
      children: [block.children],
      hasHeading: true,
      shorthand: true,
      task: task ? { checked: task.checked } : undefined,
      lineStart: itemStartLine,
      lineEnd: cursor.index
    };
  }

  return {
    type: "scope",
    title: parsed.title,
    id: parsed.id,
    children: block.children,
    hasHeading: true,
    shorthand: true,
    task: task ? { checked: task.checked } : undefined,
    lineStart: itemStartLine,
    lineEnd: cursor.index
  };
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
  cursor.next();
  return parseTableBody(cursor, tableStartLine);
}

function parseTableBody(cursor, tableStartLine) {
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

    const cells = trimmed.split("|").map((cell) => cell.trim());
    rows.push(cells);
    cursor.next();
  }

  const headers = rows.length > 0 ? rows[0] : [];
  const body = rows.slice(1);
  return { type: "table", headers, rows: body, lineStart: tableStartLine, lineEnd: cursor.index };
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

    if (trimmed === COMMAND_TABLE) {
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

function parseCodeBlock(cursor) {
  const codeStartLine = cursor.index + 1;
  const line = cursor.current();
  const trimmedLeft = line.replace(/^\s+/, "");
  const fenceMatch = trimmedLeft.match(/^(`{3,})/);
  const fenceLen = fenceMatch ? fenceMatch[1].length : 3;
  const lang = trimmedLeft.slice(fenceLen).trim() || undefined;
  cursor.next();

  const contentLines = [];

  while (!cursor.eof()) {
    const nextLine = cursor.current();
    const nextTrimmed = nextLine.replace(/^\s+/, "");
    const closeMatch = nextTrimmed.match(/^(`{3,})\s*$/);
    if (closeMatch && closeMatch[1].length >= fenceLen) {
      cursor.next();
      return { type: "code", lang, text: contentLines.join("\n"), lineStart: codeStartLine, lineEnd: cursor.index };
    }
    contentLines.push(nextLine);
    cursor.next();
  }

  cursor.error("Unterminated code fence.");
  return { type: "code", lang, text: contentLines.join("\n"), lineStart: codeStartLine, lineEnd: cursor.index };
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

let _renderOptions = {};

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
  const children = scope.children.map((child) => renderNode(child, depth + 1)).join("\n");
  const rootClass = isTitleScope ? " sdoc-root" : "";
  const dl = dataLineAttrs(scope);

  if (scope.hasHeading === false) {
    return `<section class="sdoc-scope sdoc-scope-noheading${rootClass}"${dl}>${children}</section>`;
  }

  const idAttr = scope.id ? ` id="${escapeAttr(scope.id)}"` : "";
  const hasChildren = scope.children.length > 0;
  const toggle = hasChildren ? `<span class="sdoc-toggle"></span>` : "";
  const heading = `<h${level}${idAttr} class="sdoc-heading sdoc-depth-${level}"${dl}>${toggle}${renderInline(scope.title)}</h${level}>`;
  const childrenHtml = children ? `\n<div class="sdoc-scope-children">${children}</div>` : "";
  return `<section class="sdoc-scope${rootClass}">${heading}${childrenHtml}</section>`;
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

function renderTable(table) {
  const dl = dataLineAttrs(table);
  const headerCells = table.headers
    .map((cell) => `<th class="sdoc-table-th">${renderInline(cell)}</th>`)
    .join("");
  const thead = `<thead class="sdoc-table-head"><tr>${headerCells}</tr></thead>`;

  const bodyRows = table.rows
    .map((row) => {
      const cells = row
        .map((cell) => `<td class="sdoc-table-td">${renderInline(cell)}</td>`)
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("\n");
  const tbody = bodyRows ? `<tbody class="sdoc-table-body">${bodyRows}</tbody>` : "";

  return `<table class="sdoc-table"${dl}>${thead}\n${tbody}</table>`;
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
    case "code": {
      const langClass = node.lang ? ` class="language-${escapeAttr(node.lang)}"` : "";
      return `<pre class="sdoc-code"${dl}><code${langClass}>${escapeHtml(node.text)}</code></pre>`;
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
    return { nodes, meta: {} };
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

  if (doc) {
    // @meta was inside the document scope — strip it from children
    const filteredChildren = doc.children.filter((_, index) => index !== metaIndex);
    const stripped = { ...doc, children: filteredChildren };
    return { nodes: [stripped], meta };
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

  @media print {
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
  }
`;

function renderHtmlDocumentFromParsed(parsed, title, options = {}) {
  _renderOptions = options.renderOptions ?? {};
  const body = parsed.nodes
    .map((node, index) => {
      if (node.type === "scope" && index === 0) {
        return renderScope(node, 1, true);
      }
      return renderNode(node, 1);
    })
    .join("\n");
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
  const cssAppend = options.cssAppend ? `\n${options.cssAppend}` : "";
  const scriptTag = options.script ? `\n<script>${options.script}</script>` : "";

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
    ${confidentialHtml}
    ${headerHtml ? `<header class="sdoc-page-header">${headerHtml}</header>` : ""}
    <div class="sdoc-main">
      <main>
        ${errorHtml}
        ${body}
      </main>
    </div>
    ${footerContent ? `<footer class="sdoc-page-footer">${footerContent}</footer>` : ""}
  </div>${scriptTag}
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

    // Standalone opener: {, {[.], {[#], {[table]
    if (trimmed === COMMAND_SCOPE_OPEN ||
        trimmed === COMMAND_LIST_BULLET ||
        trimmed === COMMAND_LIST_NUMBER ||
        trimmed === COMMAND_TABLE) {
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

function listSections(nodes) {
  return getContentScopes(nodes).map((node) => ({
    id: node.id || null,
    derivedId: slugify(node.title),
    title: node.title,
    preview: firstParagraphPreview(node.children || [], 100)
  }));
}

function extractSection(nodes, sectionId) {
  const scopes = getContentScopes(nodes);

  // First pass: match explicit @id (case-sensitive)
  for (const node of scopes) {
    if (node.id && node.id === sectionId) {
      return { title: node.title, content: collectPlainText(node.children || []) };
    }
  }

  // Second pass: match derived slug (case-insensitive)
  const lowerTarget = sectionId.toLowerCase();
  for (const node of scopes) {
    if (slugify(node.title).toLowerCase() === lowerTarget) {
      return { title: node.title, content: collectPlainText(node.children || []) };
    }
  }

  return null;
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

module.exports = {
  parseSdoc,
  extractMeta,
  renderFragment,
  renderTextParagraphs,
  renderHtmlDocumentFromParsed,
  renderHtmlDocument,
  formatSdoc,
  slugify,
  inferType,
  listSections,
  extractSection,
  extractAbout,
  // Low-level helpers for custom renderers (e.g. slide-renderer)
  parseInline,
  escapeHtml,
  escapeAttr
};
