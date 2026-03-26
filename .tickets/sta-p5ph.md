---
id: sta-p5ph
status: closed
deps: [sta-73k8]
links: []
created: 2026-03-26T03:19:55Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Add search, read_lines, write_lines, copy, and move actions to manage_files

Add five new actions to manage_files: three for efficient navigation/editing of large files without blowing the context window, and two for file operations.

## Description

- **search**: takes `filename` and `pattern` (substring match by default). Optional `regex` boolean flag to treat pattern as a regex. Returns matching line numbers + content. Cap results at 100 matches; if truncated, indicate how many total matches exist.
- **read_lines**: takes `filename`, `from`, `to` (1-indexed, inclusive). Returns lines prefixed with their line numbers, plus the total line count of the file. Clamp out-of-range values silently (e.g. `to` past EOF returns up to the last line).
- **write_lines**: takes `filename`, `from`, `to` (1-indexed, inclusive), `content`. Replaces lines `from` through `to` with the provided content. Splice semantics: `from: 5, to: 4` inserts before line 5 without removing anything; empty `content` with a valid range deletes those lines. Returns confirmation with the new total line count.
- **copy**: takes `source` and `destination`. Copies a file. Returns the absolute path of the destination.
- **move**: takes `source` and `destination`. Moves/renames a file. Returns the absolute path of the destination.

All five use the shared path resolution helper from sta-73k8 (flat filename resolves to FILES_DIR, absolute path must be under TEMP_ATTACHMENTS_DIR). For copy and move, both source and destination are resolved through the helper.

Update the help text, parameter descriptions, and action union type to include all new actions.

## Acceptance criteria

- search returns matching lines with line numbers; supports both substring and regex; caps at 100 results.
- read_lines returns the requested range with line number prefixes and total line count.
- write_lines replaces the specified line range with new content; returns new total line count.
- copy and move work between any paths under TEMP_ATTACHMENTS_DIR.
- All five validate paths using the shared resolver.
- Help text documents all new actions.
- Type-checks (`npx tsc --noEmit`) and tests (`npm test`) pass.
