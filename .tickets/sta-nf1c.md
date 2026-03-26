---
id: sta-nf1c
status: open
deps: []
links: []
created: 2026-03-26T13:06:02Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Extract handlePrompt into smaller focused functions

handlePrompt in src/agent/index.ts (lines 471-870) is a ~400-line function that is the core of the application. It handles: loading conversation messages, building the system prompt (differently for main agent vs subagent, with memories, scratchpad, plugin lists), processing file attachments, running auto-search, setting up the event subscriber for message persistence, calling agent.prompt(), filtering tools for subagents, handling errors/aborts, cleaning up error messages, extracting response text, and triggering background compaction.

Extract into these focused functions:
- buildMainAgentSystemPrompt(config, allPlugins, memories, scratchpadTitles): string — the main agent branch of the system prompt assembly (current lines 514-561)
- buildSubagentSystemPrompt(config, subagentRow, allPlugins): string — the subagent branch (current lines 562-601)
- processAttachments(attachments): { resolvedMessage, imageContents } — attachment processing loop (current lines 611-630)
- triggerCompactionIfNeeded(agent, pool, agentId, config): void — the compaction check and background task launch (current lines 795-867)

handlePrompt becomes the orchestrator that calls these helpers in sequence. The event subscriber setup (lines 691-726) and error handling (lines 746-781) can stay inline since they are tightly coupled to the prompt call and not reusable.

Non-goals: do not change any behavior. Do not restructure the event subscriber or error handling. Do not move these helpers to separate files — keep them in src/agent/index.ts (the file is 870 lines, which is fine once handlePrompt is broken up). Do not change function signatures of handlePrompt itself.

## Acceptance Criteria

1. handlePrompt is under 150 lines. 2. System prompt assembly is in two separate testable functions. 3. Compaction trigger logic is in its own function. 4. No behavior changes. 5. All existing tests pass.

