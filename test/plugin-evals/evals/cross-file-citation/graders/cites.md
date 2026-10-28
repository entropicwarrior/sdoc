---
type: llm
---

The project's documents say:
- lexica/requirements.sdoc, R4 (id @r4): recovery after a crash shall complete in under 3 seconds per 1 GiB of write-ahead log written since the last checkpoint, and in under 10 seconds in all.
- lexica/architecture.sdoc, section Write-Ahead Log (id @write-ahead-log) and its subsections Checkpoints (@wal-checkpoints) and Recovery (@wal-recovery): a checkpoint every 256 MiB of log bounds what must be replayed; replay runs at about 900 MiB/s on the reference NVMe host (about 180 MiB/s on network block storage); the log is fsynced every 64 KiB or 20 ms; replay stops at the first record that fails its checksum.

PASS if the reply does all of these:
- states R4's bound of under 3 seconds per GiB of log (the 10 second overall cap is optional);
- attributes that bound to requirements.sdoc (by file name, with R4 or its id);
- names at least one design mechanism from the architecture listed above, such as the 256 MiB checkpoint interval or the replay rate;
- cites architecture.sdoc for that mechanism, naming the section (by id or title: Write-Ahead Log, Checkpoints or Recovery).

FAIL if any citation is missing, if a figure is attributed to the wrong file, or if the reply states a figure that contradicts the ones above. Formatting does not matter.
