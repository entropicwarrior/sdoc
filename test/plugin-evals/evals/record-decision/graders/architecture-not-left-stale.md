---
# Accuracy, a stale reference: after the new decision, architecture.sdoc @block-cache
# still says the cache uses 2Q. Neither the prompt nor the editing guide asks for it to
# change, and leaving it until the code changes is a fair choice, so the reply passes
# whether it brought the section in line or told the user it is now out of date. A
# judge reads the reply, since no grader checks a file or the reply: a silent update of
# the section fails here.
type: llm
---

The run was asked to record a decision replacing the block cache's 2Q eviction with CLOCK-Pro, in lexica/decisions.sdoc. Another document, lexica/architecture.sdoc, describes the block cache in its Block Cache section (id @block-cache) as using 2Q eviction. Once the decision is recorded, that description is out of date unless it is changed.

PASS if the reply does either of these:
- says it updated the architecture's Block Cache section (or the architecture's description of the cache's eviction) to the new decision;
- tells the user that the architecture's Block Cache section, or architecture.sdoc's description of the block cache, still describes 2Q and is out of date or needs updating, now or when the code changes.

FAIL if it does neither. A reply that only says the new decision links to the architecture's Block Cache section, or that warns only about other documents, fails. Formatting does not matter.
