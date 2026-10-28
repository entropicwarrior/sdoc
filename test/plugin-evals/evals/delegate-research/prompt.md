---
description: "Research delegated to a subagent; with the plugin, to its research agent (indicator only)."
tags: [read, subagent]
plugins: ["../../../../plugins/sdoc-lexica"]
max_turns: 12
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill, Agent, "mcp__sdoc-lexica__*"]
---

Have a subagent research which of tidewater's design decisions are still open, then give me a short summary of what it found.
