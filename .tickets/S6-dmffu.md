---
id: S6-dmffu
status: closed
deps: []
links: []
created: 2026-05-30T00:10:28Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Migrate Pi to @earendil-works scope at 0.78.0

Objective: move the two Pi dependencies from the deprecated @mariozechner scope to the renamed @earendil-works scope at version ^0.78.0, and update every import accordingly.

Scope:
- package.json: replace "@mariozechner/pi-agent-core" and "@mariozechner/pi-ai" with "@earendil-works/pi-agent-core" and "@earendil-works/pi-ai" at "^0.78.0". Bump engines.node from ">=20" to ">=22.19.0" (pi 0.75.0 raised the minimum).
- Regenerate package-lock.json by running npm install (do NOT hand-edit the lockfile).
- Update ALL source imports from "@mariozechner/pi-*" to "@earendil-works/pi-*" across src/. This includes the type-only imports, the value imports (Type, getModel, complete, Agent, getOAuthProvider, getOAuthProviders), the "@mariozechner/pi-ai/oauth" subpath in src/login.ts and src/auth.ts, AND the vitest mock module paths in src/agent.test.ts (vi.mock("@mariozechner/pi-ai") and vi.mock("@mariozechner/pi-agent-core")).

Non-goals:
- Do NOT touch coder/ or plugin-runner/ — they have no Pi dependencies.
- Do NOT adapt the OAuth login callbacks in this task (that is a separate ticket). Just change the import paths here.
- Do NOT attempt to fix type errors arising from OAuth callback shape changes here; leave them for the next ticket.

Constraints/caveats:
- The /oauth subpath must become "@earendil-works/pi-ai/oauth".
- Use ripgrep to find every occurrence so none are missed.
- npm install may need a writable cache; the env's default npm cache is read-only. Use a writable cache dir if needed (e.g. npm install --cache /tmp/opencode/npmcache).

## Acceptance Criteria

All @mariozechner/* references in src/ and package.json are gone (rg confirms zero matches). package.json shows @earendil-works/pi-agent-core and @earendil-works/pi-ai at ^0.78.0 and engines.node >=22.19.0. package-lock.json regenerated via npm install and resolves the @earendil-works packages at 0.78.x. ready for implementation

