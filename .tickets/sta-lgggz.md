---
id: sta-lgggz
status: closed
deps: []
links: []
created: 2026-07-01T21:37:33Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Resource limits on plugin-runner, python-runner, and coder containers

Objective: a runaway plugin or coding task can currently consume all host memory/PIDs; only signal-bridge has a limit.

In docker-compose.yml add mem_limit and pids_limit to:
- plugin-runner: mem_limit 1g, pids_limit 256
- python-runner: mem_limit 1g, pids_limit 256
- coder: mem_limit 4g, pids_limit 512 (claude CLI is heavy)

docker-compose.harbormaster.yml only overrides volume paths, so no change needed there — verify.

Non-goals: no CPU limits, no limits on app/postgres.

Validate with docker compose config -q.


## Notes

**2026-07-01T21:40:43Z**

ready for implementation
