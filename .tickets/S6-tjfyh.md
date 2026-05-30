---
id: S6-tjfyh
status: closed
deps: [S6-ojpxn]
links: []
created: 2026-05-30T00:10:59Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Verify build, type-check, tests, and Docker build after Pi upgrade

Objective: confirm the whole project is healthy after the Pi scope migration and OAuth reconciliation.

Scope:
- Run npx tsc --noEmit and fix any remaining type errors caused by the upgrade.
- Run npm test (vitest). Fix test fallout. Most likely culprits: the vitest mocks in src/agent.test.ts whose factory shapes must match the new module's exported surface, and upload-tools.test.ts / queue.test.ts which import Pi types. Update mocks/types only to match the new library; do NOT weaken assertions to make tests pass.
- Run npm run build and ensure dist/ compiles.
- Run docker compose build to ensure the app image builds (per AGENTS.md). The runtime base is node:22-slim which satisfies the new Node 22.19.0 minimum; confirm the build succeeds.

Non-goals:
- Do not change application behavior to make a test pass. If a test exposes a real behavioral break from the upgrade, report it instead of papering over it.
- Do not touch coder/ or plugin-runner/ builds.

Constraints/caveats:
- npm/docker may need a writable cache in this environment (read-only default npm cache). Use a writable cache dir if necessary.
- If docker compose build cannot run in the environment (no daemon), report that explicitly rather than skipping silently; at minimum ensure npm run build + npm test + tsc are green.

## Acceptance Criteria

npx tsc --noEmit, npm run build, and npm test all pass cleanly. docker compose build succeeds (or, if the Docker daemon is unavailable in the environment, that limitation is reported and the local build+test+typecheck are all green). No test assertions were weakened to pass. ready for implementation

