---
id: sta-i1hw
status: closed
deps: []
links: []
created: 2026-04-10T15:42:05Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Persist user messages before LLM call

Move the user message save from the message_end event subscriber to before agent.prompt(), so messages are persisted even when the model is unreachable and all retries fail.

Scope: src/agent/index.ts (handlePrompt function), src/queue.ts (processQueue function).

Changes:
- Add an 'isRetry: boolean' parameter to handlePrompt (or to RoutingResult, whichever is cleaner).
- In handlePrompt, after formatting the user message and running auto-search but before agent.prompt(): if not a retry, save the user message to the DB via saveMessage, and insert the auto-search embedding into message_embeddings if present.
- Remove the user message save from the message_end subscriber (keep assistant and toolResult saves there).
- In processQueue, pass isRetry: entry.retries > 0 when calling handlePrompt.

Non-goals:
- Do not change retry count, timing, or queue architecture.
- Do not change steered message handling (those bypass the queue and are saved by the subscriber as before).
- Do not change scheduler or cron logic.

## Acceptance Criteria

1. If the model is unreachable and all retries fail, the user message row exists in the messages table. 2. On successful processing, exactly one user message row per prompt (no duplicates on retry). 3. Auto-search embedding is still saved to message_embeddings when available. 4. npm test passes. 5. npx tsc --noEmit passes.

