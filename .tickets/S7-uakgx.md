---
id: S7-uakgx
status: closed
deps: []
links: []
created: 2026-07-11T12:41:29Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Upgrade Pi packages to 0.80.6

Objective: upgrade @earendil-works/pi-agent-core and @earendil-works/pi-ai from ^0.78.0 to ^0.80.6 in package.json and adapt to the pi-ai 0.80.0 breaking change (root entrypoint is now core-only).

Changes:
1. package.json: bump both packages to ^0.80.6, run npm install to update the lockfile.
2. src/agent/index.ts: replace 'getModel' (removed from root) with 'getBuiltinModel' imported from '@earendil-works/pi-ai/providers/all'. Same signature; existing 'as any' casts on the arguments stay.
3. src/agent/compaction.ts: import 'complete' from '@earendil-works/pi-ai/compat' instead of the root entrypoint. All other imports (types, Type) stay on the root — they are still exported there.
4. src/agent.test.ts: the module mock of '@earendil-works/pi-ai' currently provides Type, getModel, and complete. Split it: keep Type on the root mock, add vi.mock('@earendil-works/pi-ai/compat') providing 'complete', and vi.mock('@earendil-works/pi-ai/providers/all') providing 'getBuiltinModel' (returning { contextWindow: 200000 } as before). Update the test file's own 'import { complete }' to the compat path.
5. Add a DECISIONLOG.md entry: we deliberately use the deprecated /compat entrypoint for 'complete' because pi-agent-core 0.80.6 itself still rides on /compat internally (Agent's default streamFn is compat streamSimple); a full Models-API migration is deferred until Pi removes /compat and the Agent constructor API changes with it.

Non-goals: do NOT migrate to the new Models/provider-collection API. Do NOT touch src/auth.ts or src/login.ts — the /oauth subpath is unchanged. Do NOT change coder/ or plugin-runner/ (no Pi deps there).

Caveats: the Agent constructor usage (getApiKey option) is unchanged in 0.80.6 — no changes needed in createAgent besides the getModel rename. Per AGENTS.md, only local imports use .js extensions; package subpath imports are as written above.

## Acceptance Criteria

npx tsc --noEmit passes; npm test passes; docker compose build succeeds; package-lock.json shows both Pi packages at 0.80.6.

ready for implementation

