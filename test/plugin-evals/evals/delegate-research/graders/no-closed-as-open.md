---
type: llm
---

In this project's decision log (lexica/decisions.sdoc) exactly two decisions are open (status Proposed): D-0009, io_uring for log writes on Linux, and D-0011, tiered storage for cold tables. Every other decision is closed: D-0001, D-0003 to D-0008 and D-0010 are Accepted, D-0002 is Superseded by D-0007, and D-0012 (per-block bloom filters) is Rejected. A historical design note, lexica/design/wal-notes.sdoc, discusses options that were settled later; none of them is an open decision.

PASS if the reply names both D-0009 and D-0011 (by number or by subject) as open, and presents no other decision or design option as open or still to be decided.
FAIL if it leaves either out, or presents any closed decision (for example D-0012, or a choice from the historical notes such as one log per column family) as open. Mentioning a closed decision as closed is fine. Formatting does not matter.
