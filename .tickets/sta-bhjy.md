---
id: sta-bhjy
status: closed
deps: []
links: []
created: 2026-03-26T13:05:19Z
type: task
priority: 0
assignee: Stavros Korokithakis
---
# Enforce read-only page queries via PostgreSQL transactions

The validateReadOnlySql function in src/index.ts (line 289) uses a regex to check that page queries start with SELECT/WITH and contain no extra semicolons. This is bypassable: a writable CTE like `WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x` passes both checks but mutates data. Since page queries on public pages are reachable without authentication, this is a security hole.

The fix: wrap page query execution in a READ ONLY transaction so PostgreSQL enforces it at the engine level. In handlePageQueryRequest (src/index.ts, around line 301), change the query execution to: acquire a client from the pool, run `BEGIN TRANSACTION READ ONLY`, execute the query, `COMMIT`, and release the client. On error, `ROLLBACK` and release.

Keep validateReadOnlySql as a fast-fail UX check (it gives a nicer error message than the Postgres one for obviously wrong queries like UPDATE/DELETE), but it is no longer the security boundary.

Non-goals: do not create a separate read-only database user or connection pool. Do not change anything about how page queries are defined, stored, or parameterized. The transaction-level enforcement is sufficient.

## Acceptance Criteria

1. A page query containing a writable CTE (e.g. `WITH x AS (DELETE FROM ...) SELECT ...`) must be rejected by Postgres rather than executing the mutation. 2. Existing read-only SELECT queries must continue to work unchanged. 3. Add a test case covering the writable-CTE scenario.

