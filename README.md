# SDOC

A plain-text documentation format designed for AI-agent efficiency. Explicit brace scoping means deterministic parsing, surgical section extraction, and 10-50x token savings compared to Markdown.

## Why SDOC?

Markdown has no formal structure — section boundaries are ambiguous, extraction requires heuristics, and AI agents waste tokens loading entire files to find one section. SDOC fixes this.

- **Unambiguous structure** — `{ }` braces define scope, not whitespace or heading levels. No guessing where a section ends.
- **Progressive disclosure** — AI agents can read a table of contents, then extract only the sections they need. No need to consume the whole file.
- **Unlimited nesting** — Nest scopes as deep as you like. Structure follows your content, not format limitations.
- **Parsing safety** — Deterministic parsing eliminates the ambiguity that creates injection surfaces in automated document processing pipelines.
- **Content-presentation separation** — The AST is format-neutral. Render to HTML, slides, PDF, or anything else from the same source.
- **Human-readable as plain text** — No build step required to read an SDOC file. It looks good in any text editor.

## What's in the Box

**The format** — a formal specification (`lexica/specification.sdoc`) with EBNF grammar, plus a comprehensive authoring guide written as an AI agent skill document. Drop `docs/reference/sdoc-authoring.sdoc` into any AI agent's context and it can read and write SDOC immediately.

**A zero-dependency JavaScript parser** — `src/sdoc.js` parses SDOC into a format-neutral AST. No runtime dependencies, works anywhere Node runs. Parsing and rendering are cleanly separated — build your own renderers on top.

**Slide deck generation** — turn any SDOC file into an HTML slide deck with themes, layouts (center, two-column), speaker notes, mermaid diagrams, and PDF export via headless Chrome.

**A document site builder** — serve a folder of SDOC files as a browsable site with sidebar navigation, search, and split-pane comparison.

**PDF and HTML export** — export any document to A4 PDF via headless Chrome, or to standalone HTML. Available as both a CLI tool and a VS Code command.

**A VS Code extension** — live preview, sticky scroll, code folding, document symbols, mermaid rendering, and commands for all the above.

## Quick Start

```bash
# Build and install the VS Code extension
npm install
npm run package
code --install-extension dist/sdoc-*.vsix
```

Open any `.sdoc` file and click the preview icon in the editor title bar, or run **SDOC: Open Preview to the Side** from the Command Palette.

### Build slides

```bash
node tools/build-slides.js deck.sdoc -o slides.html
```

Each top-level scope becomes a slide. Set `type: slides` in `@meta`. See `docs/reference/slide-authoring.sdoc` for the full authoring guide.

### Export to PDF or HTML

```bash
node tools/build-doc.js doc.sdoc                   # PDF (requires Chrome)
node tools/build-doc.js doc.sdoc --html -o doc.html # HTML
```

Or use **SDOC: Export PDF** / **SDOC: Export HTML** from the VS Code Command Palette.

### Browse documents

```bash
python3 tools/serve_docs.py docs/
```

Or use the **SDOC: Browse Documents** command from the VS Code Command Palette.

## For AI Agents

This repo provides an [`llms.txt`](https://raw.githubusercontent.com/entropicwarrior/sdoc/main/llms.txt) file at the repo root for AI agent discovery.

Key resources for agents:

| Resource | What it gives you |
|---|---|
| [`docs/reference/sdoc-authoring.sdoc`](https://raw.githubusercontent.com/entropicwarrior/sdoc/main/docs/reference/sdoc-authoring.sdoc) | Skill document — drop into context to read/write SDOC immediately |
| [`lexica/specification.sdoc`](https://raw.githubusercontent.com/entropicwarrior/sdoc/main/lexica/specification.sdoc) | Formal spec with EBNF grammar |

All `.sdoc` files are designed for progressive disclosure. The JavaScript API provides three functions that let agents navigate without loading entire files:

```javascript
const { extractAbout, listSections, extractSection } = require("@entropicwarrior/sdoc");

extractAbout(text);              // ~50 tokens — what is this file about?
listSections(text);              // ~50-100 tokens — what sections does it have?
extractSection(text, "error-handling"); // ~200-1000 tokens — give me just this section
```

Total cost for a precise answer: ~750 tokens. The same lookup in Markdown requires loading the full file (5,000-50,000 tokens).

## Format at a Glance

```sdoc
# Chapter One @chapter-1
{
    This is body text with *emphasis*, **strong**, and `code`.

    # Nested Section @details
    {
        Unlimited nesting. Each scope is independently addressable.

        ```python
        def hello():
            print("Hello from SDOC")
        ```
    }

    # Status :example
    {
        {[table 60% center]
            Endpoint | Status
            /v2/api | {+Active+}
            /v1/api | {-Deprecated-}
        }
    }

    # Internal Notes :comment
    {
        This scope is invisible in rendered output but
        stays in the AST for tooling and agents.
    }
}
```

## Features

### Inline Formatting

`*emphasis*`, `**strong**`, `~~strikethrough~~`, `` `inline code` ``, `[links](url)`, and `<https://autolinks>`.

### Semantic Markers

Annotate text with semantic meaning that renders as colored highlights:

| Syntax | Meaning | Color |
|---|---|---|
| `{+text+}` | Positive | Green |
| `{=text=}` | Neutral | Blue |
| `{^text^}` | Note | Amber |
| `{?text?}` | Caution | Dark amber |
| `{!text!}` | Warning | Orange |
| `{-text-}` | Negative | Red |
| `{~text~}` | Highlight | Yellow |

Markers nest with other inline formatting: `{+**all checks** passed+}`.

### Math

Inline math with `$x^2 + y^2$`, display math with `$$E = mc^2$$`, and multi-line equations with ` ```math ` code fences. Rendered via KaTeX.

### Code Blocks

Fenced with triple backticks, optional language tag for syntax highlighting. The `src:` directive includes external files inline:

````
```json src:./config.json lines:1-10
```
````

### Mermaid Diagrams

Code blocks tagged `mermaid` render as SVG diagrams — flowcharts, sequence diagrams, class diagrams, state diagrams, and more.

### Images

Markdown-style images with optional width and alignment:

```
![Photo](image.png =50% center)
```

### Tables

Pipe-delimited tables with optional flags for appearance (`borderless`, `headerless`), width (`auto`, `60%`, `400px`), and alignment (`left`, `center`, `right`). All flags compose freely. Cells starting with `=` are evaluated as formulas (`=SUM`, `=AVG`, `=COUNT`, arithmetic with A1 cell references).

### Lists

Bullet lists (`-`), numbered lists (`1.`), and task lists (`- [ ]` / `- [x]`). Items can have rich body content including nested lists, code blocks, and paragraphs.

### References

Tag any section with `@id` and cross-reference it anywhere with `@id` — renders as a clickable link.

### Slides

Turn any SDOC file into an HTML slide deck with themes, layouts (center, two-column), speaker notes, and PDF export.

### Scope Types

Classify scopes with a `:type` annotation — `:schema`, `:warning`, `:deprecated`, `:example`, or any custom label. Types render as `data-scope-type` attributes and CSS classes for styling.

### Data Blocks

Tag a JSON code fence with `:data` and the parser validates and stores the parsed result on the AST node. `extractDataBlocks()` gives programmatic access. Ideal for embedding schemas, configs, and structured metadata alongside prose.

### Comment Scopes

A `:comment` scope is excluded from rendered output but stays in the AST — perfect for agent instructions, internal notes, and build metadata that readers shouldn't see.

### Custom Styling

Per-folder `sdoc.config.json` or per-file `@meta` scope for custom CSS, headers, footers, and confidentiality banners. Configs cascade from workspace root to file.

## Learning the Format

- `docs/guide/intro.sdoc` — what SDOC is and why
- `docs/guide/why-sdoc.sdoc` — the case for SDOC over Markdown
- `docs/tutorials/first-steps.sdoc` — write your first document
- `docs/reference/sdoc-authoring.sdoc` — authoring guide with quick reference and common mistakes
- `docs/reference/syntax.sdoc` — full syntax reference

## Contributing

This project uses **Git Flow**:

| Branch | Purpose |
|---|---|
| `main` | Stable releases, tagged with version numbers |
| `develop` | Integration branch — features merge here |
| `release/vX.Y.Z` | Cut from `develop` when ready to release |
| `feat/*`, `fix/*` | Short-lived branches off `develop` |

**To contribute:**

1. Create a branch off `develop` (`feat/my-feature`, `fix/parser-bug`, etc.)
2. Make your changes, commit, push
3. Open a PR targeting `develop`
4. Get one approval from another contributor
5. Merge (squash or regular — your call)

Release branches merge to both `main` and `develop`. No direct pushes to `main` or `develop`.

## License

[MIT](LICENSE) — 2026 @entropicwarrior
