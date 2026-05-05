---
id: sta-cqrzl
status: closed
deps: []
links: []
created: 2026-05-05T18:28:03Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Fix silent empty-summary compaction (issue #28)

When the summarizer model returns no text blocks (e.g., a reasoning-capable model that emits only thinking blocks before exhausting its output budget), `escalatingSummarize` returns "". The level guards (`level1Text.length < inputLength`, same for level 2) accept this empty string as success because `0 < inputLength` is always true. The empty summary is then persisted, replacing the previous compaction's summary as the active one and silently destroying compacted long-term memory.

Apply layered fixes in src/agent/compaction.ts and src/database.ts:

1. Core fix — escalatingSummarize: change both level guards so an empty/whitespace-only result falls through to the next level. Require `text.trim().length > 0 && text.length < inputLength`. Level 3 (deterministic truncation) becomes the real safety net.

2. Disable reasoning for the summarization complete() calls. Pass a model variant with `reasoning: false` to both calls. Verify against the pi-mono library that this is the correct way to disable reasoning per-call (the library is /badlogic/pi-mono on Context7; or check the existing usage at src/agent/index.ts:420,432). If the library doesn't honor `reasoning: false` on the model object passed to `complete()`, drop this step and rely on (1)+(3); document the finding in the completion report.

3. saveCompaction guard (src/database.ts): throw if the summary is empty or whitespace-only. Last-resort tripwire so a future regression in escalatingSummarize surfaces loudly instead of silently corrupting state.

4. Logging: when a level produces unusable text (empty or not shorter than input), log the response's stopReason and the count of non-text blocks (e.g., thinking) alongside the existing failure log line, so the underlying cause is diagnosable from logs.

Non-goals:
- No migration / cleanup of existing bad rows in the compactions table. Operator runs the DELETE workaround manually.
- Don't restructure the level cascade or change prompts.
- Don't add tests unless one would catch a real regression a single manual run wouldn't (per repo policy).

## Acceptance Criteria

- A response with no text blocks does not produce a stored compaction with empty summary; it falls through to level 2 then level 3 truncation.
- saveCompaction rejects empty/whitespace summaries with an exception.
- Reasoning is disabled on the summarization calls, OR the developer documented why this wasn't possible with the current library API.

