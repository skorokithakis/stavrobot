---
id: sta-serh
status: closed
deps: []
links: []
created: 2026-04-06T09:39:14Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Remove client.py and references on master

Delete client.py. Remove all client.py references from AGENTS.md, README.md, ARCHITECTURE.md. Remove the 'Code style: Python' section from AGENTS.md. Add a note in AGENTS.md (in the 'Version control' section or a new 'Branches' section) that master and pages are separate, independent histories (pages is the documentation branch, not merged into master).

## Acceptance Criteria

client.py deleted. No grep hits for 'client.py' in repo. No Python style section in AGENTS.md. Branch model documented.

