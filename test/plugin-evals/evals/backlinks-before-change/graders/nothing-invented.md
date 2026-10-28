---
type: llm
---

In this project exactly these places link to the Compaction section of lexica/architecture.sdoc (id @compaction):
- lexica/requirements.sdoc, requirement R5 ("Compaction Does Not Hurt Writes");
- lexica/decisions.sdoc, decision D-0007 ("Leveled Compaction by Default");
- lexica/glossary.sdoc, the Compaction term;
- inside lexica/architecture.sdoc itself, the reading guide's table row "@compaction".
Also acceptable to mention: architecture.sdoc's Time to Live section refers to the subsection @compaction-triggers, and the Performance Budget table links to requirement R5 (which is the reverse direction).

PASS if the reply identifies the links in requirements.sdoc (R5), decisions.sdoc (D-0007) and glossary.sdoc, and every other place it presents as linking to the compaction section is one listed above. Any identification counts: a requirement or decision number, an id, a file and line, or a description.
FAIL if it leaves out any of those three, or presents as a link any place not listed above (for example decision D-0002, or another requirement). Mentions explicitly described as plain-text mentions without a link do not count against it. Formatting does not matter.
