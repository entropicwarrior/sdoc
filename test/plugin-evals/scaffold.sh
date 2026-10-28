#!/bin/bash
# Seeds an eval run's empty workspace (the current directory) with the
# tidewater fixture. Each case's scaffold.sh calls this one.
#
#   scaffold.sh full       lexica/ (from fixture/knowledge), src/, README.md
#   scaffold.sh src-only   src/ and README.md, no lexica/
#
# The fixture is stored as fixture/knowledge, never as a directory named
# lexica/: the repository's own tests and knowledge index walk for lexica/.
#
# The workspace becomes a git repository with backdated commits, so that a
# file's age is the age of the last commit touching it:
#   lexica/glossary.sdoc, README.md                       400 days
#   architecture, requirements, skills/release, src/      75 days
#   lexica/decisions.sdoc                                 2 days
# Every file is in the first commit, and the commit subjects say nothing about
# which file changed: Claude Code shows recent subjects in its system prompt,
# so a telling subject would answer the freshness case without the dates.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fixture="$here/fixture"
mode="${1:-full}"

cp -R "$fixture/src" ./src
cp "$fixture/README.md" ./README.md
if [ "$mode" = full ]; then
  cp -R "$fixture/knowledge" ./lexica
  later=(lexica/architecture.sdoc lexica/requirements.sdoc lexica/skills/release.sdoc src/wal.go)
  latest=(lexica/decisions.sdoc)
else
  later=(src/wal.go)
  latest=()
fi

git_() {
  git -c user.name=eval -c user.email=eval@example.com \
      -c init.defaultBranch=main -c commit.gpgsign=false "$@"
}
# commit <days ago> <subject>: commits everything staged, dated that long ago.
commit() {
  local when=$(($(date +%s) - $1 * 86400))
  GIT_AUTHOR_DATE="$when +0000" GIT_COMMITTER_DATE="$when +0000" \
    git_ commit -q -m "$2"
}
# The first commit holds an earlier form of the files a later commit touches:
# the same text without its final newline.
strip_final_newline() {
  local f
  for f in "$@"; do
    printf '%s' "$(cat "$f")" > "$f.tmp" && mv "$f.tmp" "$f"
  done
}
restore() {
  local f
  for f in "$@"; do
    case "$f" in
      lexica/*) cp "$fixture/knowledge/${f#lexica/}" "$f" ;;
      *) cp "$fixture/$f" "$f" ;;
    esac
  done
  git_ add -- "$@"
}

git_ init -q
strip_final_newline "${later[@]}" ${latest[@]+"${latest[@]}"}
git_ add -A
commit 400 "Initial import"
restore "${later[@]}"
commit 75 "Update docs and code"
if [ ${#latest[@]} -gt 0 ]; then
  restore "${latest[@]}"
  commit 2 "Update docs"
fi
