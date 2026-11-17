---
# The spec's own section id write-ahead-log-format is not the renamed one, and
# stays as it is.
type: regex
target: { source: file, path: lexica/spec/format.sdoc }
pattern: '@write-ahead-log-format\b'
---
