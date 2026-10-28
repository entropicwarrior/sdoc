---
name: lexica
description: Find, read and maintain a project's knowledge in lexica/ directories (SDOC files of specs, requirements, architecture, implementation status and skills). Use when starting a task in a project that has a lexica/ directory, when you need project conventions or design decisions, and when finishing a task that should update the project's knowledge.
---

# Working with a Lexica knowledge tree

A project following the Lexica convention keeps its knowledge in directories named `lexica/`, as SDOC files. A `lexica/` directory sits beside the code it describes, at any level of the tree, and may have subdirectories organised by domain.

Each file declares its kind in `@meta`:

- `type: doc` is descriptive. It says what something is: requirements, architecture, specifications, implementation status.
- `type: skill` is prescriptive. It says how to do something here: conventions, procedures, checklists.

## Finding what you need

When the project has `lexica/`, the conversation starts with an index: every file with its `@about` summary. Work from it progressively, loading only what the task needs.

1. **Choose files** by their summary in the index, or with `mcp__sdoc-lexica__list` and `mcp__sdoc-lexica__search`.
2. **Outline before reading.** `mcp__sdoc-lexica__outline` gives each section's id and line range.
3. **Read only the sections you need** with `mcp__sdoc-lexica__read`. When a file has a reading guide, follow it; it is shown the first time you Read the file.
4. **Prefer the nearest knowledge.** A `lexica/` directory next to the code you are changing is more specific than the one at the project root. Read both when they bear on the task.

Read the implementation status of the area before starting work. It is usually `impl-status.sdoc`, or `<domain>-impl-status.sdoc`, and holds what is done, in progress and next. When a knowledge server (an MCP server with tools such as `list_knowledge`, `get_sections` and `get_section`) is connected, use it the same way for knowledge shared across projects.

## Keeping it current

Knowledge that drifts from the code misleads the next reader, human or agent.

- **When you finish a task, update the impl-status of the area you worked in.** Record what was done, what is left, and any decision a later session needs. A session can end at any moment, so the status is its memory.
- **When a change alters a requirement, spec or convention, change that document in the same piece of work.**
- **Organise by domain, not by document type.** Use `lexica/billing/` holding billing's spec, architecture and status, never `lexica/specs/` or `lexica/plans/`. Completed work stays in its domain.
- **Keep at most one impl-status per directory.** When one area outgrows it, split the directory into subdomains, each with its own status.
- **Requirements are single, testable *shall* statements with semantic ids,** free of design. Design belongs in architecture and specifications.

## A new knowledge file

Give it a descriptive file name, put it in the `lexica/` directory of its domain, and start from:

```
# Billing Specification @billing-spec
{
    @meta {
        type: doc

        sdoc-version: 0.2
    }

    @about {
        How invoices are computed, issued and corrected. Read before changing anything under billing/.
    }

    # Overview @overview
    {
        ...
    }
}
```

`@about` is what discovery shows, so it must tell a reader whether to open the file: two to five sentences, with no pointers to other files. Add `@related-resources`, `@reading-guide` or `@editing-guide` when they help; the `authoring` skill describes them and the rest of the SDOC syntax.
