---
id: sta-p5ph
status: open
deps: []
links: []
created: 2026-03-26T03:19:55Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Add search, read_lines, and write_lines actions to manage_files

Add three new actions to manage_files for efficient navigation of large files without blowing the context window.

## Description

- **search**: takes `filename` and `pattern` (substring match by default). Optional `regex` boolean flag to treat pattern as a regex. Returns matching line numbers + content.
- **read_lines**: takes `filename`, `from`, `to` (1-indexed line numbers). Returns lines prefixed with their line numbers, plus the total line count of the file.
- **write_lines**: takes `filename`, `from`, `to`, `content`. Replaces lines `from` through `to` (inclusive) with the provided content.

All three accept absolute paths under `TEMP_ATTACHMENTS_DIR`, same as the `read` action. Use the `resolveReadPath` helper (extract from the existing `read` action) to share path resolution logic.

Update the help text and parameter descriptions to document the new actions.

## Acceptance criteria

- search returns matching lines with line numbers; supports both substring and regex.
- read_lines returns the requested range with line number prefixes and total line count.
- write_lines replaces the specified line range with new content.
- All three validate paths the same way read does (flat filename or absolute path under TEMP_ATTACHMENTS_DIR).
- Help text documents all new actions.
- Type-checks (`npx tsc --noEmit`) and tests (`npm test`) pass.
