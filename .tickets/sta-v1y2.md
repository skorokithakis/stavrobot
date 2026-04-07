---
id: sta-v1y2
status: closed
deps: []
links: []
created: 2026-04-07T00:30:39Z
type: bug
priority: 1
assignee: Stavros Korokithakis
---
# Fix: Signal send tool unconditionally registered

send_signal_message is always added to the base tools array in agent/index.ts (line 412), unlike the other three channel send tools which are conditional on their config section existing. It should follow the same pattern: only registered when config.signal is defined.

## Acceptance Criteria

send_signal_message is only registered when config.signal is defined, same as the other three channel send tools.

