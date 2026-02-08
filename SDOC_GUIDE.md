# SDOC Guide

SDOC ("Simple/Smart Documentation") is a plain-text documentation format where structure is defined by explicit brace scoping — indentation is purely cosmetic.

This guide teaches you everything you need to write SDOC files. Part 1 is a quick reference with examples. Part 2 is the full specification for edge cases.

---

## Quick Reference

### Core Principle

All structure comes from `{ }` braces. Whitespace and indentation are cosmetic — use them freely for readability but they never affect meaning.

### Scopes

A scope is a heading followed by a brace-delimited block. Nesting depth determines heading style.

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

- `#` starts a heading (multiple `#` characters are allowed but don't affect depth — only nesting does)
- `@id` at the end of a heading line assigns a referenceable ID
- `{ }` delimits the scope's content

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

The reserved `@meta` scope configures per-file settings and is not rendered in the document body:

```
# Meta @meta
{
    # Style
    { styles/custom.css }
    # StyleAppend
    { styles/overrides.css }
    # Header
    { My *custom* header }
    # Footer
    { Footer text here }
}
```

Hierarchical configuration is also available via `sdoc.config.json` files in any folder.

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

---

## Full Specification

The authoritative SDOC specification follows below. Refer to this for edge cases, formal grammar, and detailed parsing rules.

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

        scope         = heading ws? block ;
        heading       = "#" { "#" } ws title (ws id)? ;
        id            = "@" ident ;
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
        bullet_item   = "-" ws title [ws? block]? ;
        numbered_item = number ("." | ")") ws title [ws? block]? ;
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
