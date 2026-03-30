---
id: sta-spvq
status: closed
deps: []
links: []
created: 2026-03-30T13:58:56Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Send error messages back to users on their source channel

In processQueue, when a non-retryable 400 error or exhausted-retry error occurs, send an error message back to the user via their originating channel (Signal, Telegram, WhatsApp). Follow the existing AuthError notification pattern on lines 225-243 of queue.ts. Extract a helper function (e.g. sendErrorToSource) that takes source, sender, config, and message, and sends via the appropriate channel. Use this helper in both the 400 branch and the exhausted-retries branch. For the exhausted-retries branch, change entry.reject(error) to entry.resolve(userMessage) so the server no longer crashes from an unhandled rejection. Parse the upstream provider error JSON to extract a human-readable message (the 'message' field inside the error object). If parsing fails, fall back to the raw error string. The user-facing message format should be something like: 'Something went wrong: <extracted message>'. Non-goals: do NOT change retry counts, delays, or add special handling for specific status codes like 429.

## Acceptance Criteria

1) User receives an error message on their channel when a 400 or exhausted-retry error occurs. 2) Server does not crash on exhausted retries. 3) npm test passes. 4) npx tsc --noEmit passes.

