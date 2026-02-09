#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const SPEC_PATH = path.resolve(__dirname, "..", "spec", "specification.sdoc");
const OUTPUT_PATH = path.resolve(__dirname, "..", "SDOC_GUIDE.md");

const QUICK_REFERENCE = `# SDOC Guide

SDOC ("Simple/Smart Documentation") is a plain-text documentation format where structure is defined by explicit brace scoping — indentation is purely cosmetic.

This guide teaches you everything you need to write SDOC files. Part 1 is a quick reference with examples. Part 2 is the full specification for edge cases.

---

## Quick Reference

### Core Principle

All structure comes from \`{ }\` braces. Whitespace and indentation are cosmetic — use them freely for readability but they never affect meaning.

### Scopes

A scope is a heading followed by a brace-delimited block. Nesting depth determines heading style.

\`\`\`
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
\`\`\`

- \`#\` starts a heading (multiple \`#\` characters are allowed but don't affect depth — only nesting does)
- \`@id\` at the end of a heading line assigns a referenceable ID
- \`{ }\` delimits the scope's content

### Headingless Scopes

A bare \`{ }\` block without a heading creates a section without a title — useful for grouping content:

\`\`\`
{
    This content is grouped and indented, but has no heading.
}
\`\`\`

### Inline Blocks

Short content can be written on one line:

\`\`\`
# Author
{ Jane Doe }

# Version
{ 1.0 }
\`\`\`

### K&R Brace Style

The opening brace (or list/table opener) can appear at the end of the heading line instead of on its own line:

\`\`\`
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
\`\`\`

This also works on list item lines: \`- Item {\`. K&R and Allman styles can be mixed freely in the same document.

### Paragraphs

Consecutive text lines form a paragraph. A blank line or a new scope ends the paragraph.

\`\`\`
# About
{
    This is the first paragraph.
    These lines join together.

    This is a second paragraph.
}
\`\`\`

### Lists

#### Explicit List Blocks

Use \`{[.]}\` for bulleted or \`{[#]}\` for numbered lists:

\`\`\`
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
\`\`\`

#### List Items with Bodies

Items can have their own content block:

\`\`\`
{[.]
    - Item with details
    {
        This paragraph belongs to the item above.
    }
    - Simple item
}
\`\`\`

#### Implicit Lists

Inside a normal scope, a run of \`-\` or \`1.\` lines automatically becomes a list:

\`\`\`
# Quick List
{
    - Alpha
    - Beta
    - Gamma
}
\`\`\`

#### Anonymous List Items

Items with no heading — just a body block:

\`\`\`
{[.]
    {
        First item, body only.
    }
    {
        Second item, body only.
    }
}
\`\`\`

#### Task Lists

Checkbox syntax inside a list block:

\`\`\`
{[.]
    - [ ] Pending task
    - [x] Completed task
}
\`\`\`

### Tables

Declared with \`{[table]}\`. First row is the header, columns separated by \`|\`:

\`\`\`
{[table]
    Name | Age | City
    Alice | 30 | NYC
    Bob | 25 | LA
}
\`\`\`

### Inline Formatting

| Syntax | Result |
|--------|--------|
| \`*text*\` | Emphasis |
| \`**text**\` | Strong |
| \`~~text~~\` | Strikethrough |
| \`\\\`code\\\`\` | Inline code |

### Links and Images

\`\`\`
[Link text](https://example.com)
<https://example.com>
<mailto:hello@example.com>
![Alt text](path/to/image.png)
\`\`\`

### References

Assign an ID with \`@id\` on a heading, then reference it anywhere with \`@id\`:

\`\`\`
# Setup @setup
{
    Follow these instructions.
}

# Usage
{
    Make sure you complete @setup first.
}
\`\`\`

### Blockquotes

\`\`\`
> This is a quoted line.
> Another line in the same quote.
>
> New paragraph in the same quote.
\`\`\`

### Code Blocks

Fenced with triple backticks. Content inside is raw (no parsing):

\`\`\`\`
\`\`\`javascript
function hello() {
    console.log("Hello!");
}
\`\`\`
\`\`\`\`

### Horizontal Rules

A line of three or more \`-\`, \`*\`, or \`_\`:

\`\`\`
---
\`\`\`

### Escaping

Backslash escapes special characters: \`\\\\\` \`\\{\` \`\\}\` \`\\@\` \`\\[\` \`\\]\` \`\\(\` \`\\)\` \`\\*\` \`\\~\` \`\\#\` \`\\!\` \`\\<\` \`\\>\` \`\\\\\`\`

A line starting with \`\\#\` renders as a literal \`#\` (not a heading). A line starting with \`\\>\` renders as a literal \`>\` (not a blockquote).

### Meta Scope

The reserved \`@meta\` scope configures per-file settings and is not rendered in the document body:

\`\`\`
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
\`\`\`

Hierarchical configuration is also available via \`sdoc.config.json\` files in any folder.

### Conventions

- **Indentation:** Use any whitespace you like — it's cosmetic. Most authors use 4 spaces.
- **IDs:** Use lowercase kebab-case (\`@my-section\`). IDs should be unique within a document.
- **Commas:** Commas between list items or scopes are allowed but ignored — use them if you find them readable.

### Complete Example

\`\`\`
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
            2. Run \\\`npm install\\\`
            3. Run \\\`npm start\\\`
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
\`\`\`

---
`;

function main() {
  let spec;
  try {
    spec = fs.readFileSync(SPEC_PATH, "utf-8");
  } catch (err) {
    console.error(`Error reading specification: ${err.message}`);
    process.exit(1);
  }

  const output = `${QUICK_REFERENCE}
## Full Specification

The authoritative SDOC specification follows below. Refer to this for edge cases, formal grammar, and detailed parsing rules.

\`\`\`
${spec.trimEnd()}
\`\`\`
`;

  fs.writeFileSync(OUTPUT_PATH, output, "utf-8");
  console.log(`Generated ${OUTPUT_PATH}`);
}

main();
