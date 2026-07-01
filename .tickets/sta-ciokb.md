---
id: sta-ciokb
status: closed
deps: []
links: []
created: 2026-07-01T21:37:33Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Retry callback POSTs from plugin-runner and coder

Objective: async plugin tool results and coder task results are currently lost forever if the app is down/restarting when the callback fires.

- plugin-runner/src/script-runner.ts postCallback(): currently one fetch attempt, failure only logged. Add a retry loop: ~5 attempts with increasing backoff (e.g. 5s, 15s, 30s, 60s, 120s). Retry on network errors and non-2xx responses. Log each failure; final give-up stays an error log.
- coder/server.py post_result(): same treatment in Python (urllib). Note run_coding_task's outer except currently swallows the URLError — retries belong inside post_result so the result is actually delivered.

Non-goals: no persistent outbox, no changes to the callback payload or auth.

Also: mention the retry behavior in the async tool callback flow section of ARCHITECTURE.md. Run npm test and docker compose build.


## Notes

**2026-07-01T21:40:43Z**

ready for implementation
