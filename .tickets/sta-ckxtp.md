---
id: sta-ckxtp
status: closed
deps: []
links: []
created: 2026-07-01T21:37:33Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Do not auto-retry turns that persisted progress; add re-entrancy guard

Objective: prevent retries from replaying tool side effects, and turn a future queue re-entrancy bug into a loud failure.

Part 1 — retry behavior (src/agent/index.ts, src/queue.ts, src/errors.ts):
Currently queue.ts retries a failed turn up to 3 times. If the first attempt already persisted assistant/toolResult messages via saveChain (src/agent/index.ts ~880-906), the retry reloads them and agent.prompt() replays the turn, re-executing tools that already ran (duplicate outbound messages, duplicate external side effects).
- In handlePrompt's subscribe callback, track whether any message beyond the initial user message was persisted this turn.
- When the turn ends in error AND progress was persisted, throw a distinguishable error type (new class in src/errors.ts, wrapping the original error message).
- In processQueue (src/queue.ts), treat that error like retry exhaustion: log, sendErrorToSource with the parsed provider message, resolve. Do not retry.
- Turns that fail before anything beyond the user message was persisted keep the existing 3-retry behavior.

Part 2 — re-entrancy guard (src/agent/index.ts):
The single shared Agent instance is only safe because the queue is strictly single-threaded. Add a module-level in-progress flag in handlePrompt: throw immediately if handlePrompt is entered while another turn is in progress; clear the flag in a finally block.

Non-goals: no idempotency keys, no durable queue, no changes to steering.

Also: update the retry description in ARCHITECTURE.md (message flow section), and add/adjust tests in src/queue.test.ts for the non-retryable path. Run npm test.


## Notes

**2026-07-01T21:40:43Z**

ready for implementation
