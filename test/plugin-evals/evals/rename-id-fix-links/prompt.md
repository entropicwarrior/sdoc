---
description: "Rename a section id and fix every link to it, in nine files, leaving a look-alike id (write-ahead-log-format) alone."
tags: [edit]
plugins: ["../../../../plugins/sdoc-lexica"]
max_turns: 12
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill, Agent, "mcp__sdoc-lexica__*", Edit, Write]
---

Rename the write-ahead-log section id in the architecture doc to `wal-log`, and fix everything that points at the old id.
