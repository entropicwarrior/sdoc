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
  slide-layouts.js    Structured slide layouts (columns, stats, pipeline, ...)
  slide-connectors.js Connectors: a line between two elements named by @id, with a
                      shape hint (vh, hv, elbow, straight). The routing is pure and
                      is serialised into the deck with toString(), so one
                      implementation runs in the page and is unit-tested here.
                      Resolved once, in the browser, against the laid-out boxes —
                      which is why the HTML build and every export agree without any
                      of them re-measuring. Both harvests call
                      window.sdocConnectors.resolve(slide) once a slide is visible.
  slide-geometry.js   Measures a built deck in headless Chrome
  slide-pptx.js       PowerPoint / Google Slides export, driven by that measurement
  slide-pdf.js        PDF export via headless Chrome (used by build-slides.js --pdf)
  slide-fade-bake.js  Bakes `background-fade` into the picture for export: a CSS
                      mask becomes a PDF soft mask that macOS Preview draws as a
                      hard edge. HTML keeps the mask; --pdf and --pptx bake.
  slide-artifact.js   Claude Slides artifact export: harvests the DOM tree and
                      emits flow layout, so an edit in the editor reflows
  slide-artifact-validate.js  The Slides subset as data, and a validator for it
                      (nothing checks these files once published)
  theme.js            Theme loading, theme.json, CSS asset inlining
  zip.js              Minimal ZIP writer (zlib only), for the PPTX package
  extension.js        VS Code extension with preview and document server
  href-path.js        Resolves a link href to a file on disk (raw, then percent-
                      decoded); shared by extension.js and build-doc --check
  knowledge-base.js   Progressive discovery over SDOC text: lexica/ dirs, file
                      summaries, outlines with line ranges, section reads, search,
                      signposts, and the checker build-doc --check runs. Runtime-
                      neutral (no fs, no path) because the Claude Code plugin runs
                      it inside Claude Code, where there is no Node
  site-template/      Shared viewer templates (index.html, viewer.css)

themes/             Slide themes
  default/            Built-in default theme (CSS + navigation JS)

vendor/             Vendored dependencies
  mermaid.min.js      Mermaid diagram renderer (bundled for offline use)

test/               Test files
  test-all.js         Comprehensive test suite (node test/test-all.js)
  test-knr.js         K&R brace placement tests (node test/test-knr.js)
  test-notion.js      Notion renderer tests (node test/test-notion.js)
  test-plugin.js      The Claude Code plugin: generated files up to date, the
                      ES-module parser building the same tree as src/sdoc.js on
                      every repo file, knowledge-base, and every hook and tool
                      driven through an in-memory file system. The engine calling
                      the hooks is checked by hand (docs/guide/claude-code-plugin.sdoc)
  test-slides.js      Slide renderer tests (node test/test-slides.js)
  test-slide-artifact.js  Claude Slides export, its validator and the pull diff
                         (node test/test-slide-artifact.js; Chrome-gated tests
                         skip themselves when it is absent). Also parses both
                         injected harvest scripts the way the page will see
                         them — a halved backslash or a stray backtick there
                         only ever surfaced as "serialised before it reported
                         its geometry", which names neither file nor character
  test-artifact-conformance.js  The Claude Slides export feature by feature. Knows
                         the feature list from src/slide-layouts.js, so a layout or
                         config key with no deck exercising it fails here. Checks the
                         exported HTML from test/artifact-golden/, so most of it runs
                         with no browser; regenerate with --update and read the diff
  test-pptx-conformance.js  The PowerPoint / Google Slides export feature by feature.
                         Same shape as the artifact one: knows the layout list, and
                         checks a structural digest under test/pptx-golden/ so the
                         guards run with no browser (--update to regenerate)
  artifact-golden/    The checked-in Claude Slides export of the two example decks
  pptx-golden/        Structural digests of the PPTX export: what the harvest found
                      per slide against what reached the file
  plugin-evals/       Evals of the Claude Code plugin: whether it helps, not what it
                      does (npm run eval:plugin; costs model calls, so not in
                      npm test). Cases under evals/, run from the repo root,
                      and a fixture whose knowledge is stored as
                      fixture/knowledge/, never lexica/
  test-slide-layouts.js  Structured layouts, theme loading, geometry, PPTX and
                         connectors (node test/test-slide-layouts.js; the
                         geometry, PPTX and connector tests skip themselves when
                         Chrome is absent). The connector routing is tested as
                         pure arithmetic — planConnector takes two boxes and
                         returns rectangles — plus a browser check that the
                         boxes come out in design pixels at any window scale,
                         which is the standing trap in this repo
  *.sdoc              Test fixture files

.claude-plugin/     marketplace.json: the repo is a Claude Code plugin marketplace

plugins/            Claude Code plugins
  sdoc-lexica/        SDOC + Lexica: skills, read-only tools (mcp__sdoc-lexica__*), hooks,
                      and a read-only research agent (sdoc-lexica:research).
                      Runs as a mod: Claude Code executes hooks/register.mjs in its
                      own runtime, so no Node is needed on the user's machine.
                      hooks/handlers.mjs holds the behaviour against an io adapter.
                      lib/ and skills/authoring/reference/ are GENERATED by
                      tools/build-plugin.js — edit the sources

skills/             Claude skills shipped with the repo (copy into .claude/skills/)
  sdoc-artifact/      Publishing a deck to a Claude Slides artifact, and pulling edits back

bindings/           Bindings for other languages
  python/             Python binding: calls src/sdoc.js, does not reimplement it
    src/sdoc/           The package (reference.py, model.py, inline.py, bridge.js)
    test/test_binding.py  Tests (python3 bindings/python/test/test_binding.py)
    README.md           Install, API, and how a consumer depends on it

tools/              CLI tools
  build-plugin.js     Writes the plugin's generated files: ES-module copies of
                      src/sdoc.js and src/knowledge-base.js, and the authoring
                      guide (npm run build:plugin; --check)
  build-slides.js     Build slides from SDOC
                      (node tools/build-slides.js [--pdf] [--pptx] [--artifact]
                       [--check] [--fit MODE])
  artifact-resolve-assets.js  Rewrites sdoc-asset: placeholders to uploaded /_blob/<id> urls
  artifact-diff.js    Compares a pulled artifact against the last export and
                      reports the changes against the .sdoc scopes they came from
  artifact-fidelity.js  How far the flow export lands from the build it came
                      from, per slide, as a number (node tools/artifact-fidelity.js
                      <deck.sdoc> [--theme <dir>] [--slides a,b,c] [--json <file>]
                      [--worst N]). --slides narrows the build as well as the
                      measurement, which is where the time goes; an id no slide
                      has is refused rather than measured as nothing. Renders the
                      emitted slides against a modelled viewer and compares the
                      ink of every text element with the build's. Matches on
                      text, never by index; resolves sdoc-asset: to real bytes
                      and carries the deck's @font-face over, because a
                      collapsed picture or a fallback face buries the signal.
                      It asks two questions: where the text landed, and whether
                      every emitted element landed where the exporter placed it
                      (`misplacedElements`, which is exported and unit-tested —
                      it was keyed wrongly and silently checked nothing).
                      A CLEAN RUN IS NOT A CORRECT SLIDE: it renders in Chrome,
                      not the Slides runtime, so anything the viewer does
                      differently is invisible (an empty div with a width holds
                      here and collapses there); and it measures geometry, so a
                      defect that moves nothing — a dropped wash, an undrawn
                      bar, a mark that loses its colour — reads as 0px.
                      A regression detector, not a verdict
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

**Claude Code plugin (plugins/sdoc-lexica):**
- Nothing the hooks module loads may use Node — no `require`, `fs`, `path`,
  `process`. Claude Code runs it without them; files go through `$.fs`, in
  register.mjs only. `src/sdoc.js` and `src/knowledge-base.js` must stay that way
  too, and must run as ES modules (strict mode).
- After changing `src/sdoc.js`, `src/knowledge-base.js` or the authoring guide, run
  `npm run build:plugin` and commit what it writes. `npm test` fails while a
  generated file is stale.
- The mod API is early access: `claude plugin validate plugins/sdoc-lexica` after a Claude
  Code update shows what it no longer accepts.
- A tool call the mod answers itself skips Claude Code's permission check, which
  runs beneath `next(e)`. `consent()` in handlers.mjs is the guard: it puts every
  path a call names, as written and where it leads through links, to `$.tool.check`
  as a Read (a file) or a Glob (a directory). A deny refuses, inside the project
  too; an ask goes through in the project and the plugin and asks the person
  elsewhere. Keep new tools behind it: list a new tool's paths in `toolPaths`, and
  give a directory parameter the kind `dir` in `toolRequests`, or it is checked as
  a file.
- A skill is named after its folder (`skills/lexica/` is `/sdoc-lexica:lexica`); the
  frontmatter `name` does not change that.
- `prompt.context`, `session.compact` and a compaction's `session.append` never
  reach a user plugin: Claude Code's built-in security plugin passes over its hooks
  there (the debug log says "bypassed by cc-plugin-sec-default"). The index goes with
  `prompt.submit`, which also sees a compaction or a /clear: the conversation's
  opening message has changed.
- `agent.spawn` does reach a user plugin (2.1.312: the debug log says
  "agent.spawn general-purpose: prompt rewritten by a hook", and no "bypassed").
  The subagent brief goes there. A `tool.call` fallback in register.mjs briefs at an
  agent's first tool call only if the spawn hook never runs; check the log after a
  Claude Code update.
- Call each `$` noun where it is written: `$.store.get(key)`, never `$.store` passed
  as a value, which `claude plugin validate` refuses. `ioOf` in register.mjs spells
  out every call for that reason.
- Evals live in `test/plugin-evals/evals`, run with the repo root as the target
  (`npm run eval:plugin`): a case may load only plugins under the target. A
  fixture is never a directory named `lexica/`: this repo's own plugin would take
  it for the repo's knowledge. Each case's scaffold copies `fixture/knowledge/` to
  `lexica/`.
- Edits go through Bash as often as through Edit (`sed -i`, a Python script), so the
  `tool.call` Bash hook watches the `.sdoc` files a command names. Anything an edit
  gets, a Bash change must get too.
- Every action is noted through `io.log`: in the debug log always, in the session
  with the plugin's `verbose` option unless it is `quiet` (the session shows it).
- The plugin has no version, in plugin.json or the marketplace entry, on purpose:
  Claude Code then versions it by commit, so a fix merged to `main` reaches everyone.
  With a number, a fix without a bump would reach no one. validate's "No version
  specified" warning is expected.

**Python (bindings/python):**
- The binding contains no parser. Anything about the grammar — block or inline —
  comes from `src/sdoc.js` through the node worker. A regex over sdoc syntax in
  Python is the defect this binding exists to remove.
- No runtime dependencies. `node` is the only external requirement, and its
  absence is a hard error, never a skip.
- Standard library only in tests too; no pytest.

**Testing:**
- No test framework — tests are plain Node scripts with assert helpers
- Run the fast suites — no browser, a few seconds, 928 tests:
  `npm test`
- Run the browser-gated ones too (under a minute, needs Chrome; each suite runs its
  browser tests one at a time, since starting them together froze the machine):
  `npm run test:browser`   — or `npm run test:all` for both
- Before committing anything that touches the parser, the renderer or an
  exporter, run `npm run test:all`. `npm test` alone does not cover slides.
  (928 fast + 360 browser = 1288, with the plugin's suite)
- Python binding: `python3 bindings/python/test/test_binding.py` (needs `node`, and
  `setuptools` for the wheel test — Python 3.12+ no longer bundles it)
- Tests exit non-zero on failure
- Run tests and verify 0 failures before committing parser changes
- A parser change can move the binding's behaviour: run its tests too

**Building the extension:**
- `npm run package` (produces `dist/sdoc-<version>.vsix`)
- Install: `code --install-extension dist/sdoc-<version>.vsix`

## Branching Strategy

This project uses **Git Flow**:

- `main` — stable releases, tagged with version numbers
- `develop` — integration branch, features merge here
- `release/vX.Y.Z` — cut from `develop` when ready to release, merged to both `main` and `develop`
- `feat/*`, `fix/*` — short-lived branches off `develop`
- `hotfix/plugin-*` — off `main`, only for a Claude Code plugin broken by a Claude
  Code update: PR to `main`, then merge `main` back into `develop`. No GitHub
  release, so nothing is published to npm or the Marketplace
  (docs/guide/claude-code-plugin.sdoc, Shipping a Fix)

Branch from `develop`, open PRs targeting `develop`. No direct pushes to `main` or `develop`.

## Claude Slides limits found by publishing

Things the format or the viewer will not carry, each confirmed on a live
artifact rather than inferred. They have in common that nothing moves, so
`artifact-fidelity.js` reports the slide clean and only a person looking at it
can tell:

- **A colour on a mark inside a table cell is lost.** `<b><span style="color">`
  and `<span style="color"><b>` both render in the CELL's colour. Put the
  colour on the cell and drop the override. The exporter warns.
- **Cells are ruled by the viewer and cannot be unruled.** `border` applies to
  `div text img table x-icon` and not to a cell, so the rules are drawn whether
  or not the deck wants them.
- **An empty box with a width collapses *as a flex item*,** though it holds in
  a browser. A spacer has to grow — `flex:1 1 auto` inside a row with an
  explicit width. This is about flex sizing, not about empty boxes: an empty
  PINNED box with a width, a height and a background paints correctly, which
  the pipeline spine relies on — sixteen of them, confirmed on screen.
- **A pinned box nested in flow containers is offset by its flow parent**, so
  the exporter lifts every one to be a direct child of the `<section>`.
- **`object-fit` is stripped from an `<img>` when the page normalises it.**
  Read back off a stored slide: `width:527px;height:354px;object-fit:cover`
  came back as `width:527px;height:354px`. A deck relying on a crop loses it
  with nothing to say so. Either crop the source asset to its box aspect, or
  bake the crop into the picture at export — neither is done automatically.
- **An auto margin centres nothing.** `margin` is accepted and ignored, so
  `margin-inline: auto` — a common idiom — simply does not centre. Use
  `align-self: center` in a flex column, which the exporter now emits.
- **A relative offset does not offset.** `left/top/right/bottom` are pinned-only
  in the format, so the exporter emits a relative offset as a `transform:
  translate(...)` instead: that moves the paint and not the layout, which is
  what `position: relative` means and keeps the element reflowing.

## SDOC Format

Knowledge files use the SDOC format (`.sdoc`). If you need to write or edit
SDOC, use the `sdoc_reference` tool for the format guide. Start with the
Quick Reference and Common Mistakes sections.
