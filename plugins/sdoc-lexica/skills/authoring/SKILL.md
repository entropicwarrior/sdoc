---
name: authoring
description: Read, write and edit SDOC (.sdoc) files correctly. Use whenever you create, change or review a .sdoc file, or need to read one efficiently; it covers the syntax, the mistakes that break parsing, signposts, and how to read a large file by section.
---

# SDOC authoring

SDOC is plain-text documentation with explicit brace scoping. Structure comes only from `{ }`: indentation is cosmetic. Two parsers, same input, same tree.

## Reading a file

Read progressively; a knowledge file can run to thousands of lines.

1. `mcp__sdoc-lexica__outline` with the file: every section's `@id`, title and line range.
2. `mcp__sdoc-lexica__read` with the ids you need: the source of just those sections, with line numbers.
3. To edit, Read the file with `offset`/`limit` from those line ranges (Edit needs a prior Read), then Edit.

`mcp__sdoc-lexica__search` finds sections by words; `mcp__sdoc-lexica__guides` shows a file's signposts.

## Essential syntax

```
# Document Title @doc-id
{
    @meta {
        type: doc

        sdoc-version: 0.2
    }

    @about {
        Two to five sentences: what this covers, for whom, when to read it.
    }

    # Section @section-id
    {
        A paragraph is one long line. Do not hard-wrap prose.

        - Implicit list: single-line items only
        - Second item

        {[.]
            - Explicit list item
            {
                Body of the item above: paragraphs, code, nested lists.
            }
            - Plain item
        }

        {[#]
            1. Numbered
            2. Items
        }

        {[table]
            Name | Value
            Alpha | 1
        }

        See @other-section; another file: [Setup](./setup.sdoc#install).
    }

    # Heading With K&R Brace @other-section {
        Content.
    }
}
```

- `#` starts a heading; the number of `#` does not set depth, nesting does. `@slug` at the end of the heading gives it an id (lowercase kebab-case, unique in the file).
- A heading not followed by `{` is a braceless scope: it runs to the next heading, a `}`, or end of file. A first heading with no `{` makes the rest of the file its body (implicit root).
- Inline: `*em*`, `**strong**`, `~~strike~~`, `` `code` ``, `$math$`, `[text](url)`, `![alt](img.png =50%)`. Markers: `{+good+}` `{-bad-}` `{!warning!}` `{^note^}` `{~highlight~}`.
- Code fences are raw. ` ```mermaid `, ` ```svg ` and ` ```math ` render as diagrams and equations; ` ```json :data ` is parsed into data.
- `// comment` at the start of a line is dropped. A `:comment` scope (`# TODO :comment`) is kept in the tree but not rendered.
- `# Title @id :type` gives a scope a type (`:requirement`, `:warning`, ...).
- Escape a literal `{ } @ # * [ ] < > $ |` with `\`.

## Mistakes that break a file

- **`{[.]}` on one line is an empty list.** The opener `{[.]`, `{[#]` or `{[table]` has no `}` on its line; a separate `}` closes it.
- **Bare content inside a list block is a parse error.** Anything beyond an item's title line goes in a `{ }` body block right after the item. A blank line ends a multi-line item title.
- **`@slug` is document-local.** For a section of another file write `[Label](./file.sdoc#slug)`, and escape an `@` inside a link label as `\@`.
- **`[@key]` is a citation, `@key` a section reference.** Citations are defined in a `{[citations]` block.
- **Unescaped `<T>` in prose** reads as an autolink: escape it or put it in backticks.

## Signposts

Optional reserved scopes describing the document itself, written as direct children of the root, after `@meta`, in this order:

| Signpost | Answers | Shape |
|---|---|---|
| `@about` | Should I read this? | Paragraphs and lists; no section references |
| `@not-about` | What does it leave out, and why? | Paragraphs and lists; no links |
| `@related-resources` | What else goes with it? | One table `Resource \| Relation`, each resource one link |
| `@reading-guide` | Where do I start, what can I skip? | Prose, then one table `Sections \| Note` of `@id`s |
| `@editing-guide` | What are the rules for changing this file? | Paragraphs and lists |

Pointers to other documents go in `@related-resources`, never in `@about` or `@not-about`. When a file has an `@editing-guide`, the first edit to it is refused once with the guide: make the edit again following it.

## When editing

- Keep every `@id` stable: references and links from other files point at them.
- Keep braces balanced and match the surrounding indentation (cosmetic, but readable).
- After each edit the plugin reports any finding the edit added (parse error, broken reference, signpost shape). Fix errors before going on. `mcp__sdoc-lexica__check` checks a file on demand.
- Add `sdoc-version: 0.2` and `type: doc` or `type: skill` in `@meta` when creating a file.

## The full guide

The complete authoring guide ships with this skill at `${CLAUDE_SKILL_DIR}/reference/sdoc-authoring.sdoc` (about 1,200 lines). Outline it and read only the section you need, for instance:

| Need | Section ids |
|---|---|
| Lists, tables, column directives, formulas | `lists`, `tables`, `column-directives`, `table-formulas` |
| Inline formatting, references, citations | `inline-formatting`, `references`, `citations` |
| Code includes, diagrams, math | `code-blocks`, `mermaid`, `svg`, `math-blocks` |
| `@meta`, scope types, data blocks, comments | `meta-scope`, `scope-types`, `data-blocks`, `comments` |
| Signposts in depth | `signposts`, `signpost-rules`, `choosing-signpost` |
| Every common mistake, with examples | `common-mistakes` |
