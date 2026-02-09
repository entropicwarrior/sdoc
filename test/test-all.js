const {
  parseSdoc,
  extractMeta,
  renderFragment,
  renderTextParagraphs,
  renderHtmlDocumentFromParsed,
  renderHtmlDocument
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
console.log("\n--- Results: " + pass + " passed, " + fail + " failed ---");
if (fail > 0) process.exit(1);
