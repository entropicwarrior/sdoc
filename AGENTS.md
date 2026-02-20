# Agent Instructions

## Project Knowledge

This project uses the Lexica convention for organising knowledge:

- `skills/` directories contain **how-to knowledge**: patterns, conventions,
  techniques, runbooks.
- `docs/` directories contain **reference knowledge**: specs, architecture,
  design decisions, plans, project status.

**Note for this repo:** The `docs/` directory is used for user-facing
documentation served by the SDOC document browser. Reference knowledge lives
in `spec/` instead. When starting a task:

1. List the `skills/` and `spec/` directories at the repo root.
2. Read filenames to identify relevant knowledge.
3. Open relevant files and read the About section near the top to confirm
   relevance.
4. Read only the sections you need — scan headings first.

## SDOC Format

Knowledge files use the SDOC format (`.sdoc`). If you need to write or edit
SDOC, use the `sdoc_reference` tool for the format guide. Start with the
Quick Reference and Common Mistakes sections.
