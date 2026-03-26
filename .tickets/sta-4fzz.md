---
id: sta-4fzz
status: closed
deps: [sta-ent0]
links: []
created: 2026-03-26T15:30:42Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Generate plugins/index.md from GitHub API in build-pages.sh

Add a section to build-pages.sh (after the skills post-build step) that fetches all plugin-* repos from the stavrobot GitHub org via the unauthenticated API, fetches manifest.json from each repo to get the plugin name, and writes public/plugins/index.md as a plain markdown table with columns: Name (proper-cased from manifest name), Description (from GitHub repo description), URL (repo HTML URL). Skip repos where manifest.json fetch fails. This file is for bot consumption, not Zola — it goes straight into public/, not content/.

## Acceptance Criteria

build-pages.sh produces public/plugins/index.md with a row per plugin repo that has a valid manifest.json. Name comes from manifest, description from GitHub API, URL is the repo URL.

