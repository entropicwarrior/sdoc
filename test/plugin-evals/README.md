# sdoc-lexica plugin evals

Cases for `claude plugin eval` that measure what `plugins/sdoc-lexica` adds, with
and without the plugin, on a fictional project: tidewater, a Go storage library
with a `lexica/` knowledge tree.

```
test/plugin-evals/
  evals/<case>/        prompt.md (frontmatter: plugins, max_turns 12, timeout 300,
                       allowed_tools), case.yaml (scaffold_script), graders/*.md,
                       scaffold.sh (calls ../../scaffold.sh)
  evals/results/       written by each run, gitignored
  scaffold.sh          seeds a run's workspace from fixture/
  fixture/knowledge/   becomes lexica/ in the workspace
  fixture/src/         src/wal.go, a stub
  compare.js           result JSON → tables; before/after comparison
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

# a model, both arms; then record tool calls while the traces still exist
npm run eval:plugin -- --tag read edit quiet --model sonnet --runs 3 \
  --ablation with-without -j 4 --keep-temp --json test/plugin-evals/evals/results/sonnet-before.json
node test/plugin-evals/compare.js --embed test/plugin-evals/evals/results/sonnet-before.json

# read one run, or compare two
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
| find-fact | the fsync thresholds; no Read of architecture.sdoc without a `limit` (both arms) |
| locate-skill | three release steps only `lexica/skills/release.sdoc` holds |
| cross-file-citation | R4 and the design meeting it, each cited (judge) |
| partial-words | a question sharing few words with its section (no "blackout", "half-written", "entry") |
| backlinks-before-change | the three files linking to `#compaction`, nothing invented (judge) |
| rename-id-fix-links | `@write-ahead-log` → `@wal-log` in four files, by Edit |
| record-decision | D-0010 per the editing guide; D-0005 superseded, not deleted |
| freshness | the file longest unchanged (asked by age: the stub code makes architecture.sdoc look stale) |
| delegate-research | a subagent finds D-0009; indicator: `sdoc-lexica:research` was the one used |
| no-lexica-quiet | no `lexica/`: no plugin tool call and no plugin skill (both arms) |
| create-sdoc-file | a new runbook.sdoc with @about and three sections with ids, braces balanced; indicator: the authoring skill loaded |

`create-sdoc-file` (tag `create`) came after the baseline. It checks whether
`paths: ["**/*.sdoc"]` on the authoring skill stops the skill from loading for a file
that does not exist yet. To run the original ten alone, as the baseline did, filter
with `--tag read edit quiet`.
