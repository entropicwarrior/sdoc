# sdoc-lexica plugin evals

Cases for `claude plugin eval` that measure what `plugins/sdoc-lexica` adds, with
and without the plugin, on a fictional project: tidewater, a Go storage library
with a `lexica/` knowledge tree of 23 files and about 5,800 lines.

The knowledge tree is built the way real ones go wrong. Besides the architecture,
decisions, requirements and glossary, it holds a 2,700-line format specification,
component notes, runbooks, operations notes and a FAQ, and documents that are out of
date and say so: the superseded format version 3 spec, historical design notes and the
deprecated 1.x release procedure. Those hold old values (the fsync thresholds, the
release steps) that a text search finds next to the current ones. Every current file
agrees with the others, and the operational figures live in the architecture alone, so
each question keeps one right answer and one right source.

## What the evals measure

The plugin has three goals, and the evals measure those and nothing else:

- **Accuracy:** fewer errors, invented facts and stale references. The graders'
  score: each grader checks an outcome (the answer, a file's content), the same way
  with the plugin and without it.
- **Speed:** wall time per run (SECS).
- **Tokens:** every token a run sends and receives, subagents included, counted
  from the traces by `compare.js --embed`, in three kinds that cost very
  differently: NEW (input at full price, cache writes included), CACHED (the
  conversation re-read from the prompt cache, at about a tenth of the price, and
  most of a long task's tokens) and OUT (what the model writes). The price of a
  run ($/RUN) is shown beside them, so a change in cheap cached tokens is not
  mistaken for a change in cost.

How a run got there is not a goal: how many files it opened or tools it called is a
clue for finding out why a figure moved (`compare.js --detail`), never a grader. A
case or a grader is never chosen because the plugin wins it: a fair case may show
the plugin losing, and that is what it is for. While every case scores 1.00 in both
arms, accuracy tells the two apart nowhere, and only harder cases would.

```
test/plugin-evals/
  evals/<case>/        prompt.md (frontmatter: plugins, max_turns 12, timeout 300,
                       allowed_tools), case.yaml (scaffold_script), graders/*.md,
                       scaffold.sh (calls ../../scaffold.sh)
  evals/results/       written by each run, gitignored
  scaffold.sh          seeds a run's workspace from fixture/
  fixture/knowledge/   becomes lexica/ in the workspace
  fixture/src/         src/wal.go, a stub
  compare.js           result JSON → accuracy, time and tokens per case, with and
                       without the plugin; before/after comparison
```

The fixture is stored as `knowledge/`, never as a directory named `lexica/`: the
repository's tests and its own knowledge index walk for `lexica/`. The scaffold copies
it in, renames it, and makes a git repository with backdated commits, so the last
change to `glossary.sdoc` is 400 days old, to `decisions.sdoc` 2 days, and to the rest
75 days. Every file is in the first commit and the subjects are neutral, because
Claude Code shows recent commit subjects in its system prompt.

## Running

`npm run eval:plugin` is `claude plugin eval . --eval-dir test/plugin-evals/evals`
with `--trust-plugin --scaffold --no-publish --threshold 0 --judge-model sonnet
--allow-tools Edit Write 'mcp__sdoc-lexica__*'`; add the rest after `--`. The target
is the repository root because a case may load only plugins under the target, and
`plugins/sdoc-lexica` is outside `test/plugin-evals`.

```
# smoke: one case, one run, plugin arm only
npm run eval:plugin -- --case find-fact --runs 1 --ablation none --keep-temp

# a model, both arms; then record tokens and tool calls while the traces still exist
npm run eval:plugin -- --tag read edit quiet --model sonnet --runs 3 \
  --ablation with-without -j 4 --keep-temp --json test/plugin-evals/evals/results/sonnet-before.json
node test/plugin-evals/compare.js --embed test/plugin-evals/evals/results/sonnet-before.json

# read one run (--detail adds tool calls and turns, as clues), or compare two
node test/plugin-evals/compare.js test/plugin-evals/evals/results/sonnet-before.json
node test/plugin-evals/compare.js test/plugin-evals/evals/results/sonnet-before.json \
  test/plugin-evals/evals/results/sonnet-after.json
```

An after run with `--ablation none` costs half; `compare.js` then takes Δ against the
before run's W/OUT arm, which loads no plugin. It also rescores both files without the
graders either left unscored, since a with-only indicator counts under `none`.

## Cases

| Case | Checks |
| --- | --- |
| find-fact | the fsync thresholds in force, not the superseded ones (judge) |
| locate-skill | three release steps only `lexica/skills/release.sdoc` holds, none of the deprecated 1.x ones (judge) |
| cross-file-citation | R4 and the design meeting it, each cited (judge) |
| partial-words | a question sharing few words with its section (no "blackout", "half-written", "entry") |
| backlinks-before-change | the six files linking to `#compaction`, none of those that only mention it, nothing invented (judge) |
| rename-id-fix-links | `@write-ahead-log` → `@wal-log` in nine files, by Edit, and the spec's look-alike `@write-ahead-log-format` left alone |
| record-decision | D-0013 per the editing guide; D-0005 superseded, not deleted; architecture.sdoc @block-cache brought in line or reported out of date, which nothing asks for (judge) |
| freshness | the file longest unchanged (asked by age: the stub code makes architecture.sdoc look stale) |
| delegate-research | a subagent finds both open decisions, D-0009 and D-0011, and no closed one (judge); indicator: `sdoc-lexica:research` was the one used |
| no-lexica-quiet | no `lexica/`: no plugin tool call and no plugin skill (both arms) |
| create-sdoc-file | a new runbook.sdoc with @about and three sections with ids, braces balanced; indicator: the authoring skill loaded |

`create-sdoc-file` (tag `create`) came after the baseline. It checks whether
`paths: ["**/*.sdoc"]` on the authoring skill stops the skill from loading for a file
that does not exist yet. To run the original ten alone, as the baseline did, filter
with `--tag read edit quiet`.
