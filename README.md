# SDOC

A plain-text documentation format designed for AI-agent efficiency. Explicit brace scoping means deterministic parsing, surgical section extraction, and 10-50x token savings compared to Markdown.

## Why SDOC?

- **Unambiguous structure** — `{ }` braces define scope, not whitespace or heading levels. No guessing where a section ends.
- **Progressive disclosure** — AI agents can read a table of contents, then extract only the sections they need. No need to consume the whole file.
- **Unlimited nesting** — Nest scopes as deep as you like. Structure follows your content, not format limitations.
- **Content-presentation separation** — The AST is format-neutral. Render to HTML, slides, PDF, or anything else from the same source.
- **Human-readable as plain text** — No build step required to read an SDOC file. It looks good in any text editor.

## What's in the Box

**The format** — a formal specification (`lexica/specification.sdoc`) with EBNF grammar, plus a comprehensive authoring guide written as an AI agent skill document. Drop `lexica/sdoc-authoring.sdoc` into any AI agent's context and it can read and write SDOC immediately.

**A zero-dependency JavaScript parser** — `src/sdoc.js` parses SDOC into a format-neutral AST. No runtime dependencies, works anywhere Node runs. Parsing and rendering are cleanly separated — build your own renderers on top.

**Slide deck generation** — turn any SDOC file into an HTML slide deck with themes, layouts (center, two-column), speaker notes, mermaid diagrams, and PDF export via headless Chrome.

**A document site builder** — serve a folder of SDOC files as a browsable site with sidebar navigation, search, and split-pane comparison.

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

Each top-level scope becomes a slide. Set `type: slides` in `@meta`. See `lexica/slide-authoring.sdoc` for the full authoring guide.

### Browse documents

```bash
python3 tools/serve_docs.py docs/
```

Or use the **SDOC: Browse Documents** command from the VS Code Command Palette.

## Format at a Glance

```sdoc
# Chapter One @chapter-1
{
    This is body text with *emphasis*, **strong**, and `code`.

    # Nested Section @details
    {
        Unlimited nesting. Each scope is independently addressable.

        {[code lang=python]
            def hello():
                print("Hello from SDOC")
        }
    }

    # A List
    {
        {[.]
            - First item
            - Second item with **bold**
            - Third item
        }
    }
}
```

## Learning the Format

- `docs/guide/intro.sdoc` — what SDOC is and why
- `docs/tutorials/first-steps.sdoc` — write your first document
- `docs/reference/syntax.sdoc` — full syntax reference
- `SDOC_GUIDE.md` — quick reference in Markdown (also used by AI tools)

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

**Auto-sync:** changes to `src/sdoc.js` and `lexica/sdoc-authoring.sdoc` automatically open a PR in the `lexica-common` repo via GitHub Actions.

## License

[MIT](LICENSE) — 2026 Irreversible Inc.
