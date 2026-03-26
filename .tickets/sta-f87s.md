---
id: sta-f87s
status: open
deps: []
links: []
created: 2026-03-26T13:05:50Z
type: task
priority: 1
assignee: Stavros Korokithakis
---
# Introduce versioned migrations for database schema

Schema initialization in src/database.ts is spread across 8 separate initialize*Schema functions called sequentially in main() (src/index.ts lines 449-457): initializeSchema, initializeMemoriesSchema, initializeCompactionsSchema, initializeCronSchema, initializePagesSchema, initializeScratchpadSchema, initializeAgentsSchema, initializeEmbeddingsSchema. Each contains a mix of CREATE TABLE IF NOT EXISTS, ALTER TABLE ADD/DROP COLUMN IF (NOT) EXISTS, and DO blocks. The ordering matters (e.g. agents before embeddings due to FK) but is implicit.

Problems:
1. Every startup re-runs every idempotent statement, including historical migrations that only applied to databases created before a specific change (e.g. dropping interlocutor_id, dropping old pages_path_key constraint). These accumulate forever.
2. It is easy to add a new ALTER TABLE in the wrong function or forget an ordering dependency.
3. There is no way to tell which migrations are historical artifacts vs still needed.

The fix: introduce a schema_version table with a single integer row. Number each migration starting from 0 (the current baseline = all existing CREATE TABLE + ALTER statements consolidated into migration 0). On startup, read the current version, run any migrations with a higher number, update the version. Each migration is a function that takes a pg.Pool.

For existing deployments: migration 0 should be idempotent (the current CREATE IF NOT EXISTS / ADD IF NOT EXISTS approach), so running it on an already-initialized database is safe. Migration 0 should also create the schema_version table and set version to 0 if it does not exist. All subsequent migrations (1, 2, ...) are non-idempotent and only run once.

Structure: create a src/migrations.ts (or src/migrations/ directory) that exports a runMigrations(pool) function. Each migration is a numbered function. main() calls runMigrations(pool) instead of the 8 separate initialize calls.

Consolidate all existing schema setup into migration 0. Strip out historical ALTER TABLE statements that are only relevant to databases that predate them — after migration 0 runs, the schema is in its final state and these intermediate steps are not needed.

Non-goals: do not change any table schemas. Do not introduce a migration framework dependency (this is simple enough to do inline). Do not add rollback/down migration support (YAGNI).

## Acceptance Criteria

1. main() calls a single runMigrations(pool) instead of 8 separate initialize functions. 2. A schema_version table tracks the current version. 3. Existing deployments (already-initialized databases) can run the migration system without data loss. 4. Fresh databases get the correct final schema. 5. Future schema changes can be added as new numbered migrations. 6. The 8 initialize*Schema functions are removed from database.ts.

