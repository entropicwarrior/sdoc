# SDOC Guide

SDOC ("Simple/Smart Documentation") is a plain-text documentation format where structure is defined by explicit brace scoping — indentation is purely cosmetic.

This guide teaches you everything you need to write SDOC files. Part 1 is a quick reference with examples. Part 2 is the full specification for edge cases.

---

## Quick Reference

### Core Principle

Structure comes from explicit scoping. Braces (`{ }`) provide unambiguous scope boundaries, while braceless scopes offer a lighter syntax for simple documents. Whitespace and indentation are cosmetic — use them freely for readability but they never affect meaning.

### Scopes

A scope is a heading followed by content. Use braces for explicit scoping, or omit them for braceless leaf scopes:

```
# Document Title
{
    # Section @section-id
    {
        Paragraph text goes here.

        # Subsection
        {
            Deeper content.
        }
    }
}
```

Or with braceless scopes (content runs until the next heading or EOF):

```
# Document Title

# Section A
Content of section A.

# Section B
Content of section B.
```

- `#` starts a heading (multiple `#` characters are allowed but don't affect depth — only nesting does)
- `@id` at the end of a heading line assigns a referenceable ID
- `{ }` delimits the scope's content (optional for leaf scopes)

### Headingless Scopes

A bare `{ }` block without a heading creates a section without a title — useful for grouping content:

```
{
    This content is grouped and indented, but has no heading.
}
```

### Inline Blocks

Short content can be written on one line:

```
# Author
{ Jane Doe }

# Version
{ 1.0 }
```

### K&R Brace Style

The opening brace (or list/table opener) can appear at the end of the heading line instead of on its own line:

```
# Title {
    Content goes here.
}

# My List {[.]
    - Item 1
    - Item 2
}

# Data {[table]
    Name | Age
    Alice | 30
}

# Section @id {
    IDs go before the brace.
}
```

This also works on list item lines: `- Item {`. K&R and Allman styles can be mixed freely in the same document.

### Braceless Scopes

A heading not followed by `{` creates a braceless scope. Content runs until the next `#` heading, a closing `}`, or end of file:

```
# Section A
Content of Section A.
It can span multiple lines.

# Section B
Content of Section B.
```

- Braceless scopes support paragraphs, code blocks, blockquotes, implicit lists, HRs, and tables
- Encountering another `#` heading ends the braceless scope (the heading becomes a sibling)
- Braceless and explicit scopes can be mixed freely

### Implicit Root

If the first heading in a document is not followed by `{`, the entire document is wrapped in an implicit root scope:

```
# My Document

# Section A
Content of section A.

# Section B
Content of section B.
```

This is equivalent to wrapping everything after the first heading in `{ ... }`. If the first heading IS followed by `{`, the document uses explicit mode.

### Paragraphs

Consecutive text lines form a paragraph. A blank line or a new scope ends the paragraph.

```
# About
{
    This is the first paragraph.
    These lines join together.

    This is a second paragraph.
}
```

### Lists

#### Explicit List Blocks

Use `{[.]}` for bulleted or `{[#]}` for numbered lists:

```
# Features
{[.]
    - Fast parsing
    - Explicit structure
    - Easy references
}

# Steps
{[#]
    1. Install the extension
    2. Create a .sdoc file
    3. Open the preview
}
```

#### List Items with Bodies

Items can have their own content block:

```
{[.]
    - Item with details
    {
        This paragraph belongs to the item above.
    }
    - Simple item
}
```

Rich content like code blocks, extra paragraphs, or nested lists inside a list item **must** be wrapped in a `{ }` body block:

```
{[#]
    1. First step
    {
        Here is some detail:

        ```python
        print("hello")
        ```
    }
    2. Second step
}
```

**Important:** Bare code fences or paragraphs between list items (outside a body block) will cause parser errors.

Shorthand items (`- Item` or `1. Item`) always render in normal body font, even with a body block. To render a list item as a heading (larger, bolder), use `#` syntax instead:

```
{[.]
    # Heading-style item
    {
        This item's title renders as a heading.
    }
    - Normal item
    {
        This item's title stays in normal body font.
    }
}
```

#### Multi-line List Items

Inside an explicit list block (`{[.]}` or `{[#]}`), a list item's title can span multiple lines. Lines after the marker that aren't a command token are joined to the title with a space:

```
{[.]
    - This is a long list item
      that continues on the next line
    - Short item
}
```

Continuation stops at blank lines, list markers, headings, braces, code fences, blockquotes, and horizontal rules. A body block can still follow the completed multi-line title. This feature only applies to explicit list blocks, not implicit lists.

#### Implicit Lists

Inside a normal scope, a run of `-` or `1.` lines automatically becomes a list:

```
# Quick List
{
    - Alpha
    - Beta
    - Gamma
}
```

#### Anonymous List Items

Items with no heading — just a body block:

```
{[.]
    {
        First item, body only.
    }
    {
        Second item, body only.
    }
}
```

#### Task Lists

Checkbox syntax inside a list block:

```
{[.]
    - [ ] Pending task
    - [x] Completed task
}
```

### Tables

Declared with `{[table]}`. First row is the header, columns separated by `|`:

```
{[table]
    Name | Age | City
    Alice | 30 | NYC
    Bob | 25 | LA
}
```

### Inline Formatting

| Syntax | Result |
|--------|--------|
| `*text*` | Emphasis |
| `**text**` | Strong |
| `~~text~~` | Strikethrough |
| `\`code\`` | Inline code |

### Links and Images

```
[Link text](https://example.com)
<https://example.com>
<mailto:hello@example.com>
![Alt text](path/to/image.png)
```

### References

Assign an ID with `@id` on a heading, then reference it anywhere with `@id`:

```
# Setup @setup
{
    Follow these instructions.
}

# Usage
{
    Make sure you complete @setup first.
}
```

### Blockquotes

```
> This is a quoted line.
> Another line in the same quote.
>
> New paragraph in the same quote.
```

### Code Blocks

Fenced with triple backticks. Content inside is raw (no parsing):

````
```javascript
function hello() {
    console.log("Hello!");
}
```
````

### Horizontal Rules

A line of three or more `-`, `*`, or `_`:

```
---
```

### Escaping

Backslash escapes special characters: `\\` `\{` `\}` `\@` `\[` `\]` `\(` `\)` `\*` `\~` `\#` `\!` `\<` `\>` `\\``

A line starting with `\#` renders as a literal `#` (not a heading). A line starting with `\>` renders as a literal `>` (not a blockquote).

### Meta Scope

The reserved `@meta` scope configures per-file settings and is not rendered in the document body. Use sub-scopes for rich content, or key:value syntax for simple values:

```
# Meta @meta
{
    # Style
    { styles/custom.css }
    # Header
    { My *custom* header }
    # Footer
    { Footer text here }
}
```

Key:value syntax (lighter weight):

```
# Meta @meta
{
    style: styles/custom.css
    header: My Header
    footer: My Footer
    author: Jane Smith
    version: 1.0
}
```

- Well-known keys: `style`, `styleappend`/`style-append`, `header`, `footer`
- Other keys (e.g., `author`, `date`, `version`) are stored as custom properties
- Sub-scope syntax takes precedence over key:value when both exist
- Each key:value pair should be on its own paragraph line

Hierarchical configuration is also available via `sdoc.config.json` files in any folder.

### Document Formatting

The VSCode extension provides a built-in formatter. Use **Format Document** (Shift+Option+F on macOS, Shift+Alt+F on Windows/Linux) to auto-indent based on brace depth.

- Respects your VS Code tab size and spaces/tabs preference
- Code blocks are left untouched
- Inline blocks (`{ content }`) stay on one line
- K&R style lines are handled correctly
- Formatting is idempotent and never changes document structure

You can also use `formatSdoc(text, indentStr)` from the JavaScript API.

### Conventions

- **Indentation:** Use any whitespace you like — it's cosmetic. Most authors use 4 spaces.
- **IDs:** Use lowercase kebab-case (`@my-section`). IDs should be unique within a document.
- **Commas:** Commas between list items or scopes are allowed but ignored — use them if you find them readable.

### Complete Example

```
# My Project Documentation
{
    # Meta @meta
    {
        # Header
        { My Project v2.0 }
    }

    # Introduction @intro
    {
        Welcome to My Project. See @setup to get started.
    }

    # Setup @setup
    {
        # Requirements
        {[.]
            - Node.js 18+
            - A modern browser
        }

        # Installation
        {[#]
            1. Clone the repo
            2. Run \`npm install\`
            3. Run \`npm start\`
        }
    }

    # API Reference @api
    {
        # Endpoints
        {[table]
            Method | Path | Description
            GET | /users | List all users
            POST | /users | Create a user
            GET | /users/:id | Get a user
        }
    }

    # FAQ
    {
        # Is indentation significant?
        {
            No. Indentation is purely cosmetic. Structure comes from braces.
        }
    }
}
```

### Common Mistakes

These are easy errors to make — especially for AI agents generating SDOC. Avoid them.

#### Bare content inside list blocks

Inside a list block (`{[.]}` or `{[#]}`), the **only** valid children are list items (`-`, `1.`, `#` headings, or anonymous `{ }` blocks). Bare paragraphs, code fences, or other content floating between items is a **parser error**.

**Wrong — bare paragraphs inside a list block:**

```
{[.]
    - First item title

      This paragraph is NOT inside a body block.
      It will cause a parser error.

    - Second item
}
```

**Right — wrap rich content in a `{ }` body block:**

```
{[.]
    - First item title
    {
        This paragraph belongs to the item above.

        So does this one, and any code blocks, nested lists, etc.
    }
    - Second item
}
```

This is the single most common SDOC mistake. If a list item needs **anything** beyond its title line (extra paragraphs, code blocks, nested lists, blockquotes), that content **must** go in a `{ }` body block immediately after the item.

#### Unescaped `<` and `>` in text

Angle brackets in regular text (outside of inline code backticks) can be misinterpreted as autolinks. Escape them with `\<` and `\>`:

**Wrong:**

```
- **observer<T>** — a pointer type
```

**Right:**

```
- **observer\<T\>** — a pointer type
```

Inside backtick code spans (`` `observer<T>` ``), angle brackets are fine — code spans are raw.

#### Forgetting that blank lines stop multi-line list item titles

A list item title can span multiple continuation lines, but a blank line terminates the title. Content after the blank line is bare content in the list block (a parser error) unless wrapped in a body block:

**Wrong:**

```
{[.]
    - This is a long item title
      that continues here

      But this is NOT a continuation — it's a bare paragraph (error).
}
```

**Right:**

```
{[.]
    - This is a long item title
      that continues here
    {
        This extra content is properly in a body block.
    }
}
```

---

## Full Specification

The authoritative SDOC specification is in `spec/specification.sdoc`. Refer to it for edge cases, formal grammar, and detailed parsing rules.

The embedded copy below may be out of date. When in doubt, the `.sdoc` file is the source of truth.

```
# SDOC Specification v0.1 @sdoc-spec
{
    # Meta @meta
    {
        # Version
        { 0.1 }
        # Status
        { Draft }
    }

    # Overview @overview
    {
        SDOC ("Simple/Smart Documentation") is a plain text documentation format with explicit scoping.

        # Goals @goals
        {
            {[.]
                - Explicit scoping with braces; whitespace and indentation are cosmetic
                - Minimal syntax, easy to parse and render
                - Automatic heading styles based on nesting depth
                - Easy lists and easy references
                - No hidden metadata: only user-provided IDs exist
            }
        }

        # Core Concepts @core-concepts
        {
            {[.]
                - A document is a tree of scopes
                - A scope has a heading line and a block (`{ ... }`)
                - Headings are explicit and always start with `#`
                - A scope may have an optional human ID (e.g., `@overview`)
                - References use `@id` in text
                - Paragraphs are separated by blank lines or by a new scope at the same level
                - Whitespace (spaces/tabs) is ignored except where noted
            }
        }
    }

    # Syntax @syntax
    {
        # Heading Line @heading-line
        {
            ```
            # Title text @id
            ```

            {[.]
                - The line must start with `#` (after optional indentation)
                - Multiple `#` characters are allowed but do not affect depth. Depth comes only from scope nesting
                - The optional `@id` must appear at the end of the line, separated by whitespace
                - If no `@id` is present, the scope has no ID
                - If you need a literal `@` in the title, escape it (`\@`)
            }
        }

        # Scope Block @scope-block
        {
            ```
            # Title
            {
                ...
            }
            ```

            `{` opens a scope block and `}` closes it. Indentation is cosmetic.

            # K&R Style Brace Placement @knr-braces
            {
                The opening brace (or list/table opener) may appear at the end of a heading or list-item line instead of on its own line:

                ```
                # Title {
                    ...
                }

                # My List {[.]
                    - Item 1
                    - Item 2
                }

                # Data {[table]
                    Name | Age
                    Alice | 30
                }

                # Title @id {
                    ...
                }
                ```

                {[.]
                    - The opener must be the last token on the line (trailing whitespace is allowed)
                    - Applies to `{`, `{[.]`, `{[#]`, and `{[table]`
                    - Also works on list-item shorthand lines (e.g., `- Item {`)
                    - Escaped braces (`\{`) are not treated as openers
                    - The closing `}` must still appear on its own line
                    - Inline blocks (`{ content }`) are not affected; a line ending with `}` is not treated as K&R
                    - Headingless scopes (bare `{` on its own line) are not affected
                }
            }

            # Headingless Scopes @headingless-scopes
            {
                A bare `{` block without a preceding heading creates a headingless scope:

                ```
{
    Grouped content here.
}
                ```

                {[.]
                    - Headingless scopes render as sections without a heading element
                    - They inherit the same nesting/indentation as headed scopes
                    - Useful for grouping paragraphs or creating visual indentation without a title
                    - Can be nested arbitrarily
                }
            }

            # Inline Blocks @inline-blocks
            {
                For simple content, blocks can be written on a single line:

                ```
                # Name
                { John Doe }

                # Count
                { 42 }
                ```

                {[.]
                    - Inline blocks must not contain unescaped `{` or `}` characters
                    - Multi-line blocks are always supported and sometimes clearer for longer content
                }
            }
        }

        # Lists @lists
        {
            Lists are declared by a list block type:

            ```
            # Bulleted List
            {[.]
                # Item 1
                { ... }
                # Item 2
                { ... }
            }

            # Numbered List
            {[#]
                # Item 1
                { ... }
                # Item 2
                { ... }
            }
            ```

            {[.]
                - `{[.]` creates a bulleted list
                - `{[#]` creates a numbered list
                - List items are scopes inside the list block
                - Commas between list items are allowed but ignored
            }

            # List Item Shorthand @list-shorthand
            {
                Inside a list block, `- Title text` is shorthand for a list item scope:

                ```
                {[.]
                    - Item 1
                    - Item 2
                }
                ```

                {[.]
                    - A shorthand item may optionally be followed by a block (`{ ... }` or list opener)
                    - If no block follows, the item has no body
                    - Rich content after a list item (code blocks, extra paragraphs, nested lists) **must** be wrapped in a `{ }` body block — bare content between list items is a parser error
                    - Shorthand items always render in normal body font, even with a body block. Use `#` headed scopes for heading-style list items
                    - Outside list blocks, leading list-item lines form implicit lists (see @implicit-lists)
                }

                Numbered shorthand is also supported:

                ```
                {[#]
                    1. Item 1
                    2. Item 2
                }
                ```
            }

            # Implicit Lists @implicit-lists
            {
                Inside a normal scope block, a run of list-item lines is treated as a list:

                ```
                # Simple bulleted list
                {
                    - Item 1
                    - Item 2
                }

                # Simple numbered list
                {
                    1. First
                    2. Second
                }
                ```

                {[.]
                    - The list type is chosen by the first item marker (`-` for bulleted, `1.` / `1)` for numbered)
                    - Mixed markers end the implicit list
                    - Each item may optionally be followed by a block (`{ ... }` or list opener)
                }
            }

            # Anonymous List Items @anonymous-list-items
            {
                Inside a list block, a list item can start with a block directly:

                ```
                {[.]
                    {
                        This item has no heading line.
                    }
                }
                ```

                The block contents are rendered as the list item body.
            }

            # Task Lists @task-lists
            {
                Inside a list block, task items use Markdown-style checkboxes:

                ```
                {[.]
                    - [ ] Pending task
                    - [x] Completed task
                }
                ```

                Works in both bulleted and numbered list blocks.
            }
        }

        # Tables @tables
        {
            Tables are declared with `{[table]`:

            ```
{[table]
    Name | Age | City
    Alice | 30 | NYC
    Bob | 25 | LA
}
            ```

            {[.]
                - The first row is always the header
                - Columns are separated by `|`
                - Each row is a single line
                - Cell contents support inline formatting
                - Leading and trailing whitespace in cells is trimmed
            }
        }

        # Paragraphs @paragraphs
        {
            {[.]
                - Consecutive text lines are joined into a single paragraph
                - A blank line ends the paragraph
                - A new scope or list at the same level also ends the paragraph
            }
        }

        # References @references
        {
            {[.]
                - A reference is `@id` in text (unescaped)
                - References link to the scope with that ID
                - ID uniqueness is strongly recommended; tooling may warn on duplicates
            }
        }

        # External Links @external-links
        {
            Markdown-style links:

            ```
            [label](https://example.com)
            ```
        }

        # Autolinks @autolinks
        {
            Angle-bracket links:

            ```
            <https://example.com>
            <mailto:hello@example.com>
            ```

            Only `http`, `https`, and `mailto` schemes are recognised.
        }

        # Images @images
        {
            Markdown-style images:

            ```
            ![Alt text](https://example.com/image.png)
            ```
        }

        # Blockquotes @blockquotes
        {
            ```
            > A quoted line.
            > Another line in the same quote.
            ```

            {[.]
                - Consecutive `>` lines form a single blockquote
                - A blank `>` line breaks paragraphs within the blockquote
            }
        }

        # Horizontal Rules @horizontal-rules
        {
            A line of three or more `-`, `*`, or `_` characters:

            ```
            ---
            ```
        }

        # Inline Formatting @inline-formatting
        {
            {[.]
                - Emphasis: `*em*`
                - Strong: `**strong**`
                - Strikethrough: `~~strike~~`
                - Inline code: `` `code` ``
            }
        }

        # Escaping @escaping
        {
            In normal text (including headings and paragraphs), a backslash escapes: `\\` `\{` `\}` `\@` `\[` `\]` `\(` `\)` `\*` `\~` `\#` `\!` `\<` `\>` and `` \` ``.

            Escapes are processed before reference detection.

            If a line begins with `\#`, it is treated as a normal paragraph line (rendered with a literal `#`). If a line begins with `\>`, it is treated as a normal paragraph line (rendered with a literal `>`).
        }

        # Code Blocks @code-blocks
        {
            Fenced blocks for code or raw text:

            `````
            ```lang
            raw text here { # @ } is not parsed
            ```
            `````

            {[.]
                - The opening and closing fences must be on their own lines
                - Anything inside is treated as raw text (no parsing, no escapes)
                - Optional language tag after the opening fence
            }
        }
    }

    # Styles, Header, and Footer @styling
    {
        # Hierarchical Config @hierarchical-config
        {
            Place `sdoc.config.json` in any folder. When rendering a file, configs are merged from the workspace root down to the file's folder.

            ```json
            {
                "style": "styles/sdoc.custom.css",
                "styleAppend": "styles/overrides.css",
                "header": "My Project Docs",
                "footer": "© 2026 My Company"
            }
            ```

            {[.]
                - The closest config to the file overrides parent configs
                - `style` replaces the default stylesheet
                - `styleAppend` is appended after the base stylesheet (string or array)
                - `header` and `footer` are plain text with inline formatting supported
                - Paths in `style` and `styleAppend` are resolved relative to the config file
            }

            A starter stylesheet template is provided at `examples/sdoc.template.css`.
        }

        # Per-File Overrides (Meta Scope) @meta-scope
        {
            A reserved meta scope overrides header/footer and styles:

            ```
            # Meta @meta
            {
                # Style
                { styles/sdoc.custom.css }
                # StyleAppend
                { styles/overrides.css }
                # Header
                { My *custom* header }
                # Footer
                { Page-specific footer text }
            }
            ```

            {[.]
                - The `@meta` scope is not rendered in the document body
                - The meta scope should appear at the top level of the document
                - `Style` and `StyleAppend` are treated as file paths (relative to the SDOC file)
                - `Header` and `Footer` render their scope contents at the top/bottom of the page
                - Per-file meta settings override the merged `sdoc.config.json` values
                - `@meta` is reserved and should not be used for normal references
            }
        }
    }

    # Interactive Preview @interactive-preview
    {
        The VSCode extension provides an interactive preview with the following features. These are preview-only behaviours and do not affect the SDOC format or static HTML export.

        # Collapsible Scopes @collapsible-scopes
        {
            Scope headings that have children display a toggle triangle, visible on hover. Clicking the triangle collapses the scope's children (hides the content below the heading). Clicking again expands them.

            {[.]
                - The triangle points right when collapsed, down when expanded
                - Collapse state is preserved across preview refreshes using webview state
                - Scopes are identified by their `@id` if present, otherwise by source line number
                - Only scopes with children show the toggle
            }
        }

        # Click-to-Navigate @click-to-navigate
        {
            Clicking any rendered element in the preview (heading, paragraph, code block, blockquote, list item, table, horizontal rule) navigates the editor cursor to the corresponding source line in the SDOC file.

            {[.]
                - Each rendered element carries a `data-line` attribute with its 1-indexed source line number
                - Clicking inside an editable paragraph or on a collapse toggle does not trigger navigation
            }
        }

        # Inline Text Editing @inline-editing
        {
            Paragraphs in the preview are directly editable. Clicking a paragraph gives it focus with a visible outline. Typing changes the text, and pressing Enter or clicking away writes the change back to the source file.

            {[.]
                - Only paragraph elements are editable (not headings, code blocks, etc.)
                - Inline formatting (`*bold*`, `@ref`) in the original source is lost if the user edits text that contained it
                - Escape also blurs the paragraph (discarding focus without triggering a save of the current edit state)
            }
        }
    }

    # Document Formatting @document-formatting
    {
        The VSCode extension provides a built-in document formatter accessible via Format Document (Shift+Option+F). The formatter reindents the document based on brace depth.

        {[.]
            - Blank lines are preserved as empty lines with no indentation
            - Code block content (between ``` fences) is passed through raw with no reindentation
            - Closing braces `}` decrement depth before indenting
            - Standalone openers (`{`, `{[.]`, `{[#]`, `{[table]`) indent at current depth, then increment
            - Inline blocks (`{ content }`) indent at current depth with no depth change
            - K&R lines (heading or list item ending with an opener) indent at current depth, then increment
            - The formatter respects the user's tab size and spaces/tabs preference
            - Formatting is idempotent
        }
    }

    # Parsing Rules @parsing-rules
    {
        Command tokens are recognised only at the start of a line (after optional indentation):

        {[.]
            - `#` heading line
            - `{` scope open
            - `}` scope close
            - `{[.]` / `{[#]` list open
            - `{[table]` table open
            - `>` blockquote line
            - `---` / `***` / `___` horizontal rule
            - `` ``` `` code fence
        }

        Blank lines are allowed anywhere and are ignored.
    }

    # Formal Grammar @grammar
    {
        Informal EBNF grammar:

        ```
        document      = scope ;

        scope         = heading ws? block
                      | heading_with_opener block_body "}" ;
        heading       = "#" { "#" } ws title (ws id)? ;
        heading_with_opener = "#" { "#" } ws title (ws id)? ws block_opener ;
        id            = "@" ident ;
        block_opener  = "{" | "{[.]" | "{[#]" | "{[table]" ;
        block         = "{" ws? block_body "}" ;

        block_body    = { blank | paragraph | scope | headingless_scope
                        | list_scope | table_scope
                        | implicit_list | blockquote | horizontal_rule
                        | code_block | comma_sep } ;
        headingless_scope = "{" ws? block_body "}" ;
        list_scope    = list_open ws? list_body "}" ;
        list_open     = "{[.]" | "{[#]" ;
        table_scope   = "{[table]" ws? table_body "}" ;
        table_body    = table_row { table_row } ;
        table_row     = cell { "|" cell } ;
        list_body     = { blank | comma_sep | scope | list_item_shorthand } ;
        implicit_list = list_item_shorthand { list_item_shorthand } ;
        list_item_shorthand = bullet_item | numbered_item ;
        bullet_item   = "-" ws title [ws? block]?
                      | "-" ws title ws block_opener block_body "}" ;
        numbered_item = number ("." | ")") ws title [ws? block]?
                      | number ("." | ")") ws title ws block_opener block_body "}" ;
        number        = DIGIT { DIGIT } ;

        paragraph     = text_line { ws? text_line } ;
        text_line     = line_not_starting_with_command ;

        blockquote    = quote_line { quote_line | blank } ;
        quote_line    = ">" text_line ;

        horizontal_rule = "---" | "***" | "___" ;

        code_block    = fence_open raw_text fence_close ;
        fence_open    = "```" [lang] newline ;
        fence_close   = "```" newline ;

        comma_sep     = "," ;
        blank         = newline ;

        ident         = (ALPHA | "_") { ALPHA | DIGIT | "_" | "-" } ;
        ```

        {[.]
            - `title` is the remainder of the heading line, excluding the optional trailing `@id`
            - If a line starts with a command token, it is not a paragraph line
            - The grammar is line-oriented; practical parsers should operate on lines
        }
    }

    # Open Questions @open-questions
    {
        {[.]
            - Comment syntax (if any)
            - Duplicate ID resolution (error vs warning vs nearest-scope)
            - Additional list types (checkboxes, alpha, roman)
            - Additional inline formatting (underline, highlight)
        }
    }
}
```
