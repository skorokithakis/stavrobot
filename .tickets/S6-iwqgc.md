---
id: S6-iwqgc
status: closed
deps: [S6-tjfyh]
links: []
created: 2026-05-30T00:11:11Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Update docs and decision log for Pi scope migration

Objective: update user-facing docs and the decision log to reflect the Pi package rename.

Scope:
- ARCHITECTURE.md: replace references to @mariozechner/pi-agent-core and @mariozechner/pi-ai with the @earendil-works equivalents (e.g. the lines describing wrapping the Agent class, getModel from pi-ai, getOAuthProvider from pi-ai/oauth). Keep the surrounding prose accurate.
- config.example.toml: update the comment that references 'npx @mariozechner/pi-coding-agent' to the new package name. Verify the correct new CLI package name before editing — the coding-agent package is now @earendil-works/pi-coding-agent (confirm via npm view @earendil-works/pi-coding-agent version using a writable cache). If the package does not exist under that name, report it and leave a TODO rather than guessing.
- DECISIONLOG.md: add an entry recording the decision to migrate from the deprecated @mariozechner Pi scope to @earendil-works at 0.78.0, noting it was a user-approved upgrade and that the only non-mechanical change was the OAuth login callback adaptation.
- AGENTS.md: the 'Context7' section says the library ID is /badlogic/pi-mono. That repo now redirects to /earendil-works/pi. Update that line to the new Context7 ID (/earendil-works/pi). Also update the 'Pi library versions' section wording if it names the old scope.

Non-goals:
- No code changes. Docs only.

Constraints/caveats:
- Do not invent a CLI package name; verify it exists on npm first.
- Keep headings sentence-case per AGENTS.md.

## Acceptance Criteria

ARCHITECTURE.md, config.example.toml, DECISIONLOG.md, and AGENTS.md updated to reference @earendil-works packages and the /earendil-works/pi Context7 ID. The config.example.toml CLI package name was verified to exist on npm (or a TODO was left with explanation if not). DECISIONLOG.md has a new entry for the migration. ready for implementation

