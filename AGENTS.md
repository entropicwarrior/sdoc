# Agent Instructions

## Project Overview

SDOC ("Simple/Smart Documentation") is a plain text documentation format with
explicit brace scoping. This repo contains the format specification, a
JavaScript parser/renderer, and a VS Code extension for live preview.

## Project Knowledge

This project uses the Lexica convention for organising knowledge:

- `skills/` directories contain **how-to knowledge**: patterns, conventions,
  techniques, runbooks.
- `spec/` contains **reference knowledge**: specs, architecture, design
  decisions, plans, project status.

**Note:** `docs/` is used for user-facing documentation served by the SDOC
document browser — not for agent knowledge.

When starting a task:

1. List the `skills/` and `spec/` directories at the repo root.
2. Read filenames to identify relevant knowledge.
3. Open relevant files and read the About section near the top to confirm
   relevance.
4. Read only the sections you need — scan headings first.

## Project Structure

```
spec/               Specification and governance
  requirements.sdoc   Why SDOC exists, abstract requirements (R1-R10)
  specification.sdoc  The formal v0.1 spec, written in SDOC format
  suggestions.sdoc    Proposed features (S1-S9) with priority and rationale
  status.sdoc         What's done, what's in progress, what's next
  lexica.sdoc         Lexica knowledge system description
  skill-files-design.sdoc         Lexica design document
  skill-files-implementation-plan.sdoc  Lexica implementation plan

skills/             How-to knowledge for agents
  sdoc-authoring.sdoc  How to write correct SDOC files

examples/           Example and reference files
  example.sdoc        Quick reference showing all SDOC features
  sdoc.config.json    Sample config (style, header, footer)

docs/               User-facing documentation (served by document browser)
  guide/              Getting started, setup
  reference/          API and CLI reference
  tutorials/          Step-by-step tutorials
  index.sdoc          Docs landing page

src/                Source code
  sdoc.js             Parser and HTML renderer (~1800 lines)
  extension.js        VS Code extension with preview and document server
  site-template/      Shared viewer templates (index.html, viewer.css)

test/               Test files
  test-all.js         Comprehensive test suite (node test/test-all.js)
  test-knr.js         K&R brace placement tests (node test/test-knr.js)

tools/              CLI tools
  serve_docs.py       CLI to start a local SDOC document server
```

## Before Making Changes

Read `spec/status.sdoc` first — it has the current task list.

If changing the parser or renderer, read `spec/specification.sdoc`.
If adding features, read `spec/requirements.sdoc` and `spec/suggestions.sdoc`.

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
