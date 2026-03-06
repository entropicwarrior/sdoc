# Agent Instructions

## Project Overview

SDOC ("Simple/Smart Documentation") is a plain text documentation format with
explicit brace scoping. This repo contains the format specification, a
JavaScript parser/renderer, and a VS Code extension for live preview.

## Project Knowledge

This project uses the Lexica convention for organising knowledge. Build
knowledge lives in `lexica/` — the specification, requirements, and project
status needed to work on the source code. User-facing documentation lives
in `docs/` — authoring guides, tutorials, and references for people using
the format.

When starting a task:

1. Read `lexica/impl-status.sdoc` for current project state.
2. If changing the parser, read `lexica/specification.sdoc`.
3. If adding features, read `lexica/requirements.sdoc` and `lexica/suggestions.sdoc`.
4. Read only the sections you need — scan headings first.

## Project Structure

```
lexica/             Build knowledge (what you need to work on the src)
  specification.sdoc  The formal v0.1 spec (doc)
  requirements.sdoc   Why SDOC exists, requirements R1-R10 (doc)
  impl-status.sdoc    What's done, what's in progress, what's next (doc)
  sdoc-plan.sdoc      Roadmap: parser, spec additions, export pipeline (doc)
  suggestions.sdoc    Proposed features S1-S9 (doc)

docs/               User-facing documentation (served by document browser)
  guide/              Getting started, setup, the case for SDOC
    why-sdoc.sdoc       Why SDOC over Markdown
  reference/          Authoring guides, syntax, API, CLI
    sdoc-authoring.sdoc How to write correct SDOC files (skill)
    slide-authoring.sdoc How to create slide decks (skill)
  tutorials/          Step-by-step walkthroughs
  index.sdoc          Docs landing page

examples/           Example and reference files
  example.sdoc        Quick reference showing all SDOC features
  sdoc.config.json    Sample config (style, header, footer)
  sdoc.template.css   Sample custom stylesheet
  example-overrides.css  Style override example

src/                Source code
  sdoc.js             Parser and HTML renderer (~2000 lines)
  slide-renderer.js   SDOC-to-HTML slide deck renderer
  slide-pdf.js        PDF export via headless Chrome (used by build-slides.js --pdf)
  extension.js        VS Code extension with preview and document server
  site-template/      Shared viewer templates (index.html, viewer.css)

themes/             Slide themes
  default/            Built-in default theme (CSS + navigation JS)

vendor/             Vendored dependencies
  mermaid.min.js      Mermaid diagram renderer (bundled for offline use)

test/               Test files
  test-all.js         Comprehensive test suite (node test/test-all.js)
  test-knr.js         K&R brace placement tests (node test/test-knr.js)
  test-slides.js      Slide renderer tests (node test/test-slides.js)
  *.sdoc              Test fixture files

tools/              CLI tools
  build-slides.js     Build HTML slides from SDOC (node tools/build-slides.js [--pdf])
  serve_docs.py       CLI to start a local SDOC document server
```

## Before Making Changes

Read `lexica/impl-status.sdoc` first — it has the current task list.

If changing the parser or renderer, read `lexica/specification.sdoc`.
If adding features, read `lexica/requirements.sdoc` and `lexica/suggestions.sdoc`.

The requirements document defines stable goals (R1-R10) that all changes
should be evaluated against.

## Coding Conventions

**JavaScript:**
- Vanilla JS, no transpilation, no TypeScript
- CommonJS require/module.exports (this is a VS Code extension)
- No runtime dependencies — the parser must stay dependency-free
- `const` by default, `let` when reassignment is needed, never `var`
- Semicolons required, double quotes for strings
- Functions over classes unless state encapsulation is clearly needed
- Error collection pattern: accumulate errors, don't throw

**Parser architecture:**
- Line-based parsing. Command tokens only at start of line.
- AST must be format-neutral (see C2 in requirements.sdoc)
- Parsing and rendering are separate concerns
- `parseSdoc()` returns `{ nodes, errors }`. Renderers consume nodes.

**Testing:**
- No test framework — tests are plain Node scripts with assert helpers
- Run all tests: `node test/test-all.js && node test/test-knr.js && node test/test-slides.js`
- Tests exit non-zero on failure
- Run tests and verify 0 failures before committing parser changes

**Building the extension:**
- `npm run package` (produces `dist/sdoc-<version>.vsix`)
- Install: `code --install-extension dist/sdoc-<version>.vsix`

## Branching Strategy

This project uses **Git Flow**:

- `main` — stable releases, tagged with version numbers
- `develop` — integration branch, features merge here
- `release/vX.Y.Z` — cut from `develop` when ready to release, merged to both `main` and `develop`
- `feat/*`, `fix/*` — short-lived branches off `develop`

Branch from `develop`, open PRs targeting `develop`. No direct pushes to `main` or `develop`.

## SDOC Format

Knowledge files use the SDOC format (`.sdoc`). If you need to write or edit
SDOC, use the `sdoc_reference` tool for the format guide. Start with the
Quick Reference and Common Mistakes sections.
