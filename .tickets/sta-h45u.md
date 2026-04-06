---
id: sta-h45u
status: closed
deps: [sta-serh]
links: []
created: 2026-04-06T09:39:19Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Remove client.py references on pages branch

Switch to the pages branch (separate history). Remove all client.py references from AGENTS.md, README.md, ARCHITECTURE.md. Remove the 'Code style: Python' section from AGENTS.md. Add the same branch model note as on master. Use jj to work on the pages bookmark. Describe the change with jj describe.

## Acceptance Criteria

No grep hits for 'client.py' on pages branch. No Python style section. Branch model documented.

