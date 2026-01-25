# SDOC v0.1 (Draft Spec)

This document defines the first draft of the SDOC ("Simple/Smart Documentation") format.

## Goals
- Explicit scoping with braces; whitespace and indentation are cosmetic.
- Minimal syntax, easy to parse and render.
- Automatic heading styles based on nesting depth.
- Easy lists and easy references.
- No hidden metadata: only user-provided IDs exist.

## Core Concepts
- A document is a tree of **scopes**.
- A scope has a **heading line** and a **block** (`{ ... }`).
- Headings are explicit and always start with `#`.
- A scope may have an optional human ID (e.g., `@overview`).
- References use `@id` in text.
- Paragraphs are separated by blank lines or by a new scope at the same level.
- Whitespace (spaces/tabs) is ignored except where noted.

## Syntax Overview

### Heading Line
```
# Title text @id
```
- The line must start with `#` (after optional indentation).
- Multiple `#` characters are allowed but **do not** affect depth. Depth comes only from scope nesting.
- The optional `@id` must appear at the **end** of the line, separated by whitespace.
- If no `@id` is present, the scope has **no ID**.
- If you need a literal `@` in the title, escape it (`\@`).

### Scope Block
```
# Title
{
    ...
}
```
- `{` opens a scope block and `}` closes it.
- Indentation is cosmetic.

### Lists
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
- `{[.]` creates a bulleted list.
- `{[#]` creates a numbered list.
- List items are **scopes** inside the list block.
- Commas between list items are allowed but ignored.

#### List Item Shorthand
Inside a list block, `- Title text` is shorthand for a list item scope:
```
{[.]
    - Item 1
    - Item 2
}
```
- A shorthand item may optionally be followed by a block (`{ ... }` or list opener).
- If no block follows, the item has no body.
- Outside list blocks, leading list-item lines form implicit lists (see below).

You can also use numbered shorthand inside list blocks:
```
{[#]
    1. Item 1
    2. Item 2
}
```

#### Implicit (Simple) Lists
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
- The list type is chosen by the first item marker (`-` for bulleted, `1.` / `1)` for numbered).
- Mixed markers end the implicit list.
- Each item may optionally be followed by a block (`{ ... }` or list opener).

#### Anonymous List Items
Inside a list block, you can also start a list item with a block directly:
```
{[.]
    {
        This item has no heading line.
    }
}
```
- The block contents are rendered as the list item body.

#### Task Lists
Inside a list block, task items use Markdown-style checkboxes:
```
{[.]
    - [ ] Pending task
    - [x] Completed task
}
```
- Works in both bulleted and numbered list blocks.

### Paragraphs
- Consecutive text lines are joined into a **single paragraph**.
- A blank line ends the paragraph.
- A new scope or list at the same level also ends the paragraph.

### References
- A reference is `@id` in text (unescaped).
- References link to the scope with that ID.
- ID uniqueness is strongly recommended; tooling may warn on duplicates.

### External Links
Use Markdown-style links:
```
[label](https://example.com)
```

### Autolinks
Use angle-bracket links:
```
<https://example.com>
<mailto:hello@example.com>
```
Only `http`, `https`, and `mailto` schemes are recognized for autolinks.

### Images
Use Markdown-style images:
```
![Alt text](https://example.com/image.png)
```

### Blockquotes
Use `>` at the start of a line:
```
> A quoted line.
> Another line in the same quote.
```
- Consecutive `>` lines form a single blockquote.
- A blank `>` line breaks paragraphs within the blockquote.

### Horizontal Rules
Use a line of three or more `-`, `*`, or `_` characters:
```
---
```

### Inline Formatting
- Emphasis: `*em*`
- Strong: `**strong**`
- Strikethrough: `~~strike~~`
- Inline code: `` `code` ``

## Styles, Header, and Footer
SDOC supports optional styling, a page header, and a page footer.

### Hierarchical Config (sdoc.config.json)
Place `sdoc.config.json` in any folder. When rendering a file, configs are merged from the workspace root down to the file's folder.

Example `sdoc.config.json`:
```
{
    "style": "styles/sdoc.custom.css",
    "styleAppend": "styles/overrides.css",
    "header": "My Project Docs",
    "footer": "© 2026 My Company"
}
```

Rules:
- The closest config to the file overrides parent configs.
- `style` replaces the default stylesheet.
- `styleAppend` is appended after the base stylesheet (string or array).
- `header` and `footer` are plain text with inline formatting supported.
- Paths in `style` and `styleAppend` are resolved relative to the config file.

Note: A starter stylesheet template is provided at `styles/sdoc.template.css`.

### Per-file Overrides (Meta Scope)
Use a reserved meta scope to override header/footer and styles:
```
# Meta @meta
{
    # Style
    {
        styles/sdoc.custom.css
    }
    # StyleAppend
    {
        styles/overrides.css
    }
    # Header
    {
        My *custom* header
    }
    # Footer
    {
        Page-specific footer text
    }
}
```

Rules:
- The `@meta` scope is not rendered in the document body.
- The meta scope should appear at the top level of the document.
- `Style` and `StyleAppend` are treated as file paths (relative to the SDOC file).
- `Header` and `Footer` render their scope contents at the top/bottom of the page.
- Per-file meta settings override the merged `sdoc.config.json` values.
- `@meta` is reserved and should not be used for normal references.

### Escaping
In normal text (including headings and paragraphs), a backslash escapes:
- `\\` `\{` `\}` `\@` `\[` `\]` `\(` `\)` `\*` `\~` `\#` `\!` `\<` `\>` ``\```  
Escapes are processed before reference detection.
If a line begins with `\#`, it is treated as a normal paragraph line (rendered with a literal `#`).
If a line begins with `\>`, it is treated as a normal paragraph line (rendered with a literal `>`).

### Code Blocks (Raw Text)
Use fenced blocks for code or raw text:
`````
```lang
raw text here { # @ } is not parsed
```
`````
- The opening and closing fences must be on their own lines.
- Anything inside is treated as raw text (no parsing, no escapes).
- Optional language tag after the opening fence.

## Parsing Rules (Line-Based)
Command tokens are recognized only at the start of a line (after optional indentation):
- `#` heading line
- `{` scope open
- `}` scope close
- `{[.]` / `{[#]` list open
- `>` blockquote line
- `---` / `***` / `___` horizontal rule
- `` ``` `` code fence

Blank lines are allowed anywhere and are ignored.

## Informal Grammar (EBNF-ish)
```
document      = scope ;

scope         = heading ws? block ;
heading       = "#" { "#" } ws title (ws id)? ;
id            = "@" ident ;
block         = "{" ws? block_body "}" ;

block_body    = { blank | paragraph | scope | list_scope | implicit_list | blockquote | horizontal_rule | code_block | comma_sep } ;
list_scope    = list_open ws? list_body "}" ;
list_open     = "{[.]" | "{[#]" ;
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

Notes:
- `title` is the remainder of the heading line, excluding the optional trailing `@id`.
- If a line starts with a command token, it is **not** a paragraph line.
- The grammar is line-oriented; practical parsers should operate on lines.

## Example (Updated)
```
# Example Simple/Smart Document
{
    # Overview @overview
    {
        This is an example document. Scopes are explicit.
        The style of a heading is based on its nesting depth.
        References look like @overview.
    }

    # Lists
    {
        # Bulleted
        {[.]
            - Item 1
            {
                Item 1 details.
            }
            - Item 2
            {
                Item 2 details.
            }
        }

        # Numbered
        {[#]
            - First
            {
                First details.
            }
            - Second
            {
                Second details.
            }
        }
    }
}
```

## Open Questions (For Later Iteration)
- Comment syntax (if any).
- Duplicate ID resolution (error vs warning vs nearest-scope).
- Additional list types (checkboxes, alpha, roman).
- Additional inline formatting (underline, strikethrough, highlight).
