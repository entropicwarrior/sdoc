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

## Building Slides

Generate an HTML slide deck from an SDOC file:

```
node tools/build-slides.js deck.sdoc [-o output.html] [--theme path/to/theme]
```

Each top-level scope becomes a slide. Set `type: slides` in `@meta`. See `lexica/slide-authoring.sdoc` for the full authoring guide.

## Contributing

**Branch strategy:** trunk-based development with branch protection on `main`.

1. Create a short-lived branch off `main` (`fix/parser-bug`, `feat/list-items`, etc.)
2. Make your changes, commit, push
3. Open a PR to `main`
4. Get one approval from another contributor
5. Merge (squash or regular — your call)

No direct pushes to `main`. Keep branches short — merge often rather than accumulating large changes.

**Auto-sync:** changes to `src/sdoc.js` and `lexica/sdoc-authoring.sdoc` automatically open a PR in the `lexica-common` repo via GitHub Actions. You don't need to do anything — just be aware that parser and skill file changes propagate.

## Learning the Format

- `docs/guide/intro.sdoc` — what SDOC is and why
- `docs/tutorials/first-steps.sdoc` — write your first document
- `docs/reference/syntax.sdoc` — full syntax reference
- `SDOC_GUIDE.md` — quick reference in Markdown (also used by AI tools)
