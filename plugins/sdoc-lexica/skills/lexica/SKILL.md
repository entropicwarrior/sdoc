---
name: lexica
description: "Finds, reads and maintains a project's knowledge in lexica/ directories (SDOC files of specs, requirements, architecture, implementation status and how-to skills), loading it by section through the plugin's tools or the sdoc-lexica:research agent rather than reading files whole."
when_to_use: "Use when the conversation carries the plugin's index of the project's lexica/ files, which comes with the first prompt in every project that has a lexica/ directory (so with no index there is none to look for): to look up the project's conventions, requirements or design decisions, and when finishing a task its knowledge should record (implementation status, a changed spec or decision). Examples: 'what does the spec say about X', 'check the requirements before changing Y', 'update the impl status', 'record this decision'."
---

# Working with a Lexica knowledge tree

A project following the Lexica convention keeps its knowledge in directories named `lexica/`, as SDOC files. A `lexica/` directory sits beside the code it describes, at any level of the tree, and may have subdirectories organised by domain.

Each file declares its kind in `@meta`:

- `type: doc` is descriptive. It says what something is: requirements, architecture, specifications, implementation status.
- `type: skill` is prescriptive. It says how to do something here: conventions, procedures, checklists.

## Finding what you need

When the project has `lexica/`, the conversation starts with an index: every file with its `@about` summary (its title when the summaries do not fit) and, where git knows it, how long ago it last changed (`changed 3 weeks ago`); an old file may lag the code. A subagent's task carries a shorter index of its own. Work from it progressively, loading only what the task needs.

1. **Choose files** by their summary in the index, or with `mcp__sdoc-lexica__list` (`detail: "titles"` for a shorter list) and `mcp__sdoc-lexica__search`. Search ranks sections best first, and when no section holds every word, shows those holding the most with the words they lack; `read: true` returns the best sections whole, which often answers a question in one call.
2. **Outline before reading.** `mcp__sdoc-lexica__outline` gives each section's id and line range; `files` outlines several at once, `depth: 1` only the top-level sections.
3. **Read only the sections you need** with `mcp__sdoc-lexica__read`. When a file has a reading guide, follow it; it is shown the first time you Read the file.
4. **Prefer the nearest knowledge.** A `lexica/` directory next to the code you are changing is more specific than the one at the project root. Read both when they bear on the task.

For a question such as "what does the knowledge say about X", when the answer matters more than the text and may be spread over several files, or you do not know where it is, delegate to the `sdoc-lexica:research` agent: it searches and reads read-only, and returns at most 200 words citing file, section and lines, so the sections it read stay out of the conversation. When you already know where to look and expect the answer in one place, read that section yourself: the agent starts with none of your context, so it is slower and costs more.

Read the implementation status of the area before starting work. It is usually `impl-status.sdoc`, or `<domain>-impl-status.sdoc`, and holds what is done, in progress and next. When a knowledge server (an MCP server with tools such as `list_knowledge`, `get_sections` and `get_section`) is connected, use it the same way for knowledge shared across projects.

## Keeping it current

Knowledge that drifts from the code misleads the next reader, human or agent.

- **When you finish a task, update the impl-status of the area you worked in.** Record what was done, what is left, and any decision a later session needs. A session can end at any moment, so the status is its memory.
- **When a change alters a requirement, spec or convention, change that document in the same piece of work.**
- **Before renaming or moving a section or a file,** `mcp__sdoc-lexica__backlinks` lists the links and `@id` references to it, so they change with it.
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
