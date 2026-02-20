# Agent Instructions

## Project Overview

SDOC ("Simple/Smart Documentation") is a plain text documentation format with
explicit brace scoping. This repo contains the format specification, a
JavaScript parser/renderer, and a VS Code extension for live preview.

## Project Knowledge

This project uses the Lexica convention for organising knowledge. All
knowledge files live in `lexica/` at the repo root.

When starting a task:

1. List the `lexica/` directory at the repo root.
2. Read filenames to identify relevant knowledge.
3. Open relevant files and read the About section near the top to confirm
   relevance.
4. Read only the sections you need — scan headings first.
5. Check parent directories for broader project-wide knowledge.

## Project Structure

```
lexica/             Project knowledge (all skills and reference docs)
  INDEX.sdoc          Auto-generated knowledge index
  sdoc-authoring.sdoc How to write correct SDOC files (skill)
  specification.sdoc  The formal v0.1 spec (doc)
  requirements.sdoc   Why SDOC exists, requirements R1-R10 (doc)
  suggestions.sdoc    Proposed features S1-S9 (doc)
  status.sdoc         What's done, what's in progress, what's next (doc)
  lexica.sdoc         Lexica knowledge system description (doc)
  lexica-design.sdoc  Lexica design document (doc)
  lexica-plan.sdoc    Lexica implementation plan (doc)

docs/               User-facing documentation (served by document browser)
  guide/              Getting started, setup
  reference/          API and CLI reference
  tutorials/          Step-by-step tutorials
  index.sdoc          Docs landing page

examples/           Example and reference files
  example.sdoc        Quick reference showing all SDOC features
  sdoc.config.json    Sample config (style, header, footer)
  sdoc.template.css   Sample custom stylesheet
  example-overrides.css  Style override example

src/                Source code
  sdoc.js             Parser and HTML renderer (~1900 lines)
  extension.js        VS Code extension with preview and document server
  site-template/      Shared viewer templates (index.html, viewer.css)

test/               Test files
  test-all.js         Comprehensive test suite (node test/test-all.js)
  test-knr.js         K&R brace placement tests (node test/test-knr.js)
  *.sdoc              Test fixture files

tools/              CLI tools
  serve_docs.py       CLI to start a local SDOC document server
  generate_guide.js   Generates SDOC_GUIDE.md from parser source
  generate_index.js   Generates INDEX.sdoc for a lexica/ directory
```

## Before Making Changes

Read `lexica/status.sdoc` first — it has the current task list.

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
- Run all tests: `node test/test-all.js && node test/test-knr.js`
- Tests exit non-zero on failure
- Run tests and verify 0 failures before committing parser changes

**Building the extension:**
- `npm run package` (produces `dist/sdoc-<version>.vsix`)
- Install: `code --install-extension dist/sdoc-<version>.vsix`

## SDOC Format

Knowledge files use the SDOC format (`.sdoc`). If you need to write or edit
SDOC, use the `sdoc_reference` tool for the format guide. Start with the
Quick Reference and Common Mistakes sections.
