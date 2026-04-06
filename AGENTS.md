# Agents

This file contains instructions for AI coding agents operating in this repository.

The project's GitHub URL is https://github.com/skorokithakis/stavrobot/.

## Architecture reference

`ARCHITECTURE.md` is the authoritative reference for how the system works: containers,
message flow, database schema, security model, plugin system, and more. Read it before
exploring the repo — it will answer most structural questions faster than grepping. After
any change that affects architecture (new containers, endpoints, tools, database tables,
security boundaries, message flow, etc.), update `ARCHITECTURE.md` to reflect the new
state.

## Project overview

Stavrobot is a TypeScript HTTP server that wraps an LLM-powered agent (Anthropic Claude
by default) with access to a PostgreSQL database via a SQL execution tool. It exposes a
single `POST /chat` endpoint. The project is containerized with Docker and docker-compose.

## Build, run, and test commands

```bash
# Install dependencies
npm install

# Build (compile TypeScript to dist/)
npm run build

# Run the compiled server
npm start

# Run in dev mode (tsx, no compile step)
npm run dev

# Type-check without emitting (useful for CI or quick validation)
npx tsc --noEmit

# Run tests
npm test

# Docker
docker compose up --build
```

Tests use vitest. Run `npm test` after changes that touch request handling, auth,
or database logic.

There is no linter or formatter configured. If one is added, use Biome (single tool for
both linting and formatting with good TypeScript ESM support).

## Code style: TypeScript

### Module system

- The project uses ESM (`"type": "module"` in package.json, `"module": "NodeNext"` in
  tsconfig).
- All local imports must use the `.js` extension (e.g., `import { loadConfig } from
  "./config.js"`), even though the source files are `.ts`. This is required by NodeNext
  module resolution.

### Imports

- Use `import type` for type-only imports (e.g., `import type { Config } from
  "./config.js"`). This is enforced by strict mode and tree-shaking.
- Order: third-party modules first, then local modules (with `./` prefix).
- Named exports only. No default exports.

### Typing

- `strict: true` is enabled in tsconfig. All code must satisfy strict type checking.
- All functions must have explicit return type annotations, including `Promise<void>`.
- Use interfaces for object shapes (e.g., `Config`, `PostgresConfig`).
- Use `unknown` instead of `any` for untyped data, then narrow with type guards or
  assertions. The only exception is when a library API forces `any`.
- Type assertions should be used sparingly. When necessary, cast through `unknown` first
  (e.g., `TOML.parse(content) as unknown as Config`).

### Naming

- `camelCase` for variables, functions, and parameters.
- `PascalCase` for interfaces and type aliases.
- No abbreviations. Prefer `message` over `msg`, `response` over `res`, `request` over
  `req`.

### Functions and structure

- Use standalone `async` functions, not classes, for application logic.
- The `Agent` class from the library is the only class used directly.
- Keep functions small and focused. Each file in `src/` has a clear responsibility:
  `config.ts` (loading config), `database.ts` (Postgres operations), `agent.ts`
  (LLM agent setup and prompting), `index.ts` (HTTP server and entry point).

### Logging

- Add `console.log` statements to trace code flow at a high level. Not every line, but
  enough to follow what's happening in the logs: tool invocations, external API calls,
  key decision points, and results (or at least their size/shape).
- Use the `[stavrobot]` prefix for all log lines (e.g.,
  `console.log("[stavrobot] web_search called:", query)`).
- Use `console.error` for errors and `console.warn` for warnings.

### Error handling

- Let exceptions propagate. Do not add defensive try/catch blocks unless the function
  is the boundary where the error must be handled (e.g., the HTTP request handler in
  `index.ts`).
- At HTTP boundaries, catch errors and return structured JSON error responses with
  appropriate status codes.
- Use `error instanceof Error ? error.message : String(error)` when converting unknown
  caught values to strings.

### Comments

- Comments explain "why", not "what". Do not add comments that just describe what the
  next few lines do.
- Comments should be full sentences, properly capitalized, ending with a full stop.
- Currently the codebase has almost no comments because the code is straightforward. Do
  not add unnecessary comments.

### Formatting

- Use double quotes for strings.
- Use `const` by default, `let` only when reassignment is needed. Never use `var`.
- Trailing commas in multiline constructs.
- Semicolons at end of statements.
- 2-space indentation.

## Configuration

- Runtime config is loaded from `config.toml` (or path in `CONFIG_PATH` env var).
- `config.toml` is gitignored. `config.example.toml` is the template.
- Do not commit secrets or API keys.

## Docker

- Multi-stage Dockerfile: build stage compiles TypeScript, production stage copies only
  compiled JS and production dependencies.
- docker-compose runs Postgres 17 and the app, with a health check on Postgres before
  the app starts.
- The app listens on port 3000 by default (configurable via `PORT` env var).
- After completing a feature, run `docker compose build` to verify all containers build
  successfully.
- `docker-compose.harbormaster.yml` is an override file that replaces `./data` volume
  paths with `{{ HM_DATA_DIR }}`. Whenever `docker-compose.yml` changes (new services,
  volume mounts, etc.), update `docker-compose.harbormaster.yml` to match. The volume
  paths in both files must stay in sync.
- NEVER mount the Docker socket (`/var/run/docker.sock`) into any container. The LLM
  agents have shell access and could use the socket to introspect or control the entire
  Docker host.
- Never mount single files as Docker volumes. Mount entire directories instead and place
  the files inside them. Docker creates a directory with the file's name if the file
  doesn't exist on the host at container start time.
- Secret isolation pattern for LLM containers: create the service user with UID 9999
  (`useradd -m -u 9999 <user>`). Mount the config directory read-write. In the
  entrypoint (running as root), `chmod 600` the config file so only root can read it,
  extract the values the service needs into a separate file owned by the service user,
  then exec the service process as that user. This way the LLM (which has shell access)
  cannot read secrets from the config file.

## LLM isolation

- The LLM agent must never be able to read files from the app container's filesystem. All code execution happens in separate containers with no shared filesystem mounts between the app and runner containers.
- No tool may give the LLM the ability to read arbitrary files from the app container. If a new tool needs filesystem access, it must run in a dedicated separate container.
- The app container must not have code execution runtimes (Python, uv, etc.) installed. These belong in their dedicated runner containers.
- Plugin configuration files (`config.json`) may contain secrets (API keys, tokens, etc.). No API endpoint or tool may ever return config values to the LLM agent. The agent can write config via `configure_plugin`, but must never be able to read it back. When reporting config status (e.g., after an update), only report which keys are present or missing, never their values.

## Version control

- When asked to commit, run `git diff` first, then git commit with a message describing
  the whole change.
- Do not mention AI in commit messages. Write them as if the human wrote the code.
- DO NOT REVERT ANY CHANGES. If you notice unrelated changes in the repo, pause and ask
  the user, as they might be changes the user has made.
- After completing any task that modifies files, ALWAYS run `jj describe -m "..."` with
  an appropriate message describing the whole change. DO NOT SKIP THIS.
- When a change fixes a GitHub issue, include `Fixes #<number>` in the commit message
  so the issue is closed automatically when pushed.

## Branches

`master` and `pages` are **separate, independent histories** with no common ancestor —
they are not related branches and must never be merged. `master` is the application
source code. `pages` is the documentation/GitHub Pages branch (skills, install guides,
etc.) served via Cloudflare Pages at `stavrobot.stavros.io`. Changes to one branch have
no effect on the other. Task tickets (`.tickets/`) only exist on `master`.

## Coder subsystem

The self-programming feature is split across two containers:

- **Plugin runner (`plugin-runner/`):** Node.js HTTP server with no LLM. Handles both
  locally created (editable) plugins and git-installed plugins. Creates a dedicated
  system user per plugin and restricts each plugin's directory to its own user
  (`chmod 700`), so plugins cannot read each other's files or config. Endpoints:
  - `GET /bundles` — list all plugins
  - `GET /bundles/:name` — get plugin manifest
  - `POST /bundles/:name/tools/:tool/run` — execute a plugin tool
  - `POST /install` — install a plugin from a git URL
  - `POST /update` — update an installed plugin
  - `POST /remove` — remove a plugin
  - `POST /configure` — set plugin configuration
  - `POST /create` — create a new empty editable plugin
- **Claude Code container (`coder/`):** Python HTTP server that wraps the `claude`
  headless binary. Receives coding tasks for a specific plugin, runs as that plugin's
  user, and works in `/plugins/<plugin>/`. Posts results back to the main app via
  `POST /chat`. Endpoint:
  - `POST /code` — submit a coding task with `{ taskId, plugin, message }` (returns 202 immediately)

The async workflow: main app sends `POST /code` with `{ taskId, plugin, message }` to
`coder` → `coder` spawns `claude -p` as a subprocess in `/plugins/<plugin>/` as the
plugin's user → on completion, posts result to `app:3000/chat` with `source: "coder"`.

Configuration: the `coder` entrypoint (running as root) reads `config.toml`,
extracts `[coder].model` into `/run/coder-env` (chmod 600), then execs the server
as root. The server runs as root so it can switch to different plugin users per task.
Before each task, it copies `.credentials.json` from `/home/coder/.claude/` into the
plugin directory (owned by the plugin user), runs claude, then copies refreshed
credentials back and cleans up. The LLM process cannot read `config.toml` directly.

When changing the plugin system (plugin-runner endpoints, manifest schema, runtime
environment, lifecycle hooks, etc.), ALWAYS update `coder/PLUGIN.md` to reflect the
changes.  This file is the plugin authoring guide used by the coder agent.

## Pi library versions

- Only the main app (`package.json`) depends on packages from the Pi mono repo. The
  coder no longer has Pi dependencies. When Pi package versions are updated, only the
  main app's `package.json` needs to be kept in sync.

## Context7

- The LLM agent library used in this project is from the Pi mono repo. The Context7
  library ID is `/badlogic/pi-mono`.

## Deployment model

- This is a single-user bot. One person chats with it at a time.

## Library boundaries

- Never rely on undocumented or internal behaviour of third-party libraries (e.g.,
  reading private fields, depending on internal error propagation paths, importing from
  `dist/` subpaths that aren't part of the public API).
- When a workaround requires reaching into library internals, flag it explicitly and
  discuss with the user before proceeding. Document the dependency clearly in a comment.

## Documentation

- When adding significant user-facing features (new integrations like Telegram, new UI
  pages like the database explorer, new API endpoints, etc.), update the README to
  document them. Users should be able to discover and understand major functionality by
  reading the README.

## Authentication

- All HTTP endpoints must require authentication by default. The only exceptions are
  endpoints that explicitly need to be public, such as incoming webhooks from external
  services (Telegram, Signal, etc.).
- Public routes are whitelisted in the `isPublicRoute` function in `index.ts`. When
  adding a new endpoint, do NOT add it to the whitelist unless it genuinely needs to be
  accessible without authentication.
- When in doubt, require auth. It is better to accidentally require auth on something
  that could be public than to accidentally expose something that should be private.

## Pages

- The `pages` table schema: `id` (serial PK), `path` (text), `version` (integer), `mimetype` (text), `data` (BYTEA), `is_public` (boolean, default false), `queries` (JSONB, nullable), `created_at` (timestamptz). Unique constraint on `(path, version)`.
- Versioning model: every edit inserts a new version row; a delete inserts a tombstone (empty data). Old versions are never removed.
- Pages are served at `GET /pages/<path>` — the latest version is returned. If the latest version is a tombstone (empty data), the page is treated as deleted (404).
- `is_public` controls auth: false requires authentication, true is publicly accessible.
- The LLM agent manages pages via the `manage_pages` tool (not `execute_sql`).
- The `/pages/` prefix is whitelisted in `isPublicRoute` so the route is reachable without a session cookie, but the route handler enforces auth for non-public pages.
- Named queries: pages can define SQL queries in the `queries` JSONB column, fetchable via `GET /api/pages/<path>/queries/<name>`.

## General rules

- Do not write forgiving code. Let errors propagate rather than silently catching them.
- Titles and headings: capitalize only the first letter, not every word.
- No emojis unless explicitly requested.
- If unsure what to do, stop and ask for instructions rather than guessing.
- When adding new features, present a plan and ask for confirmation before implementing.
- When implementing a feature that involves an architectural decision made during
  discussion with the user, record it in `DECISIONLOG.md` at the project root. Only
  record decisions that come from user discussion, not decisions you make yourself. Update
  this file whenever a new decision is implemented.
- When finishing a feature, think whether any non-obvious decisions should be put in
  DECISIONLOG.md or in comments in the code.
