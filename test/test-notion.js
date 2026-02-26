const {
  parseSdoc,
  extractMeta,
  parseInline
} = require("../src/sdoc.js");
const {
  renderNotionBlocks,
  flattenInline,
  flattenInlineNodes,
  mapNotionLanguage
} = require("../src/notion-renderer.js");
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log("  PASS: " + name); }
  catch (e) { fail++; console.log("  FAIL: " + name + " — " + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

function parseAndRender(sdoc) {
  const parsed = parseSdoc(sdoc);
  assert(parsed.errors.length === 0, "parse errors: " + JSON.stringify(parsed.errors));
  const { nodes } = extractMeta(parsed.nodes);
  return renderNotionBlocks(nodes);
}

// ============================================================
console.log("--- Rich text flattening ---");

test("plain text", () => {
  const rt = flattenInline("Hello world");
  assert(rt.length === 1);
  assert(rt[0].text.content === "Hello world");
  assert(rt[0].annotations.bold === false);
  assert(rt[0].annotations.italic === false);
});

test("bold text", () => {
  const rt = flattenInline("**bold**");
  assert(rt.length === 1);
  assert(rt[0].text.content === "bold");
  assert(rt[0].annotations.bold === true);
  assert(rt[0].annotations.italic === false);
});

test("italic text", () => {
  const rt = flattenInline("*italic*");
  assert(rt.length === 1);
  assert(rt[0].text.content === "italic");
  assert(rt[0].annotations.italic === true);
});

test("strikethrough text", () => {
  const rt = flattenInline("~~struck~~");
  assert(rt.length === 1);
  assert(rt[0].text.content === "struck");
  assert(rt[0].annotations.strikethrough === true);
});

test("inline code", () => {
  const rt = flattenInline("`code`");
  assert(rt.length === 1);
  assert(rt[0].text.content === "code");
  assert(rt[0].annotations.code === true);
});

test("nested bold with code", () => {
  const rt = flattenInline("**bold with `code`**");
  assert(rt.length === 2);
  assert(rt[0].text.content === "bold with ");
  assert(rt[0].annotations.bold === true);
  assert(rt[0].annotations.code === false);
  assert(rt[1].text.content === "code");
  assert(rt[1].annotations.bold === true);
  assert(rt[1].annotations.code === true);
});

test("link", () => {
  const rt = flattenInline("[click here](https://example.com)");
  assert(rt.length === 1);
  assert(rt[0].text.content === "click here");
  assert(rt[0].text.link.url === "https://example.com");
});

test("bold link", () => {
  const rt = flattenInline("**[bold link](https://example.com)**");
  assert(rt.length === 1);
  assert(rt[0].text.content === "bold link");
  assert(rt[0].annotations.bold === true);
  assert(rt[0].text.link.url === "https://example.com");
});

test("ref renders as text", () => {
  const rt = flattenInline("@section-id");
  assert(rt.length === 1);
  assert(rt[0].text.content === "@section-id");
  assert(rt[0].text.link === null);
});

test("image is skipped in inline flattening", () => {
  const nodes = parseInline("![alt](pic.png)");
  const rt = flattenInlineNodes(nodes);
  assert(rt.length === 0, "images should be skipped");
});

test("mixed text with formatting", () => {
  const rt = flattenInline("Hello **bold** and *italic* world");
  assert(rt.length === 5);
  assert(rt[0].text.content === "Hello ");
  assert(rt[1].text.content === "bold");
  assert(rt[1].annotations.bold === true);
  assert(rt[2].text.content === " and ");
  assert(rt[3].text.content === "italic");
  assert(rt[3].annotations.italic === true);
  assert(rt[4].text.content === " world");
});

test("empty text returns empty array", () => {
  const rt = flattenInline("");
  assert(rt.length === 0);
});

test("null text returns empty array", () => {
  const rt = flattenInline(null);
  assert(rt.length === 0);
});

test("content exceeding 2000 chars is split", () => {
  const long = "a".repeat(4500);
  const rt = flattenInline(long);
  assert(rt.length === 3, "should split into 3 chunks, got " + rt.length);
  assert(rt[0].text.content.length === 2000);
  assert(rt[1].text.content.length === 2000);
  assert(rt[2].text.content.length === 500);
});

test("autolink", () => {
  const rt = flattenInline("<https://example.com>");
  assert(rt.length === 1);
  assert(rt[0].text.content === "https://example.com");
  assert(rt[0].text.link.url === "https://example.com");
});

// ============================================================
console.log("\n--- Paragraphs ---");

test("simple paragraph", () => {
  const blocks = parseAndRender("# Doc {\n  Hello world.\n}");
  // Document scope → heading_1 toggle, with paragraph child
  const heading = blocks[0];
  assert(heading.type === "heading_1");
  const children = heading.heading_1.children;
  assert(children.length === 1);
  assert(children[0].type === "paragraph");
  assert(children[0].paragraph.rich_text[0].text.content === "Hello world.");
});

test("paragraph with image extracts image block", () => {
  const blocks = parseAndRender("# Doc {\n  Text ![alt](https://example.com/pic.png) more\n}");
  const children = blocks[0].heading_1.children;
  assert(children.length === 2, "should have paragraph + image, got " + children.length);
  assert(children[0].type === "paragraph");
  assert(children[1].type === "image");
  assert(children[1].image.external.url === "https://example.com/pic.png");
});

test("image-only paragraph emits just image block", () => {
  const blocks = parseAndRender("# Doc {\n  ![alt](https://example.com/pic.png)\n}");
  const children = blocks[0].heading_1.children;
  assert(children.length === 1);
  assert(children[0].type === "image");
});

test("paragraph with two images", () => {
  const blocks = parseAndRender("# Doc {\n  ![a](https://example.com/a.png) ![b](https://example.com/b.png)\n}");
  const children = blocks[0].heading_1.children;
  assert(children.length === 2);
  assert(children[0].type === "image");
  assert(children[0].image.external.url === "https://example.com/a.png");
  assert(children[1].type === "image");
  assert(children[1].image.external.url === "https://example.com/b.png");
});

test("image caption from alt text", () => {
  const blocks = parseAndRender("# Doc {\n  ![My caption](https://example.com/pic.png)\n}");
  const img = blocks[0].heading_1.children[0];
  assert(img.image.caption.length === 1);
  assert(img.image.caption[0].text.content === "My caption");
});

test("relative image URLs are skipped", () => {
  const blocks = parseAndRender("# Doc {\n  Text ![alt](pic.png) more\n}");
  const children = blocks[0].heading_1.children;
  // Only the paragraph with text, no image block
  assert(children.length === 1, "relative image should be skipped");
  assert(children[0].type === "paragraph");
});

// ============================================================
console.log("\n--- Scopes and headings ---");

test("depth 1 produces heading_1", () => {
  const blocks = parseAndRender("# Title {\n  Content.\n}");
  assert(blocks[0].type === "heading_1");
  assert(blocks[0].heading_1.rich_text[0].text.content === "Title");
});

test("depth 2 produces flat heading_2", () => {
  const blocks = parseAndRender("# Doc {\n  # Sub {\n    Content.\n  }\n}");
  const children = blocks[0].heading_1.children;
  assert(children[0].type === "heading_2");
  assert(children[0].heading_2.is_toggleable === false, "heading_2 should be flat");
  // Content follows as sibling, not nested under heading_2
  assert(children[1].type === "paragraph");
});

test("depth 3+ produces flat heading_3", () => {
  const blocks = parseAndRender("# A {\n  # B {\n    # C {\n      Content.\n    }\n  }\n}");
  const h1Children = blocks[0].heading_1.children;
  // All sub-headings are flat siblings inside heading_1
  assert(h1Children[0].type === "heading_2");
  assert(h1Children[0].heading_2.is_toggleable === false);
  assert(h1Children[1].type === "heading_3");
  assert(h1Children[1].heading_3.is_toggleable === false);
  assert(h1Children[2].type === "paragraph");
  assert(h1Children[2].paragraph.rich_text[0].text.content === "Content.");
});

test("headingless scope emits children directly", () => {
  const blocks = parseAndRender("# Doc {\n  {\n    Content.\n  }\n}");
  const children = blocks[0].heading_1.children;
  // Headingless scope should produce its children (a paragraph) directly
  assert(children[0].type === "paragraph");
});

test("toggle heading has is_toggleable true when children exist", () => {
  const blocks = parseAndRender("# Title {\n  Content.\n}");
  assert(blocks[0].heading_1.is_toggleable === true);
});

test("heading without children has is_toggleable false", () => {
  const blocks = parseAndRender("# Title {\n}");
  assert(blocks[0].heading_1.is_toggleable === false);
});

test("document scope unwrapped as heading_1", () => {
  const blocks = parseAndRender("# Document Title\n\nContent here.");
  assert(blocks.length === 1);
  assert(blocks[0].type === "heading_1");
  assert(blocks[0].heading_1.rich_text[0].text.content === "Document Title");
});

// ============================================================
console.log("\n--- Lists ---");

test("bullet list", () => {
  const blocks = parseAndRender("# Doc {\n  {[.]\n    - First\n    - Second\n  }\n}");
  const ch = blocks[0].heading_1.children;
  assert(ch[0].type === "bulleted_list_item");
  assert(ch[0].bulleted_list_item.rich_text[0].text.content === "First");
  assert(ch[1].type === "bulleted_list_item");
});

test("numbered list", () => {
  const blocks = parseAndRender("# Doc {\n  {[#]\n    1. Alpha\n    2. Beta\n  }\n}");
  const ch = blocks[0].heading_1.children;
  assert(ch[0].type === "numbered_list_item");
  assert(ch[0].numbered_list_item.rich_text[0].text.content === "Alpha");
});

test("task list checked", () => {
  const blocks = parseAndRender("# Doc {\n  {[.]\n    - [x] Done\n  }\n}");
  const ch = blocks[0].heading_1.children;
  assert(ch[0].type === "to_do");
  assert(ch[0].to_do.checked === true);
  assert(ch[0].to_do.rich_text[0].text.content === "Done");
});

test("task list unchecked", () => {
  const blocks = parseAndRender("# Doc {\n  {[.]\n    - [ ] Pending\n  }\n}");
  const ch = blocks[0].heading_1.children;
  assert(ch[0].type === "to_do");
  assert(ch[0].to_do.checked === false);
});

test("list item with nested content", () => {
  // At nestLevel 1 (inside heading_1 toggle), list items cannot have children
  // due to Notion API nesting limits. Nested content is dropped.
  const blocks = parseAndRender("# Doc {\n  {[.]\n    - Item {\n      Nested paragraph.\n    }\n  }\n}");
  const children = blocks[0].heading_1.children;
  const item = children[0];
  assert(item.type === "bulleted_list_item");
  assert(!item.bulleted_list_item.children, "no children at nestLevel 1");
});

test("list with bold item", () => {
  const blocks = parseAndRender("# Doc {\n  {[.]\n    - **Bold item**\n  }\n}");
  const children = blocks[0].heading_1.children;
  const rt = children[0].bulleted_list_item.rich_text;
  assert(rt[0].annotations.bold === true);
});

// ============================================================
console.log("\n--- Tables ---");

test("basic table", () => {
  const blocks = parseAndRender("# Doc {\n  {[table]\n    Name | Age\n    Alice | 30\n  }\n}");
  const children = blocks[0].heading_1.children;
  const table = children[0];
  assert(table.type === "table");
  assert(table.table.table_width === 2);
  assert(table.table.has_column_header === true);
  assert(table.table.children.length === 2, "header row + 1 data row");
});

test("table header row has correct content", () => {
  const blocks = parseAndRender("# Doc {\n  {[table]\n    Name | Age\n    Alice | 30\n  }\n}");
  const table = blocks[0].heading_1.children[0];
  const headerRow = table.table.children[0];
  assert(headerRow.table_row.cells[0][0].text.content === "Name");
  assert(headerRow.table_row.cells[1][0].text.content === "Age");
});

test("headerless table", () => {
  const blocks = parseAndRender("# Doc {\n  {[table headerless]\n    A | B\n    C | D\n  }\n}");
  const table = blocks[0].heading_1.children[0];
  assert(table.table.has_column_header === false);
  assert(table.table.children.length === 2, "all rows are data rows");
});

test("table with inline formatting", () => {
  const blocks = parseAndRender("# Doc {\n  {[table]\n    Name | Status\n    Alice | **active**\n  }\n}");
  const table = blocks[0].heading_1.children[0];
  const dataRow = table.table.children[1];
  assert(dataRow.table_row.cells[1][0].annotations.bold === true);
});

test("empty cell produces empty rich text", () => {
  const blocks = parseAndRender("# Doc {\n  {[table]\n    A | B\n    X\n  }\n}");
  const table = blocks[0].heading_1.children[0];
  const dataRow = table.table.children[1];
  // Second cell should be padded (empty)
  assert(dataRow.table_row.cells.length === 2);
});

// ============================================================
console.log("\n--- Code blocks ---");

test("code block with language", () => {
  const blocks = parseAndRender("# Doc {\n  ```javascript\n  const x = 1;\n  ```\n}");
  const children = blocks[0].heading_1.children;
  assert(children[0].type === "code");
  assert(children[0].code.language === "javascript");
});

test("mermaid code block", () => {
  const blocks = parseAndRender("# Doc {\n  ```mermaid\n  graph TD;\n  ```\n}");
  const children = blocks[0].heading_1.children;
  assert(children[0].code.language === "mermaid");
});

test("unknown language falls back to plain text", () => {
  const blocks = parseAndRender("# Doc {\n  ```foobar\n  stuff\n  ```\n}");
  const children = blocks[0].heading_1.children;
  assert(children[0].code.language === "plain text");
});

test("long code text is split", () => {
  const longCode = "x".repeat(4500);
  const blocks = parseAndRender("# Doc {\n  ```\n" + longCode + "\n  ```\n}");
  const children = blocks[0].heading_1.children;
  const rt = children[0].code.rich_text;
  assert(rt.length === 3, "should split into 3 chunks, got " + rt.length);
});

test("empty code block", () => {
  const blocks = parseAndRender("# Doc {\n  ```\n  ```\n}");
  const children = blocks[0].heading_1.children;
  assert(children[0].type === "code");
  assert(children[0].code.rich_text.length >= 1);
});

// ============================================================
console.log("\n--- Blockquotes ---");

test("single paragraph blockquote", () => {
  const blocks = parseAndRender("# Doc {\n  > This is a quote.\n}");
  const children = blocks[0].heading_1.children;
  assert(children[0].type === "quote");
  assert(children[0].quote.rich_text[0].text.content === "This is a quote.");
});

test("multi-paragraph blockquote joined with newline", () => {
  const blocks = parseAndRender("# Doc {\n  > First paragraph.\n  >\n  > Second paragraph.\n}");
  const children = blocks[0].heading_1.children;
  const rt = children[0].quote.rich_text;
  const allText = rt.map((r) => r.text.content).join("");
  assert(allText.includes("First paragraph."), "has first paragraph");
  assert(allText.includes("\n"), "has newline separator");
  assert(allText.includes("Second paragraph."), "has second paragraph");
});

test("blockquote with inline formatting", () => {
  const blocks = parseAndRender("# Doc {\n  > This is **bold** in a quote.\n}");
  const children = blocks[0].heading_1.children;
  const rt = children[0].quote.rich_text;
  const boldParts = rt.filter((r) => r.annotations.bold);
  assert(boldParts.length > 0, "should have bold text in quote");
});

// ============================================================
console.log("\n--- Dividers ---");

test("horizontal rule produces divider", () => {
  const blocks = parseAndRender("# Doc {\n  ---\n}");
  const children = blocks[0].heading_1.children;
  assert(children[0].type === "divider");
});

// ============================================================
console.log("\n--- Language mapping ---");

test("known language passes through", () => {
  assert(mapNotionLanguage("python") === "python");
  assert(mapNotionLanguage("JavaScript") === "javascript");
});

test("alias maps correctly", () => {
  assert(mapNotionLanguage("js") === "javascript");
  assert(mapNotionLanguage("ts") === "typescript");
  assert(mapNotionLanguage("py") === "python");
  assert(mapNotionLanguage("sh") === "shell");
  assert(mapNotionLanguage("yml") === "yaml");
});

test("unknown language returns plain text", () => {
  assert(mapNotionLanguage("obscurelang") === "plain text");
  assert(mapNotionLanguage(null) === "plain text");
  assert(mapNotionLanguage(undefined) === "plain text");
});

// ============================================================
console.log("\n--- Integration ---");

test("full document renders without error", () => {
  const sdoc = `# My Document @meta
{
    type: doc
}

# Introduction
{
    This is the intro with **bold** and *italic*.

    {[.]}
        - First item
        - Second item
    }

    > A blockquote.

    ---

    \`\`\`python
    def hello():
        print("hello")
    \`\`\`
}

# Details
{
    # Subsection
    {
        More content here.

        {[table]}
            Name | Value
            Key | 42
        }
    }
}`;
  const blocks = parseAndRender(sdoc);
  assert(blocks.length > 0, "should produce blocks");
  // Should not throw
});

test("multiple top-level scopes", () => {
  const sdoc = "# A {\n  Content A.\n}\n\n# B {\n  Content B.\n}";
  const blocks = parseAndRender(sdoc);
  assert(blocks.length === 2, "should have 2 top-level headings, got " + blocks.length);
  assert(blocks[0].type === "heading_1");
  assert(blocks[1].type === "heading_1");
});

test("example.sdoc renders without error", () => {
  const examplePath = path.join(__dirname, "..", "examples", "example.sdoc");
  if (fs.existsSync(examplePath)) {
    const text = fs.readFileSync(examplePath, "utf-8");
    const parsed = parseSdoc(text);
    const { nodes } = extractMeta(parsed.nodes);
    const blocks = renderNotionBlocks(nodes);
    assert(blocks.length > 0, "example.sdoc should produce blocks");
  }
});

test("deeply nested scopes all flatten under heading_1", () => {
  const sdoc = "# L1 {\n  # L2 {\n    # L3 {\n      # L4 {\n        Deep.\n      }\n    }\n  }\n}";
  const blocks = parseAndRender(sdoc);
  // Only L1 (heading_1) is toggle. L2, L3, L4 are all flat siblings inside it.
  const children = blocks[0].heading_1.children;
  assert(children[0].type === "heading_2", "L2 is heading_2");
  assert(children[0].heading_2.is_toggleable === false);
  assert(children[1].type === "heading_3", "L3 is heading_3");
  assert(children[2].type === "heading_3", "L4 is heading_3");
  assert(children[3].type === "paragraph", "Deep content is flat sibling");
});

// ============================================================
console.log("\n--- Results: " + pass + " passed, " + fail + " failed ---");
if (fail > 0) process.exit(1);
