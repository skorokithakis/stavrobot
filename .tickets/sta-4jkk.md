---
id: sta-4jkk
status: open
deps: []
links: []
created: 2026-03-26T13:05:32Z
type: task
priority: 1
assignee: Stavros Korokithakis
---
# Split plugin-runner/src/index.ts into domain modules

plugin-runner/src/index.ts is 1795 lines with 8+ distinct responsibilities: HTTP routing/auth, bundle loading/registry, plugin user management, script execution, plugin lifecycle (install/update/remove/create), configuration, file transport, and async callbacks. This makes it hard to navigate, review, and safely modify.

Concrete maintenance hazard: the async-init tail logic in handleInstall (lines 1329-1364) and handleUpdate (lines 1495-1530) is nearly identical (~35 lines copy-pasted). A bug fix in one will be missed in the other.

Split into these modules:
- script-runner.ts: runScript(), scanPluginTempDir(), postCallback()
- plugin-user.ts: ensurePluginUser(), removePluginUser(), getPluginUserIds(), derivePluginUsername()
- bundle-registry.ts: loadBundles(), findBundle(), findTool(), isBundleManifest(), manifest validation, migratePermissions()
- plugin-lifecycle.ts: handleInstall(), handleUpdate(), handleRemove(), handleCreate(), handleConfigure(), and a shared runAsyncInit() helper that deduplicates the async-init tail logic
- index.ts: HTTP server, routing, auth middleware — thin composition layer that imports and dispatches to the above

Shared state (PLUGINS_DIR, bundles array, etc.) should be passed explicitly or kept in bundle-registry.ts and imported by the lifecycle module. Do not introduce classes or DI frameworks.

Non-goals: do not change any external behavior or HTTP API contracts. Do not refactor the script execution logic itself. This is a pure structural refactor.

## Acceptance Criteria

1. All existing plugin-runner HTTP endpoints behave identically (same request/response contracts). 2. The async-init logic between install and update is deduplicated into a single shared helper. 3. No file in plugin-runner/src/ exceeds ~500 lines. 4. Docker build succeeds.

