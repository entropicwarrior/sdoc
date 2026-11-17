---
type: llm
---

The current fsync policy is in lexica/architecture.sdoc, section Write-Ahead Log (@write-ahead-log): the log is fsynced every 64 KiB or every 20 ms, whichever comes first; a write with `Sync: true` forces an fsync at once. Two outdated documents give other values: lexica/spec/format-v1.sdoc (superseded, format version 3) and lexica/design/wal-notes.sdoc (historical design notes) say every 256 KiB or every 100 ms.

PASS if the reply gives 64 KiB and 20 ms as the thresholds in force.
FAIL if it gives 256 KiB or 100 ms as the thresholds in force, or presents the two sets as equally current, or leaves unclear which one applies. Mentioning the old values as old or superseded is fine. Formatting does not matter.
