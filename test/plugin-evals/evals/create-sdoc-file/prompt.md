---
description: "A new .sdoc file from scratch: does the authoring skill load (indicator), and is the file well formed?"
tags: [create]
plugins: ["../../../../plugins/sdoc-lexica"]
max_turns: 12
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill, Agent, "mcp__sdoc-lexica__*", Edit, Write]
---

Create lexica/runbook.sdoc: an on-call runbook for tidewater with an @about, sections for paging, restoring from the WAL and failover, each with an @id.
