---
description: "Add D-0013, after D-0012, the way decisions.sdoc's editing guide says, superseding D-0005 without deleting it."
tags: [edit]
plugins: ["../../../../plugins/sdoc-lexica"]
max_turns: 12
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill, Agent, "mcp__sdoc-lexica__*", Edit, Write]
---

We've decided to replace the block cache's 2Q eviction with CLOCK-Pro: lock contention on the 2Q queues capped point reads at about 1.2 million per second on 32 cores, and CLOCK-Pro takes no lock on a hit. Record this decision.
