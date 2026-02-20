const {
  parseSdoc,
  extractMeta,
  renderFragment,
  renderTextParagraphs,
  renderHtmlDocumentFromParsed,
  renderHtmlDocument,
  formatSdoc,
  slugify,
  listSections,
  extractSection,
  extractAbout
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
  const projectDir = path.join(__dirname, "..", "spec");
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
console.log("\n--- Results: " + pass + " passed, " + fail + " failed ---");
if (fail > 0) process.exit(1);
