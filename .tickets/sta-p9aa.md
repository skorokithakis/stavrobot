---
id: sta-p9aa
status: closed
deps: []
links: []
created: 2026-03-26T00:33:30Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Remove hardcoded main agent ID assumptions

Replace all hardcoded agent ID 1 references (outside the seed INSERT) with getMainAgentId(). Scope: src/agents.ts (runtime check on line 152 and all help/error strings referencing 'agent 1'), src/send-tools.ts (error message on line 104), prompts/agent-prompt.txt (replace 'agent 1' with placeholder {{main_agent_id}} and substitute at load time where the prompt is assembled). Update comments in src/database.ts and ARCHITECTURE.md to document the invariant. Non-goals: do not add a name-based DB lookup fallback, do not change the seed INSERT in database.ts, do not change test mocks. Fixes #20.

## Acceptance Criteria

No hardcoded literal 1 meaning main agent outside the seed INSERT. npx tsc --noEmit and npm test both pass.

