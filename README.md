# SDOC

A plain-text documentation format with explicit brace scoping. Structure comes from `{ }` — indentation is cosmetic.

## Quick Start

Build and install the VS Code extension:

```
npm install
npm run package
code --install-extension dist/sdoc-*.vsix
```

Open `examples/example.sdoc` to see the format in action. Click the preview-to-side icon in the editor title bar (or run **SDOC: Open Preview to the Side** from the Command Palette) to see it rendered.

## Reading the Docs

The `docs/` folder contains the full guide, syntax reference, API reference, and tutorials — all written in SDOC.

**In VS Code:** Open any `.sdoc` file and click the preview-to-side icon in the editor title bar.

**In a browser:** Serve all docs with a local HTTP server:

```
python3 tools/serve_docs.py docs/
```

Or use the **SDOC: Browse Documents** command from the VS Code Command Palette. The viewer opens in your browser with a sidebar, search, and split-pane comparison. Edits are reflected on refresh.

## Learning the Format

- `docs/guide/intro.sdoc` — what SDOC is and why
- `docs/tutorials/first-steps.sdoc` — write your first document
- `docs/reference/syntax.sdoc` — full syntax reference
- `SDOC_GUIDE.md` — quick reference in Markdown (also used by AI tools)
