const {
  SDOC_FORMAT_VERSION,
  parseSdoc,
  extractMeta,
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
  stripAboutScopes,
  getDocumentScope,
  foldRootSiblings,
  SIGNPOST_IDS,
  EXPORT_HIDDEN_SIGNPOST_IDS,
  RESERVED_SCOPE_IDS,
  getSignpost,
  isSignpostEmpty,
  stripSignposts,
  hiddenSignposts,
  extractSignpost,
  extractSignposts,
  extractRelatedResources,
  resourceKind,
  extractReadingGuide,
  validateSignposts,
  fixSignpostOrder,
  RESERVED_ORDER,
  extractDataBlocks,
  KNOWN_SCOPE_TYPES,
  parseInline,
  renderKatex,
  collectAllIds,
  collectCitationDefinitions,
  validateRefs,
  validateCitations,
  sanitizeSvg,
  readableTextColor
} = require("../src/sdoc.js");
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log("  PASS: " + name); }
  catch (e) { fail++; console.log("  FAIL: " + name + " — " + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

// ============================================================
// An unclosed scope

test("a scope opened with a brace and never closed is an error", () => {
  // It used to end silently at EOF, which is the worst answer available: the
  // scopes after it parse as its children, so the document reports as clean
  // with the wrong tree, and nothing downstream can see it because everything
  // downstream reads the tree.
  const r = parseSdoc("# A @a {\n    # B @b {\n        x\n\n    # C @c {\n        y\n    }\n}\n");
  assert(r.errors.length === 1, "one error, got " + r.errors.length);
  assert(/never closed/.test(r.errors[0].message), r.errors[0].message);
  // The outermost scope is the one that reaches EOF unclosed: @b is closed by
  // the brace meant for @a. Which brace the author forgot cannot be known, so
  // the report names the scope that is demonstrably still open rather than
  // guessing at the one they meant.
  assert(r.errors[0].line === 1, "names the outermost unclosed scope, got line " + r.errors[0].line);
});

test("the error names the line the scope opened on, not the end of the file", () => {
  const r = parseSdoc("# A @a {\n    x\n}\n\n# B @b {\n    y\n");
  assert(r.errors.length === 1, "one error");
  assert(r.errors[0].line === 5, "line 5, got " + r.errors[0].line);
});

test("a well-formed document reports nothing", () => {
  const r = parseSdoc("# A @a {\n    # B @b {\n        x\n    }\n\n    # C @c {\n        y\n    }\n}\n");
  assert(r.errors.length === 0, "no errors: " + JSON.stringify(r.errors));
  assert(r.nodes[0].children.filter((c) => c.type === "scope").length === 2, "@b and @c are siblings");
});

test("a braceless scope still ends at EOF without complaint", () => {
  // A scope that never opened a brace is not missing one. This is the
  // distinction the check turns on, and the reason it is not simply counting.
  assert(parseSdoc("# A @a\n    Some content.\n").errors.length === 0, "braceless scope");
  assert(parseSdoc("# Title\n\nSome prose.\n").errors.length === 0, "implicit root");
  assert(parseSdoc("# A @a {\n    # B @b\n        text\n}\n").errors.length === 0, "braceless inside braced");
});

test("an unclosed scope no longer swallows the ones after it", () => {
  const bad = parseSdoc("# A @a {\n    # B @b {\n        x\n\n    # C @c {\n        y\n    }\n}\n");
  const b = bad.nodes[0].children.find((c) => c.id === "b");
  // The tree is still built so the error can be reported alongside content,
  // but the document is no longer silently accepted.
  assert(b && b.children.some((c) => c.id === "c"), "c nests under b, which is why this must be reported");
});


// ============================================================
console.log("--- Paragraphs ---");

test("single paragraph", () => {
  const r = parseSdoc("# Doc\n{\n  Hello world.\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].children[0].type === "paragraph");
  assert(r.nodes[0].children[0].text === "Hello world.");
});

test("two paragraphs separated by blank line", () => {
  const r = parseSdoc("# Doc\n{\n  First.\n\n  Second.\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].children.length === 2);
  assert(r.nodes[0].children[0].text === "First.");
  assert(r.nodes[0].children[1].text === "Second.");
});

test("multi-line paragraph joins lines", () => {
  const r = parseSdoc("# Doc\n{\n  Line one\n  line two\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].children[0].text === "Line one line two");
});

// ============================================================
console.log("\n--- Scopes ---");

test("basic scope with heading and body", () => {
  const r = parseSdoc("# Title\n{\n  Body.\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].type === "scope");
  assert(r.nodes[0].title === "Title");
  assert(r.nodes[0].hasHeading === true);
});

test("scope with @id", () => {
  const r = parseSdoc("# Title @my-id\n{\n  Body.\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].id === "my-id");
  assert(r.nodes[0].title === "Title");
});

test("nested scopes", () => {
  const r = parseSdoc("# Outer\n{\n  # Inner\n  {\n    Deep.\n  }\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].children[0].type === "scope");
  assert(r.nodes[0].children[0].title === "Inner");
});

test("headingless scope", () => {
  const r = parseSdoc("# Doc\n{\n  {\n    Grouped.\n  }\n}");
  assert(r.errors.length === 0);
  const inner = r.nodes[0].children[0];
  assert(inner.type === "scope");
  assert(inner.hasHeading === false);
});

test("inline block", () => {
  const r = parseSdoc("# Name\n{ John Doe }");
  assert(r.errors.length === 0);
  assert(r.nodes[0].children[0].text === "John Doe");
});

test("empty inline block", () => {
  const r = parseSdoc("# Empty\n{ }");
  assert(r.errors.length === 0);
  assert(r.nodes[0].children.length === 0);
});

// ============================================================
console.log("\n--- K&R Brace Style ---");

test("K&R heading scope", () => {
  const r = parseSdoc("# Title {\n  Content.\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].title === "Title");
  assert(r.nodes[0].children[0].text === "Content.");
});

test("K&R with @id", () => {
  const r = parseSdoc("# Title @myid {\n  Content.\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].id === "myid");
});

test("K&R bullet list", () => {
  const r = parseSdoc("# List {[.]\n  - A\n  - B\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].children[0].type === "list");
  assert(r.nodes[0].children[0].listType === "bullet");
});

test("K&R numbered list", () => {
  const r = parseSdoc("# Steps {[#]\n  1. First\n  2. Second\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].children[0].listType === "number");
});

test("K&R table", () => {
  const r = parseSdoc("# Data {[table]\n  Name | Age\n  Alice | 30\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].children[0].type === "table");
});

test("K&R on list item", () => {
  const r = parseSdoc("{[.]\n  - Item {\n    Body.\n  }\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].items[0].title === "Item");
  assert(r.nodes[0].items[0].children[0].text === "Body.");
});

test("K&R nested scopes", () => {
  const r = parseSdoc("# Outer {\n  # Inner {\n    Deep.\n  }\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].children[0].title === "Inner");
});

test("mixed K&R and Allman", () => {
  const r = parseSdoc("# A {\n  Content A.\n}\n# B\n{\n  Content B.\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].title === "A");
  assert(r.nodes[1].title === "B");
});

// ============================================================
console.log("\n--- Explicit Lists ---");

test("bullet list", () => {
  const r = parseSdoc("{[.]\n  - Apple\n  - Banana\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].type === "list");
  assert(r.nodes[0].listType === "bullet");
  assert(r.nodes[0].items.length === 2);
  assert(r.nodes[0].items[0].title === "Apple");
});

test("numbered list", () => {
  const r = parseSdoc("{[#]\n  1. First\n  2. Second\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].listType === "number");
  assert(r.nodes[0].items.length === 2);
});

test("list item with body block", () => {
  const r = parseSdoc("{[.]\n  - Item\n  {\n    Details.\n  }\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].items[0].title === "Item");
  assert(r.nodes[0].items[0].children[0].text === "Details.");
});

test("anonymous list items", () => {
  const r = parseSdoc("{[.]\n  {\n    Body only.\n  }\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].items.length === 1);
  assert(r.nodes[0].items[0].hasHeading === false);
});

test("task list checked", () => {
  const r = parseSdoc("{[.]\n  - [x] Done\n}");
  assert(r.errors.length === 0);
  const item = r.nodes[0].items[0];
  assert(item.task && item.task.checked === true);
  assert(item.title === "Done");
});

test("task list unchecked", () => {
  const r = parseSdoc("{[.]\n  - [ ] Pending\n}");
  assert(r.errors.length === 0);
  const item = r.nodes[0].items[0];
  assert(item.task && item.task.checked === false);
});

test("commas between list items are ignored", () => {
  const r = parseSdoc("{[.]\n  - A\n  ,\n  - B\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].items.length === 2);
});

// ============================================================
console.log("\n--- Implicit Lists ---");

test("implicit bullet list", () => {
  const r = parseSdoc("# Doc\n{\n  - One\n  - Two\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].children[0].type === "list");
  assert(r.nodes[0].children[0].listType === "bullet");
});

test("implicit numbered list", () => {
  const r = parseSdoc("# Doc\n{\n  1. First\n  2. Second\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].children[0].type === "list");
  assert(r.nodes[0].children[0].listType === "number");
});

test("implicit list item with body", () => {
  const r = parseSdoc("# Doc\n{\n  - Item\n  {\n    Body.\n  }\n}");
  assert(r.errors.length === 0);
  const item = r.nodes[0].children[0].items[0];
  assert(item.title === "Item");
  assert(item.children[0].text === "Body.");
});

// ============================================================
console.log("\n--- Tables ---");

test("basic table", () => {
  const r = parseSdoc("{[table]\n  Name | Age\n  Alice | 30\n  Bob | 25\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].type === "table");
  assert(r.nodes[0].headers.length === 2);
  assert(r.nodes[0].headers[0] === "Name");
  assert(r.nodes[0].headers[1] === "Age");
  assert(r.nodes[0].rows.length === 2);
  assert(r.nodes[0].rows[0][0] === "Alice");
});

test("table cell whitespace is trimmed", () => {
  const r = parseSdoc("{[table]\n  Name  |  Age \n   Alice  |  30 \n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].headers[0] === "Name");
  assert(r.nodes[0].rows[0][0] === "Alice");
  assert(r.nodes[0].rows[0][1] === "30");
});

test("escaped pipe in table cell", () => {
  const r = parseSdoc("{[table]\n  Expression | Result\n  \\|x\\| + \\|y\\| | sum of absolutes\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].headers.length === 2);
  assert(r.nodes[0].rows[0][0] === "|x| + |y|", "escaped pipes should become literal: " + r.nodes[0].rows[0][0]);
  assert(r.nodes[0].rows[0][1] === "sum of absolutes");
});

test("escaped pipe renders in HTML", () => {
  const html = renderHtmlDocument("# Doc {\n    {[table]\n        Expr | Value\n        \\|x\\| | 5\n    }\n}", "Test");
  assert(html.includes("|x|"), "escaped pipe should render as literal pipe");
  assert(html.includes("<td"), "should have table cells");
});

test("mix of escaped and unescaped pipes in table", () => {
  const r = parseSdoc("{[table]\n  A | B | C\n  a\\|b | c | d\n}");
  assert(r.nodes[0].rows[0].length === 3, "should have 3 cells");
  assert(r.nodes[0].rows[0][0] === "a|b", "escaped pipe in first cell: " + r.nodes[0].rows[0][0]);
  assert(r.nodes[0].rows[0][1] === "c");
  assert(r.nodes[0].rows[0][2] === "d");
});

// ============================================================
console.log("\n--- Blockquotes ---");

test("basic blockquote", () => {
  const r = parseSdoc("# Doc\n{\n  > A quote.\n  > Another line.\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].children[0].type === "blockquote");
  assert(r.nodes[0].children[0].paragraphs.length >= 1);
});

test("blockquote with blank line separating paragraphs", () => {
  const r = parseSdoc("# Doc\n{\n  > First.\n  >\n  > Second.\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].children[0].type === "blockquote");
  assert(r.nodes[0].children[0].paragraphs.length === 2);
});

// ============================================================
console.log("\n--- Code Blocks ---");

test("basic code block", () => {
  const r = parseSdoc("# Doc\n{\n  ```\n  hello\n  ```\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].children[0].type === "code");
  assert(r.nodes[0].children[0].text.includes("hello"));
});

test("code block with language tag", () => {
  const r = parseSdoc("# Doc\n{\n  ```javascript\n  const x = 1;\n  ```\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].children[0].lang === "javascript");
});

test("code block preserves raw content", () => {
  const r = parseSdoc("# Doc\n{\n  ```\n  # Not a heading\n  { not a brace }\n  @not-a-ref\n  ```\n}");
  assert(r.errors.length === 0);
  const text = r.nodes[0].children[0].text;
  assert(text.includes("# Not a heading"));
  assert(text.includes("{ not a brace }"));
  assert(text.includes("@not-a-ref"));
});

// ============================================================
console.log("\n--- Horizontal Rules ---");

test("horizontal rule with dashes", () => {
  const r = parseSdoc("# Doc\n{\n  Text.\n  ---\n  More text.\n}");
  assert(r.errors.length === 0);
  const types = r.nodes[0].children.map(c => c.type);
  assert(types.includes("hr"));
});

test("horizontal rule with asterisks", () => {
  const r = parseSdoc("# Doc\n{\n  ***\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].children[0].type === "hr");
});

test("horizontal rule with underscores", () => {
  const r = parseSdoc("# Doc\n{\n  ___\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].children[0].type === "hr");
});

// ============================================================
console.log("\n--- Inline Formatting ---");

test("emphasis", () => {
  const html = renderHtmlDocument("# Doc\n{\n  This is *emphasized*.\n}", "Test");
  assert(html.includes("<em>emphasized</em>"));
});

test("strong", () => {
  const html = renderHtmlDocument("# Doc\n{\n  This is **strong**.\n}", "Test");
  assert(html.includes("<strong>strong</strong>"));
});

test("strikethrough", () => {
  const html = renderHtmlDocument("# Doc\n{\n  This is ~~struck~~.\n}", "Test");
  assert(html.includes("<del>struck</del>"));
});

test("inline code", () => {
  const html = renderHtmlDocument("# Doc\n{\n  Use `console.log`.\n}", "Test");
  assert(html.includes("console.log</code>"));
});

// ============================================================
console.log("\n--- Links and Images ---");

test("markdown link", () => {
  const html = renderHtmlDocument("# Doc\n{\n  Visit [SDOC](https://example.com).\n}", "Test");
  assert(html.includes('href="https://example.com"'));
  assert(html.includes("SDOC"));
});

test("autolink http", () => {
  const html = renderHtmlDocument("# Doc\n{\n  See <https://example.com>.\n}", "Test");
  assert(html.includes('href="https://example.com"'));
});

test("autolink mailto", () => {
  const html = renderHtmlDocument("# Doc\n{\n  Email <mailto:hello@example.com>.\n}", "Test");
  assert(html.includes('href="mailto:hello@example.com"'));
});

test("bare URL autolink", () => {
  const html = renderHtmlDocument("# Doc\n{\n  See https://example.com for details.\n}", "Test");
  assert(html.includes('href="https://example.com"'), "bare URL should become a link");
  assert(html.includes(">https://example.com</a>"), "link text should be the URL");
});

test("bare URL strips trailing punctuation", () => {
  const html = renderHtmlDocument("# Doc\n{\n  Visit https://example.com.\n}", "Test");
  assert(html.includes('href="https://example.com"'), "trailing period should not be in URL");
});

test("bare URL stops at closing paren", () => {
  const html = renderHtmlDocument("# Doc\n{\n  (see https://example.com)\n}", "Test");
  assert(html.includes('href="https://example.com"'), "closing paren should not be in URL");
});

test("bare http URL autolink", () => {
  const html = renderHtmlDocument("# Doc\n{\n  See http://example.com for info.\n}", "Test");
  assert(html.includes('href="http://example.com"'), "http URLs should also autolink");
});

test("bare URL with path", () => {
  const html = renderHtmlDocument("# Doc\n{\n  See https://example.com/path/to/page?q=1&r=2#anchor.\n}", "Test");
  assert(html.includes('href="https://example.com/path/to/page?q=1&amp;r=2#anchor"'), "URL with path, query, and fragment should work");
});

test("image", () => {
  const html = renderHtmlDocument("# Doc\n{\n  ![Alt text](image.png)\n}", "Test");
  assert(html.includes('src="image.png"'));
  assert(html.includes('alt="Alt text"'));
});

// ============================================================
console.log("\n--- References ---");

test("reference renders as link", () => {
  const html = renderHtmlDocument("# Section @sec\n{\n  Hello.\n}\n# Other\n{\n  See @sec.\n}", "Test");
  assert(html.includes('href="#sec"'));
  assert(html.includes("@sec"));
});

test("scope gets id attribute", () => {
  const html = renderHtmlDocument("# Section @my-section\n{\n  Content.\n}", "Test");
  assert(html.includes('id="my-section"'));
});

// ============================================================
console.log("\n--- Escaping ---");

test("escaped hash is not a heading", () => {
  const r = parseSdoc("# Doc\n{\n  \\# Not a heading.\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].children[0].type === "paragraph");
});

test("escaped brace in text", () => {
  const html = renderHtmlDocument("# Doc\n{\n  A \\{ brace.\n}", "Test");
  assert(html.includes("{"));
});

test("escaped at-sign", () => {
  const html = renderHtmlDocument("# Doc\n{\n  Email: user\\@host.\n}", "Test");
  assert(html.includes("@"));
  // Should NOT be treated as a reference link
  assert(!html.includes('class="sdoc-ref"'));
});

test("escaped blockquote", () => {
  const r = parseSdoc("# Doc\n{\n  \\> Not a quote.\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].children[0].type === "paragraph");
});

// ============================================================
console.log("\n--- Meta Scope Extraction ---");

test("extractMeta returns meta and remaining nodes", () => {
  const r = parseSdoc("# Meta @meta\n{\n  # Style\n  { custom.css }\n}\n# Body\n{\n  Content.\n}");
  assert(r.errors.length === 0);
  const result = extractMeta(r.nodes);
  assert(result.meta !== null);
  assert(result.meta.stylePath === "custom.css");
  // Meta scope should be removed from nodes
  assert(result.nodes.length === 1);
  assert(result.nodes[0].title === "Body");
});

test("extractMeta with styleAppend", () => {
  const r = parseSdoc("# Meta @meta\n{\n  # StyleAppend\n  { overrides.css }\n}\n# Body\n{\n  Hi.\n}");
  const result = extractMeta(r.nodes);
  assert(result.meta.styleAppendPath === "overrides.css");
});

test("extractMeta with header and footer", () => {
  const r = parseSdoc("# Meta @meta\n{\n  # Header\n  { My Header }\n  # Footer\n  { My Footer }\n}\n# Body\n{\n  Hi.\n}");
  const result = extractMeta(r.nodes);
  assert(result.meta.headerNodes.length > 0);
  assert(result.meta.footerNodes.length > 0);
});

test("extractMeta with no meta scope passes through", () => {
  const r = parseSdoc("# Doc\n{\n  Content.\n}");
  const result = extractMeta(r.nodes);
  assert(result.nodes.length === 1);
  assert(result.meta.stylePath === null || result.meta.stylePath === undefined);
});

// ============================================================
console.log("\n--- HTML Rendering ---");

test("renderHtmlDocument produces complete HTML", () => {
  const html = renderHtmlDocument("# Hello\n{\n  World.\n}", "Test Title");
  assert(html.includes("<!DOCTYPE html>") || html.includes("<html"));
  assert(html.includes("Hello"));
  assert(html.includes("World"));
  assert(html.includes("<style>"));
});

test("renderHtmlDocumentFromParsed works", () => {
  const parsed = parseSdoc("# Hello\n{\n  World.\n}");
  const metaResult = extractMeta(parsed.nodes);
  const html = renderHtmlDocumentFromParsed(
    { nodes: metaResult.nodes, errors: parsed.errors },
    "Test",
    { meta: metaResult.meta }
  );
  assert(html.includes("Hello"));
  assert(html.includes("World"));
});

test("renderFragment produces HTML without wrapper", () => {
  const r = parseSdoc("# Title\n{\n  Body.\n}");
  const html = renderFragment(r.nodes, 2);
  assert(html.includes("Title"));
  assert(html.includes("Body"));
  assert(!html.includes("<!DOCTYPE"));
});

test("renderTextParagraphs renders inline formatting", () => {
  const html = renderTextParagraphs("Hello *world*.");
  assert(html.includes("<em>world</em>"));
});

test("renderTextParagraphs handles multiple paragraphs", () => {
  const html = renderTextParagraphs("First.\n\nSecond.");
  assert(html.includes("First."));
  assert(html.includes("Second."));
});

test("cssOverride replaces default style", () => {
  const html = renderHtmlDocument("# Doc\n{\n  Hi.\n}", "Test", {
    cssOverride: "body { color: red; }"
  });
  assert(html.includes("color: red"));
});

test("cssAppend is added after base style", () => {
  const html = renderHtmlDocument("# Doc\n{\n  Hi.\n}", "Test", {
    cssAppend: ".custom { color: blue; }"
  });
  assert(html.includes("color: blue"));
});

test("config header and footer render", () => {
  const html = renderHtmlDocument("# Doc\n{\n  Hi.\n}", "Test", {
    config: { header: "My Header", footer: "My Footer" }
  });
  assert(html.includes("My Header"));
  assert(html.includes("My Footer"));
});

test("data-line attributes are present", () => {
  const html = renderHtmlDocument("# Title\n{\n  Content.\n}", "Test");
  assert(html.includes('data-line="'));
});

test("table renders as HTML table", () => {
  const html = renderHtmlDocument("# Doc\n{\n  {[table]\n    Name | Age\n    Alice | 30\n  }\n}", "Test");
  assert(html.includes("<table"));
  assert(html.includes("<th"));
  assert(html.includes("Alice"));
});

test("blockquote renders as HTML blockquote", () => {
  const html = renderHtmlDocument("# Doc\n{\n  > A quote.\n}", "Test");
  assert(html.includes("<blockquote"));
  assert(html.includes("A quote."));
});

test("code block renders as pre+code", () => {
  const html = renderHtmlDocument("# Doc\n{\n  ```js\n  const x = 1;\n  ```\n}", "Test");
  assert(html.includes("<pre"));
  assert(html.includes("<code"));
  assert(html.includes("const x = 1;"));
});

test("code block has copy button", () => {
  const html = renderHtmlDocument("# Doc\n{\n  ```js\n  const x = 1;\n  ```\n}", "Test");
  assert(html.includes("sdoc-copy-btn"), "should have copy button");
  assert(html.includes("sdoc-code-wrap"), "should have code wrapper div");
});

test("mermaid block does not have copy button", () => {
  const { nodes } = parseSdoc("# Doc {\n    ```mermaid\n    graph LR\n    ```\n}");
  const html = renderFragment(nodes, 2);
  assert(!html.includes("sdoc-copy-btn"), "mermaid should not have copy button");
});

test("horizontal rule renders as hr", () => {
  const html = renderHtmlDocument("# Doc\n{\n  ---\n}", "Test");
  assert(html.includes("<hr"));
});

test("task list renders checkboxes", () => {
  const html = renderHtmlDocument("# Doc\n{\n  {[.]\n    - [x] Done\n    - [ ] Todo\n  }\n}", "Test");
  assert(html.includes("checked"));
  assert(html.includes("checkbox"));
});

test("scope heading toggle is present", () => {
  const html = renderHtmlDocument("# Doc\n{\n  # Child\n  {\n    Nested.\n  }\n}", "Test");
  assert(html.includes("sdoc-toggle"));
});

// ============================================================
console.log("\n--- @about HTML rendering ---");

test("bare @about renders with sdoc-meta-section class and content (preview-style)", () => {
  // Renderer hides @about by default, so opt in to verify the meta-section emission.
  const html = renderHtmlDocument("# Doc\n{\n  @about\n  {\n    A short summary.\n  }\n  # Body\n  {\n    Content.\n  }\n}", "Test", { includeAbout: true });
  assert(html.includes("sdoc-meta-section"), "should include sdoc-meta-section class");
  assert(html.includes("A short summary."), "about content should be rendered when includeAbout: true");
  // Bare @about now gets a synthetic "About" heading instead of rendering headingless.
  // Check the element itself, not just the class string (which also appears in inlined CSS).
  assert(!/<section [^>]*sdoc-scope-noheading[^>]*>/.test(html), "bare @about should no longer render as a noheading section");
});

test("heading-form @about renders with sdoc-meta-section class and content (preview-style)", () => {
  const html = renderHtmlDocument("# Doc\n{\n  # About @about\n  {\n    Description here.\n  }\n  # Body\n  {\n    Content.\n  }\n}", "Test", { includeAbout: true });
  assert(html.includes("sdoc-meta-section"), "should include sdoc-meta-section class");
  assert(html.includes("Description here."), "about content should be rendered when includeAbout: true");
  assert(/<h\d[^>]*>(?:<span class="sdoc-toggle"[^>]*><\/span>)?About<\/h\d>/.test(html), "About heading should be emitted");
});

test("@About heading-form with mixed-case id still gets meta-section class (preview-style)", () => {
  const html = renderHtmlDocument("# Doc\n{\n  # About @About\n  {\n    Mixed case id.\n  }\n}", "Test", { includeAbout: true });
  assert(html.includes("sdoc-meta-section"), "case-insensitive @About should get meta-section class");
  assert(html.includes("Mixed case id."));
});

// --- @about default heading title ---

const ABOUT_TITLE_HEADING = /<h\d[^>]*\bid="about"[^>]*>(?:<span class="sdoc-toggle"[^>]*><\/span>)?([^<]+)<\/h\d>/;

test("@about with no title defaults to \"About\" heading", () => {
  const html = renderHtmlDocument("# Doc\n{\n  @about\n  {\n    Summary.\n  }\n}", "Test", { includeAbout: true });
  const m = html.match(ABOUT_TITLE_HEADING);
  assert(m, "@about should produce a heading element with id=\"about\"");
  assert(m[1] === "About", "default title should be \"About\", got: " + m[1]);
  assert(html.includes("Summary."), "content should still render");
});

test("@about with explicit \"About\" title renders \"About\" heading", () => {
  const html = renderHtmlDocument("# Doc\n{\n  # About @about\n  {\n    Summary.\n  }\n}", "Test", { includeAbout: true });
  const m = html.match(ABOUT_TITLE_HEADING);
  assert(m, "@about should produce a heading element with id=\"about\"");
  assert(m[1] === "About", "explicit title should render as \"About\", got: " + m[1]);
});

test("@about with custom title preserves the custom title", () => {
  const html = renderHtmlDocument("# Doc\n{\n  # Document Discovery @about\n  {\n    Summary.\n  }\n}", "Test", { includeAbout: true });
  const m = html.match(ABOUT_TITLE_HEADING);
  assert(m, "@about should produce a heading element with id=\"about\"");
  assert(m[1] === "Document Discovery", "custom title should NOT be replaced with default, got: " + m[1]);
});

test("empty bare @about renders nothing (no meta-section)", () => {
  const html = renderHtmlBody("# Doc\n{\n  @about\n  {\n  }\n  # Body\n  {\n    Content.\n  }\n}");
  assert(!html.includes("sdoc-meta-section"), "empty @about should not emit meta-section wrapper");
  assert(html.includes("Body"), "rest of document should still render");
});

test("empty heading-form @about renders nothing", () => {
  const html = renderHtmlBody("# Doc\n{\n  # About @about\n  {\n  }\n  # Body\n  {\n    Content.\n  }\n}");
  assert(!html.includes("sdoc-meta-section"), "empty @about should not emit meta-section wrapper");
  assert(!/<h\d[^>]*>(?:<span class="sdoc-toggle"[^>]*><\/span>)?About<\/h\d>/.test(html), "About heading should not be emitted for empty scope");
  assert(html.includes("Body"));
});

test("whitespace-only @about renders nothing", () => {
  const html = renderHtmlBody("# Doc\n{\n  @about\n  {\n     \n  \t  \n  }\n  # Body\n  {\n    Content.\n  }\n}");
  assert(!html.includes("sdoc-meta-section"), "whitespace-only @about should be treated as empty");
  assert(html.includes("Body"));
});

test("@about with non-blank content renders meta-section when includeAbout: true", () => {
  const html = renderHtmlBody("# Doc\n{\n  @about\n  {\n    Has content.\n  }\n  # Body\n  {\n    More.\n  }\n}", { includeAbout: true });
  assert(html.includes("sdoc-meta-section"));
  assert(html.includes("Has content."));
});

test("isAboutEmpty: no children → empty", () => {
  assert(isAboutEmpty({ children: [] }) === true);
});

test("isAboutEmpty: missing children → empty", () => {
  assert(isAboutEmpty({}) === true);
  assert(isAboutEmpty(null) === true);
});

test("isAboutEmpty: paragraph with content → not empty", () => {
  assert(isAboutEmpty({ children: [{ type: "paragraph", text: "Hi." }] }) === false);
});

test("isAboutEmpty: whitespace-only paragraph → empty", () => {
  assert(isAboutEmpty({ children: [{ type: "paragraph", text: "   \t  " }] }) === true);
});

test("isAboutEmpty: mix of whitespace paragraphs → empty", () => {
  assert(isAboutEmpty({ children: [
    { type: "paragraph", text: " " },
    { type: "paragraph", text: "" }
  ] }) === true);
});

test("isAboutEmpty: non-paragraph child (list) → not empty", () => {
  assert(isAboutEmpty({ children: [{ type: "list", items: [] }] }) === false);
});

// ============================================================
console.log("\n--- includeAbout option (export hides @about) ---");

const ABOUT_SRC = "# Doc\n{\n  @about\n  {\n    Discovery summary text.\n  }\n  # Body\n  {\n    Real content.\n  }\n}";

function hasAboutElement(html) {
  // Match the actual <section> element — the class string also appears in the
  // inlined CSS, so a substring check would give false positives.
  return /<section [^>]*sdoc-meta-section[^>]*>/.test(html);
}

test("renderHtmlDocument default hides @about (export-shape output)", () => {
  const html = renderHtmlDocument(ABOUT_SRC, "Test");
  assert(!hasAboutElement(html), "default should NOT render the meta-section element");
  assert(!html.includes("Discovery summary text."), "@about content should be stripped by default");
  assert(html.includes("Real content."), "rest of the document still renders");
});

test("renderHtmlDocument with explicit includeAbout: false matches default", () => {
  const html = renderHtmlDocument(ABOUT_SRC, "Test", { includeAbout: false });
  assert(!hasAboutElement(html), "no meta-section element should be emitted");
  assert(!html.includes("Discovery summary text."));
  assert(html.includes("Real content."));
});

test("renderHtmlDocument with includeAbout: true keeps @about (preview path)", () => {
  const html = renderHtmlDocument(ABOUT_SRC, "Test", { includeAbout: true });
  assert(hasAboutElement(html));
  assert(html.includes("Discovery summary text."));
});

test("renderHtmlBody respects includeAbout option", () => {
  const bodyDefault = renderHtmlBody(ABOUT_SRC);
  const bodyOptIn = renderHtmlBody(ABOUT_SRC, { includeAbout: true });
  assert(!bodyDefault.includes("sdoc-meta-section"), "default hides about");
  assert(bodyOptIn.includes("sdoc-meta-section"), "opt-in keeps about");
  assert(bodyDefault.includes("Real content."), "rest of doc still renders even when about is hidden");
});

test("stripAboutScopes removes top-level @about", () => {
  const r = parseSdoc(ABOUT_SRC);
  const stripped = stripAboutScopes(r.nodes);
  function hasAbout(nodes) {
    return nodes.some((n) =>
      (n.type === "scope" && n.id && n.id.toLowerCase() === "about")
      || (n.children && hasAbout(n.children))
    );
  }
  assert(!hasAbout(stripped), "no @about scope should remain after stripping");
});

test("stripAboutScopes removes the top-level @about and keeps a nested one, an ordinary scope", () => {
  const r = parseSdoc("# Doc\n{\n  @about\n  {\n    Top.\n  }\n  # Inner\n  {\n    # About @about\n    {\n      Nested.\n    }\n    Body.\n  }\n}");
  const doc = stripAboutScopes(r.nodes)[0];
  assert(!doc.children.some((n) => n.id === "about"), "top-level @about removed");
  const inner = doc.children.find((n) => n.title === "Inner");
  assert(inner.children.some((n) => n.id === "about"), "nested @about kept");
});

test("stripAboutScopes preserves non-about siblings unchanged", () => {
  const r = parseSdoc(ABOUT_SRC);
  const stripped = stripAboutScopes(r.nodes);
  // Top-level Doc scope should still have its non-about child (Body).
  const doc = stripped.find((n) => n.type === "scope" && n.title === "Doc");
  assert(doc, "Doc scope should still be present");
  const body = doc.children.find((n) => n.type === "scope" && n.title === "Body");
  assert(body, "Body scope should still be present after stripping @about");
});

test("stripAboutScopes does not mutate input nodes", () => {
  const r = parseSdoc(ABOUT_SRC);
  const before = JSON.stringify(r.nodes);
  stripAboutScopes(r.nodes);
  assert(JSON.stringify(r.nodes) === before, "input AST should be unchanged");
});

// ============================================================
console.log("\n--- Error Collection ---");

test("unclosed scope parses gracefully (EOF as implicit close)", () => {
  const r = parseSdoc("# Doc\n{");
  // Parser treats EOF as implicit close — no errors, scope is created
  assert(r.nodes.length === 1);
  assert(r.nodes[0].title === "Doc");
});

test("unexpected closing brace handled gracefully", () => {
  const r = parseSdoc("# Doc\n{\n  Content.\n}\n}");
  assert(r.nodes.length >= 1);
});

test("unclosed nested scopes parse gracefully", () => {
  const r = parseSdoc("# A\n{\n# B\n{");
  // Parser treats EOF as implicit close for both
  assert(r.nodes.length >= 1);
});

// ============================================================
console.log("\n--- Edge Cases ---");

test("empty document", () => {
  const r = parseSdoc("");
  assert(r.errors.length === 0);
  assert(r.nodes.length === 0);
});

test("whitespace-only document", () => {
  const r = parseSdoc("   \n  \n   ");
  assert(r.errors.length === 0);
  assert(r.nodes.length === 0);
});

test("multiple top-level scopes", () => {
  const r = parseSdoc("# A\n{\n  One.\n}\n# B\n{\n  Two.\n}");
  assert(r.errors.length === 0);
  assert(r.nodes.length === 2);
});

test("deeply nested scopes", () => {
  const r = parseSdoc("# L1\n{\n  # L2\n  {\n    # L3\n    {\n      # L4\n      {\n        Deep.\n      }\n    }\n  }\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].children[0].children[0].children[0].children[0].text === "Deep.");
});

test("all project docs parse cleanly", () => {
  const docsDir = path.join(__dirname, "..", "docs");
  const projectDir = path.join(__dirname, "..", "lexica");
  const examplesDir = path.join(__dirname, "..", "examples");
  const dirs = [docsDir, projectDir, examplesDir];
  let fileCount = 0;
  for (const dir of dirs) {
    walkSdocFiles(dir, (fp) => {
      const text = fs.readFileSync(fp, "utf-8");
      const r = parseSdoc(text);
      assert(r.errors.length === 0, fp + " had errors: " + JSON.stringify(r.errors));
      fileCount++;
    });
  }
  assert(fileCount > 0, "no .sdoc files found");
});

function walkSdocFiles(dir, callback) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSdocFiles(full, callback);
    } else if (entry.name.endsWith(".sdoc")) {
      callback(full);
    }
  }
}

// ============================================================
console.log("\n--- Braceless Leaf Scopes ---");

test("braceless scope with paragraph terminated by sibling heading", () => {
  // Inside an explicit parent, braceless children become siblings
  const r = parseSdoc("# Parent\n{\n  # A\n  Paragraph in A.\n\n  # B\n  {\n    Content B.\n  }\n}");
  assert(r.errors.length === 0);
  const children = r.nodes[0].children;
  assert(children.length === 2, "Expected 2 children, got " + children.length);
  assert(children[0].title === "A");
  assert(children[0].children[0].type === "paragraph");
  assert(children[0].children[0].text === "Paragraph in A.");
  assert(children[1].title === "B");
  assert(children[1].children[0].text === "Content B.");
});

test("braceless scope with code block", () => {
  const r = parseSdoc("# Parent\n{\n  # Code\n  ```js\n  const x = 1;\n  ```\n  # Next\n  { done }\n}");
  assert(r.errors.length === 0);
  const children = r.nodes[0].children;
  assert(children[0].title === "Code");
  assert(children[0].children[0].type === "code");
  assert(children[0].children[0].lang === "js");
  assert(children[1].title === "Next");
});

test("braceless scope with implicit list", () => {
  const r = parseSdoc("# Parent\n{\n  # Items\n  - One\n  - Two\n\n  # Other\n  { text }\n}");
  assert(r.errors.length === 0);
  const children = r.nodes[0].children;
  assert(children[0].title === "Items");
  assert(children[0].children[0].type === "list");
  assert(children[0].children[0].items.length === 2);
  assert(children[1].title === "Other");
});

test("braceless scope terminated by } (parent close)", () => {
  const r = parseSdoc("# Outer\n{\n  # Inner\n  Braceless inner content.\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].title === "Outer");
  assert(r.nodes[0].children[0].title === "Inner");
  assert(r.nodes[0].children[0].children[0].type === "paragraph");
  assert(r.nodes[0].children[0].children[0].text === "Braceless inner content.");
});

test("braceless scope terminated by EOF", () => {
  const r = parseSdoc("# Only\nJust some text.");
  assert(r.errors.length === 0);
  assert(r.nodes[0].title === "Only");
  assert(r.nodes[0].children[0].text === "Just some text.");
});

test("multiple braceless siblings inside explicit parent", () => {
  const r = parseSdoc("# Parent\n{\n  # A\n  Content A.\n\n  # B\n  Content B.\n\n  # C\n  Content C.\n}");
  assert(r.errors.length === 0);
  const children = r.nodes[0].children;
  assert(children.length === 3, "Expected 3 children, got " + children.length);
  assert(children[0].title === "A");
  assert(children[0].children[0].text === "Content A.");
  assert(children[1].title === "B");
  assert(children[1].children[0].text === "Content B.");
  assert(children[2].title === "C");
  assert(children[2].children[0].text === "Content C.");
});

test("mix of braceless and explicit scopes", () => {
  const r = parseSdoc("# Parent\n{\n  # Braceless\n  Some text.\n\n  # Explicit\n  {\n    With braces.\n  }\n\n  # Another Braceless\n  More text.\n}");
  assert(r.errors.length === 0);
  const children = r.nodes[0].children;
  assert(children.length === 3, "Expected 3 children, got " + children.length);
  assert(children[0].title === "Braceless");
  assert(children[0].children[0].text === "Some text.");
  assert(children[1].title === "Explicit");
  assert(children[1].children[0].text === "With braces.");
  assert(children[2].title === "Another Braceless");
  assert(children[2].children[0].text === "More text.");
});

test("multiple braceless siblings at top level (implicit root)", () => {
  // At top level, first braceless heading becomes implicit root, rest are its children
  const r = parseSdoc("# Doc\n\n# A\nContent A.\n\n# B\nContent B.");
  assert(r.errors.length === 0);
  assert(r.nodes.length === 1);
  assert(r.nodes[0].title === "Doc");
  const children = r.nodes[0].children;
  assert(children.length === 2, "Expected 2 children, got " + children.length);
  assert(children[0].title === "A");
  assert(children[1].title === "B");
});

test("braceless scope with blockquote", () => {
  const r = parseSdoc("# Quote\n> A quoted line.\n> Another line.\n\n# Next\n{ ok }");
  assert(r.errors.length === 0);
  assert(r.nodes[0].title === "Quote");
  assert(r.nodes[0].children[0].type === "blockquote");
});

test("braceless scope with HR", () => {
  const r = parseSdoc("# Section\nBefore.\n---\nAfter.\n\n# Next\n{ ok }");
  assert(r.errors.length === 0);
  assert(r.nodes[0].title === "Section");
  const types = r.nodes[0].children.map(c => c.type);
  assert(types.includes("hr"));
  assert(types.includes("paragraph"));
});

test("braceless scope with headingless scope inside", () => {
  const r = parseSdoc("# Outer\n{\n  Grouped.\n}\nMore text.\n\n# Next\n{ ok }");
  assert(r.errors.length === 0);
  // This is an explicit scope (has {) — first top-level # Outer sees { so it's explicit
  // Actually: # Outer is followed by {, so it's explicit. Let me adjust.
  // The headingless scope test within braceless should be different:
  const r2 = parseSdoc("# Top\nBefore.\n\n# Next\n{ ok }");
  assert(r2.errors.length === 0);
  assert(r2.nodes[0].title === "Top");
  assert(r2.nodes[0].children[0].text === "Before.");
});

test("braceless scope does not consume child headings", () => {
  // Inside an explicit parent, # Child heading terminates the braceless scope, becoming a sibling
  const r = parseSdoc("# Outer\n{\n  # A\n  A text.\n\n  # B\n  B text.\n}");
  assert(r.errors.length === 0);
  const children = r.nodes[0].children;
  assert(children.length === 2, "Expected 2 sibling scopes, got " + children.length);
  assert(children[0].title === "A");
  assert(children[1].title === "B");
});

// ============================================================
console.log("\n--- Implicit Root Scope ---");

test("implicit root with braceless children", () => {
  const r = parseSdoc("# My Document\n\nFirst paragraph.\n\nSecond paragraph.");
  assert(r.errors.length === 0);
  assert(r.nodes.length === 1);
  assert(r.nodes[0].title === "My Document");
  assert(r.nodes[0].children.length === 2);
  assert(r.nodes[0].children[0].text === "First paragraph.");
  assert(r.nodes[0].children[1].text === "Second paragraph.");
});

test("implicit root with child headings as braceless siblings", () => {
  const r = parseSdoc("# Doc Title\n\n# Section A\nContent A.\n\n# Section B\nContent B.");
  assert(r.errors.length === 0);
  assert(r.nodes.length === 1);
  assert(r.nodes[0].title === "Doc Title");
  const children = r.nodes[0].children;
  assert(children.length === 2, "Expected 2 child scopes, got " + children.length);
  assert(children[0].title === "Section A");
  assert(children[0].children[0].text === "Content A.");
  assert(children[1].title === "Section B");
  assert(children[1].children[0].text === "Content B.");
});

test("explicit root still works (backward compat)", () => {
  const r = parseSdoc("# Doc\n{\n  Content.\n}");
  assert(r.errors.length === 0);
  assert(r.nodes.length === 1);
  assert(r.nodes[0].title === "Doc");
  assert(r.nodes[0].children[0].text === "Content.");
});

test("implicit root with @id", () => {
  const r = parseSdoc("# My Doc @my-doc\n\nContent here.");
  assert(r.errors.length === 0);
  assert(r.nodes[0].id === "my-doc");
  assert(r.nodes[0].title === "My Doc");
  assert(r.nodes[0].children[0].text === "Content here.");
});

test("implicit root with mixed braceless and explicit children", () => {
  const r = parseSdoc("# Root\n\n# Braceless Child\nSome text.\n\n# Explicit Child\n{\n  Braced.\n}");
  assert(r.errors.length === 0);
  assert(r.nodes.length === 1);
  assert(r.nodes[0].title === "Root");
  // Children should include both child scopes
  const children = r.nodes[0].children;
  const scopes = children.filter(c => c.type === "scope");
  assert(scopes.length === 2, "Expected 2 child scopes, got " + scopes.length);
  assert(scopes[0].title === "Braceless Child");
  assert(scopes[1].title === "Explicit Child");
});

test("first heading with K&R brace is explicit (no implicit root)", () => {
  const r = parseSdoc("# Doc {\n  Content.\n}");
  assert(r.errors.length === 0);
  assert(r.nodes.length === 1);
  assert(r.nodes[0].title === "Doc");
  assert(r.nodes[0].children[0].text === "Content.");
});

test("implicit root heading followed by nothing", () => {
  const r = parseSdoc("# Empty Doc");
  assert(r.errors.length === 0);
  assert(r.nodes.length === 1);
  assert(r.nodes[0].title === "Empty Doc");
  assert(r.nodes[0].children.length === 0);
});

test("heading followed by {[citations] is explicit, not implicit root", () => {
  const r = parseSdoc("# Doc\n{[citations]\n    - @a Source A.\n}\n# Other\n{\n    Content.\n}");
  assert(r.errors.length === 0);
  // If implicit root were triggered, Other would be nested under Doc
  assert(r.nodes.length === 2, "expected 2 top-level nodes, got " + r.nodes.length);
});

// ============================================================
console.log("\n--- Key:Value Meta Syntax ---");

test("key:value meta for style", () => {
  const r = parseSdoc("# Meta @meta\n{\n  style: custom.css\n}\n# Body\n{\n  Content.\n}");
  const result = extractMeta(r.nodes);
  assert(result.meta.stylePath === "custom.css");
});

test("key:value meta for header and footer", () => {
  const r = parseSdoc("# Meta @meta\n{\n  header: My Header\n\n  footer: My Footer\n}\n# Body\n{\n  Content.\n}");
  const result = extractMeta(r.nodes);
  assert(result.meta.headerText === "My Header", "headerText was: " + result.meta.headerText);
  assert(result.meta.footerText === "My Footer", "footerText was: " + result.meta.footerText);
});

test("key:value meta for arbitrary properties", () => {
  const r = parseSdoc("# Meta @meta\n{\n  author: Jane Smith\n\n  date: 2026-02-09\n\n  version: 1.0\n}\n# Body\n{\n  Content.\n}");
  const result = extractMeta(r.nodes);
  assert(result.meta.properties.author === "Jane Smith", "author was: " + result.meta.properties.author);
  assert(result.meta.properties.date === "2026-02-09");
  assert(result.meta.properties.version === "1.0");
});

test("key:value meta for styleappend", () => {
  const r = parseSdoc("# Meta @meta\n{\n  styleappend: overrides.css\n}\n# Body\n{\n  Hi.\n}");
  const result = extractMeta(r.nodes);
  assert(result.meta.styleAppendPath === "overrides.css");
});

test("key:value mixed with sub-scope (sub-scope wins)", () => {
  const r = parseSdoc("# Meta @meta\n{\n  # Style\n  { from-scope.css }\n  style: from-kv.css\n}\n# Body\n{\n  Content.\n}");
  const result = extractMeta(r.nodes);
  assert(result.meta.stylePath === "from-scope.css", "Sub-scope should take precedence, got: " + result.meta.stylePath);
});

test("key:value header renders in HTML", () => {
  const html = renderHtmlDocument("# Meta @meta\n{\n  header: My KV Header\n}\n# Body\n{\n  Content.\n}", "Test");
  assert(html.includes("My KV Header"));
});

test("key:value footer renders in HTML", () => {
  const html = renderHtmlDocument("# Meta @meta\n{\n  footer: My KV Footer\n}\n# Body\n{\n  Content.\n}", "Test");
  assert(html.includes("My KV Footer"));
});

test("key:value with style-append hyphenated key", () => {
  const r = parseSdoc("# Meta @meta\n{\n  style-append: extra.css\n}\n# Body\n{\n  Hi.\n}");
  const result = extractMeta(r.nodes);
  assert(result.meta.styleAppendPath === "extra.css");
});

test("key:value sub-scope header wins over kv header", () => {
  const r = parseSdoc("# Meta @meta\n{\n  # Header\n  { Scope Header }\n  header: KV Header\n}\n# Body\n{\n  Hi.\n}");
  const result = extractMeta(r.nodes);
  assert(result.meta.headerNodes !== null, "headerNodes should be set by sub-scope");
  assert(result.meta.headerText === null, "headerText should remain null when sub-scope wins");
});

test("key:value does not match lines without space after colon", () => {
  const r = parseSdoc("# Meta @meta\n{\n  http://example.com\n}\n# Body\n{\n  Hi.\n}");
  const result = extractMeta(r.nodes);
  assert(Object.keys(result.meta.properties).length === 0, "Should not match URL-like lines");
});

// ============================================================
console.log("\n--- Multi-line List Item Shorthand ---");

test("multi-line list item joins continuation lines", () => {
  const r = parseSdoc("# Doc\n{\n  {[.]\n    - This is a long item\n      that continues on the next line\n    - Short item\n  }\n}");
  assert(r.errors.length === 0);
  const list = r.nodes[0].children[0];
  assert(list.type === "list");
  assert(list.items[0].title === "This is a long item that continues on the next line");
  assert(list.items[1].title === "Short item");
});

test("multi-line list item with three continuation lines", () => {
  const r = parseSdoc("# Doc\n{\n  {[.]\n    - Line one\n      line two\n      line three\n  }\n}");
  assert(r.errors.length === 0);
  const list = r.nodes[0].children[0];
  assert(list.items[0].title === "Line one line two line three");
});

test("multi-line list item followed by block", () => {
  const r = parseSdoc("# Doc\n{\n  {[.]\n    - Long item\n      continued\n    {\n      Body text.\n    }\n  }\n}");
  assert(r.errors.length === 0);
  const list = r.nodes[0].children[0];
  assert(list.items[0].title === "Long item continued");
  assert(list.items[0].children.length === 1);
  assert(list.items[0].children[0].text === "Body text.");
});

test("multi-line numbered list item", () => {
  const r = parseSdoc("# Doc\n{\n  {[#]\n    1. First item spans\n       multiple lines\n    2. Second item\n  }\n}");
  assert(r.errors.length === 0);
  const list = r.nodes[0].children[0];
  assert(list.items[0].title === "First item spans multiple lines");
  assert(list.items[1].title === "Second item");
});

test("continuation stops at next list item marker", () => {
  const r = parseSdoc("# Doc\n{\n  {[.]\n    - Item A\n      continued\n    - Item B\n  }\n}");
  assert(r.errors.length === 0);
  const list = r.nodes[0].children[0];
  assert(list.items[0].title === "Item A continued");
  assert(list.items[1].title === "Item B");
});

test("continuation stops at heading", () => {
  const r = parseSdoc("# Doc\n{\n  {[.]\n    - Item A\n      continued\n    # Nested Scope\n    { Content. }\n  }\n}");
  assert(r.errors.length === 0);
  const list = r.nodes[0].children[0];
  assert(list.items[0].title === "Item A continued");
  assert(list.items[1].title === "Nested Scope");
});

test("continuation stops at closing brace", () => {
  const r = parseSdoc("# Doc\n{\n  {[.]\n    - Item A\n      continued\n  }\n}");
  assert(r.errors.length === 0);
  const list = r.nodes[0].children[0];
  assert(list.items[0].title === "Item A continued");
});

test("continuation stops at blank line", () => {
  const r = parseSdoc("# Doc\n{\n  {[.]\n    - Item A\n      continued\n\n    - Item B\n  }\n}");
  assert(r.errors.length === 0);
  const list = r.nodes[0].children[0];
  assert(list.items[0].title === "Item A continued");
  assert(list.items[1].title === "Item B");
});

test("implicit list does NOT join continuation lines", () => {
  const r = parseSdoc("# Doc\n{\n  - Item A\n  some other text\n}");
  assert(r.errors.length === 0);
  // Implicit list should NOT treat "some other text" as continuation
  const children = r.nodes[0].children;
  // The implicit list has only Item A, then "some other text" is a separate paragraph
  const list = children[0];
  assert(list.type === "list");
  assert(list.items.length === 1);
  assert(list.items[0].title === "Item A");
  assert(children[1].type === "paragraph");
  assert(children[1].text === "some other text");
});

test("multi-line list item with task checkbox", () => {
  const r = parseSdoc("# Doc\n{\n  {[.]\n    - [ ] This task spans\n          multiple lines\n    - [x] Done task\n  }\n}");
  assert(r.errors.length === 0);
  const list = r.nodes[0].children[0];
  assert(list.items[0].task.checked === false);
  assert(list.items[0].title === "This task spans multiple lines");
  assert(list.items[1].task.checked === true);
});

test("multi-line list item renders correctly in HTML", () => {
  const html = renderHtmlDocument("# Doc\n{\n  {[.]\n    - This is a long item\n      that wraps to the next line\n  }\n}", "Test");
  assert(html.includes("This is a long item that wraps to the next line"));
});

// ============================================================
console.log("\n--- Document Formatter ---");

test("basic indentation with scope", () => {
  const input = "# Title\n{\nBody text.\n}";
  const out = formatSdoc(input, "    ");
  const lines = out.split("\n");
  assert(lines[0] === "# Title");
  assert(lines[1] === "{");
  assert(lines[2] === "    Body text.");
  assert(lines[3] === "}");
});

test("nested scopes indentation", () => {
  const input = "# Outer\n{\n# Inner\n{\nDeep.\n}\n}";
  const out = formatSdoc(input, "    ");
  const lines = out.split("\n");
  assert(lines[0] === "# Outer");
  assert(lines[1] === "{");
  assert(lines[2] === "    # Inner");
  assert(lines[3] === "    {");
  assert(lines[4] === "        Deep.");
  assert(lines[5] === "    }");
  assert(lines[6] === "}");
});

test("K&R style indentation", () => {
  const input = "# Title {\nContent.\n}";
  const out = formatSdoc(input, "    ");
  const lines = out.split("\n");
  assert(lines[0] === "# Title {");
  assert(lines[1] === "    Content.");
  assert(lines[2] === "}");
});

test("inline blocks stay on one line", () => {
  const input = "# Name\n{ John Doe }";
  const out = formatSdoc(input, "    ");
  const lines = out.split("\n");
  assert(lines[0] === "# Name");
  assert(lines[1] === "{ John Doe }");
});

test("code blocks preserved raw", () => {
  const input = "# Doc\n{\n```js\n  const x = 1;\n    nested();\n```\n}";
  const out = formatSdoc(input, "    ");
  const lines = out.split("\n");
  assert(lines[0] === "# Doc");
  assert(lines[1] === "{");
  assert(lines[2] === "    ```js");
  assert(lines[3] === "  const x = 1;", "code content should be raw, got: " + lines[3]);
  assert(lines[4] === "    nested();", "code content should be raw, got: " + lines[4]);
  assert(lines[5] === "    ```");
  assert(lines[6] === "}");
});

test("lists indented correctly", () => {
  const input = "# Doc\n{\n{[.]\n- Apple\n- Banana\n}\n}";
  const out = formatSdoc(input, "    ");
  const lines = out.split("\n");
  assert(lines[2] === "    {[.]");
  assert(lines[3] === "        - Apple");
  assert(lines[4] === "        - Banana");
  assert(lines[5] === "    }");
});

test("tables indented correctly", () => {
  const input = "# Doc\n{\n{[table]\nName | Age\nAlice | 30\n}\n}";
  const out = formatSdoc(input, "    ");
  const lines = out.split("\n");
  assert(lines[2] === "    {[table]");
  assert(lines[3] === "        Name | Age");
  assert(lines[4] === "        Alice | 30");
  assert(lines[5] === "    }");
});

test("blank lines preserved", () => {
  const input = "# Doc\n{\nFirst.\n\nSecond.\n}";
  const out = formatSdoc(input, "    ");
  const lines = out.split("\n");
  assert(lines[2] === "    First.");
  assert(lines[3] === "");
  assert(lines[4] === "    Second.");
});

test("closing braces at correct depth", () => {
  const input = "# A\n{\n# B\n{\nText.\n}\n}";
  const out = formatSdoc(input, "  ");
  const lines = out.split("\n");
  assert(lines[4] === "    Text.");
  assert(lines[5] === "  }");
  assert(lines[6] === "}");
});

test("mixed K&R and Allman", () => {
  const input = "# A {\nContent A.\n}\n# B\n{\nContent B.\n}";
  const out = formatSdoc(input, "    ");
  const lines = out.split("\n");
  assert(lines[0] === "# A {");
  assert(lines[1] === "    Content A.");
  assert(lines[2] === "}");
  assert(lines[3] === "# B");
  assert(lines[4] === "{");
  assert(lines[5] === "    Content B.");
  assert(lines[6] === "}");
});

test("K&R list opener", () => {
  const input = "# Items {[.]\n- One\n- Two\n}";
  const out = formatSdoc(input, "    ");
  const lines = out.split("\n");
  assert(lines[0] === "# Items {[.]");
  assert(lines[1] === "    - One");
  assert(lines[2] === "    - Two");
  assert(lines[3] === "}");
});

test("K&R table opener", () => {
  const input = "# Data {[table]\nName | Age\nAlice | 30\n}";
  const out = formatSdoc(input, "    ");
  const lines = out.split("\n");
  assert(lines[0] === "# Data {[table]");
  assert(lines[1] === "    Name | Age");
  assert(lines[2] === "    Alice | 30");
  assert(lines[3] === "}");
});

test("tab indentation", () => {
  const input = "# Doc\n{\nBody.\n}";
  const out = formatSdoc(input, "\t");
  const lines = out.split("\n");
  assert(lines[2] === "\tBody.");
});

test("already formatted document unchanged", () => {
  const input = "# Title\n{\n    Body text.\n\n    More text.\n}";
  const out = formatSdoc(input, "    ");
  assert(out === input);
});

test("blockquote indented at depth", () => {
  const input = "# Doc\n{\n> A quote.\n> Another line.\n}";
  const out = formatSdoc(input, "    ");
  const lines = out.split("\n");
  assert(lines[2] === "    > A quote.");
  assert(lines[3] === "    > Another line.");
});

test("HR indented at depth", () => {
  const input = "# Doc\n{\nBefore.\n---\nAfter.\n}";
  const out = formatSdoc(input, "    ");
  const lines = out.split("\n");
  assert(lines[3] === "    ---");
});

test("list item with K&R opener", () => {
  const input = "# Doc\n{\n{[.]\n- Item {\nBody.\n}\n}\n}";
  const out = formatSdoc(input, "    ");
  const lines = out.split("\n");
  assert(lines[3] === "        - Item {");
  assert(lines[4] === "            Body.");
  assert(lines[5] === "        }");
});

// ============================================================
console.log("\n--- slugify ---");

test("basic slugify", () => {
  assert(slugify("Smart Pointers") === "smart-pointers");
});

test("uppercase to lowercase", () => {
  assert(slugify("RAII Pattern") === "raii-pattern");
});

test("non-alpha chars to hyphens", () => {
  assert(slugify("C++ Memory Mgmt") === "c-memory-mgmt");
});

test("strips formatting markers", () => {
  assert(slugify("**Bold Title**") === "bold-title");
});

test("strips backticks", () => {
  assert(slugify("`code` stuff") === "code-stuff");
});

test("trims leading/trailing hyphens", () => {
  assert(slugify("  Spaces  ") === "spaces");
});

test("empty string", () => {
  assert(slugify("") === "");
});

// ============================================================
console.log("\n--- listSections ---");

test("lists content scopes, excludes meta and about", () => {
  const r = parseSdoc("# Doc\n{\n# Meta @meta\n{\nauthor: Bob\n}\n# About @about\n{\nDesc.\n}\n# First @first\n{\nPara one.\n}\n# Second\n{\nPara two.\n}\n}");
  const sections = listSections(r.nodes);
  assert(sections.length === 2, "expected 2 sections, got " + sections.length);
  assert(sections[0].id === "first");
  assert(sections[0].title === "First");
  assert(sections[0].derivedId === "first");
  assert(sections[1].id === null);
  assert(sections[1].title === "Second");
  assert(sections[1].derivedId === "second");
});

test("preview from first paragraph", () => {
  const r = parseSdoc("# Doc\n{\n# Section\n{\nHello world this is content.\n}\n}");
  const sections = listSections(r.nodes);
  assert(sections[0].preview === "Hello world this is content.");
});

test("preview truncates long paragraphs", () => {
  const longText = "A".repeat(50) + " " + "B".repeat(50) + " " + "C".repeat(50);
  const r = parseSdoc("# Doc\n{\n# Section\n{\n" + longText + "\n}\n}");
  const sections = listSections(r.nodes);
  assert(sections[0].preview.length < longText.length, "preview should be truncated");
  assert(sections[0].preview.endsWith("..."), "preview should end with ...");
});

test("empty scope has empty preview", () => {
  const r = parseSdoc("# Doc\n{\n# Empty\n{\n}\n}");
  const sections = listSections(r.nodes);
  assert(sections[0].preview === "");
});

// ============================================================
console.log("\n--- extractSection ---");

test("match by explicit @id", () => {
  const r = parseSdoc("# Doc\n{\n# Section One @sec1\n{\nContent one.\n}\n# Section Two @sec2\n{\nContent two.\n}\n}");
  const result = extractSection(r.nodes, "sec2");
  assert(result !== null);
  assert(result.title === "Section Two");
  assert(result.content.includes("Content two"));
});

test("match by derived slug", () => {
  const r = parseSdoc("# Doc\n{\n# Smart Pointers\n{\nModern C++ provides.\n}\n}");
  const result = extractSection(r.nodes, "smart-pointers");
  assert(result !== null);
  assert(result.title === "Smart Pointers");
  assert(result.content.includes("Modern C++"));
});

test("derived slug match is case-insensitive", () => {
  const r = parseSdoc("# Doc\n{\n# Smart Pointers\n{\nContent.\n}\n}");
  const result = extractSection(r.nodes, "Smart-Pointers");
  assert(result !== null);
});

test("explicit @id takes priority over derived slug", () => {
  const r = parseSdoc("# Doc\n{\n# Alpha @beta\n{\nFirst.\n}\n# Beta\n{\nSecond.\n}\n}");
  const result = extractSection(r.nodes, "beta");
  assert(result !== null);
  assert(result.title === "Alpha", "should match explicit @id first, got: " + result.title);
});

test("no match returns null", () => {
  const r = parseSdoc("# Doc\n{\n# Section\n{\nContent.\n}\n}");
  const result = extractSection(r.nodes, "nonexistent");
  assert(result === null);
});

test("excludes meta and about from matching", () => {
  const r = parseSdoc("# Doc\n{\n# About @about\n{\nDesc.\n}\n# Content\n{\nReal.\n}\n}");
  const result = extractSection(r.nodes, "about");
  assert(result === null, "should not match @about scope");
});

// ============================================================
console.log("\n--- extractAbout ---");

test("extracts about text", () => {
  const r = parseSdoc("# Doc\n{\n# About @about\n{\nThis is the about section.\n}\n# Content\n{\nStuff.\n}\n}");
  const about = extractAbout(r.nodes);
  assert(about === "This is the about section.");
});

test("joins multiple paragraphs", () => {
  const r = parseSdoc("# Doc\n{\n# About @about\n{\nFirst para.\n\nSecond para.\n}\n}");
  const about = extractAbout(r.nodes);
  assert(about === "First para. Second para.");
});

test("returns null when no about", () => {
  const r = parseSdoc("# Doc\n{\n# Content\n{\nStuff.\n}\n}");
  const about = extractAbout(r.nodes);
  assert(about === null);
});

test("case-insensitive @about matching", () => {
  const r = parseSdoc("# Doc\n{\n# ABOUT @About\n{\nText.\n}\n}");
  const about = extractAbout(r.nodes);
  assert(about === "Text.");
});

// ============================================================
console.log("\n--- extractMeta enhanced ---");

test("extracts uuid from meta", () => {
  const r = parseSdoc("# Meta @meta\n{\nuuid: 550e8400-e29b\n}\n# Body\n{\nContent.\n}");
  const result = extractMeta(r.nodes);
  assert(result.meta.uuid === "550e8400-e29b");
});

test("extracts type from meta", () => {
  const r = parseSdoc("# Meta @meta\n{\ntype: skill\n}\n# Body\n{\nContent.\n}");
  const result = extractMeta(r.nodes);
  assert(result.meta.type === "skill");
});

test("extracts tags as array", () => {
  const r = parseSdoc("# Meta @meta\n{\ntags: cpp, memory, raii\n}\n# Body\n{\nContent.\n}");
  const result = extractMeta(r.nodes);
  assert(Array.isArray(result.meta.tags));
  assert(result.meta.tags.length === 3);
  assert(result.meta.tags[0] === "cpp");
  assert(result.meta.tags[1] === "memory");
  assert(result.meta.tags[2] === "raii");
});

test("single tag", () => {
  const r = parseSdoc("# Meta @meta\n{\ntags: solo\n}\n# Body\n{\nContent.\n}");
  const result = extractMeta(r.nodes);
  assert(result.meta.tags.length === 1);
  assert(result.meta.tags[0] === "solo");
});

test("missing uuid/type/tags default to null/null/[]", () => {
  const r = parseSdoc("# Meta @meta\n{\nauthor: Bob\n}\n# Body\n{\nContent.\n}");
  const result = extractMeta(r.nodes);
  assert(result.meta.uuid === null);
  assert(result.meta.type === null);
  assert(result.meta.tags.length === 0);
});

test("no meta scope has empty meta object", () => {
  const r = parseSdoc("# Doc\n{\nContent.\n}");
  const result = extractMeta(r.nodes);
  assert(Object.keys(result.meta).length === 0);
});

// ============================================================
console.log("\n--- inferType ---");

test("meta type takes precedence", () => {
  assert(inferType("skill-foo.sdoc", { type: "doc" }) === "doc");
});

test("infers skill from filename prefix", () => {
  assert(inferType("skill-error-handling.sdoc", {}) === "skill");
  assert(inferType("skill-error-handling.sdoc", null) === "skill");
});

test("infers doc from filename prefix", () => {
  assert(inferType("doc-architecture.sdoc", {}) === "doc");
});

test("returns null for unknown prefix", () => {
  assert(inferType("error-handling.sdoc", {}) === null);
  assert(inferType("readme.sdoc", {}) === null);
});

console.log("\n--- nested code fences ---");

test("4-backtick fence contains 3-backtick content", () => {
  const r = parseSdoc("# Doc\n{\n````\n```js\nlet x = 1;\n```\n````\n}");
  assert(r.nodes.length === 1);
  const code = r.nodes[0].children.find((n) => n.type === "code");
  assert(code);
  assert(code.text.includes("```js"));
  assert(code.text.includes("let x = 1;"));
});

test("4-backtick fence not closed by 3 backticks", () => {
  const r = parseSdoc("# Doc\n{\n````\n```\nstill code\n```\n````\n}");
  const code = r.nodes[0].children.find((n) => n.type === "code");
  assert(code);
  assert(code.text.includes("still code"));
  assert(code.text.includes("```"));
});

test("braces inside nested code fence do not affect scope", () => {
  const r = parseSdoc("# Doc\n{\n````\n```\nfunction() {\n}\n```\n````\n    Paragraph after.\n}");
  assert(r.nodes.length === 1);
  const para = r.nodes[0].children.find((n) => n.type === "paragraph" && n.text.includes("Paragraph"));
  assert(para, "paragraph after nested fence should be inside the document scope");
});

test("extractMeta finds @meta inside document scope", () => {
  const r = parseSdoc("# Doc\n{\n    # Meta @meta\n    {\n        type: skill\n    }\n    # Content\n    {\n        text\n    }\n}");
  const result = extractMeta(r.nodes);
  assert(result.meta.type === "skill", "should find type inside document scope");
  // @meta should be stripped from output nodes
  const docChildren = result.nodes[0].children;
  const hasMeta = docChildren.some((n) => n.id === "meta");
  assert(!hasMeta, "@meta should be stripped from children");
});

// ============================================================
console.log("\n--- Company and confidential ---");

test("extractMeta promotes company and confidential", () => {
  const r = parseSdoc("# Meta @meta\n{\n    company: Acme Corp\n\n    confidential: true\n}\n# Body\n{\n    text\n}");
  const result = extractMeta(r.nodes);
  assert(result.meta.company === "Acme Corp", "should promote company");
  assert(result.meta.confidential === "true", "should promote confidential");
});

test("confidential: true renders notice in doc HTML", () => {
  const html = renderHtmlDocument("# Meta @meta\n{\n    confidential: true\n}\n# Body\n{\n    Content.\n}", "Test");
  assert(html.includes("sdoc-confidential-notice"), "should have notice element");
  assert(html.includes("CONFIDENTIAL"), "should contain CONFIDENTIAL text");
});

test("confidential with company renders entity in doc HTML", () => {
  const html = renderHtmlDocument("# Meta @meta\n{\n    company: Acme Corp\n\n    confidential: true\n}\n# Body\n{\n    Content.\n}", "Test");
  assert(html.includes("Acme Corp"), "should include company name in notice");
});

test("company renders in footer of doc HTML", () => {
  const html = renderHtmlDocument("# Meta @meta\n{\n    company: Acme Corp\n}\n# Body\n{\n    Content.\n}", "Test");
  assert(html.includes("sdoc-company-footer"), "should have company in footer");
  assert(html.includes("Acme Corp"), "should have company name");
  assert(html.includes("sdoc-page-footer"), "should have footer element");
});

test("no company or confidential produces no notice or company footer", () => {
  const html = renderHtmlDocument("# Meta @meta\n{\n    type: doc\n}\n# Body\n{\n    Content.\n}", "Test");
  assert(!html.includes('<div class="sdoc-confidential-notice">'), "no notice element");
  assert(!html.includes('<span class="sdoc-company-footer">'), "no company footer element");
});

// ============================================================
console.log("\n--- Bare @meta and @about ---");

test("bare @meta { } is parsed as a scope with id 'meta'", () => {
  const r = parseSdoc("# Doc {\n    @meta {\n        type: doc\n    }\n    # Body {\n        Content.\n    }\n}");
  assert(r.errors.length === 0, "no parse errors: " + r.errors.map(e => e.message).join(", "));
  const doc = r.nodes[0];
  const metaNode = doc.children.find(n => n.type === "scope" && n.id === "meta");
  assert(metaNode, "should find scope with id 'meta'");
});

test("bare @about { } is parsed as a scope with id 'about'", () => {
  const r = parseSdoc("# Doc {\n    @about {\n        Summary of this document.\n    }\n    # Body {\n        Content.\n    }\n}");
  assert(r.errors.length === 0, "no parse errors");
  const doc = r.nodes[0];
  const aboutNode = doc.children.find(n => n.type === "scope" && n.id === "about");
  assert(aboutNode, "should find scope with id 'about'");
});

test("extractMeta works with bare @meta", () => {
  const r = parseSdoc("# Doc {\n    @meta {\n        type: doc\n\n        company: Acme Corp\n    }\n    # Body {\n        Content.\n    }\n}");
  const result = extractMeta(r.nodes);
  assert(result.meta.type === "doc", "should extract type");
  assert(result.meta.company === "Acme Corp", "should extract company");
});

test("extractAbout works with bare @about", () => {
  const r = parseSdoc("# Doc {\n    @about {\n        This is the summary.\n    }\n    # Body {\n        Content.\n    }\n}");
  const result = extractMeta(r.nodes);
  const about = extractAbout(r.nodes);
  assert(about === "This is the summary.", "should extract about text, got: " + about);
});

test("bare @meta on separate line from brace", () => {
  const r = parseSdoc("# Doc {\n    @meta\n    {\n        type: skill\n    }\n    # Body {\n        Content.\n    }\n}");
  assert(r.errors.length === 0, "no parse errors");
  const result = extractMeta(r.nodes);
  assert(result.meta.type === "skill", "should extract type from bare @meta with brace on next line");
});

test("bare @meta at top level (outside document scope)", () => {
  const r = parseSdoc("@meta {\n    type: doc\n}\n\n# Body {\n    Content.\n}");
  assert(r.errors.length === 0, "no parse errors: " + r.errors.map(e => e.message).join(", "));
  const result = extractMeta(r.nodes);
  assert(result.meta.type === "doc", "should extract type from top-level bare @meta");
});

test("bare @about at top level (outside document scope)", () => {
  const r = parseSdoc("@about {\n    Summary text here.\n}\n\n# Body {\n    Content.\n}");
  assert(r.errors.length === 0, "no parse errors");
  const about = extractAbout(r.nodes);
  assert(about === "Summary text here.", "should extract about text from top level");
});

test("bare directives do not match non-meta/about", () => {
  const r = parseSdoc("# Doc {\n    @random {\n        stuff\n    }\n}");
  // @random is NOT a bare directive — it should be treated as paragraph text
  const doc = r.nodes[0];
  const randomScope = doc.children.find(n => n.type === "scope" && n.id === "random");
  assert(!randomScope, "@random should not create a scope");
});

// ============================================================
console.log("\n--- Signposts: parsing ---");

const NEW_SIGNPOST_IDS = ["not-about", "related-resources", "reading-guide", "editing-guide"];

for (const id of NEW_SIGNPOST_IDS) {
  test(`bare @${id} { on one line parses as a headingless scope`, () => {
    const r = parseSdoc(`# Doc {\n    @${id} {\n        Text.\n    }\n    # Body {\n        Content.\n    }\n}`);
    assert(r.errors.length === 0, "no parse errors");
    const node = r.nodes[0].children.find((n) => n.type === "scope" && n.id === id);
    assert(node, `should find scope with id '${id}'`);
    assert(node.hasHeading === false, "bare form has no heading");
  });

  test(`bare @${id} with the brace on the next line parses as a scope`, () => {
    const r = parseSdoc(`# Doc {\n    @${id}\n    {\n        Text.\n    }\n}`);
    assert(r.errors.length === 0, "no parse errors");
    assert(r.nodes[0].children.some((n) => n.type === "scope" && n.id === id), "scope found");
  });

  test(`braceless bare @${id} at top level parses as a scope`, () => {
    const r = parseSdoc(`@${id}\nText.\n\n# Body {\n    Content.\n}`);
    assert(r.errors.length === 0, "no parse errors");
    const node = r.nodes.find((n) => n.type === "scope" && n.id === id);
    assert(node, "scope found");
    assert(node.children.some((c) => c.type === "paragraph" && c.text === "Text."), "content captured");
  });
}

test("a mid-line reference to a signpost stays a paragraph", () => {
  const r = parseSdoc("# Doc {\n    See @reading-guide for details.\n}");
  const children = r.nodes[0].children;
  assert(children.length === 1 && children[0].type === "paragraph", "one paragraph, no scope");
});

test("@reading-guide followed by text on the same line is not a directive", () => {
  const r = parseSdoc("# Doc {\n    @reading-guide is where to start.\n}");
  assert(!r.nodes[0].children.some((n) => n.type === "scope"), "no scope created");
});

test("a bare signpost ends a braceless scope and becomes its sibling", () => {
  const r = parseSdoc("# Doc {\n    # Intro\n    Text.\n    @editing-guide {\n        Rules.\n    }\n}");
  const children = r.nodes[0].children;
  assert(children.length === 2, "two siblings, got " + children.length);
  assert(children[1].id === "editing-guide", "second sibling is @editing-guide");
});

test("SIGNPOST_IDS lists the five signposts in conventional order", () => {
  assert(JSON.stringify(SIGNPOST_IDS) === JSON.stringify(["about", "not-about", "related-resources", "reading-guide", "editing-guide"]));
});

test("RESERVED_SCOPE_IDS is @meta plus the signposts", () => {
  assert(RESERVED_SCOPE_IDS.size === 6 && RESERVED_SCOPE_IDS.has("meta") && SIGNPOST_IDS.every((id) => RESERVED_SCOPE_IDS.has(id)));
});

test("EXPORT_HIDDEN_SIGNPOST_IDS is every signpost except @reading-guide", () => {
  assert(JSON.stringify(EXPORT_HIDDEN_SIGNPOST_IDS) === JSON.stringify(["about", "not-about", "related-resources", "editing-guide"]));
});

test("getSignpost matches case-insensitively and ignores other scopes", () => {
  assert(getSignpost({ type: "scope", id: "Not-About" }).id === "not-about");
  assert(getSignpost({ type: "scope", id: "overview" }) === null);
  assert(getSignpost({ type: "paragraph" }) === null);
  assert(getSignpost({ type: "scope", id: "meta" }) === null, "@meta is reserved but not a signpost");
});

// ============================================================
console.log("\n--- Signposts: rendering ---");

const SIGNPOST_TITLES = { "not-about": "Not About", "related-resources": "Related Resources", "reading-guide": "Reading Guide", "editing-guide": "Editing Guide" };

for (const id of NEW_SIGNPOST_IDS) {
  test(`bare @${id} renders as a labelled signpost`, () => {
    const html = renderHtmlBody(`# Doc {\n    @${id} {\n        Some text.\n    }\n}`, { includeSignposts: true });
    assert(new RegExp(`<section class="[^"]*sdoc-meta-section sdoc-signpost sdoc-signpost-${id}"`).test(html), "both classes present");
    const m = html.match(new RegExp(`<h\\d[^>]*\\bid="${id}"[^>]*>(?:<span class="sdoc-toggle"[^>]*></span>)?([^<]+)</h\\d>`));
    assert(m, "heading with the section id");
    assert(m[1] === SIGNPOST_TITLES[id], `default title should be "${SIGNPOST_TITLES[id]}", got: ${m[1]}`);
  });

  test(`empty @${id} renders nothing`, () => {
    const html = renderHtmlBody(`# Doc {\n    @${id} {\n    \n    }\n    # Body {\n        Content.\n    }\n}`, { includeSignposts: true });
    assert(!/<section [^>]*sdoc-meta-section/.test(html), "no signpost element");
  });
}

test("@about carries the signpost classes and keeps sdoc-meta-section", () => {
  const html = renderHtmlBody("# Doc {\n    @about {\n        Summary.\n    }\n}", { includeSignposts: true });
  assert(/<section class="[^"]*sdoc-meta-section sdoc-signpost sdoc-signpost-about"/.test(html), "all three classes on @about");
});

test("heading-form signpost keeps its custom title", () => {
  const html = renderHtmlBody("# Doc {\n    # Further Reading @related-resources {\n        {[table]\n            Resource | Relation\n            [A](a.sdoc) | Sibling\n        }\n    }\n}", { includeSignposts: true });
  assert(/>Further Reading<\/h\d>/.test(html), "custom title kept");
  assert(html.includes("sdoc-signpost-related-resources"));
});

test("mixed-case id still gets the canonical per-section class", () => {
  const html = renderHtmlBody("# Doc {\n    # Scope @Not-About {\n        Text.\n    }\n}", { includeSignposts: true });
  assert(html.includes("sdoc-signpost-not-about"));
});

test("the @related-resources table renders as a table inside the signpost", () => {
  const html = renderHtmlBody("# Doc {\n    @related-resources {\n        {[table]\n            Resource | Relation\n            [Spec](spec.sdoc) | Normative source\n        }\n    }\n}", { includeSignposts: true });
  const section = html.slice(html.indexOf("sdoc-signpost-related-resources"));
  assert(/<table/.test(section), "table rendered");
  assert(section.includes('href="spec.sdoc"'), "link rendered");
});

// ============================================================
console.log("\n--- Signposts: export visibility ---");

const ALL_SIGNPOSTS_SRC = "# Doc {\n    @about {\n        A.\n    }\n    @not-about {\n        - B.\n    }\n    @related-resources {\n        {[table]\n            Resource | Relation\n            [X](x.sdoc) | Sibling\n        }\n    }\n    @reading-guide {\n        Start at the top.\n    }\n    @editing-guide {\n        - Keep it short.\n    }\n    # Body {\n        Real content.\n    }\n}";

function signpostsIn(html) {
  return SIGNPOST_IDS.filter((id) => new RegExp(`<section [^>]*sdoc-signpost-${id}\\b`).test(html));
}

test("export default keeps @reading-guide and drops the other four", () => {
  const html = renderHtmlDocument(ALL_SIGNPOSTS_SRC, "T");
  assert(JSON.stringify(signpostsIn(html)) === JSON.stringify(["reading-guide"]), "got " + signpostsIn(html));
  assert(html.includes("Real content."));
});

test("renderHtmlBody default applies the same rule", () => {
  assert(JSON.stringify(signpostsIn(renderHtmlBody(ALL_SIGNPOSTS_SRC))) === JSON.stringify(["reading-guide"]));
});

test("includeSignposts: true keeps all five", () => {
  assert(signpostsIn(renderHtmlDocument(ALL_SIGNPOSTS_SRC, "T", { includeSignposts: true })).length === 5);
});

test("includeAbout: true keeps @about on top of the defaults, and nothing more", () => {
  const expected = JSON.stringify(["about", "reading-guide"]);
  assert(JSON.stringify(signpostsIn(renderHtmlDocument(ALL_SIGNPOSTS_SRC, "T", { includeAbout: true }))) === expected);
  assert(JSON.stringify(signpostsIn(renderHtmlBody(ALL_SIGNPOSTS_SRC, { includeAbout: true }))) === expected);
});

test("signposts keeps a single section on top of the defaults", () => {
  const html = renderHtmlDocument(ALL_SIGNPOSTS_SRC, "T", { signposts: { "related-resources": true } });
  assert(JSON.stringify(signpostsIn(html)) === JSON.stringify(["related-resources", "reading-guide"]), "got " + signpostsIn(html));
});

test("signposts drops a section shown by default", () => {
  const html = renderHtmlDocument(ALL_SIGNPOSTS_SRC, "T", { signposts: { "reading-guide": false } });
  assert(signpostsIn(html).length === 0, "got " + signpostsIn(html));
  assert(html.includes("Real content."));
});

test("signposts applies on top of includeSignposts: true", () => {
  const html = renderHtmlDocument(ALL_SIGNPOSTS_SRC, "T", { includeSignposts: true, signposts: { "editing-guide": false } });
  assert(JSON.stringify(signpostsIn(html)) === JSON.stringify(["about", "not-about", "related-resources", "reading-guide"]));
});

test("signposts applies on top of includeAbout: true", () => {
  const html = renderHtmlBody(ALL_SIGNPOSTS_SRC, { includeAbout: true, signposts: { "editing-guide": true, "reading-guide": false } });
  assert(JSON.stringify(signpostsIn(html)) === JSON.stringify(["about", "editing-guide"]));
});

test("hiddenSignposts resolves the options to the ids a render drops", () => {
  assert(JSON.stringify(hiddenSignposts()) === JSON.stringify(["about", "not-about", "related-resources", "editing-guide"]));
  assert(JSON.stringify(hiddenSignposts({ includeSignposts: true })) === "[]");
  assert(JSON.stringify(hiddenSignposts({ includeAbout: true })) === JSON.stringify(["not-about", "related-resources", "editing-guide"]));
  assert(JSON.stringify(hiddenSignposts({ includeSignposts: false, includeAbout: true })) === JSON.stringify(["about", "not-about", "related-resources", "editing-guide"]));
});

test("hiddenSignposts matches ids case-insensitively and ignores unknown ids and non-booleans", () => {
  const hidden = hiddenSignposts({ signposts: { "Related-Resources": true, "editing-guide": "yes", "body": true, "meta": true } });
  assert(JSON.stringify(hidden) === JSON.stringify(["about", "not-about", "editing-guide"]), "got " + hidden);
});

test("an explicit includeSignposts: false wins over includeAbout: true", () => {
  const html = renderHtmlDocument(ALL_SIGNPOSTS_SRC, "T", { includeSignposts: false, includeAbout: true });
  assert(JSON.stringify(signpostsIn(html)) === JSON.stringify(["reading-guide"]));
});

test("a nested @not-about inside a body section is exported as an ordinary section", () => {
  const html = renderHtmlBody("# Doc {\n    # Body {\n        @not-about {\n            Nested.\n        }\n        Text.\n    }\n}");
  assert(html.includes("Nested."), "content kept");
  assert(!html.includes("sdoc-signpost"), "not styled as a signpost");
});

test("stripSignposts defaults to the export-hidden sections, without mutating", () => {
  const r = parseSdoc(ALL_SIGNPOSTS_SRC);
  const before = JSON.stringify(r.nodes);
  const ids = stripSignposts(r.nodes)[0].children.filter((n) => n.id).map((n) => n.id);
  assert(JSON.stringify(ids) === JSON.stringify(["reading-guide"]), "got " + ids);
  assert(JSON.stringify(r.nodes) === before, "input not mutated");
});

test("stripSignposts takes an explicit id list", () => {
  const r = parseSdoc(ALL_SIGNPOSTS_SRC);
  const ids = stripSignposts(r.nodes, ["reading-guide"])[0].children.filter((n) => n.id).map((n) => n.id);
  assert(!ids.includes("reading-guide") && ids.includes("about"));
});

test("stripAboutScopes still removes only @about", () => {
  const r = parseSdoc(ALL_SIGNPOSTS_SRC);
  const ids = stripAboutScopes(r.nodes)[0].children.filter((n) => n.id).map((n) => n.id);
  assert(!ids.includes("about"), "about removed");
  assert(ids.includes("not-about") && ids.includes("editing-guide"), "other sections untouched");
});

test("isSignpostEmpty is the function isAboutEmpty names", () => {
  assert(isAboutEmpty === isSignpostEmpty);
  assert(isSignpostEmpty({ children: [{ type: "paragraph", text: "  " }] }) === true);
  assert(isSignpostEmpty({ children: [{ type: "table", headers: [], rows: [] }] }) === false);
});

// ============================================================
console.log("\n--- Signposts: extraction ---");

test("extractSignpost joins blocks with a blank line and keeps links", () => {
  const r = parseSdoc("# Doc {\n    @not-about {\n        Not covered here.\n\n        - Slides: see [slide guide](slides.sdoc).\n    }\n}");
  const text = extractSignpost(r.nodes, "not-about");
  assert(text === "Not covered here.\n\nSlides: see [slide guide](slides.sdoc).", "got: " + JSON.stringify(text));
});

test("extractSignpost returns null for absent, empty and unknown sections", () => {
  const r = parseSdoc("# Doc {\n    @editing-guide {\n    }\n    # Body {\n        Text.\n    }\n}");
  assert(extractSignpost(r.nodes, "not-about") === null, "absent");
  assert(extractSignpost(r.nodes, "editing-guide") === null, "empty");
  assert(extractSignpost(r.nodes, "body") === null, "not a signpost");
  assert(extractSignpost(r.nodes, "meta") === null, "@meta is not a signpost");
});

test("extractSignpost matches a heading-form id case-insensitively", () => {
  const r = parseSdoc("# Doc {\n    # Rules @Editing-Guide {\n        Keep it short.\n    }\n}");
  assert(extractSignpost(r.nodes, "editing-guide") === "Keep it short.");
});

test("extractSignpost finds a section at top level outside a document scope", () => {
  const r = parseSdoc("@reading-guide {\n    Start here.\n}\n\n# Body {\n    Text.\n}");
  assert(extractSignpost(r.nodes, "reading-guide") === "Start here.");
});

test("extractSignpost finds a section written beside the root scope", () => {
  const r = parseSdoc("@editing-guide {\n    Rules.\n}\n\n# Doc {\n    # Body {\n        Text.\n    }\n}");
  assert(extractSignpost(r.nodes, "editing-guide") === "Rules.");
});

test("extractSignposts returns present non-empty sections keyed by id", () => {
  const r = parseSdoc("# Doc {\n    @about {\n        Summary.\n    }\n    @editing-guide {\n    }\n    # Body {\n        Text.\n    }\n}");
  const all = extractSignposts(r.nodes);
  assert(JSON.stringify(Object.keys(all)) === JSON.stringify(["about"]), "got " + Object.keys(all));
  assert(JSON.stringify(extractSignposts(parseSdoc("# Doc {\n    Text.\n}").nodes)) === "{}");
});

test("extractAbout still joins paragraphs with a space (unchanged)", () => {
  const r = parseSdoc("# Doc {\n    @about {\n        First.\n\n        Second.\n    }\n}");
  assert(extractAbout(r.nodes) === "First. Second.");
});

test("extractRelatedResources returns label, href and relation per row", () => {
  const r = parseSdoc("# Doc {\n    @related-resources {\n        {[table]\n            Resource | Relation\n            [Spec](spec.sdoc) | Normative source\n            [**Guide**](guide.sdoc#intro) | Prerequisite\n        }\n    }\n}");
  const pages = extractRelatedResources(r.nodes);
  assert(pages.length === 2);
  assert(pages[0].label === "Spec" && pages[0].href === "spec.sdoc" && pages[0].relation === "Normative source");
  assert(pages[1].label === "Guide" && pages[1].href === "guide.sdoc#intro");
});

test("extractRelatedResources classifies each resource as sdoc, file or external", () => {
  const r = parseSdoc("# Doc {\n    @related-resources {\n        {[table]\n            Resource | Relation\n            [Spec](../spec.sdoc#refs) | Source\n            [Logo](img/logo.svg) | Artwork\n            https://github.com/o/r | Repository\n            [Here](#here) | Not a resource\n        }\n    }\n}");
  const got = extractRelatedResources(r.nodes).map((x) => x.label + ":" + x.kind);
  assert(JSON.stringify(got) === JSON.stringify(["Spec:sdoc", "Logo:file", "https://github.com/o/r:external"]), JSON.stringify(got));
});

test("resourceKind: a scheme is external, a .sdoc path is sdoc, anything else is file", () => {
  assert(resourceKind("https://x.y/a.sdoc") === "external" && resourceKind("mailto:a@b.c") === "external");
  assert(resourceKind("a/b.sdoc?x=1#s") === "sdoc" && resourceKind("../c.SDOC") === "sdoc");
  assert(resourceKind("data.json") === "file" && resourceKind("dir/") === "file");
});

test("extractRelatedResources skips malformed rows and returns null when absent", () => {
  const r = parseSdoc("# Doc {\n    @related-resources {\n        {[table]\n            Resource | Relation\n            Not a link | Sibling\n            [Ok](ok.sdoc) | Sibling\n        }\n    }\n}");
  assert(extractRelatedResources(r.nodes).length === 1);
  assert(extractRelatedResources(parseSdoc("# Doc {\n    Text.\n}").nodes) === null);
});

test("extractReadingGuide returns the free text and the table entries", () => {
  const r = parseSdoc("# Doc {\n    @reading-guide {\n        Skim once.\n\n        {[table]\n            Sections | Note\n            @intro, @usage | Start here\n        }\n    }\n    # Intro @intro {\n        A.\n    }\n    # Usage @usage {\n        B.\n    }\n}");
  const guide = extractReadingGuide(r.nodes);
  assert(guide.text === "Skim once.");
  assert(guide.entries.length === 1);
  assert(JSON.stringify(guide.entries[0].sections) === JSON.stringify(["intro", "usage"]));
  assert(guide.entries[0].note === "Start here");
  assert(extractReadingGuide(parseSdoc("# Doc {\n    Text.\n}").nodes) === null);
});

test("listSections and extractSection exclude every signpost", () => {
  const r = parseSdoc("# Doc {\n    # Not About @not-about {\n        X.\n    }\n    # Guide @reading-guide {\n        Y.\n    }\n    # Rules @editing-guide {\n        Z.\n    }\n    # Pages @related-resources {\n        W.\n    }\n    # Body @body {\n        Real.\n    }\n}");
  const ids = listSections(r.nodes).map((s) => s.id);
  assert(JSON.stringify(ids) === JSON.stringify(["body"]), "got " + ids);
  for (const id of NEW_SIGNPOST_IDS) assert(extractSection(r.nodes, id) === null, id + " should not be extractable");
});

// ============================================================
console.log("\n--- Signposts: validation ---");

const VALID_SIGNPOST_DOC = `# Doc {
    @about {
        What this is.
    }
    @not-about {
        - Slides: they need their own layout rules.
    }
    @related-resources {
        {[table]
            Resource | Relation
            [Spec](spec.sdoc) | Normative source
        }
    }
    @reading-guide {
        Skim once.

        {[.]
            - Then dip in.
        }

        {[table]
            Sections | Note
            @intro, @usage | Start here
        }
    }
    @editing-guide {
        - Keep it short.
          {[.]
            - Nested lists are fine.
          }
    }
    # Intro @intro {
        A.
    }
    # Usage @usage {
        B.
    }
}`;

function signpostFindings(src) {
  const r = parseSdoc(src);
  assert(r.errors.length === 0, "parse errors: " + r.errors.map((e) => e.message).join(", "));
  return validateSignposts(r.nodes);
}
function findingTypes(src) {
  return signpostFindings(src).map((f) => f.type);
}
// A document with one signpost body swapped in, and @intro/@usage to point at.
function withSection(id, body) {
  return `# Doc {\n    @${id} {\n${body}\n    }\n    # Intro @intro {\n        A.\n    }\n    # Usage @usage {\n        B.\n    }\n}`;
}
const TABLE = (header, ...rows) => `        {[table]\n            ${header}\n${rows.map((r) => "            " + r).join("\n")}\n        }`;

test("a document using every signpost correctly has no findings", () => {
  const f = signpostFindings(VALID_SIGNPOST_DOC);
  assert(f.length === 0, JSON.stringify(f));
});

test("a document with no signposts has no findings", () => {
  assert(signpostFindings("# Doc {\n    # Body {\n        Text.\n    }\n}").length === 0);
});

test("reserved scopes beside the root scope count as top level", () => {
  assert(signpostFindings("# Meta @meta {\n    sdoc-version: 0.2\n}\n@about {\n    Summary.\n}\n# Doc {\n    @editing-guide {\n        Rules.\n    }\n    Body.\n}").length === 0);
});

test("placement: a signpost below the top level", () => {
  const f = signpostFindings("# Doc {\n    # Body {\n        @about {\n            Nested.\n        }\n    }\n}");
  assert(f.length === 1 && f[0].type === "reserved-scope-placement" && f[0].id === "about", JSON.stringify(f));
  assert(f[0].lineStart === 3, "line of the nested scope, got " + f[0].lineStart);
});

test("placement: a nested @meta is reported too", () => {
  assert(findingTypes("# Doc {\n    # Body {\n        @meta {\n            type: doc\n        }\n    }\n}").includes("reserved-scope-placement"));
});

test("duplicate: the second occurrence is reported", () => {
  const f = signpostFindings("# Doc {\n    @editing-guide {\n        One.\n    }\n    # Rules @editing-guide {\n        Two.\n    }\n}");
  assert(f.length === 1 && f[0].type === "reserved-scope-duplicate" && f[0].lineStart === 5, JSON.stringify(f));
});

test("content: a code block in @about", () => {
  assert(JSON.stringify(findingTypes(withSection("about", "        Text.\n        ```js\n        x();\n        ```"))) === JSON.stringify(["signpost-content"]));
});

test("content: a table in @not-about", () => {
  assert(JSON.stringify(findingTypes(withSection("not-about", TABLE("A | B", "1 | 2")))) === JSON.stringify(["signpost-content"]));
});

test("content: a sub-scope inside a list item of @editing-guide", () => {
  assert(findingTypes(withSection("editing-guide", "        - Item {\n            # Sub {\n                X.\n            }\n          }")).includes("signpost-content"));
});

test("content: a blockquote in @editing-guide", () => {
  assert(findingTypes(withSection("editing-guide", "        > Quoted.")).includes("signpost-content"));
});

test("content: a paragraph in @related-resources", () => {
  const types = findingTypes(withSection("related-resources", "        These go together.\n\n" + TABLE("Resource | Relation", "[A](a.sdoc) | Sibling")));
  assert(JSON.stringify(types) === JSON.stringify(["signpost-content"]), JSON.stringify(types));
});

test("content: a list after the table in @reading-guide", () => {
  const types = findingTypes(withSection("reading-guide", TABLE("Sections | Note", "@intro | Start") + "\n\n        - Afterthought."));
  assert(JSON.stringify(types) === JSON.stringify(["signpost-content"]), JSON.stringify(types));
});

test("content: a code block before the table in @reading-guide", () => {
  const types = findingTypes(withSection("reading-guide", "        ```\n        x\n        ```\n\n" + TABLE("Sections | Note", "@intro | Start")));
  assert(JSON.stringify(types) === JSON.stringify(["signpost-content"]), JSON.stringify(types));
});

test("table: @reading-guide with prose but no table", () => {
  assert(JSON.stringify(findingTypes(withSection("reading-guide", "        Just prose."))) === JSON.stringify(["signpost-table"]));
});

test("content: a table written straight after an implicit list item belongs to that item", () => {
  // The parser attaches a block that follows "- item" to the item, so the
  // table is inside the list and the section has no table of its own.
  const types = findingTypes(withSection("reading-guide", "        - Dip in.\n" + TABLE("Sections | Note", "@intro | Start")));
  assert(types.includes("signpost-content") && types.includes("signpost-table"), JSON.stringify(types));
});

test("table: @related-resources with no table", () => {
  assert(findingTypes(withSection("related-resources", "        - [A](a.sdoc)")).includes("signpost-table"));
});

test("table: @related-resources with two tables", () => {
  const types = findingTypes(withSection("related-resources", TABLE("Resource | Relation", "[A](a.sdoc) | Sibling") + "\n" + TABLE("Resource | Relation", "[B](b.sdoc) | Sibling")));
  assert(JSON.stringify(types) === JSON.stringify(["signpost-table"]), JSON.stringify(types));
});

test("table: wrong header", () => {
  assert(JSON.stringify(findingTypes(withSection("related-resources", TABLE("Document | Why", "[A](a.sdoc) | Sibling")))) === JSON.stringify(["signpost-table"]));
});

test("table: header matches case-insensitively", () => {
  assert(findingTypes(withSection("related-resources", TABLE("resource | RELATION", "[A](a.sdoc) | Sibling"))).length === 0);
});

test("table: a headerless table fails the header rule", () => {
  const src = withSection("related-resources", "        {[table headerless]\n            [A](a.sdoc) | Sibling\n        }");
  assert(JSON.stringify(findingTypes(src)) === JSON.stringify(["signpost-table"]));
});

test("table: a row with three cells", () => {
  assert(JSON.stringify(findingTypes(withSection("related-resources", TABLE("Resource | Relation", "[A](a.sdoc) | Sibling | Extra")))) === JSON.stringify(["signpost-table"]));
});

test("table: an empty Relation cell", () => {
  const f = signpostFindings(withSection("related-resources", TABLE("Resource | Relation", "[A](a.sdoc) | ")));
  assert(f.length === 1 && f[0].type === "signpost-table" && /Relation/.test(f[0].message), JSON.stringify(f));
});

test("table: a Resource cell with two links", () => {
  assert(JSON.stringify(findingTypes(withSection("related-resources", TABLE("Resource | Relation", "[A](a.sdoc) [B](b.sdoc) | Siblings")))) === JSON.stringify(["signpost-table"]));
});

test("table: a Resource cell with plain text", () => {
  assert(JSON.stringify(findingTypes(withSection("related-resources", TABLE("Resource | Relation", "the spec | Sibling")))) === JSON.stringify(["signpost-table"]));
});

test("table: a Resource may be another SDOC document, any project file, or an external URL", () => {
  const rows = [
    "[Spec](spec.sdoc#grammar) | Normative source",
    "[Theme](../themes/default/theme.css) | Stylesheet the examples use",
    "https://github.com/entropicwarrior/sdoc | Upstream repository",
    "<https://example.com/docs> | Product documentation",
    "[Owner](mailto:docs@example.com) | Who to ask",
  ];
  const f = signpostFindings(withSection("related-resources", TABLE("Resource | Relation", ...rows)));
  assert(f.length === 0, JSON.stringify(f));
});

test("table: a Resource pointing into this document is rejected", () => {
  const f = signpostFindings(withSection("related-resources", TABLE("Resource | Relation", "[Intro](#intro) | Start here")));
  assert(f.length === 1 && f[0].type === "signpost-table" && /@reading-guide/.test(f[0].message), JSON.stringify(f));
});

test("table: a Resource given by an absolute path or a file: URL is rejected", () => {
  for (const row of ["[Hosts](/etc/hosts) | Absolute", "[Tmp](file:///tmp/x) | File URL", "[Win](C:\\docs\\x.sdoc) | Drive path"]) {
    const f = signpostFindings(withSection("related-resources", TABLE("Resource | Relation", row)));
    assert(f.length === 1 && /relative/.test(f[0].message), row + ": " + JSON.stringify(f));
  }
});

test("content: a link in @not-about is rejected, in a paragraph or a list item at any depth", () => {
  const cases = [
    "        Slides are covered in [Slide Authoring](slides.sdoc).",
    "        - Slides: see [Slide Authoring](slides.sdoc).",
    "        - Styling\n          {[.]\n            - Themes: https://example.com/themes\n          }",
  ];
  for (const body of cases) {
    const f = signpostFindings(withSection("not-about", body));
    assert(f.length === 1 && f[0].type === "signpost-content" && /holds no links/.test(f[0].message), body + ": " + JSON.stringify(f));
  }
});

test("content: @not-about giving reasons, with no links, is valid", () => {
  assert(signpostFindings(withSection("not-about", "        - Slides: they need their own layout rules.\n        - Theming: nobody has written it yet.")).length === 0);
});

test("content: links stay allowed in @about and @editing-guide", () => {
  assert(signpostFindings(withSection("about", "        See [the spec](spec.sdoc).")).length === 0);
  assert(signpostFindings(withSection("editing-guide", "        - Follow [the style guide](style.sdoc).")).length === 0);
});

test("content: a section reference in @about is an error, in a paragraph or a list item at any depth", () => {
  const cases = [
    "        Start with @intro.",
    "        - Covers usage, see @usage.",
    "        - Topics\n          {[.]\n            - Basics: read @intro first\n          }",
  ];
  for (const body of cases) {
    const f = signpostFindings(withSection("about", body));
    assert(f.length === 1 && f[0].type === "signpost-content" && f[0].severity === "error" && /no section references/.test(f[0].message), body + ": " + JSON.stringify(f));
  }
});

test("content: @about may mention an @id as code, escaped, or in an email address", () => {
  assert(signpostFindings(withSection("about", "        Defines the `@intro` scope and the \\@usage id. Mail docs@example.com.")).length === 0);
});

test("content: section references stay allowed in @editing-guide", () => {
  assert(signpostFindings(withSection("editing-guide", "        - Keep @intro and @usage in step.")).length === 0);
});

test("table: a Sections cell with a bare word", () => {
  assert(JSON.stringify(findingTypes(withSection("reading-guide", TABLE("Sections | Note", "@intro, usage | Start")))) === JSON.stringify(["signpost-table"]));
});

test("ref: a Sections reference that does not resolve is reported once, by validateRefs", () => {
  const src = withSection("reading-guide", TABLE("Sections | Note", "@intro, @nope | Start"));
  assert(signpostFindings(src).length === 0, JSON.stringify(signpostFindings(src)));
  const w = validateRefs(parseSdoc(src).nodes);
  assert(w.length === 1 && w[0].type === "broken-ref" && w[0].id === "nope", JSON.stringify(w));
});

test("ref: a Sections reference resolves by explicit @id", () => {
  assert(signpostFindings(withSection("reading-guide", TABLE("Sections | Note", "@intro, @usage | Start"))).length === 0);
});

test("ref: a Sections reference matching only a title slug is broken, and names the heading", () => {
  const src = "# Doc {\n    @reading-guide {\n        {[table]\n            Sections | Note\n            @intro | Start\n        }\n    }\n    # Intro {\n        A.\n    }\n}";
  assert(signpostFindings(src).length === 0, JSON.stringify(signpostFindings(src)));
  const w = validateRefs(parseSdoc(src).nodes);
  assert(w.length === 1 && w[0].type === "broken-ref" && w[0].id === "intro", JSON.stringify(w));
  assert(w[0].message.includes('matches the heading "Intro", which has no @id: add @intro to it'), w[0].message);
});

test("ref: a Sections reference to a reserved scope is rejected", () => {
  assert(JSON.stringify(findingTypes(withSection("reading-guide", TABLE("Sections | Note", "@reading-guide | Start")))) === JSON.stringify(["signpost-ref"]));
});

test("an empty table-model section is not reported", () => {
  assert(signpostFindings(withSection("related-resources", "")).length === 0);
});

// ============================================================
console.log("\n--- Signposts: order ---");

function orderFindings(src) {
  return validateSignposts(parseSdoc(src).nodes).filter((f) => f.type === "signpost-order");
}

test("RESERVED_ORDER is @meta then the signposts", () => {
  assert(JSON.stringify(RESERVED_ORDER) === JSON.stringify(["meta", "about", "not-about", "related-resources", "reading-guide", "editing-guide"]));
});

test("order: the conventional order has no warning", () => {
  assert(orderFindings("# Meta @meta {\n    type: doc\n}\n# Doc {\n    @about {\n        A.\n    }\n    @editing-guide {\n        - E.\n    }\n    # Body {\n        B.\n    }\n}").length === 0);
});

test("order: a signpost ranked below one before it is a warning on the later one", () => {
  const f = orderFindings("# Doc {\n    @editing-guide {\n        - E.\n    }\n    @about {\n        A.\n    }\n}");
  assert(f.length === 1 && f[0].id === "about" && f[0].lineStart === 5 && f[0].severity === "warning", JSON.stringify(f));
  assert(/should come before @editing-guide/.test(f[0].message));
});

test("order: a signpost after the body is a warning", () => {
  const f = orderFindings("# Doc {\n    # Body {\n        B.\n    }\n    @reading-guide {\n        Start.\n    }\n}");
  assert(f.length === 1 && f[0].id === "reading-guide" && /before the body/.test(f[0].message), JSON.stringify(f));
});

test("order: a paragraph before the signposts starts the body", () => {
  assert(orderFindings("# Doc {\n    Intro.\n\n    @about {\n        A.\n    }\n}").length === 1);
});

test("order: a :comment scope is neither body nor reserved", () => {
  assert(orderFindings("# Doc {\n    # Draft :comment {\n        Note.\n    }\n    @about {\n        A.\n    }\n    # Body {\n        B.\n    }\n}").length === 0);
});

test("order: @meta after a signpost is a warning on @meta", () => {
  const f = orderFindings("# Doc {\n    @about {\n        A.\n    }\n    @meta {\n        type: doc\n    }\n}");
  assert(f.length === 1 && f[0].id === "meta", JSON.stringify(f));
});

test("order: reserved scopes beside the root count in source order", () => {
  assert(orderFindings("@about {\n    A.\n}\n# Doc {\n    @editing-guide {\n        - E.\n    }\n    # Body {\n        B.\n    }\n}").length === 0);
  assert(orderFindings("@editing-guide {\n    - E.\n}\n# Doc {\n    @about {\n        A.\n    }\n}").length === 1);
});

test("order: a nested reserved id is an ordinary section, not out of order", () => {
  const f = validateSignposts(parseSdoc("# Doc {\n    # Body {\n        @about {\n            A.\n        }\n    }\n}").nodes);
  assert(JSON.stringify(f.map((x) => x.type)) === JSON.stringify(["reserved-scope-placement"]), JSON.stringify(f));
});

test("order: every other finding is an error", () => {
  const f = validateSignposts(parseSdoc("# Doc {\n    # Body {\n        @about {\n            A.\n        }\n    }\n    @not-about {\n        {[table]\n            A | B\n            1 | 2\n        }\n    }\n}").nodes);
  assert(f.length >= 2 && f.filter((x) => x.type !== "signpost-order").every((x) => x.severity === "error"), JSON.stringify(f));
});

// ============================================================
console.log("\n--- Signposts: fixSignpostOrder ---");

function expectFixed(src, expected) {
  const r = fixSignpostOrder(src);
  assert(r.changed === true, "should change; reason: " + r.reason);
  if (expected !== undefined) assert(r.text === expected, "got:\n" + r.text);
  assert(orderFindings(r.text).length === 0, "no order warning left");
  assert(fixSignpostOrder(r.text).changed === false, "fixing again changes nothing");
  return r.text;
}

test("fix: reorders, moves a signpost from after the body, and keeps a comment with its scope", () => {
  const src = "# Meta @meta {\n    sdoc-version: 0.2\n}\n# Doc {\n    @editing-guide {\n        - Keep it short.\n    }\n\n    // why this summary exists\n    @about {\n        Summary.\n    }\n    # Body @body {\n        Text.\n    }\n\n    # Start Here @reading-guide {\n        Start.\n    }\n}\n";
  const out = "# Meta @meta {\n    sdoc-version: 0.2\n}\n# Doc {\n    // why this summary exists\n    @about {\n        Summary.\n    }\n\n    # Start Here @reading-guide {\n        Start.\n    }\n\n    @editing-guide {\n        - Keep it short.\n    }\n\n    # Body @body {\n        Text.\n    }\n}\n";
  expectFixed(src, out);
});

test("fix: a signpost beside the root that must follow one inside moves into the root", () => {
  const out = expectFixed("@editing-guide {\n    - Rules.\n}\n\n# Doc {\n    @about {\n        Summary.\n    }\n    # Body {\n        Text.\n    }\n}\n");
  assert(out.startsWith("# Doc {\n    @about {"), "root first, @about inside it:\n" + out);
  assert(out.includes("    @editing-guide {\n        - Rules.\n    }"), "re-indented into the root:\n" + out);
});

test("fix: a signpost after the root moves into it, re-indented", () => {
  const out = expectFixed("# Doc {\n    @about {\n        Summary.\n    }\n    # Body {\n        Text.\n    }\n}\n\n@editing-guide {\n    - Rules.\n}\n");
  assert(out === "# Doc {\n    @about {\n        Summary.\n    }\n\n    @editing-guide {\n        - Rules.\n    }\n\n    # Body {\n        Text.\n    }\n}\n", "got:\n" + out);
});

test("fix: paragraphs either side of a moved signpost stay separate", () => {
  const out = expectFixed("# Doc {\n    Intro.\n    @about {\n        A.\n    }\n    More.\n}\n");
  const paragraphs = parseSdoc(out).nodes[0].children.filter((n) => n.type === "paragraph").map((n) => n.text);
  assert(JSON.stringify(paragraphs) === JSON.stringify(["Intro.", "More."]), JSON.stringify(paragraphs));
});

test("fix: refuses, with a reason, when moving text would change the structure", () => {
  const src = "# Doc {\n    Intro.\n\n    @about\n    Summary.\n}\n";
  const r = fixSignpostOrder(src);
  assert(r.changed === false && r.text === src && /structure/.test(r.reason), JSON.stringify(r));
});

test("fix: a document already in order is returned as it is", () => {
  const src = "# Doc {\n    @about {\n        A.\n    }\n    # Body {\n        B.\n    }\n}\n";
  const r = fixSignpostOrder(src);
  assert(r.changed === false && r.reason === null && r.text === src);
});

test("fix: keeps CRLF line endings and the trailing newline", () => {
  const out = expectFixed("# Doc {\r\n    # Body {\r\n        B.\r\n    }\r\n    @about {\r\n        A.\r\n    }\r\n}\r\n");
  assert(!/[^\r]\n/.test(out) && out.endsWith("}\r\n"), JSON.stringify(out));
});

test("fix: works on a document without a single root scope", () => {
  const out = expectFixed("# A {\n    a\n}\n@about {\n    Summary.\n}\n# B {\n    b\n}\n");
  assert(out.startsWith("@about {"), "got:\n" + out);
});

test("every .sdoc file in the repo passes validateSignposts", () => {
  const root = path.join(__dirname, "..");
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".sdoc")) files.push(full);
    }
  }
  for (const sub of ["lexica", "docs", "examples"]) walk(path.join(root, sub));
  assert(files.length > 10, "found the corpus");
  for (const file of files) {
    const r = parseSdoc(fs.readFileSync(file, "utf8"));
    const f = validateSignposts(r.nodes);
    assert(f.length === 0, path.relative(root, file) + ": " + f.map((x) => x.lineStart + " " + x.message).join("; "));
  }
});

// ============================================================
console.log("\n--- Root scope with scopes beside it ---");

// The class lists of the scope sections, in document order.
function sectionClasses(html) {
  return [...html.matchAll(/<section class="([^"]*)"/g)].map((m) => m[1]);
}

test("getDocumentScope: reserved and :comment scopes beside the root are set aside", () => {
  const nodes = parseSdoc("# Notes :comment {\n    Draft.\n}\n@about {\n    Summary.\n}\n# Doc {\n    Body.\n}\n@editing-guide {\n    Rules.\n}").nodes;
  const doc = getDocumentScope(nodes);
  assert(doc && doc.title === "Doc", "root found, got " + (doc && doc.title));
});

test("getDocumentScope: a paragraph or a second ordinary scope means no single root", () => {
  assert(getDocumentScope(parseSdoc("Intro.\n\n# Doc {\n    Body.\n}").nodes) === null, "paragraph beside");
  assert(getDocumentScope(parseSdoc("# A {\n    a\n}\n# B {\n    b\n}").nodes) === null, "two scopes");
  assert(getDocumentScope(parseSdoc("# Notes :comment {\n    Draft.\n}").nodes) === null, "a lone :comment is not a root");
});

test("foldRootSiblings: scopes before the root go first, scopes after it go last", () => {
  const nodes = parseSdoc("@about {\n    Summary.\n}\n# Doc {\n    # Intro {\n        A.\n    }\n}\n@editing-guide {\n    Rules.\n}").nodes;
  const folded = foldRootSiblings(nodes);
  assert(folded.length === 1 && folded[0].title === "Doc", "one root");
  const order = folded[0].children.map((n) => n.id || n.title);
  assert(JSON.stringify(order) === JSON.stringify(["about", "Intro", "editing-guide"]), JSON.stringify(order));
  assert(nodes[1].children.length === 1, "the parsed root is not changed");
});

test("foldRootSiblings: without a single root, or with nothing beside it, nodes come back as they are", () => {
  const twoScopes = parseSdoc("@about {\n    Summary.\n}\n# A {\n    a\n}\n# B {\n    b\n}").nodes;
  assert(foldRootSiblings(twoScopes) === twoScopes, "no single root");
  const alone = parseSdoc("# Doc {\n    Body.\n}").nodes;
  assert(foldRootSiblings(alone) === alone, "nothing beside");
});

test("HTML: @reading-guide beside the root renders inside it, not as the title", () => {
  const html = renderHtmlBody("@reading-guide {\n    Start with the intro.\n}\n# My Doc {\n    # Intro {\n        Hello.\n    }\n}");
  const classes = sectionClasses(html);
  assert(classes[0] === "sdoc-scope sdoc-root", "root first: " + JSON.stringify(classes));
  assert(classes.filter((c) => c.includes("sdoc-root")).length === 1, "one root: " + JSON.stringify(classes));
  assert(/sdoc-signpost-reading-guide"[^>]*>\s*<h2/.test(html), "the guide is a child of the root");
  assert(html.indexOf("Start with the intro") < html.indexOf("Hello."), "the guide keeps its place before the body");
});

test("HTML: a :comment scope beside the root leaves the root styling alone", () => {
  const html = renderHtmlBody("# Notes :comment {\n    Draft.\n}\n# My Doc {\n    Body.\n}");
  assert(sectionClasses(html)[0] === "sdoc-scope sdoc-root", JSON.stringify(sectionClasses(html)));
  assert(!html.includes("Draft."), "the comment is not rendered");
});

test("HTML: without a single root, a leading signpost does not take the title styling", () => {
  const html = renderHtmlBody("@reading-guide {\n    Guide.\n}\n# A {\n    a\n}\n# B {\n    b\n}");
  const classes = sectionClasses(html);
  assert(!classes.some((c) => c.includes("sdoc-root") && c.includes("sdoc-meta-section")), JSON.stringify(classes));
  assert(classes.filter((c) => c.includes("sdoc-root")).length === 1, "A is the title: " + JSON.stringify(classes));
});

test("extractMeta: @meta and a signpost beside the root leave a single root", () => {
  const r = extractMeta(parseSdoc("# Meta @meta {\n    sdoc-version: 0.2\n}\n@about {\n    Summary.\n}\n# Doc {\n    Body.\n}").nodes);
  assert(r.meta.properties["sdoc-version"] === "0.2", "meta read");
  assert(r.nodes.length === 1 && r.nodes[0].title === "Doc", "one root");
  assert(r.nodes[0].children[0].id === "about", "@about folded in first");
});

test("extractAbout: @meta beside the root does not hide an @about inside it", () => {
  const nodes = parseSdoc("# Meta @meta {\n    sdoc-version: 0.2\n}\n# Doc {\n    @about {\n        Summary.\n    }\n    Body.\n}").nodes;
  assert(extractAbout(nodes) === "Summary.", "got " + extractAbout(nodes));
});

test("validation: a :comment scope beside the root does not make signposts misplaced", () => {
  const src = "# Notes :comment {\n    Draft.\n}\n# Doc {\n    @about {\n        Summary.\n    }\n    Body.\n}";
  assert(signpostFindings(src).length === 0, JSON.stringify(signpostFindings(src)));
  assert(extractSignpost(parseSdoc(src).nodes, "about") !== null, "extracted");
});

test("validation: with @about beside the root and inside it, the later one is the duplicate", () => {
  const f = signpostFindings("@about {\n    One.\n}\n# Doc {\n    @about {\n        Two.\n    }\n}");
  assert(f.length === 1 && f[0].type === "reserved-scope-duplicate" && f[0].lineStart === 5, JSON.stringify(f));
});

// ============================================================
console.log("\n--- A reserved id below the top level is an ordinary scope ---");

const NESTED_RESERVED_SRC = "# Doc {\n    @related-resources {\n        {[table]\n            Resource | Relation\n            [Spec](spec.sdoc) | Source\n        }\n    }\n    # Body {\n        # Related Resources @related-resources {\n            - [A](a.sdoc)\n        }\n        Text.\n    }\n}";

test("stripSignposts drops the top-level signpost and keeps the nested one", () => {
  const doc = stripSignposts(parseSdoc(NESTED_RESERVED_SRC).nodes)[0];
  assert(!doc.children.some((n) => n.id === "related-resources"), "top-level @related-resources dropped");
  const body = doc.children.find((n) => n.title === "Body");
  assert(body.children.some((n) => n.id === "related-resources"), "nested one kept");
});

test("stripSignposts drops a signpost written beside the root", () => {
  const nodes = parseSdoc("@editing-guide {\n    Rules.\n}\n# Doc {\n    Body.\n}").nodes;
  const stripped = stripSignposts(nodes);
  assert(stripped.length === 1 && stripped[0].title === "Doc", JSON.stringify(stripped.map((n) => n.id || n.title)));
});

test("HTML export: the nested scope keeps its content and is not styled as a signpost", () => {
  const html = renderHtmlBody(NESTED_RESERVED_SRC);
  assert(!html.includes("spec.sdoc"), "the top-level @related-resources is hidden in exports");
  assert(html.includes("a.sdoc"), "the nested section is exported");
  assert((html.match(/sdoc-signpost/g) || []).length === 0, "no signpost styling");
});

test("HTML preview: only the top-level scope is styled as a signpost", () => {
  const html = renderHtmlBody(NESTED_RESERVED_SRC, { includeSignposts: true });
  assert((html.match(/sdoc-signpost-related-resources/g) || []).length === 1, "one signpost box");
  assert(html.includes("spec.sdoc") && html.includes("a.sdoc"), "both rendered");
});

test("listSections and extractSection find the nested scope", () => {
  const nodes = parseSdoc(NESTED_RESERVED_SRC).nodes;
  const titles = listSections(nodes).map((s) => s.title);
  assert(JSON.stringify(titles) === JSON.stringify(["Body", "Related Resources"]), JSON.stringify(titles));
  const section = extractSection(nodes, "related-resources");
  assert(section && section.content.includes("a.sdoc"), JSON.stringify(section));
});

test("listSections does not list what a top-level @meta contains", () => {
  const nodes = parseSdoc("# Doc {\n    # Meta @meta {\n        # Header {\n            Acme\n        }\n    }\n    # Body {\n        x\n    }\n}").nodes;
  const titles = listSections(nodes).map((s) => s.title);
  assert(JSON.stringify(titles) === JSON.stringify(["Body"]), JSON.stringify(titles));
});

test("validation: the placement finding says the scope is ordinary, and its content is checked", () => {
  const f = signpostFindings("# Doc {\n    # Body {\n        @about {\n            # Inner {\n                @editing-guide {\n                    Rules.\n                }\n            }\n        }\n    }\n}");
  assert(f.length === 2 && f.every((x) => x.type === "reserved-scope-placement"), JSON.stringify(f));
  assert(f[0].message.includes("an ordinary section, not a signpost"), f[0].message);
  assert(f[1].id === "editing-guide", "the scope inside the misplaced one is reported too");
});

test("validation: a misplaced @meta is ordinary, not configuration", () => {
  const f = signpostFindings("# Doc {\n    # Body {\n        @meta {\n            type: doc\n        }\n    }\n}");
  assert(f[0].message.includes("not configuration"), f[0].message);
});

// ============================================================
console.log("\n--- Mermaid diagrams ---");

test("mermaid code block renders as pre.mermaid", () => {
  const html = renderHtmlDocument("# Doc {\n    ```mermaid\n    graph LR\n      A --> B\n    ```\n}", "Test");
  assert(html.includes('class="mermaid"'), "should have pre.mermaid");
  assert(html.includes("graph LR"), "should have diagram content");
  assert(!html.includes('language-mermaid'), "should not have language-mermaid code block");
});

test("mermaid blocks trigger CDN script injection", () => {
  const html = renderHtmlDocument("# Doc {\n    ```mermaid\n    graph LR\n      A --> B\n    ```\n}", "Test");
  assert(html.includes("mermaid"), "should have mermaid script");
  assert(html.includes("cdn.jsdelivr.net"), "should include CDN URL");
});

test("no mermaid blocks means no mermaid script", () => {
  const html = renderHtmlDocument("# Doc {\n    ```javascript\n    const x = 1;\n    ```\n}", "Test");
  assert(!html.includes("mermaid.min.js"), "should not include mermaid script");
});

test("regular code blocks still render normally", () => {
  const html = renderHtmlDocument("# Doc {\n    ```javascript\n    const x = 1;\n    ```\n}", "Test");
  assert(html.includes('class="language-javascript"'), "should have language class");
  assert(html.includes("<code"), "should have code element");
});

test("mermaid theme defaults to neutral", () => {
  const text = "# Doc {\n    ```mermaid\n    graph LR\n      A --> B\n    ```\n}";
  const parsed = parseSdoc(text);
  const metaResult = extractMeta(parsed.nodes);
  const html = renderHtmlDocumentFromParsed(
    { nodes: metaResult.nodes, errors: parsed.errors },
    "Test",
    { meta: metaResult.meta }
  );
  assert(html.includes('theme:"neutral"'), "should default to neutral theme");
  assert(!html.includes("prefers-color-scheme"), "should not have auto detection");
});

test("mermaid theme dark produces theme:dark", () => {
  const text = "# Doc {\n    ```mermaid\n    graph LR\n      A --> B\n    ```\n}";
  const parsed = parseSdoc(text);
  const metaResult = extractMeta(parsed.nodes);
  const html = renderHtmlDocumentFromParsed(
    { nodes: metaResult.nodes, errors: parsed.errors },
    "Test",
    { meta: metaResult.meta, mermaidTheme: "dark" }
  );
  assert(html.includes('theme:"dark"'), "should use dark theme");
  assert(!html.includes("prefers-color-scheme"), "should not have auto detection");
});

test("mermaid theme auto uses matchMedia for prefers-color-scheme", () => {
  const text = "# Doc {\n    ```mermaid\n    graph LR\n      A --> B\n    ```\n}";
  const parsed = parseSdoc(text);
  const metaResult = extractMeta(parsed.nodes);
  const html = renderHtmlDocumentFromParsed(
    { nodes: metaResult.nodes, errors: parsed.errors },
    "Test",
    { meta: metaResult.meta, mermaidTheme: "auto" }
  );
  assert(html.includes('prefers-color-scheme:dark'), "should use matchMedia for dark detection");
  assert(html.includes('theme:isDark?"dark":"neutral"'), "should pick dark or neutral based on media query");
});

test("mermaid theme option has no effect without mermaid blocks", () => {
  const text = "# Doc {\n    Hello world\n}";
  const parsed = parseSdoc(text);
  const metaResult = extractMeta(parsed.nodes);
  const html = renderHtmlDocumentFromParsed(
    { nodes: metaResult.nodes, errors: parsed.errors },
    "Test",
    { meta: metaResult.meta, mermaidTheme: "dark" }
  );
  assert(!html.includes("mermaid.initialize"), "should not have mermaid init without mermaid blocks");
  assert(!html.includes("cdn.jsdelivr.net"), "should not include CDN URL");
});

// ============================================================
console.log("\n--- SVG diagrams ---");

test("svg code block renders as sdoc-svg-block", () => {
  const { nodes } = parseSdoc('# Doc {\n    ```svg\n    <svg viewBox="0 0 100 50"><rect width="100" height="50" fill="blue"/></svg>\n    ```\n}');
  const html = renderFragment(nodes, 2);
  assert(html.includes('class="sdoc-svg-block"'), "should have sdoc-svg-block wrapper");
  assert(html.includes('<svg viewBox="0 0 100 50">'), "should contain raw SVG");
  assert(!html.includes('language-svg'), "should not have language-svg code block");
  assert(!html.includes('sdoc-copy-btn'), "should not have copy button");
});

test("svg block strips script tags", () => {
  const { nodes } = parseSdoc('# Doc {\n    ```svg\n    <svg><script>alert("xss")</script><rect width="10" height="10"/></svg>\n    ```\n}');
  const html = renderFragment(nodes, 2);
  assert(!html.includes("<script"), "should strip script tags");
  assert(html.includes("<rect"), "should keep safe elements");
});

test("svg block strips foreignObject tags", () => {
  const html = renderHtmlDocument('# Doc {\n    ```svg\n    <svg><foreignObject><div>hack</div></foreignObject><circle r="5"/></svg>\n    ```\n}', "Test");
  assert(!html.includes("foreignObject"), "should strip foreignObject tags");
  assert(!html.includes("hack"), "should strip foreignObject content");
  assert(html.includes("<circle"), "should keep safe elements");
});

test("svg block does not trigger highlight.js", () => {
  const html = renderHtmlDocument('# Doc {\n    ```svg\n    <svg><rect width="10" height="10"/></svg>\n    ```\n}', "Test");
  assert(!html.includes("highlight.min.js"), "should not include highlight.js for svg");
});

test("sanitizeSvg strips multiline script", () => {
  const input = '<svg><script type="text/javascript">\nalert("xss");\n</script><rect/></svg>';
  const result = sanitizeSvg(input);
  assert(!result.includes("script"), "should strip multiline script");
  assert(result.includes("<rect/>"), "should keep safe elements");
});

test("sanitizeSvg strips self-closing script", () => {
  const result = sanitizeSvg('<svg><script /><rect/></svg>');
  assert(!result.includes("script"), "should strip self-closing script");
});

test("sanitizeSvg strips self-closing foreignObject", () => {
  const result = sanitizeSvg('<svg><foreignObject /><rect/></svg>');
  assert(!result.includes("foreignObject"), "should strip self-closing foreignObject");
});

test("sanitizeSvg is case-insensitive", () => {
  const result = sanitizeSvg('<svg><SCRIPT>alert(1)</SCRIPT><ForeignObject><div/></ForeignObject><rect/></svg>');
  assert(!result.includes("SCRIPT"), "should strip uppercase SCRIPT");
  assert(!result.includes("ForeignObject"), "should strip mixed-case foreignObject");
});

test("sanitizeSvg preserves safe SVG content", () => {
  const input = '<svg viewBox="0 0 200 100"><rect x="10" y="10" width="80" height="40" fill="#4a90d9" rx="5"/><text x="50" y="35" text-anchor="middle" fill="white">Hello</text><line x1="90" y1="30" x2="120" y2="30" stroke="#333"/></svg>';
  const result = sanitizeSvg(input);
  assert(result === input, "safe SVG should pass through unchanged");
});

test("sanitizeSvg strips onload attribute", () => {
  const result = sanitizeSvg('<svg onload="alert(1)"><rect/></svg>');
  assert(!result.includes("onload"), "should strip onload");
  assert(!result.includes("alert"), "should strip handler value");
  assert(result.includes("<rect/>"), "should keep safe elements");
});

test("sanitizeSvg strips onclick attribute", () => {
  const result = sanitizeSvg('<svg><rect onclick="alert(1)"/></svg>');
  assert(!result.includes("onclick"), "should strip onclick");
});

test("sanitizeSvg strips event handlers with single quotes", () => {
  const result = sanitizeSvg("<svg><rect onmouseover='alert(1)'/></svg>");
  assert(!result.includes("onmouseover"), "should strip single-quoted handler");
});

test("sanitizeSvg neutralizes javascript: href", () => {
  const result = sanitizeSvg('<svg><a href="javascript:alert(1)"><text>click</text></a></svg>');
  assert(!result.includes("javascript:"), "should neutralize javascript: URL");
  assert(result.includes("<text>click</text>"), "should keep child content");
});

test("sanitizeSvg neutralizes javascript: xlink:href", () => {
  const result = sanitizeSvg('<svg><a xlink:href="javascript:alert(1)"><text>click</text></a></svg>');
  assert(!result.includes("javascript:"), "should neutralize javascript: in xlink:href");
});

test("sanitizeSvg preserves safe href values", () => {
  const result = sanitizeSvg('<svg><a href="https://example.com"><text>link</text></a></svg>');
  assert(result.includes('href="https://example.com"'), "should preserve safe href");
});

test("sanitizeSvg enforces svg root", () => {
  const result = sanitizeSvg('<div>before</div><svg><rect/></svg><div>after</div>');
  assert(result.startsWith("<svg>"), "should start with svg");
  assert(result.endsWith("</svg>"), "should end with svg");
  assert(!result.includes("before"), "should discard content before svg");
  assert(!result.includes("after"), "should discard content after svg");
});

test("sanitizeSvg returns empty string for non-svg input", () => {
  assert(sanitizeSvg("<div>not svg</div>") === "", "should return empty for non-svg");
  assert(sanitizeSvg("") === "", "should return empty for empty string");
  assert(sanitizeSvg(null) === "", "should return empty for null");
});

// ============================================================
console.log("\n--- Syntax highlighting ---");

test("language-tagged code block injects highlight.js CDN script", () => {
  const html = renderHtmlDocument("# Doc {\n    ```javascript\n    const x = 1;\n    ```\n}", "Test");
  assert(html.includes("highlight.min.js"), "should include highlight.js script");
  assert(html.includes("highlightElement"), "should have highlightElement call");
});

test("highlight.js CSS is inlined in the style block", () => {
  const html = renderHtmlDocument("# Doc {\n    ```python\n    print('hi')\n    ```\n}", "Test");
  assert(html.includes(".hljs{"), "should include highlight.js CSS");
  assert(html.includes("prefers-color-scheme:dark"), "should include dark mode CSS");
});

test("code block without language tag does not trigger highlight.js", () => {
  const html = renderHtmlDocument("# Doc {\n    ```\n    plain code\n    ```\n}", "Test");
  assert(!html.includes("highlight.min.js"), "should not include highlight.js script");
  assert(!html.includes(".hljs{"), "should not include highlight.js CSS");
});

test("mermaid blocks do not trigger highlight.js", () => {
  const html = renderHtmlDocument("# Doc {\n    ```mermaid\n    graph LR\n      A --> B\n    ```\n}", "Test");
  assert(!html.includes("highlight.min.js"), "should not include highlight.js for mermaid");
});

test("math blocks do not trigger highlight.js", () => {
  const html = renderHtmlDocument("# Doc {\n    ```math\n    x^2\n    ```\n}", "Test");
  assert(!html.includes("highlight.min.js"), "should not include highlight.js for math");
});

test("document with no code blocks has no highlight.js", () => {
  const html = renderHtmlDocument("# Doc {\n    Hello world.\n}", "Test");
  assert(!html.includes("highlight.min.js"), "should not include highlight.js");
  assert(!html.includes(".hljs{"), "should not include highlight.js CSS");
});

test("highlight.js uses sdoc-code integration CSS override", () => {
  const html = renderHtmlDocument("# Doc {\n    ```javascript\n    const x = 1;\n    ```\n}", "Test");
  assert(html.includes(".sdoc-code code.hljs"), "should have sdoc-code hljs integration CSS");
});

test("image with percentage width", () => {
  const r = parseSdoc("# Doc {\n    ![photo](pic.png =50%)\n}");
  assert(r.errors.length === 0);
  const html = renderHtmlDocument("# Doc {\n    ![photo](pic.png =50%)\n}", "Test");
  assert(html.includes('style="width:50%"'), "should have width style");
  assert(html.includes('src="pic.png"'), "should have correct src");
  assert(html.includes('alt="photo"'), "should have correct alt");
});

test("image with pixel width", () => {
  const html = renderHtmlDocument("# Doc {\n    ![photo](pic.png =200px)\n}", "Test");
  assert(html.includes('style="width:200px"'), "should have pixel width");
});

test("image without width has no style", () => {
  const html = renderHtmlDocument("# Doc {\n    ![photo](pic.png)\n}", "Test");
  assert(!html.includes('style="width:'), "should not have width style");
});

test("image centered", () => {
  const html = renderHtmlDocument("# Doc {\n    ![photo](pic.png =50% center)\n}", "Test");
  assert(html.includes("width:50%"), "should have width");
  assert(html.includes("display:block"), "should be block");
  assert(html.includes("margin-left:auto"), "should be centered");
  assert(html.includes("margin-right:auto"), "should be centered");
});

test("image left aligned", () => {
  const html = renderHtmlDocument("# Doc {\n    ![photo](pic.png =40% left)\n}", "Test");
  assert(html.includes("float:left"), "should float left");
});

test("image right aligned", () => {
  const html = renderHtmlDocument("# Doc {\n    ![photo](pic.png =40% right)\n}", "Test");
  assert(html.includes("float:right"), "should float right");
});

test("image width without alignment stays inline", () => {
  const html = renderHtmlDocument("# Doc {\n    ![photo](pic.png =50%)\n}", "Test");
  assert(!html.includes("display:block"), "should not be block");
  assert(!html.includes("float:"), "should not float");
});

test("two images side by side", () => {
  const html = renderHtmlDocument("# Doc {\n    ![a](a.png =48%) ![b](b.png =48%)\n}", "Test");
  assert(html.includes('style="width:48%"'), "should have width");
  // Both images should render
  assert(html.includes('src="a.png"'), "first image");
  assert(html.includes('src="b.png"'), "second image");
});

// ============================================================
console.log("\n--- Table row lines ---");

test("a table records the source line of each row, skipping blank lines", () => {
  const table = parseSdoc("{[table]\n    H | V\n    a | 1\n\n    b | 2\n}").nodes[0];
  assert(JSON.stringify(table.rowLines) === "[3,5]", JSON.stringify(table.rowLines));
});

test("rowLines leaves out the header and a column directive row, and keeps a headerless first row", () => {
  const withDirective = parseSdoc("{[table]\n    H | V\n    < | >\n    a | 1\n}").nodes[0];
  assert(withDirective.rows.length === 1 && JSON.stringify(withDirective.rowLines) === "[4]", JSON.stringify(withDirective));
  const headerless = parseSdoc("{[table headerless]\n    a | 1\n    b | 2\n}").nodes[0];
  assert(JSON.stringify(headerless.rowLines) === "[2,3]", JSON.stringify(headerless.rowLines));
});

const ROW_LINES_SRC = "# Doc {\n    @reading-guide {\n        {[table]\n            Sections | Note\n            @a | one\n\n            @b, @reading-guide | two\n            bad |\n        }\n    }\n    @related-resources {\n        {[table]\n            Resource | Relation\n            [A](a.sdoc) | Sibling\n            [B](b.sdoc) | Other\n        }\n    }\n    # A @a {\n        x\n    }\n    # B @b {\n        y\n    }\n}";

test("extractReadingGuide and extractRelatedResources give each row its own line", () => {
  const nodes = parseSdoc(ROW_LINES_SRC).nodes;
  assert(JSON.stringify(extractReadingGuide(nodes).entries.map((e) => e.lineStart)) === "[5,7]");
  assert(JSON.stringify(extractRelatedResources(nodes).map((e) => e.lineStart)) === "[14,15]");
});

test("validation: a finding about a row points at that row", () => {
  const f = validateSignposts(parseSdoc(ROW_LINES_SRC).nodes).filter((x) => x.type !== "signpost-order");
  const at = f.map((x) => [x.type, x.lineStart, x.lineEnd]);
  assert(JSON.stringify(at) === JSON.stringify([["signpost-ref", 7, 7], ["signpost-table", 8, 8]]), JSON.stringify(at));
});

test("validateRefs: a broken reference in a table cell points at its row", () => {
  const w = validateRefs(parseSdoc("# Doc {\n    # A @a {\n        x\n    }\n    {[table]\n        H | V\n        @a | ok\n        @missing | bad\n    }\n}").nodes);
  assert(w.length === 1 && w[0].lineStart === 8 && w[0].lineEnd === 8, JSON.stringify(w));
});

test("fixSignpostOrder moves a signpost holding a table", () => {
  const r = fixSignpostOrder("# Doc {\n    # Body {\n        B.\n    }\n    @related-resources {\n        {[table]\n            Resource | Relation\n            [A](a.sdoc) | Sibling\n        }\n    }\n}\n");
  assert(r.changed === true, JSON.stringify(r));
  assert(r.text.indexOf("@related-resources") < r.text.indexOf("# Body"), r.text);
});

// ============================================================
console.log("\n--- Table options ---");

test("borderless table", () => {
  const r = parseSdoc("{[table borderless]\n  Name | Age\n  Alice | 30\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].type === "table");
  assert(r.nodes[0].options && r.nodes[0].options.borderless === true);
  const html = renderHtmlDocument("# Doc {\n    {[table borderless]\n        Name | Age\n        Alice | 30\n    }\n}", "Test");
  assert(html.includes("sdoc-table-borderless"), "should have borderless class");
});

test("headerless table", () => {
  const r = parseSdoc("{[table headerless]\n  A | B\n  C | D\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].type === "table");
  assert(r.nodes[0].headers.length === 0, "headerless table should have no headers");
  assert(r.nodes[0].rows.length === 2, "all rows should be data rows");
  assert(r.nodes[0].rows[0][0] === "A");
});

test("borderless headerless table", () => {
  const r = parseSdoc("{[table borderless headerless]\n  A | B\n  C | D\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].headers.length === 0);
  assert(r.nodes[0].options.borderless === true);
  assert(r.nodes[0].options.headerless === true);
  const html = renderHtmlDocument("# Doc {\n    {[table borderless headerless]\n        A | B\n        C | D\n    }\n}", "Test");
  assert(html.includes("sdoc-table-borderless"), "borderless class");
  assert(html.includes("sdoc-table-headerless"), "headerless class");
  assert(!html.includes("<thead"), "no thead for headerless");
});

test("plain table still works", () => {
  const r = parseSdoc("{[table]\n  Name | Age\n  Alice | 30\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].headers[0] === "Name");
  assert(r.nodes[0].rows[0][0] === "Alice");
});

test("K&R table with options", () => {
  const r = parseSdoc("# Data {[table borderless]\n  Name | Age\n  Alice | 30\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].children[0].type === "table");
  assert(r.nodes[0].children[0].options.borderless === true);
});

// --- Table width and alignment ---

test("table with auto width", () => {
  const r = parseSdoc("{[table auto]\n  Name | Age\n  Alice | 30\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].options.width === "auto");
});

test("table with percentage width", () => {
  const r = parseSdoc("{[table 60%]\n  Name | Age\n  Alice | 30\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].options.width === "60%");
});

test("table with decimal percentage width", () => {
  const r = parseSdoc("{[table 33.3%]\n  Name | Age\n  Alice | 30\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].options.width === "33.3%");
});

test("table with pixel width", () => {
  const r = parseSdoc("{[table 400px]\n  Name | Age\n  Alice | 30\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].options.width === "400px");
});

test("table with center alignment", () => {
  const r = parseSdoc("{[table center]\n  Name | Age\n  Alice | 30\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].options.align === "center");
});

test("table with right alignment", () => {
  const r = parseSdoc("{[table right]\n  Name | Age\n  Alice | 30\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].options.align === "right");
});

test("table with width and alignment combined", () => {
  const r = parseSdoc("{[table 60% center]\n  Name | Age\n  Alice | 30\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].options.width === "60%");
  assert(r.nodes[0].options.align === "center");
});

test("table with auto width and right alignment and borderless", () => {
  const r = parseSdoc("{[table auto right borderless]\n  A | B\n  C | D\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].options.width === "auto");
  assert(r.nodes[0].options.align === "right");
  assert(r.nodes[0].options.borderless === true);
});

test("render table with width style", () => {
  const html = renderHtmlDocument("# Doc {\n    {[table 60%]\n        Name | Age\n        Alice | 30\n    }\n}", "Test");
  assert(html.includes("width:60%"), "should have width style");
  assert(html.includes("table-layout:fixed"), "explicit width should use fixed layout");
});

test("render table with center alignment", () => {
  const html = renderHtmlDocument("# Doc {\n    {[table auto center]\n        Name | Age\n        Alice | 30\n    }\n}", "Test");
  assert(html.includes("width:auto"), "should have auto width");
  assert(!html.includes("table-layout:fixed"), "auto width should not use fixed layout");
  assert(html.includes("margin-left:auto"), "should have margin-left:auto");
  assert(html.includes("margin-right:auto"), "should have margin-right:auto");
});

test("render table with right alignment", () => {
  const html = renderHtmlDocument("# Doc {\n    {[table 400px right]\n        Name | Age\n        Alice | 30\n    }\n}", "Test");
  assert(html.includes("width:400px"), "should have pixel width");
  assert(html.includes("table-layout:fixed"), "pixel width should use fixed layout");
  assert(html.includes("margin-left:auto"), "should have margin-left:auto");
  assert(html.includes("margin-right:0"), "should have margin-right:0");
});

test("plain table has no inline style", () => {
  const html = renderHtmlDocument("# Doc {\n    {[table]\n        Name | Age\n        Alice | 30\n    }\n}", "Test");
  assert(!html.includes('style='), "plain table should have no inline style");
});

test("K&R table with width and alignment", () => {
  const r = parseSdoc("# Data {[table 60% center]\n  Name | Age\n  Alice | 30\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].children[0].type === "table");
  assert(r.nodes[0].children[0].options.width === "60%");
  assert(r.nodes[0].children[0].options.align === "center");
});

// --- renderHtmlBody ---

test("renderHtmlBody returns fragment without DOCTYPE", () => {
  const html = renderHtmlBody("# Hello {\n    World\n}");
  assert(!html.includes("<!DOCTYPE"), "should not contain DOCTYPE");
  assert(!html.includes("<html"), "should not contain <html>");
  assert(!html.includes("<head"), "should not contain <head>");
  assert(!html.includes("<body"), "should not contain <body>");
});

test("renderHtmlBody produces structural HTML", () => {
  const html = renderHtmlBody("# Doc {\n    A paragraph.\n\n    - Item one\n    - Item two\n}");
  assert(html.includes("<h1"), "should contain heading");
  assert(html.includes("<p"), "should contain paragraph");
  assert(html.includes("<li"), "should contain list items");
});

test("renderHtmlBody strips meta scope", () => {
  const html = renderHtmlBody("@meta {\n    sdoc-version: 0.2\n}\n# Doc {\n    Content\n}");
  assert(!html.includes("sdoc-version"), "meta content should not appear in body");
  assert(html.includes("Content"), "body content should appear");
});

// ============================================================
console.log("\n--- Code block include syntax ---");

test("code block with src attribute", () => {
  const r = parseSdoc("# Doc {\n    ```json src:./data.json\n    ignored body\n    ```\n}");
  assert(r.errors.length === 0);
  const code = r.nodes[0].children[0];
  assert(code.type === "code");
  assert(code.lang === "json");
  assert(code.src === "./data.json");
});

test("code block with src and lines", () => {
  const r = parseSdoc("# Doc {\n    ```json src:./data.json lines:10-20\n    body\n    ```\n}");
  assert(r.errors.length === 0);
  const code = r.nodes[0].children[0];
  assert(code.src === "./data.json");
  assert(code.lines.start === 10);
  assert(code.lines.end === 20);
});

test("code block with src only (no lang)", () => {
  const r = parseSdoc("# Doc {\n    ```src:./file.txt\n    body\n    ```\n}");
  assert(r.errors.length === 0);
  const code = r.nodes[0].children[0];
  assert(code.src === "./file.txt");
  assert(code.lang === undefined);
});

test("code block with URL src", () => {
  const r = parseSdoc("# Doc {\n    ```json src:https://example.com/schema.json\n    body\n    ```\n}");
  assert(r.errors.length === 0);
  const code = r.nodes[0].children[0];
  assert(code.src === "https://example.com/schema.json");
  assert(code.lang === "json");
});

test("code block without src has no src field", () => {
  const r = parseSdoc("# Doc {\n    ```javascript\n    const x = 1;\n    ```\n}");
  assert(r.errors.length === 0);
  const code = r.nodes[0].children[0];
  assert(code.src === undefined, "plain code block should not have src");
  assert(code.lang === "javascript");
});

// ============================================================
console.log("\n--- sdoc-version warnings ---");

test("warning when @meta exists but sdoc-version is missing", () => {
  const r = parseSdoc("# Meta @meta\n{\n    type: doc\n}\n# Body\n{\n    Content.\n}");
  const result = extractMeta(r.nodes);
  assert(result.warnings.length === 1, "expected 1 warning, got " + result.warnings.length);
  assert(result.warnings[0].includes("Missing sdoc-version"), "warning should mention sdoc-version");
});

test("no warning when sdoc-version is present", () => {
  const r = parseSdoc("# Meta @meta\n{\n    type: doc\n\n    sdoc-version: 0.1\n}\n# Body\n{\n    Content.\n}");
  const result = extractMeta(r.nodes);
  assert(result.warnings.length === 0, "expected no warnings, got " + result.warnings.length);
});

test("no warning when there is no @meta scope", () => {
  const r = parseSdoc("# Doc\n{\nContent.\n}");
  const result = extractMeta(r.nodes);
  assert(result.warnings.length === 0, "expected no warnings, got " + result.warnings.length);
});

test("SDOC_FORMAT_VERSION is exported and equals 0.2", () => {
  assert(SDOC_FORMAT_VERSION === "0.2", "expected 0.2, got " + SDOC_FORMAT_VERSION);
});

// ============================================================
console.log("\n--- Math / KaTeX ---");

test("inline math parsing", () => {
  const nodes = parseInline("The formula $x^2$ is simple.");
  const mathNode = nodes.find(n => n.type === "math_inline");
  assert(mathNode, "should have math_inline node");
  assert(mathNode.value === "x^2", "value should be x^2, got: " + mathNode.value);
});

test("display math parsing", () => {
  const nodes = parseInline("See $$E = mc^2$$ here.");
  const mathNode = nodes.find(n => n.type === "math_display");
  assert(mathNode, "should have math_display node");
  assert(mathNode.value === "E = mc^2", "value should be E = mc^2");
});

test("lone $ is not math ($100)", () => {
  const nodes = parseInline("It costs $100.");
  const mathNode = nodes.find(n => n.type === "math_inline");
  assert(!mathNode, "$100 should not trigger math");
});

test("whitespace after opening $ prevents math", () => {
  const nodes = parseInline("$ x$ is not math.");
  const mathNode = nodes.find(n => n.type === "math_inline");
  assert(!mathNode, "$ x$ should not trigger math");
});

test("whitespace before closing $ prevents math", () => {
  const nodes = parseInline("$x $ is not math.");
  const mathNode = nodes.find(n => n.type === "math_inline");
  assert(!mathNode, "$x $ should not trigger math");
});

test("escaped dollar is literal", () => {
  const html = renderHtmlDocument("# Doc {\n    Price is \\$100.\n}", "Test");
  assert(html.includes("$100"), "should contain literal $100");
  assert(!html.includes("sdoc-math"), "should not have math class");
});

test("inline math renders with sdoc-math-inline class", () => {
  const html = renderHtmlDocument("# Doc {\n    The formula $x^2$ works.\n}", "Test");
  assert(html.includes("sdoc-math-inline"), "should have sdoc-math-inline class");
});

test("display math renders with sdoc-math-display class", () => {
  const html = renderHtmlDocument("# Doc {\n    Here: $$E = mc^2$$\n}", "Test");
  assert(html.includes("sdoc-math-display"), "should have sdoc-math-display class");
});

test("math code block renders as sdoc-math-block", () => {
  const html = renderHtmlDocument("# Doc {\n    ```math\n    \\int_0^1 x^2 dx\n    ```\n}", "Test");
  assert(html.includes("sdoc-math-block"), "should have sdoc-math-block class");
  assert(!html.includes('<button class="sdoc-copy-btn"'), "math block should not have copy button element");
});

test("KaTeX CSS injected when math present", () => {
  const html = renderHtmlDocument("# Doc {\n    Formula: $x^2$\n}", "Test");
  assert(html.includes("katex"), "should reference katex CSS");
  assert(html.includes("cdn.jsdelivr.net"), "should include CDN URL");
});

test("KaTeX CSS not injected when no math", () => {
  const html = renderHtmlDocument("# Doc {\n    No math here.\n}", "Test");
  assert(!html.includes("katex.min.css"), "should not include katex CSS");
});

test("renderKatex fallback when KaTeX unavailable", () => {
  // We can't easily test the fallback without unloading KaTeX,
  // but we can verify renderKatex produces valid output
  const output = renderKatex("x^2", false);
  assert(output.includes("katex") || output.includes("sdoc-math-fallback"), "should produce katex or fallback output");
});

test("adjacent dollar signs $$ start display math, not inline", () => {
  const nodes = parseInline("$$x$$");
  const displayNode = nodes.find(n => n.type === "math_display");
  const inlineNode = nodes.find(n => n.type === "math_inline");
  assert(displayNode, "should parse as display math");
  assert(!inlineNode, "should not parse as inline math");
});

// ============================================================
// Semantic Markers
// ============================================================

test("positive marker renders with correct class", () => {
  const html = renderHtmlDocument("# T\n{\nResult: {+passed+}\n}", "Test");
  assert(html.includes("sdoc-mark-positive") && html.includes(">passed</span>"), "should render positive marker");
});

test("neutral marker renders with correct class", () => {
  const html = renderHtmlDocument("# T\n{\nStatus: {=info=}\n}", "Test");
  assert(html.includes("sdoc-mark-neutral") && html.includes(">info</span>"), "should render neutral marker");
});

test("note marker renders with correct class", () => {
  const html = renderHtmlDocument("# T\n{\nNote: {^note^}\n}", "Test");
  assert(html.includes("sdoc-mark-note") && html.includes(">note</span>"), "should render note marker");
});

test("caution marker renders with correct class", () => {
  const html = renderHtmlDocument("# T\n{\nCaution: {?caution?}\n}", "Test");
  assert(html.includes("sdoc-mark-caution") && html.includes(">caution</span>"), "should render caution marker");
});

test("warning marker renders with correct class", () => {
  const html = renderHtmlDocument("# T\n{\nAlert: {!warning!}\n}", "Test");
  assert(html.includes("sdoc-mark-warning") && html.includes(">warning</span>"), "should render warning marker");
});

test("negative marker renders with correct class", () => {
  const html = renderHtmlDocument("# T\n{\nResult: {-failed-}\n}", "Test");
  assert(html.includes("sdoc-mark-negative") && html.includes(">failed</span>"), "should render negative marker");
});

test("nested bold inside marker", () => {
  const html = renderHtmlDocument("# T\n{\nResult: {+**bold** text+}\n}", "Test");
  assert(html.includes("<strong>bold</strong> text</span>"), "should render bold inside marker");
});

test("nested emphasis inside marker", () => {
  const html = renderHtmlDocument("# T\n{\nResult: {+*em* text+}\n}", "Test");
  assert(html.includes("<em>em</em> text</span>"), "should render emphasis inside marker");
});

test("unclosed marker falls through as plain text", () => {
  const nodes = parseInline("{+unclosed");
  assert(nodes.length === 1 && nodes[0].type === "text", "should be plain text");
  assert(nodes[0].value === "{+unclosed", "should preserve original text");
});

test("escaped marker delimiter prevents marker", () => {
  const nodes = parseInline("\\{+text+}");
  const hasMarker = nodes.some(n => n.type === "mark_positive");
  assert(!hasMarker, "should not create marker when escaped");
});

test("marker uses <mark> element", () => {
  const html = renderHtmlDocument("# T\n{\nResult: {+ok+}\n}", "Test");
  assert(html.includes("sdoc-mark"), "should use sdoc-mark class");
});

test("multiple markers on one line", () => {
  const html = renderHtmlDocument("# T\n{\nResults: {+pass+} and {^careful^} and {?caution?} and {-fail-}\n}", "Test");
  assert(html.includes("sdoc-mark-positive"), "should have positive marker");
  assert(html.includes("sdoc-mark-note"), "should have note marker");
  assert(html.includes("sdoc-mark-caution"), "should have caution marker");
  assert(html.includes("sdoc-mark-negative"), "should have negative marker");
});

test("highlight marker renders with <mark> element", () => {
  const html = renderHtmlDocument("# T\n{\nNote: {~important~}\n}", "Test");
  assert(html.includes("sdoc-mark-highlight") && html.includes(">important</mark>"), "should render highlight with <mark>");
});

test("parseInline produces correct node types for markers", () => {
  const types = [
    ["{+text+}", "mark_positive"],
    ["{=text=}", "mark_neutral"],
    ["{^text^}", "mark_note"],
    ["{?text?}", "mark_caution"],
    ["{!text!}", "mark_warning"],
    ["{-text-}", "mark_negative"],
    ["{~text~}", "mark_highlight"],
  ];
  for (const [input, expected] of types) {
    const nodes = parseInline(input);
    assert(nodes.length === 1, `should parse ${input} as single node`);
    assert(nodes[0].type === expected, `${input} should produce ${expected}, got ${nodes[0].type}`);
  }
});

// ============================================================
console.log("\n--- Scope Types ---");

test(":type after @id", () => {
  const r = parseSdoc("# Auth @auth :requirement\n{\n  Content.\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].title === "Auth");
  assert(r.nodes[0].id === "auth");
  assert(r.nodes[0].scopeType === "requirement");
});

test(":type without @id", () => {
  const r = parseSdoc("# Schema :schema\n{\n  Content.\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].title === "Schema");
  assert(r.nodes[0].id === undefined);
  assert(r.nodes[0].scopeType === "schema");
});

test("@id without :type", () => {
  const r = parseSdoc("# Section @sec\n{\n  Content.\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].title === "Section");
  assert(r.nodes[0].id === "sec");
  assert(r.nodes[0].scopeType === undefined);
});

test(":type before @id", () => {
  const r = parseSdoc("# Endpoint :api @ep\n{\n  Content.\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].title === "Endpoint");
  assert(r.nodes[0].id === "ep");
  assert(r.nodes[0].scopeType === "api");
});

test("colon in title is NOT a type (no whitespace before colon)", () => {
  const r = parseSdoc("# Note: Important\n{\n  Content.\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].title === "Note: Important");
  assert(r.nodes[0].scopeType === undefined);
});

test("unknown scope types preserved", () => {
  const r = parseSdoc("# Custom :foobar\n{\n  Content.\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].scopeType === "foobar");
});

test("well-known types work", () => {
  for (const t of ["schema", "example", "requirement", "deprecated", "comment"]) {
    const r = parseSdoc(`# Section :${t}\n{\n  Content.\n}`);
    assert(r.errors.length === 0, `errors for :${t}`);
    assert(r.nodes[0].scopeType === t, `type for :${t}`);
  }
});

test("KNOWN_SCOPE_TYPES exported", () => {
  assert(Array.isArray(KNOWN_SCOPE_TYPES));
  assert(KNOWN_SCOPE_TYPES.includes("schema"));
  assert(KNOWN_SCOPE_TYPES.includes("comment"));
});

test("scope type with K&R brace style", () => {
  const r = parseSdoc("# Auth @auth :requirement {\n  Content.\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].title === "Auth");
  assert(r.nodes[0].id === "auth");
  assert(r.nodes[0].scopeType === "requirement");
});

test("scope type in braceless scope", () => {
  const r = parseSdoc("# Title :note\n\nSome content.");
  assert(r.errors.length === 0);
  assert(r.nodes[0].scopeType === "note");
  assert(r.nodes[0].title === "Title");
});

test("scope type in implicit root", () => {
  const r = parseSdoc("# Doc :specification\n\n# Sub\n{\n  Content.\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].scopeType === "specification");
});

test("listSections returns scopeType", () => {
  const r = parseSdoc("# Doc\n{\n  # Sub :schema\n  {\n    Content.\n  }\n}");
  const sections = listSections(r.nodes);
  const sub = sections.find(s => s.title === "Sub");
  assert(sub, "Sub section exists");
  assert(sub.scopeType === "schema", "scopeType is schema");
});

test("listSections returns null scopeType when absent", () => {
  const r = parseSdoc("# Doc\n{\n  # Sub\n  {\n    Content.\n  }\n}");
  const sections = listSections(r.nodes);
  const sub = sections.find(s => s.title === "Sub");
  assert(sub.scopeType === null);
});

test("colon without space before is not a type (Title:type)", () => {
  const r = parseSdoc("# Title:type\n{\n  Content.\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].title === "Title:type");
  assert(r.nodes[0].scopeType === undefined);
});

test("multiple :type annotations — last one wins", () => {
  const r = parseSdoc("# Title :type1 :type2\n{\n  Content.\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].scopeType === "type2", "last :type wins");
  assert(r.nodes[0].title === "Title :type1", "earlier :type remains in title");
});

test("bare colon at end of title is not a type", () => {
  const r = parseSdoc("# Title :\n{\n  Content.\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].title === "Title :");
  assert(r.nodes[0].scopeType === undefined);
});

test("escaped colon is not a scope type", () => {
  const r = parseSdoc("# Title \\:type\n{\n  Content.\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].scopeType === undefined, "escaped colon should not produce scopeType");
  assert(r.nodes[0].title.includes(":type"), "colon should remain in title");
});

// ============================================================
console.log("\n--- Line Comments ---");

test("// line skipped in braced scope", () => {
  const r = parseSdoc("# Doc\n{\n  // This is a comment\n  Visible text.\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].children.length === 1);
  assert(r.nodes[0].children[0].text === "Visible text.");
});

test("// line skipped in braceless scope", () => {
  const r = parseSdoc("# Doc\n\n// invisible\nVisible text.");
  assert(r.errors.length === 0);
  const children = r.nodes[0].children;
  assert(children.length === 1, "should have 1 child, got " + children.length);
  assert(children[0].text === "Visible text.");
});

test("// in code block preserved as raw text", () => {
  const r = parseSdoc("# Doc\n{\n  ```\n  // code comment\n  ```\n}");
  assert(r.errors.length === 0);
  const code = r.nodes[0].children[0];
  assert(code.type === "code");
  assert(code.text.includes("// code comment"));
});

test("// mid-line is paragraph text (not a comment)", () => {
  const r = parseSdoc("# Doc\n{\n  See https://example.com for details.\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].children[0].text.includes("https://example.com"));
});

test("// with leading whitespace is still a comment", () => {
  const r = parseSdoc("# Doc\n{\n    // indented comment\n  Content.\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].children.length === 1);
  assert(r.nodes[0].children[0].text === "Content.");
});

test("multiple // lines all skipped", () => {
  const r = parseSdoc("# Doc\n{\n  // line 1\n  // line 2\n  Visible.\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].children.length === 1);
  assert(r.nodes[0].children[0].text === "Visible.");
});

test("// as only content produces empty scope", () => {
  const r = parseSdoc("# Doc\n{\n  //\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].children.length === 0, "comment-only scope should have no children");
});

test("bare // with no trailing text is a comment", () => {
  const r = parseSdoc("# Doc\n{\n  //\n  Visible.\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].children.length === 1);
  assert(r.nodes[0].children[0].text === "Visible.");
});

test("// between paragraph lines joins them", () => {
  const r = parseSdoc("# Doc\n{\n  Line one\n  // comment\n  line two\n}");
  assert(r.errors.length === 0);
  assert(r.nodes[0].children.length === 1);
  assert(r.nodes[0].children[0].text === "Line one line two");
});

// ============================================================
console.log("\n--- Data Blocks ---");

test(":data flag parsed from fence metadata", () => {
  const r = parseSdoc('# Doc\n{\n  ```json :data\n  {"key": "value"}\n  ```\n}');
  assert(r.errors.length === 0);
  const code = r.nodes[0].children[0];
  assert(code.type === "code");
  assert(code.dataFlag === true);
  assert(code.lang === "json");
});

test("valid JSON parsed into data field", () => {
  const r = parseSdoc('# Doc\n{\n  ```json :data\n  {"key": "value"}\n  ```\n}');
  assert(r.errors.length === 0);
  const code = r.nodes[0].children[0];
  assert(code.data !== undefined, "data should be present");
  assert(code.data.key === "value");
});

test("invalid JSON produces error", () => {
  const r = parseSdoc('# Doc\n{\n  ```json :data\n  {invalid json}\n  ```\n}');
  assert(r.errors.length === 1, "expected 1 error, got " + r.errors.length);
  assert(r.errors[0].message.includes("Invalid JSON"));
  const code = r.nodes[0].children[0];
  assert(code.dataFlag === true);
  assert(code.data === undefined);
});

test("data field absent without :data flag", () => {
  const r = parseSdoc('# Doc\n{\n  ```json\n  {"key": "value"}\n  ```\n}');
  assert(r.errors.length === 0);
  const code = r.nodes[0].children[0];
  assert(code.dataFlag === undefined);
  assert(code.data === undefined);
});

test(":data on non-json language does not parse", () => {
  const r = parseSdoc('# Doc\n{\n  ```yaml :data\n  key: value\n  ```\n}');
  assert(r.errors.length === 0);
  const code = r.nodes[0].children[0];
  assert(code.dataFlag === true);
  assert(code.data === undefined);
});

test("extractSection returns data array for sections with :data blocks", () => {
  const r = parseSdoc('# Doc\n{\n  # Schema @schema :schema\n  {\n    ```json :data\n    {"type": "object"}\n    ```\n  }\n}');
  const section = extractSection(r.nodes, "schema");
  assert(section !== null);
  assert(Array.isArray(section.data), "data should be array");
  assert(section.data.length === 1);
  assert(section.data[0].type === "object");
});

test("extractSection omits data key when no :data blocks", () => {
  const r = parseSdoc("# Doc\n{\n  # Sub @sub\n  {\n    Plain text.\n  }\n}");
  const section = extractSection(r.nodes, "sub");
  assert(section !== null);
  assert(section.data === undefined, "data should be undefined when no :data blocks");
});

test("extractDataBlocks returns all data blocks with scope context", () => {
  const r = parseSdoc('# Doc\n{\n  # Schema @input :schema\n  {\n    ```json :data\n    {"type": "object"}\n    ```\n  }\n  # Config @cfg :config\n  {\n    ```json :data\n    {"debug": true}\n    ```\n  }\n}');
  const blocks = extractDataBlocks(r.nodes);
  assert(blocks.length === 2, "expected 2 data blocks, got " + blocks.length);
  assert(blocks[0].scopeId === "input");
  assert(blocks[0].scopeType === "schema");
  assert(blocks[0].data.type === "object");
  assert(blocks[1].scopeId === "cfg");
  assert(blocks[1].scopeType === "config");
  assert(blocks[1].data.debug === true);
});

test("extractDataBlocks returns empty array when no data blocks", () => {
  const r = parseSdoc("# Doc\n{\n  Content.\n}");
  const blocks = extractDataBlocks(r.nodes);
  assert(Array.isArray(blocks));
  assert(blocks.length === 0);
});

test(":data with empty fence content produces error", () => {
  const r = parseSdoc('# Doc\n{\n  ```json :data\n  ```\n}');
  assert(r.errors.length === 1, "expected 1 error, got " + r.errors.length);
  assert(r.errors[0].message.includes("Invalid JSON"));
  assert(r.nodes[0].children[0].dataFlag === true);
  assert(r.nodes[0].children[0].data === undefined);
});

test(":data with deeply nested JSON", () => {
  const r = parseSdoc('# Doc\n{\n  ```json :data\n  {"a": {"b": {"c": [1, 2, 3]}}}\n  ```\n}');
  assert(r.errors.length === 0);
  const data = r.nodes[0].children[0].data;
  assert(data.a.b.c[0] === 1);
  assert(data.a.b.c.length === 3);
});

test(":data with src: does not attempt JSON parse at parse time", () => {
  const r = parseSdoc('# Doc\n{\n  ```json :data src:schema.json\n  ```\n}');
  assert(r.errors.length === 0, "should not emit error for :data + src:");
  const code = r.nodes[0].children[0];
  assert(code.dataFlag === true);
  assert(code.src === "schema.json");
  assert(code.data === undefined, "data not populated until resolveIncludes");
});

test("extractDataBlocks finds data blocks in deeply nested scopes", () => {
  const r = parseSdoc('# Doc\n{\n  # Outer @outer\n  {\n    # Inner @inner :config\n    {\n      ```json :data\n      {"nested": true}\n      ```\n    }\n  }\n}');
  const blocks = extractDataBlocks(r.nodes);
  assert(blocks.length === 1);
  assert(blocks[0].scopeId === "inner");
  assert(blocks[0].scopeType === "config");
  assert(blocks[0].data.nested === true);
});

test("extractDataBlocks includes data from :comment scopes", () => {
  const r = parseSdoc('# Doc\n{\n  # Notes :comment\n  {\n    ```json :data\n    {"hidden": true}\n    ```\n  }\n}');
  const blocks = extractDataBlocks(r.nodes);
  assert(blocks.length === 1, "data blocks in comment scopes should be extracted");
  assert(blocks[0].scopeType === "comment");
  assert(blocks[0].data.hidden === true);
});

// ============================================================
console.log("\n--- Comment Scopes ---");

test(":comment scope in AST", () => {
  const r = parseSdoc("# Doc\n{\n  # Notes :comment\n  {\n    Agent notes.\n  }\n}");
  assert(r.errors.length === 0);
  const notes = r.nodes[0].children.find(c => c.scopeType === "comment");
  assert(notes !== undefined, "comment scope should be in AST");
  assert(notes.title === "Notes");
});

test(":comment scope not rendered in HTML", () => {
  const r = parseSdoc("# Doc\n{\n  # Notes :comment\n  {\n    Agent notes.\n  }\n  # Visible\n  {\n    Content.\n  }\n}");
  const html = renderFragment(r.nodes);
  assert(!html.includes("Agent notes"), "comment content should not render");
  assert(html.includes("Content."), "visible content should render");
});

test(":comment scope still extractable via extractSection", () => {
  const r = parseSdoc("# Doc\n{\n  # Notes @notes :comment\n  {\n    Agent notes.\n  }\n}");
  const section = extractSection(r.nodes, "notes");
  assert(section !== null);
  assert(section.content.includes("Agent notes"));
});

test(":comment scope visible in listSections", () => {
  const r = parseSdoc("# Doc\n{\n  # Notes :comment\n  {\n    Agent notes.\n  }\n}");
  const sections = listSections(r.nodes);
  const notes = sections.find(s => s.scopeType === "comment");
  assert(notes !== undefined, "comment scope should appear in listSections");
});

// ============================================================
console.log("\n--- HTML Rendering with Scope Types ---");

test("scope type adds data-scope-type attribute", () => {
  const r = parseSdoc("# Requirements :requirement\n{\n  Content.\n}");
  const html = renderFragment(r.nodes);
  assert(html.includes('data-scope-type="requirement"'), "should have data-scope-type attr");
});

test("scope type adds CSS class", () => {
  const r = parseSdoc("# Schema :schema\n{\n  Content.\n}");
  const html = renderFragment(r.nodes);
  assert(html.includes("sdoc-scope-type-schema"), "should have scope type CSS class");
});

test("data block renders with data label", () => {
  const r = parseSdoc('# Doc\n{\n  ```json :data\n  {"key": "value"}\n  ```\n}');
  const html = renderFragment(r.nodes);
  assert(html.includes("sdoc-data-label"), "should have data label");
  assert(html.includes(">data<"), "label should say 'data'");
});

test("regular code block has no data label", () => {
  const r = parseSdoc('# Doc\n{\n  ```json\n  {"key": "value"}\n  ```\n}');
  const html = renderFragment(r.nodes);
  assert(!html.includes("sdoc-data-label"), "should not have data label");
});

// ============================================================
console.log("\n--- Document Formatter — v0.2 features ---");

test("formatSdoc preserves scope type annotation", () => {
  const out = formatSdoc("# Title :schema\n{\nContent.\n}", "    ");
  const lines = out.split("\n");
  assert(lines[0] === "# Title :schema", "scope type should be preserved, got: " + lines[0]);
});

test("formatSdoc preserves comment lines", () => {
  const out = formatSdoc("# Doc\n{\n// a comment\nContent.\n}", "    ");
  const lines = out.split("\n");
  assert(lines[2] === "    // a comment", "comment should be indented, got: " + lines[2]);
});

test("formatSdoc preserves :comment scope structure", () => {
  const out = formatSdoc("# Doc\n{\n# Notes :comment\n{\nAgent notes.\n}\n}", "    ");
  const lines = out.split("\n");
  assert(lines[2] === "    # Notes :comment", "got: " + lines[2]);
  assert(lines[3] === "    {");
  assert(lines[4] === "        Agent notes.");
  assert(lines[5] === "    }");
});

// ============================================================
console.log("\n--- Reference & Link Validation ---");

test("broken @ref detected", () => {
  const parsed = parseSdoc("# Doc @doc\n{\n  See @nonexistent for details.\n}");
  const metaResult = extractMeta(parsed.nodes);
  const warnings = validateRefs(metaResult.nodes);
  assert(warnings.length === 1, "expected 1 warning, got " + warnings.length);
  assert(warnings[0].type === "broken-ref");
  assert(warnings[0].id === "nonexistent");
});

test("valid @ref not flagged (explicit @id)", () => {
  const parsed = parseSdoc("# Doc @doc\n{\n  # Section @my-section\n  {\n    Content.\n  }\n  See @my-section for details.\n}");
  const metaResult = extractMeta(parsed.nodes);
  const warnings = validateRefs(metaResult.nodes);
  assert(warnings.length === 0, "expected 0 warnings, got " + warnings.length);
});

test("a @ref matching only a title slug is broken, and names the heading to give the @id", () => {
  const parsed = parseSdoc("# Doc @doc\n{\n  # My Section\n  {\n    Content.\n  }\n  See @my-section for details.\n}");
  const metaResult = extractMeta(parsed.nodes);
  const warnings = validateRefs(metaResult.nodes);
  assert(warnings.length === 1 && warnings[0].type === "broken-ref" && warnings[0].id === "my-section", JSON.stringify(warnings));
  assert(warnings[0].message.includes('matches the heading "My Section", which has no @id: add @my-section to it'), warnings[0].message);
});

test("a @ref matching the title slug of a heading with another @id names that @id", () => {
  const parsed = parseSdoc("# Doc @doc\n{\n  # Table Formulas @formulas\n  {\n    Content.\n  }\n  See @table-formulas for details.\n}");
  const warnings = validateRefs(extractMeta(parsed.nodes).nodes);
  assert(warnings.length === 1 && warnings[0].message.includes("whose @id is @formulas"), JSON.stringify(warnings));
});

test("a @ref that matches nothing has no hint", () => {
  const warnings = validateRefs(parseSdoc("# Doc @doc\n{\n  See @nowhere.\n}").nodes);
  assert(warnings.length === 1 && warnings[0].message === "Broken reference: @nowhere does not match any scope @id", JSON.stringify(warnings));
});

test("absolute URLs skipped", () => {
  const parsed = parseSdoc("# Doc @doc\n{\n  Visit [Google](https://google.com) for search.\n}");
  const metaResult = extractMeta(parsed.nodes);
  const warnings = validateRefs(metaResult.nodes, { resolveFilePath: () => false });
  assert(warnings.length === 0, "expected 0 warnings for absolute URL, got " + warnings.length);
});

test("broken relative link detected", () => {
  const parsed = parseSdoc("# Doc @doc\n{\n  See [guide](./missing-file.sdoc) for details.\n}");
  const metaResult = extractMeta(parsed.nodes);
  const warnings = validateRefs(metaResult.nodes, { resolveFilePath: () => false });
  assert(warnings.length === 1, "expected 1 warning, got " + warnings.length);
  assert(warnings[0].type === "broken-link");
  assert(warnings[0].href === "./missing-file.sdoc");
});

test("valid relative link not flagged", () => {
  const parsed = parseSdoc("# Doc @doc\n{\n  See [guide](./existing-file.sdoc) for details.\n}");
  const metaResult = extractMeta(parsed.nodes);
  const warnings = validateRefs(metaResult.nodes, { resolveFilePath: () => true });
  assert(warnings.length === 0, "expected 0 warnings, got " + warnings.length);
});

test("mailto and #anchor links skipped", () => {
  const parsed = parseSdoc("# Doc @doc\n{\n  Email [us](mailto:hi@test.com) or jump to [top](#doc).\n}");
  const metaResult = extractMeta(parsed.nodes);
  const warnings = validateRefs(metaResult.nodes, { resolveFilePath: () => false });
  assert(warnings.length === 0, "expected 0 warnings for mailto/anchor, got " + warnings.length);
});

test("broken ref in preview gets sdoc-broken-ref CSS class", () => {
  const parsed = parseSdoc("# Doc @doc\n{\n  See @bogus for details.\n}");
  const metaResult = extractMeta(parsed.nodes);
  const html = renderHtmlDocumentFromParsed(
    { nodes: metaResult.nodes, errors: parsed.errors },
    "Test",
    { renderOptions: { brokenRefIds: new Set(["bogus"]) } }
  );
  assert(html.includes("sdoc-broken-ref"), "expected sdoc-broken-ref class in output");
  assert(html.includes("sdoc-broken-icon"), "expected warning icon in output");
});

test("broken link in preview gets sdoc-broken-link CSS class", () => {
  const parsed = parseSdoc("# Doc @doc\n{\n  See [guide](./missing.sdoc) for details.\n}");
  const metaResult = extractMeta(parsed.nodes);
  const html = renderHtmlDocumentFromParsed(
    { nodes: metaResult.nodes, errors: parsed.errors },
    "Test",
    { renderOptions: { brokenLinkHrefs: new Set(["./missing.sdoc"]) } }
  );
  assert(html.includes("sdoc-broken-link"), "expected sdoc-broken-link class in output");
  assert(html.includes("sdoc-broken-icon"), "expected warning icon in output");
});

test("collectAllIds includes explicit IDs and derived slugs", () => {
  const parsed = parseSdoc("# Doc @doc\n{\n  # My Section @explicit\n  {\n    Content.\n  }\n  # Another Title\n  {\n    More.\n  }\n}");
  const ids = collectAllIds(parsed.nodes);
  assert(ids.has("doc"), "should have 'doc'");
  assert(ids.has("explicit"), "should have 'explicit'");
  assert(ids.has("my-section"), "should have derived slug 'my-section'");
  assert(ids.has("another-title"), "should have derived slug 'another-title'");
});

test("broken ref inside list item detected", () => {
  const parsed = parseSdoc("# Doc @doc\n{\n  {[.]\n    - See @nonexistent for details\n  }\n}");
  const metaResult = extractMeta(parsed.nodes);
  const warnings = validateRefs(metaResult.nodes);
  assert(warnings.length === 1, "expected 1 warning for ref in list item, got " + warnings.length);
  assert(warnings[0].id === "nonexistent");
});

test("valid ref inside list item not flagged", () => {
  const parsed = parseSdoc("# Doc @doc\n{\n  # Setup @setup\n  { Content. }\n  {[.]\n    - See @setup for details\n  }\n}");
  const metaResult = extractMeta(parsed.nodes);
  const warnings = validateRefs(metaResult.nodes);
  assert(warnings.length === 0, "expected 0 warnings, got " + warnings.length);
});

test("collectAllIds finds IDs nested inside list item children", () => {
  const parsed = parseSdoc("# Doc @doc\n{\n  {[.]\n    - Item\n    {\n      # Nested @nested-id\n      { Content. }\n    }\n  }\n}");
  const ids = collectAllIds(parsed.nodes);
  assert(ids.has("nested-id"), "should have 'nested-id' from inside list item");
});

test("relative link with fragment does not false-positive", () => {
  const parsed = parseSdoc("# Doc @doc\n{\n  See [guide](./exists.sdoc#section) for details.\n}");
  const metaResult = extractMeta(parsed.nodes);
  const warnings = validateRefs(metaResult.nodes, {
    resolveFilePath: (p) => p === "./exists.sdoc"
  });
  assert(warnings.length === 0, "expected 0 warnings for link with fragment, got " + warnings.length);
});

test("relative link with query string strips query for resolution", () => {
  const parsed = parseSdoc("# Doc @doc\n{\n  See [api](./api.sdoc?v=2) for details.\n}");
  const metaResult = extractMeta(parsed.nodes);
  const warnings = validateRefs(metaResult.nodes, {
    resolveFilePath: (p) => p === "./api.sdoc"
  });
  assert(warnings.length === 0, "expected 0 warnings for link with query, got " + warnings.length);
});

test("hrefPathExists tries the href as written, then percent-decoded", () => {
  const { hrefPathExists } = require("../src/href-path.js");
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "sdoc-href-"));
  try {
    fs.writeFileSync(path.join(dir, "report%20v2.sdoc"), "");
    fs.writeFileSync(path.join(dir, "space name.sdoc"), "");
    fs.writeFileSync(path.join(dir, "100%.sdoc"), "");
    assert(hrefPathExists("report%20v2.sdoc", dir), "a literal percent sequence in the file name");
    assert(hrefPathExists("space%20name.sdoc", dir), "an encoded space");
    assert(hrefPathExists("100%.sdoc", dir), "a malformed sequence is tried as written");
    assert(!hrefPathExists("missing.sdoc", dir), "a missing file");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================
console.log("\n--- Table Formulas ---");

test("SUM of a column", () => {
  const html = renderHtmlBody("# T {[table]\nA | B\nx | 10\ny | 20\nz | 30\nTotal | =SUM(B1:B3)\n}");
  assert(html.includes(">60<"), "expected 60, got: " + html);
  assert(html.includes("sdoc-formula-cell"), "expected formula-cell class");
  assert(html.includes('title="=SUM(B1:B3)"'), "expected title with formula");
});

test("SUM of percentages displays as percentage", () => {
  const html = renderHtmlBody("# T {[table]\nName | Share\nA | 25%\nB | 50%\nC | 25%\nTotal | =SUM(B1:B3)\n}");
  assert(html.includes(">100%<"), "expected 100%, got: " + html);
});

test("AVG function", () => {
  const html = renderHtmlBody("# T {[table]\nA | B\nx | 10\ny | 20\nz | 30\nAvg | =AVG(B1:B3)\n}");
  assert(html.includes(">20<"), "expected 20");
});

test("COUNT function", () => {
  const html = renderHtmlBody("# T {[table]\nA | B\nx | 10\ny | 20\nz | 30\nN | =COUNT(B1:B3)\n}");
  assert(html.includes(">3<"), "expected 3");
});

test("basic arithmetic: addition", () => {
  const html = renderHtmlBody("# T {[table]\nA | B\nx | 10\ny | 20\nSum | =B1+B2\n}");
  assert(html.includes(">30<"), "expected 30");
});

test("basic arithmetic: multiplication", () => {
  const html = renderHtmlBody("# T {[table]\nA | B\nx | 5\ny | =B1*3\n}");
  assert(html.includes(">15<"), "expected 15");
});

test("basic arithmetic: division", () => {
  const html = renderHtmlBody("# T {[table]\nA | B\nx | 100\ny | =B1/4\n}");
  assert(html.includes(">25<"), "expected 25");
});

test("division by zero gives #DIV/0!", () => {
  const html = renderHtmlBody("# T {[table]\nA | B\nx | 10\ny | =B1/0\n}");
  assert(html.includes("#DIV/0!"), "expected #DIV/0!");
  assert(html.includes("sdoc-formula-error"), "expected error class");
});

test("out-of-bounds reference gives #VALUE!", () => {
  const html = renderHtmlBody("# T {[table]\nA | B\nx | 10\ny | =Z99\n}");
  assert(html.includes("sdoc-formula-error"), "expected error class");
});

test("unary minus", () => {
  const html = renderHtmlBody("# T {[table]\nA | B\nx | 10\ny | =-B1\n}");
  assert(html.includes(">-10<"), "expected -10");
});

test("escaped equals is not a formula", () => {
  const html = renderHtmlBody("# T {[table]\nA | B\nx | \\=SUM(B1:B1)\n}");
  assert(!html.includes("sdoc-formula-cell"), "should not be a formula cell");
});

test("formula referencing another formula", () => {
  const html = renderHtmlBody("# T {[table]\nA | B\nx | 10\ny | =B1*2\nz | =B1+B2\n}");
  assert(html.includes(">20<"), "expected 20 for B1*2");
  assert(html.includes(">30<"), "expected 30 for B1+B2");
});

test("numbers with commas parsed correctly", () => {
  const html = renderHtmlBody("# T {[table]\nA | B\nx | 1,000,000\ny | 500,000\nTotal | =SUM(B1:B2)\n}");
  assert(html.includes("1,500,000"), "expected 1,500,000");
});

test("headerless table formulas work", () => {
  const html = renderHtmlBody("# T {[table headerless]\n10 | 20\n30 | =SUM(A1:A2)\n}");
  assert(html.includes(">40<"), "expected 40");
});

test("cap table example", () => {
  const doc = `# Cap Table {[table]
    Investor | Shares | Ownership
    Seed Fund | 500,000 | 25%
    Founder A | 1,000,000 | 50%
    Founder B | 500,000 | 25%
    **Total** | =SUM(B1:B3) | =SUM(C1:C3)
}`;
  const html = renderHtmlBody(doc);
  assert(html.includes("2,000,000"), "expected 2,000,000 total shares");
  assert(html.includes("100%"), "expected 100% total ownership");
});

test("circular reference gives #CIRCULAR!", () => {
  const html = renderHtmlBody("# T {[table]\nA | B\n=B1 | =A1\n}");
  assert(html.includes("#CIRCULAR!"), "expected #CIRCULAR! for circular refs");
  assert(html.includes("sdoc-formula-error"), "expected error class");
});

test("operator precedence: multiplication before addition", () => {
  const html = renderHtmlBody("# T {[table]\nA\n=2+3*4\n}");
  assert(html.includes(">14<"), "expected 14 (not 20), got: " + html);
});

test("parentheses override precedence", () => {
  const html = renderHtmlBody("# T {[table]\nA\n=(2+3)*4\n}");
  assert(html.includes(">20<"), "expected 20");
});

test("malformed decimal gives #SYNTAX!", () => {
  const html = renderHtmlBody("# T {[table]\nA\n=1.2.3\n}");
  assert(html.includes("sdoc-formula-error"), "expected error for malformed decimal");
});

test("mixed percentage and number arithmetic", () => {
  const html = renderHtmlBody("# T {[table]\nA | B\n100 | 50%\nR | =A1*B1\n}");
  assert(html.includes(">50<"), "expected 50 (100 * 0.5)");
});

test("lowercase function name gives error", () => {
  const html = renderHtmlBody("# T {[table]\nA | B\nx | 10\ny | =sum(B1:B1)\n}");
  assert(html.includes("sdoc-formula-error"), "expected error for lowercase function");
});

// ============================================================
console.log("\n--- Column Directives: Alignment ---");

test("alignment row parsed for normal table", () => {
  const r = parseSdoc("{[table]\n  Name | Amount\n  < | >\n  Alice | 100\n}");
  assert(r.errors.length === 0, "no errors");
  const t = r.nodes[0];
  assert(t.type === "table");
  assert(t.headers.length === 2, "two headers");
  assert(t.rows.length === 1, "directive row consumed, one data row");
  assert(t.columnAlign[0] === "left", "first col left");
  assert(t.columnAlign[1] === "right", "second col right");
});

test("center alignment with =", () => {
  const r = parseSdoc("{[table]\n  A | B | C\n  < | = | >\n  x | y | z\n}");
  const t = r.nodes[0];
  assert(t.columnAlign[1] === "center", "center col");
  assert(t.rows.length === 1, "one data row");
});

test("alignment row renders text-align styles", () => {
  const html = renderHtmlBody("# T {[table]\nA | B\n< | >\nx | 10\n}");
  assert(html.includes('style="text-align:right"'), "expected right align style");
  assert(!html.includes('style="text-align:left"'), "left is default, no explicit style");
});

test("alignment applies to header cells too", () => {
  const html = renderHtmlBody("# T {[table]\nName | Amount\n< | >\nAlice | 100\n}");
  assert(html.includes('<th class="sdoc-table-th" style="text-align:right"'), "header gets right align");
});

test("no directive row means no columnAlign", () => {
  const r = parseSdoc("{[table]\n  A | B\n  x | y\n}");
  const t = r.nodes[0];
  assert(!t.columnAlign, "no columnAlign");
  assert(!t.columnFormat, "no columnFormat");
});

test("headerless table with directive row", () => {
  const r = parseSdoc("{[table headerless]\n  < | >\n  Alice | 100\n  Bob | 200\n}");
  const t = r.nodes[0];
  assert(t.headers.length === 0, "no headers");
  assert(t.rows.length === 2, "two data rows, directive consumed");
  assert(t.columnAlign[0] === "left");
  assert(t.columnAlign[1] === "right");
});

test("headerless alignment renders correctly", () => {
  const html = renderHtmlBody("# T {[table headerless]\n< | >\nAlice | 100\nBob | 200\n}");
  assert(html.includes('style="text-align:right"'), "right align in headerless");
  assert(!html.includes("<thead"), "no thead for headerless");
});

test("data row that looks like directives is NOT consumed", () => {
  // A row with content beyond alignment chars should not be treated as directives
  const r = parseSdoc("{[table]\n  A | B\n  left | right\n  x | y\n}");
  const t = r.nodes[0];
  assert(!t.columnAlign, "no columnAlign for text data");
  assert(t.rows.length === 2, "both data rows preserved");
});

test("partial directive row — empty cells fill with null", () => {
  const r = parseSdoc("{[table]\n  A | B | C\n  > | | =\n  x | y | z\n}");
  const t = r.nodes[0];
  assert(t.columnAlign[0] === "right");
  assert(t.columnAlign[1] === null, "empty cell → null");
  assert(t.columnAlign[2] === "center");
});

// ============================================================
console.log("\n--- Column Directives: Formatting ---");

test("currency format on column", () => {
  const html = renderHtmlBody("# T {[table]\nItem | Amount\n< | > $\nWidget | 1000000\n}");
  assert(html.includes("$1,000,000"), "expected formatted currency");
});

test("currency format with decimals", () => {
  const html = renderHtmlBody("# T {[table]\nItem | Price\n< | $.2\nWidget | 1234.5\n}");
  assert(html.includes("$1,234.50"), "expected $1,234.50");
});

test("thousands separator format", () => {
  const html = renderHtmlBody("# T {[table]\nItem | Count\n< | ,\nWidget | 1234567\n}");
  assert(html.includes("1,234,567"), "expected thousands separated");
});

test("thousands with decimals", () => {
  const html = renderHtmlBody("# T {[table]\nItem | Value\n< | ,.2\nWidget | 1234567.891\n}");
  assert(html.includes("1,234,567.89"), "expected ,.2 format");
});

test("fixed decimals format", () => {
  const html = renderHtmlBody("# T {[table]\nItem | Score\n< | .3\nA | 3.14159\n}");
  assert(html.includes("3.142"), "expected 3 decimal places");
});

test("percentage format", () => {
  const html = renderHtmlBody("# T {[table]\nItem | Rate\n< | %\nA | 0.452\n}");
  assert(html.includes("45.2%"), "expected 45.2%");
});

test("percentage format with fixed decimals", () => {
  const html = renderHtmlBody("# T {[table]\nItem | Rate\n< | %.1\nA | 0.4567\n}");
  assert(html.includes("45.7%"), "expected 45.7% (1 decimal)");
});

test("format applies to formula results", () => {
  const html = renderHtmlBody("# T {[table]\nItem | Amount\n< | > $\nA | 1000000\nB | 2000000\nTotal | =SUM(B1:B2)\n}");
  assert(html.includes("$3,000,000"), "expected formatted formula result");
  assert(html.includes("$1,000,000"), "expected formatted data cell");
});

test("format does not affect text cells", () => {
  const html = renderHtmlBody("# T {[table]\nItem | Amount\n< | $\n**Total** | 1000\n}");
  assert(html.includes("<strong>Total</strong>"), "text cell still renders inline");
  assert(html.includes("$1,000"), "numeric cell gets formatted");
});

test("format does not affect formula errors", () => {
  const html = renderHtmlBody("# T {[table]\nA | B\n< | $\nx | =Z99\n}");
  assert(html.includes("sdoc-formula-error"), "error still shown");
});

test("format on headerless table", () => {
  const html = renderHtmlBody("# T {[table headerless]\n> $\n1000000\n2000000\n}");
  assert(html.includes("$1,000,000"), "formatted in headerless");
  assert(html.includes("$2,000,000"), "both rows formatted");
});

test("alignment + format combined in directive cell", () => {
  const r = parseSdoc("{[table]\n  A | B\n  < | > $\n  x | 100\n}");
  const t = r.nodes[0];
  assert(t.columnAlign[1] === "right", "right aligned");
  assert(t.columnFormat[1].prefix === "$", "currency format");
  assert(t.columnFormat[1].thousands === true, "thousands separator");
});

test("formula with format preserves tooltip", () => {
  const html = renderHtmlBody("# T {[table]\nA | B\n< | $\nx | 1000\nTotal | =SUM(B1:B1)\n}");
  assert(html.includes('title="=SUM(B1:B1)"'), "tooltip preserved");
  assert(html.includes("$1,000"), "formatted result");
});

test("K&R table with directives", () => {
  const r = parseSdoc("# Data {[table]\nA | B\n< | >\nx | 10\n}");
  const t = r.nodes[0].children[0];
  assert(t.columnAlign[0] === "left");
  assert(t.columnAlign[1] === "right");
  assert(t.rows.length === 1);
});

test("directive row with only format, no alignment", () => {
  const r = parseSdoc("{[table]\n  A | B\n  | $\n  x | 1000\n}");
  const t = r.nodes[0];
  assert(!t.columnAlign, "no alignment directives");
  assert(t.columnFormat[1].prefix === "$", "format parsed");
});

test("numbers with commas still parsed for formatting", () => {
  const html = renderHtmlBody("# T {[table]\nItem | Amount\n< | $.2\nA | 1,000,000\n}");
  assert(html.includes("$1,000,000.00"), "comma-number reformatted with spec");
});

test("negative numbers formatted correctly", () => {
  const html = renderHtmlBody("# T {[table]\nA | B\n< | $\nx | 1000\ny | -500\n}");
  assert(html.includes("$1,000"), "positive formatted");
  assert(html.includes("-$500"), "negative with prefix");
});

test("bare email auto-detection", () => {
  const html = renderHtmlBody("# T {\n    Contact us at hello@example.com for help.\n}");
  assert(html.includes('href="mailto:hello@example.com"'), "expected mailto link");
  assert(html.includes(">hello@example.com<"), "expected email text");
});

// ============================================================
console.log("\n--- Citations: Parsing ---");

test("citations block parses entries", () => {
  const r = parseSdoc("# T {\n    {[citations]\n        - @smith Smith, 2020.\n        - @jones Jones, 2021.\n    }\n}");
  assert(r.errors.length === 0, "no errors");
  const cite = r.nodes[0].children[0];
  assert(cite.type === "citations", "type is citations");
  assert(cite.entries.length === 2, "two entries");
  assert(cite.entries[0].key === "smith", "first key");
  assert(cite.entries[0].text === "Smith, 2020.", "first text");
  assert(cite.entries[1].key === "jones", "second key");
});

test("citations block with multi-line entry text", () => {
  const r = parseSdoc("# T {\n    {[citations]\n        - @report Author, \"A Very Long Title\n          That Continues on the Next Line,\" 2025.\n    }\n}");
  assert(r.errors.length === 0, "no errors");
  const cite = r.nodes[0].children[0];
  assert(cite.entries.length === 1, "one entry");
  assert(cite.entries[0].text.includes("That Continues"), "multi-line text joined");
});

test("citations block invalid entry produces error", () => {
  const r = parseSdoc("# T {\n    {[citations]\n        Not a valid citation.\n    }\n}");
  assert(r.errors.length === 1, "one error");
  assert(r.errors[0].message.includes("Invalid citation entry"), "error message");
});

test("citations block empty is valid", () => {
  const r = parseSdoc("# T {\n    {[citations]\n    }\n}");
  assert(r.errors.length === 0, "no errors");
  const cite = r.nodes[0].children[0];
  assert(cite.type === "citations", "type is citations");
  assert(cite.entries.length === 0, "empty");
});

console.log("\n--- Citations: Inline References ---");

test("[@key] parsed as citation_ref", () => {
  const nodes = parseInline("See [@smith2020] for details.");
  assert(nodes.length === 3, "three nodes");
  assert(nodes[1].type === "citation_ref", "citation ref type");
  assert(nodes[1].keys[0] === "smith2020", "key");
});

test("[@key1, @key2] parsed as multi-key citation_ref", () => {
  const nodes = parseInline("See [@a, @b, @c].");
  assert(nodes[1].type === "citation_ref", "citation ref type");
  assert(nodes[1].keys.length === 3, "three keys");
  assert(nodes[1].keys[0] === "a", "first key");
  assert(nodes[1].keys[2] === "c", "third key");
});

test("[@key1,@key2] without spaces also works", () => {
  const nodes = parseInline("[@a,@b]");
  assert(nodes[0].type === "citation_ref", "citation ref type");
  assert(nodes[0].keys.length === 2, "two keys");
});

test("[text](url) is still a link, not a citation", () => {
  const nodes = parseInline("[click](http://example.com)");
  assert(nodes[0].type === "link", "link type");
});

test("[@bad key] is not a valid citation (space in key)", () => {
  const nodes = parseInline("[@bad key]");
  // Should not parse as citation_ref since "bad key" is not a valid key
  assert(nodes[0].type !== "citation_ref", "not a citation ref");
});

test("escaped \\[@key] is not a citation ref", () => {
  const nodes = parseInline("\\[@smith]");
  // The \[ produces a literal [, so [@smith] is not matched
  assert(!nodes.some(n => n.type === "citation_ref"), "no citation ref");
});

console.log("\n--- Citations: Rendering ---");

test("citation ref renders as numbered superscript link", () => {
  const html = renderHtmlBody("# T {\n    See [@smith].\n    {[citations]\n        - @smith Smith, 2020.\n    }\n}");
  assert(html.includes('class="sdoc-citation-group"'), "has citation group");
  assert(html.includes('href="#cite-smith"'), "links to citation");
  assert(html.includes(">1<"), "number 1");
});

test("same citation key renders same number", () => {
  const html = renderHtmlBody("# T {\n    First [@smith]. Second [@smith].\n    {[citations]\n        - @smith Smith, 2020.\n    }\n}");
  // Both should show number 1
  const matches = html.match(/href="#cite-smith">1<\/a>/g);
  assert(matches && matches.length === 2, "two references both numbered 1");
});

test("numbering follows order of first appearance", () => {
  const html = renderHtmlBody("# T {\n    First [@b]. Then [@a]. Then [@c].\n    {[citations]\n        - @a A, 2020.\n        - @b B, 2020.\n        - @c C, 2020.\n    }\n}");
  // @b first mentioned → 1, @a second → 2, @c third → 3
  assert(html.includes('href="#cite-b">1</a>'), "b is 1");
  assert(html.includes('href="#cite-a">2</a>'), "a is 2");
  assert(html.includes('href="#cite-c">3</a>'), "c is 3");
});

test("multiple citations in one bracket render individually linked", () => {
  const html = renderHtmlBody("# T {\n    Studies [@a, @b] show.\n    {[citations]\n        - @a A, 2020.\n        - @b B, 2020.\n    }\n}");
  assert(html.includes('href="#cite-a">1</a>'), "a linked");
  assert(html.includes('href="#cite-b">2</a>'), "b linked");
  assert(html.includes("["), "bracket open");
});

test("citation list renders with back-links", () => {
  const html = renderHtmlBody("# T {\n    See [@smith].\n    {[citations]\n        - @smith Smith, 2020.\n    }\n}");
  assert(html.includes('class="sdoc-citation-backlink"'), "has backlink");
  assert(html.includes('href="#citeref-smith"'), "backlink points to ref");
  assert(html.includes("\u21A9"), "has return arrow");
});

test("first citation ref gets id attribute, second does not", () => {
  const html = renderHtmlBody("# T {\n    First [@smith]. Second [@smith].\n    {[citations]\n        - @smith Smith, 2020.\n    }\n}");
  const idMatches = html.match(/id="citeref-smith"/g);
  assert(idMatches && idMatches.length === 1, "exactly one id attribute");
});

test("citation entries sorted by citation number in rendered output", () => {
  const html = renderHtmlBody("# T {\n    Text [@b] then [@a].\n    {[citations]\n        - @a A, 2020.\n        - @b B, 2020.\n    }\n}");
  // @b is cited first → number 1, @a is cited second → number 2
  // In rendered list, @b entry (value=1) should come before @a entry (value=2)
  const bPos = html.indexOf('id="cite-b"');
  const aPos = html.indexOf('id="cite-a"');
  assert(bPos < aPos, "b appears before a in citation list");
});

test("citation text supports inline formatting", () => {
  const html = renderHtmlBody("# T {\n    See [@s].\n    {[citations]\n        - @s Smith, *Title*, **Bold**, 2020.\n    }\n}");
  assert(html.includes("<em>Title</em>"), "italic in citation text");
  assert(html.includes("<strong>Bold</strong>"), "bold in citation text");
});

test("citation text supports links", () => {
  const html = renderHtmlBody("# T {\n    See [@s].\n    {[citations]\n        - @s Smith, 2020. [example.com](https://example.com)\n    }\n}");
  assert(html.includes('href="https://example.com"'), "link in citation text");
});

test("undefined citation renders with broken style", () => {
  const html = renderHtmlBody("# T {\n    See [@missing].\n}");
  assert(html.includes("sdoc-broken-ref"), "broken ref class");
  assert(html.includes("\u26A0"), "warning icon");
});

test("unreferenced citation definition renders with reduced opacity class", () => {
  const html = renderHtmlBody("# T {\n    {[citations]\n        - @unused Smith, 2020.\n    }\n}");
  assert(html.includes("sdoc-citation-unreferenced"), "unreferenced class");
});

test("K&R style citations block", () => {
  const html = renderHtmlBody("# T {\n    See [@s].\n    # References {[citations]\n        - @s Smith, 2020.\n    }\n}");
  assert(html.includes('href="#cite-s"'), "citation link");
  assert(html.includes("sdoc-citations"), "citations list rendered");
});

test("multiple citations blocks unified numbering", () => {
  const html = renderHtmlBody("# T {\n    See [@a].\n    {[citations]\n        - @a A, 2020.\n    }\n    See [@b].\n    {[citations]\n        - @b B, 2020.\n    }\n}");
  assert(html.includes('href="#cite-a">1</a>'), "a is 1");
  assert(html.includes('href="#cite-b">2</a>'), "b is 2");
});

console.log("\n--- Citations: Validation ---");

test("broken citation reference produces warning", () => {
  const r = parseSdoc("# T {\n    See [@missing].\n}");
  const warnings = validateCitations(r.nodes);
  assert(warnings.length === 1, "one warning");
  assert(warnings[0].type === "broken-citation", "broken-citation type");
  assert(warnings[0].key === "missing", "key is missing");
});

test("unused citation definition produces warning", () => {
  const r = parseSdoc("# T {\n    {[citations]\n        - @unused Unused, 2020.\n    }\n}");
  const warnings = validateCitations(r.nodes);
  assert(warnings.length === 1, "one warning");
  assert(warnings[0].type === "unused-citation", "unused-citation type");
  assert(warnings[0].key === "unused", "key is unused");
});

test("all citations matched produces no warnings", () => {
  const r = parseSdoc("# T {\n    See [@a] and [@b].\n    {[citations]\n        - @a A, 2020.\n        - @b B, 2020.\n    }\n}");
  const warnings = validateCitations(r.nodes);
  assert(warnings.length === 0, "no warnings");
});

test("duplicate citation definitions not flagged twice", () => {
  const r = parseSdoc("# T {\n    {[citations]\n        - @a A, 2020.\n        - @a A, 2021.\n    }\n}");
  const warnings = validateCitations(r.nodes);
  // Both are unused, but only unique keys should produce one warning
  assert(warnings.some(w => w.type === "unused-citation" && w.key === "a"), "unused warning");
});

test("collectCitationDefinitions finds entries in nested scopes", () => {
  const r = parseSdoc("# T {\n    # Inner {\n        {[citations]\n            - @deep Deep, 2020.\n        }\n    }\n}");
  const defs = collectCitationDefinitions(r.nodes);
  assert(defs.length === 1, "one definition");
  assert(defs[0].key === "deep", "key is deep");
});

console.log("\n--- Citations: Formatter ---");

test("formatter handles {[citations] block", () => {
  const input = "{[citations]\n- @smith Smith, 2020.\n- @jones Jones, 2021.\n}";
  const formatted = formatSdoc(input);
  assert(formatted.includes("    - @smith"), "citation item indented");
  assert(formatted.startsWith("{[citations]"), "opener at depth 0");
});

test("formatter handles K&R citations", () => {
  const input = "# Refs {[citations]\n- @smith Smith, 2020.\n}";
  const formatted = formatSdoc(input);
  assert(formatted.includes("    - @smith"), "citation item indented under K&R");
});

console.log("\n--- Hex Color Swatches ---");

test("6-digit hex renders as swatch with background color", () => {
  const html = renderHtmlBody("The color is #9aa0a8 here.");
  assert(html.includes('class="sdoc-color-swatch"'), "has swatch class");
  assert(html.includes("background-color:#9aa0a8"), "has background color");
  assert(html.includes(">#9aa0a8</span>"), "labels with hex code");
});

test("3-digit hex renders as swatch", () => {
  const html = renderHtmlBody("Use #fff for white.");
  assert(html.includes("background-color:#fff"), "has 3-digit background");
  assert(html.includes(">#fff</span>"), "labels with 3-digit hex");
});

test("4-digit (rgba) and 8-digit (rrggbbaa) hex render as swatches", () => {
  const html4 = renderHtmlBody("alpha #f00a done");
  assert(html4.includes("background-color:#f00a"), "4-digit swatch");
  const html8 = renderHtmlBody("alpha #9aa0a880 done");
  assert(html8.includes("background-color:#9aa0a880"), "8-digit swatch");
});

test("dark background gets white text, light gets black", () => {
  const dark = renderHtmlBody("bg #000000 here");
  assert(dark.includes("color:#ffffff"), "black bg -> white text");
  const light = renderHtmlBody("bg #ffffff here");
  assert(light.includes("color:#000000"), "white bg -> black text");
});

test("readableTextColor picks legible foreground", () => {
  assert(readableTextColor("#000000") === "#ffffff", "black -> white");
  assert(readableTextColor("#ffffff") === "#000000", "white -> black");
  assert(readableTextColor("#9aa0a8") === "#000000", "mid-light grey -> black");
  assert(readableTextColor("#1a1a2e") === "#ffffff", "dark navy -> white");
  // alpha is ignored when choosing contrast
  assert(readableTextColor("#000000ff") === "#ffffff", "8-digit ignores alpha");
  assert(readableTextColor("#000f") === "#ffffff", "4-digit ignores alpha");
});

test("invalid hex lengths are left as plain text", () => {
  const html5 = renderHtmlBody("not a color #12345 ok");
  assert(!html5.includes("sdoc-color-swatch"), "5 digits -> no swatch");
  assert(html5.includes("#12345"), "5-digit text preserved");
  const html7 = renderHtmlBody("not a color #1234567 ok");
  assert(!html7.includes("sdoc-color-swatch"), "7 digits -> no swatch");
});

test("hex inside a word is not a swatch", () => {
  const html = renderHtmlBody("issue123#fff reference");
  assert(!html.includes("sdoc-color-swatch"), "no swatch when preceded by word char");
});

test("hex followed by letters is not a swatch", () => {
  const html = renderHtmlBody("the tag #fffghi is not a color");
  assert(!html.includes("sdoc-color-swatch"), "trailing letters block the match");
});

test("escaped \\# is not a swatch", () => {
  const html = renderHtmlBody("literal \\#fff stays");
  assert(!html.includes("sdoc-color-swatch"), "escaped hash -> no swatch");
  assert(html.includes("#fff"), "literal hash text preserved");
});

test("hex inside inline code stays literal", () => {
  const html = renderHtmlBody("the value `#9aa0a8` literal");
  assert(html.includes("<code"), "renders as code");
  assert(!html.includes("sdoc-color-swatch"), "code span not turned into swatch");
});

test("swatch detected at start of inline context (list item)", () => {
  const html = renderHtmlBody("- #9aa0a8\n- #ffffff");
  const count = (html.match(/sdoc-color-swatch/g) || []).length;
  assert(count === 2, "both list items become swatches, got " + count);
});

test("bare #hex at line start is a heading, not a swatch (SDOC rule)", () => {
  const html = renderHtmlBody("#9aa0a8 leads the line");
  assert(!html.includes("sdoc-color-swatch"), "line-start hash is a heading");
  assert(/<h1[^>]*>/.test(html), "renders as a heading");
});

test("swatch print color is preserved", () => {
  const html = renderHtmlBody("swatch #9aa0a8 here");
  assert(html.includes("print-color-adjust:exact"), "print color retained");
});

test("all swatches share the same soft neutral outline (consistent, visible on any bg)", () => {
  const border = "border:1px solid rgba(128,128,128,0.5)";
  ["bg #ffffff x", "bg #000000 x", "bg #9aa0a8 x", "bg #1a73e8 x"].forEach((src) => {
    assert(renderHtmlBody(src).includes(border), "neutral outline present for: " + src);
  });
});

test("swatch style attribute is well-formed (no double quotes inside)", () => {
  const html = renderHtmlBody("swatch #9aa0a8 here");
  const m = html.match(/<span class="sdoc-color-swatch" style="([^"]*)"/);
  assert(m, "style attribute parses without an embedded double quote");
  assert(m[1].includes("font-family:'JetBrains Mono'"), "font names use single quotes");
});

console.log("\n--- Copyable Text ({copy}...{/copy}) ---");

test("inline {copy} parses as a copyable node", () => {
  const nodes = parseInline("seq {copy}ACGT{/copy} end");
  const cp = nodes.find((n) => n.type === "copyable");
  assert(cp, "copyable node produced");
  assert(cp.value === "ACGT", "value is the literal inner text");
});

test("inline {copy} renders with data-copy and a copy button", () => {
  const html = renderHtmlBody("seq {copy}ACGTGGCA{/copy} end");
  assert(html.includes('class="sdoc-copyable"'), "wrapper class present");
  assert(html.includes('data-copy="ACGTGGCA"'), "data-copy carries the text");
  assert(html.includes('class="sdoc-copy-btn sdoc-copy-inline"'), "copy button present");
  assert(html.includes(">ACGTGGCA</code>"), "text shown in monospace");
});

test("inner {copy} text is verbatim (no nested formatting)", () => {
  const html = renderHtmlBody("val {copy}a*b*c{/copy} end");
  assert(html.includes('data-copy="a*b*c"'), "asterisks copied literally");
  assert(!html.includes("<em>"), "no emphasis parsed inside copyable");
});

test("data-copy escapes quotes so the attribute stays well-formed", () => {
  const html = renderHtmlBody('x {copy}a"b{/copy} y');
  assert(html.includes('data-copy="a&quot;b"'), "double quote escaped in attribute");
});

test("escaped \\{copy} is not a copyable", () => {
  const html = renderHtmlBody("literal \\{copy}x{/copy} stays");
  assert(!html.includes("sdoc-copyable"), "escaped brace -> no copyable");
});

test("unclosed {copy} falls through as literal text", () => {
  const html = renderHtmlBody("oops {copy}ACGT with no close");
  assert(!html.includes("sdoc-copyable"), "no copyable node without {/copy}");
  assert(html.includes("{copy}ACGT"), "literal text preserved");
});

test("table copy column adds copy buttons only to that column", () => {
  const html = renderHtmlBody("{[table]\n  Gene | Sequence\n       | copy\n  BRCA1 | ACGTGGCA\n}");
  assert(html.includes('data-copy="ACGTGGCA"'), "sequence cell is copyable");
  const geneCell = html.match(/<td class="sdoc-table-td">BRCA1<\/td>/);
  assert(geneCell, "gene cell has no copy button");
});

test("copy directive row is consumed (not rendered as a data row)", () => {
  const html = renderHtmlBody("{[table]\n  Gene | Sequence\n       | copy\n  BRCA1 | ACGTGGCA\n}");
  assert(!html.includes(">copy</td>"), "directive row not rendered as data");
  const bodyRows = (html.match(/<tr>/g) || []).length;
  assert(bodyRows === 2, "one header row + one body row, got " + bodyRows);
});

test("copy directive combines with alignment/format in the same row", () => {
  const html = renderHtmlBody("{[table]\n  Item | Price | Sequence\n       | $ | copy\n  A | 1000 | ACGT\n}");
  assert(html.includes("$1,000"), "format still applied");
  assert(html.includes('data-copy="ACGT"'), "copy still applied");
});

test("headerless table supports a copy directive row", () => {
  const html = renderHtmlBody("{[table headerless]\n   | copy\n  Gene | ACGTGGCA\n}");
  assert(html.includes('data-copy="ACGTGGCA"'), "copy applied in headerless table");
});

// ============================================================
console.log("\n--- Results: " + pass + " passed, " + fail + " failed ---");
if (fail > 0) process.exit(1);
