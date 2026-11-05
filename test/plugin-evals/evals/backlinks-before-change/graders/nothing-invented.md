---
type: llm
---

In this project exactly these places link to the Compaction section of lexica/architecture.sdoc (id @compaction):
- lexica/requirements.sdoc, requirement R5 ("Compaction Does Not Hurt Writes");
- lexica/decisions.sdoc, decision D-0007 ("Leveled Compaction by Default");
- lexica/glossary.sdoc, the Compaction term;
- lexica/runbooks/compaction-stall.sdoc;
- lexica/operations/capacity.sdoc;
- lexica/spec/format.sdoc (in its section on format versions and compatibility);
- inside lexica/architecture.sdoc itself, the reading guide's table row "@compaction".
Also acceptable to mention: links to the compaction section's subsections (@compaction-triggers, @compaction-strategy, @compaction-throttling, @manual-compaction), from architecture.sdoc's Time to Live section, lexica/runbooks/compaction-stall.sdoc and lexica/components/sstables.sdoc; and the Performance Budget table's link to requirement R5 (the reverse direction).
lexica/design/wal-notes.sdoc and lexica/faq.sdoc mention compaction in plain text, with no link.

PASS if the reply identifies the links in requirements.sdoc (R5), decisions.sdoc (D-0007), glossary.sdoc, runbooks/compaction-stall.sdoc, operations/capacity.sdoc and spec/format.sdoc, and every other place it presents as linking to the compaction section is one listed above. Any identification counts: a requirement or decision number, an id, a file and line, or a description.
FAIL if it leaves out any of those six, or presents as a link any place not listed above (for example decision D-0002, design/wal-notes.sdoc or faq.sdoc). Mentions explicitly described as plain-text mentions without a link do not count against it. Formatting does not matter.
