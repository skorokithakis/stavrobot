# Architecture

This document describes the architecture of Stavrobot, a single-user personal AI assistant. It is the authoritative reference for how the system works. Keep it updated when the architecture changes.

## System overview

Stavrobot is an LLM-powered personal assistant that runs as a set of Docker containers. The owner interacts with it via a CLI client, Signal, Telegram, or WhatsApp. The main agent can create subagents, each with their own conversation history, system prompt, and tool whitelist. Interlocutors are contact records that can be assigned to agents for inbound message routing. The LLM agent (Anthropic Claude) has access to a PostgreSQL database, a plugin system, sandboxed Python execution, cron scheduling, and a self-programming subsystem that can create new tools at runtime.

All messages flow through a single `POST /chat` endpoint on the main app. The agent processes one message at a time via an in-memory queue.

## Containers

Seven containers are defined in `docker-compose.yml`. The signal-bridge is behind a Docker Compose profile and only starts when explicitly enabled.

### app (port 3000 external, 3001 internal)

The main TypeScript HTTP server. Built with a multi-stage Dockerfile: the build stage compiles TypeScript, the production stage copies only compiled JS and production dependencies. Runs on Node.js 22. WhatsApp integration runs in-process via the Baileys library (no separate container).

**Two HTTP servers run in this container:**

- **Port 3000 (external):** All user-facing endpoints. Protected by HTTP Basic Auth (password from `config.toml`). Public route exceptions are whitelisted in `isPublicRoute()`: the Telegram webhook (`POST /telegram/webhook`), pages (`GET /pages/*`), and page queries (`GET /api/pages/*/queries/*`). Pages and page queries enforce per-row auth in their handlers (checking `is_public`).

- **Port 3001 (internal):** An unauthenticated HTTP server that only accepts `POST /chat`. Used for inter-service callbacks from the signal-bridge, plugin-runner, and coder containers. This avoids distributing the app password to every container. Network-level isolation (Docker internal networking) provides the security boundary.

**Entrypoint:** `entrypoint.sh` runs as root, `chmod 600` the config file (so the Node process running as root can read it but it's protected), makes the data directory world-writable, then execs the Node process.

### postgres

PostgreSQL 17. Health-checked with `pg_isready`. The app waits for it to be healthy before starting. Data is persisted to `./data/postgres`.

### plugin-runner (port 3003)

A Node.js 22 HTTP server that manages and executes plugins. Has no LLM. Built with a multi-stage Dockerfile. The production image includes `uv`, `python3`, `git`, `openssh-client`, `curl`, and `build-essential` so plugins can use any of these runtimes.

Handles both git-installed plugins and locally created (editable) plugins. Creates a dedicated Unix system user per plugin (`plug_<name>` with hyphens replaced by underscores) and restricts each plugin's directory with `chmod 700`, so plugins cannot read each other's files or configuration.

Mounts: `./data/main:/config` (reads config.toml for the app password), `./data/plugins:/plugins`, `./cache/plugins:/cache`.

### coder (port 3002)

A Python HTTP server that wraps the `claude` CLI (Claude Code headless). Receives coding tasks for specific plugins, spawns `claude -p` as a subprocess running as the plugin's Unix user, and posts results back to the app via `POST` to `app:3001/chat`.

Built on `debian:bookworm-slim` with `uv`, `python3`, `git`, and the Claude CLI installed. Creates a `coder` user (UID 9999) for installing the Claude CLI, but the server itself runs as root so it can switch to different plugin users per task.

**Entrypoint:** Runs as root. Reads `config.toml`, extracts `[coder].model` into `/run/coder-env` (chmod 600), then execs the Python server. The LLM subprocess cannot read `config.toml` directly.

**Credential management:** Before each task, copies `.credentials.json` from `/home/coder/.claude/` into the plugin directory (owned by the plugin user). After the task, copies refreshed credentials back and cleans up. Validates that the `.claude` directory in the plugin is not a symlink to prevent credential theft.

Mounts: `./data/main:/config`, `./data/coder:/home/coder/.claude`, `./data/plugins:/plugins`, `./cache/plugins:/cache`.

### python-runner (port 3003)

A Python HTTP server that executes arbitrary Python code via `uv run`. Accepts `POST /run` with `{ code, dependencies }`. Creates a `pythonrunner` system user and runs all scripts as that user. 30-second timeout with SIGTERM/SIGKILL escalation.

No volume mounts. Completely isolated from the app filesystem.

### signal-bridge (port 8081 internal)

A Python script that bridges Signal messages to the agent. Only starts when the `signal` Docker Compose profile is enabled. Runs `signal-cli` as a subprocess in daemon mode with an HTTP API on port 8080 (internal to the container). Listens to the SSE event stream for incoming messages.

**Dual role:**
- **Inbound:** Receives Signal messages via SSE, forwards them to `app:3001/chat` with `source: "signal"`.
- **Outbound:** Exposes `POST /send` on port 8081 for the app's `send_signal_message` tool to call. Converts markdown to Signal text styles. Supports text and file attachments.

Mounts: `./data/main:/app/config:ro`, `./data/signal-cli:/root/.local/share/signal-cli`. The bridge reads `config.toml` from `/app/config/config.toml`.

### pg-backup

A PostgreSQL 17 container that runs `pg_dump | gzip` on a configurable interval (default: daily). Implements a retention policy: keeps the 30 most recent backups, plus one per month for 12 months, plus one per year forever.

Mounts: `./scripts:/scripts:ro`, `./data/db-backups:/backups`.

## HTTP routes

All routes are defined in `src/index.ts` as a flat if/else chain in the `http.createServer` callback. There is no routing framework. Routes are matched by `request.method` and `pathname` (from `new URL(request.url)`).

### Public routes (no auth required)

| Method | Path | Handler | Notes |
|--------|------|---------|-------|
| POST | `/telegram/webhook` | `handleTelegramWebhookRequest` | Validated by `x-telegram-bot-api-secret-token` header |
| GET | `/pages/*` | `handlePageRequest` | Per-row auth: handler checks `is_public` |
| GET | `/api/pages/*/queries/*` | `handlePageQueryRequest` | Per-row auth: handler checks `is_public` |

### Authenticated routes (HTTP Basic Auth required)

| Method | Path | Handler | File |
|--------|------|---------|------|
| POST | `/chat` | `handleChatRequest` | `index.ts` |
| POST | `/api/upload` | `handleUploadRequest` | `uploads.ts` |
| GET | `/providers/anthropic/login` | `serveLoginPage` | `login.ts` |
| POST | `/providers/anthropic/login` | `handleLoginPost` | `login.ts` |
| GET | `/explorer` | `serveExplorerPage` | `explorer.ts` |
| GET | `/api/explorer/tables` | `handleTablesRequest` | `explorer.ts` |
| GET | `/api/explorer/tables/:name` | `handleTableSchemaRequest` | `explorer.ts` |
| GET | `/api/explorer/tables/:name/rows` | `handleTableRowsRequest` | `explorer.ts` |
| GET | `/settings` | `serveSettingsHubPage` | `settings.ts` |
| GET | `/settings/allowlist` | `serveAllowlistPage` | `settings.ts` |
| GET | `/api/settings/allowlist` | `handleGetAllowlistRequest` | `settings.ts` |
| PUT | `/api/settings/allowlist` | `handlePutAllowlistRequest` | `settings.ts` |
| GET | `/settings/plugins` | `servePluginsPage` | `plugins.ts` |
| GET | `/plugins` | redirect → `/settings/plugins` | `index.ts` |
| GET | `/api/settings/plugins/list` | `handlePluginsListRequest` | `plugins.ts` |
| GET | `/api/settings/plugins/:name/detail` | `handlePluginDetailRequest` | `plugins.ts` |
| GET | `/api/settings/plugins/:name/config` | `handlePluginConfigRequest` | `plugins.ts` |
| POST | `/api/settings/plugins/install` | `handlePluginInstallRequest` | `plugins.ts` |
| POST | `/api/settings/plugins/update` | `handlePluginUpdateRequest` | `plugins.ts` |
| POST | `/api/settings/plugins/remove` | `handlePluginRemoveRequest` | `plugins.ts` |
| POST | `/api/settings/plugins/configure` | `handlePluginConfigureRequest` | `plugins.ts` |
| GET | `/signal/captcha` | `serveSignalCaptchaPage` | `signal-captcha.ts` |
| POST | `/signal/captcha` | `handleSignalCaptchaSubmit` | `signal-captcha.ts` |

### Internal server (port 3001, no auth)

| Method | Path | Handler |
|--------|------|---------|
| POST | `/chat` | `handleChatRequest` |

## UI pages (server-rendered HTML)

All UI pages are served as inline HTML string constants in their respective source files. There is no template engine, no static file serving, and no frontend build step. JavaScript is inlined in `<script>` tags.

| URL | Source file | Description |
|-----|-------------|-------------|
| `/` | `src/home.ts` (`buildHtml`) | Dashboard: bot info, service status, message stats, nav links |
| `/explorer` | `src/explorer.ts` (`EXPLORER_PAGE_HTML`) | Database table browser with pagination, sorting, schema view |
| `/settings` | `src/settings.ts` (`SETTINGS_HUB_HTML`) | Hub page with links to sub-settings |
| `/settings/allowlist` | `src/settings.ts` (`SETTINGS_PAGE_HTML`) | Manage Signal/Telegram/WhatsApp allowlists |
| `/settings/plugins` | `src/plugins.ts` (`PLUGINS_PAGE_HTML`) | Install/update/remove plugins, configure plugin config |
| `/signal/captcha` | `src/signal-captcha.ts` (`SIGNAL_CAPTCHA_PAGE_HTML`) | Signal rate-limit captcha submission form |
| `/providers/anthropic/login` | `src/login.ts` (`LOGIN_PAGE_HTML`) | Anthropic OAuth PKCE login flow |
| `/pages/<path>` | `src/index.ts` → `database.ts` | LLM-created pages, served from the `pages` DB table |

## Pages system

The `pages` table stores HTML (or any MIME type) content created by the LLM agent via the `manage_pages` tool (`src/pages.ts`). Pages are served at `GET /pages/<path>`.

- **Auth:** The `/pages/` prefix is whitelisted in `isPublicRoute()` so the route is reachable without a session cookie. The `handlePageRequest` handler then checks `page.isPublic`: if false and a password is configured, it enforces HTTP Basic Auth.
- **Queries:** Pages can declare named SQL queries in the `queries` JSONB column. These are served at `GET /api/pages/<path>/queries/<name>` and accept `$param:name` placeholders resolved from query string parameters. Only `SELECT`/`WITH` queries are allowed. Auth follows the same `is_public` pattern.
- **MIME type:** Stored in the `mimetype` column; served as the `Content-Type` header. Supports any MIME type (HTML, CSS, JSON, etc.).
- **Content:** Stored as `BYTEA` (via `convert_to($content, 'UTF8')`), returned as a raw buffer.
- **Security:** The `manage_pages` tool instructs the agent to default `is_public` to false and only set it true on explicit user request.

## Message flow

### Inbound message processing

All messages enter through `POST /chat` (either the external port 3000 with auth, or the internal port 3001 without auth). The request body is JSON with these fields:

- `message` (string, optional): Text message.
- `attachments` (array, optional): Pre-saved file attachments with `storedPath`, `originalFilename`, `mimeType`, `size`.
- `files` (array, optional): Raw file data as base64 with `data`, `filename`, `mimeType`. Used by the signal-bridge which cannot write to the app container's filesystem. Audio files are sent through this field like any other file.
- `source` (string, optional): Where the message came from (`"cli"`, `"signal"`, `"telegram"`, `"whatsapp"`, `"cron"`, `"coder"`, `"upload"`, `"plugin:name/tool"`).
- `sender` (string, optional): Identifier of the sender (phone number, chat ID, etc.).

At least one of `message`, `attachments`, or `files` must be present.

**Routing:** After the request is accepted, the queue resolves which agent the message belongs to:

1. **Internal sources** (`cli`, `cron`, `coder`, `plugin:*`, or no source/sender): always routed to the main agent (agent 1) without any DB lookup.
2. **Agent-to-agent messages** (`source: "agent"`): routed to the agent ID specified in `targetAgentId`. The `sender` field carries the sending agent's ID.
3. **Owner check:** If `(source, sender)` matches one of the owner's configured identities (loaded into memory at startup from `[owner]` config), the message is routed to the main agent. This is a pure in-memory check — no DB involved.
4. **Soft gate:** Look up `(source, sender)` in `interlocutor_identities`. If found, resolve the interlocutor's `agent_id` and route to that agent. If the interlocutor has no assigned agent, the message is dropped silently.
5. If no routing rule matches, the message is dropped silently — no error is returned to the caller.

### Message queue

Messages are processed sequentially through an in-memory queue (`queue.ts`). Only one message is processed at a time. The queue handles retries (up to 3 retries with 30-second delays) and special error handling for auth failures (sends login links via the originating channel) and 400 errors (non-retryable).

### Agent processing

`handlePrompt()` in `agent.ts` is the core processing function:

1. Loads the conversation messages for the resolved agent from the database and swaps them into the agent via `replaceMessages()`. This is a cheap array swap that ensures the agent always has the right history regardless of which agent received the previous message.
2. If a background compaction just finished for this agent, clears the compaction flag (the reload above already picks up the compacted state).
3. Builds the system prompt, which differs by agent type:
   - **Main agent:** base prompt (`system-prompt.txt`) + custom prompt (from config) + public hostname/timezone suffix + plugin list + memories (full content) + scratchpad titles.
   - **Subagent:** base subagent prompt (`agent-prompt.txt`) + public hostname/timezone suffix + plugin list (only if the agent's tool whitelist includes plugin tools) + the agent's `system_prompt` field from the database.
4. Filters the tool list for subagents based on their `allowed_tools` whitelist. `send_agent_message` is always included regardless of the whitelist. The main agent always gets the full tool set.
5. Processes file attachments: appends a notification with the file path and metadata to the user message. Reads image attachments into base64 for vision.
6. Formats the user message with metadata: `Time`, `Source`, `Sender`, `Text`. The sender label is `"owner"` for the owner and the interlocutor's `display_name` for external senders.
7. Validates API key/OAuth credentials before entering the agent loop.
8. Subscribes to agent events to persist messages to the database (scoped to the agent, with `sender_identity_id` or `sender_agent_id` on the inbound user message) as they complete.
9. Calls `agent.prompt()` which runs the LLM with tool use in a loop until the agent stops.
11. After completion, triggers background compaction if message count exceeds 40.

### Outbound message delivery

The agent does not directly reply to Signal, Telegram, or WhatsApp users. The system prompt instructs the agent that when `Source` is `"signal"`, `"telegram"`, or `"whatsapp"`, the text response is never delivered — the agent must use `send_signal_message`, `send_telegram_message`, or `send_whatsapp_message` tools to reach the user. For CLI source, the text response is returned in the HTTP response body.

### Telegram webhook flow

1. Telegram sends updates to `POST /telegram/webhook` (public, no auth).
2. The handler responds 200 immediately (Telegram requires fast responses).
3. Downloads voice notes, photos, or documents from the Telegram API.
4. Enqueues the message with `source: "telegram"` and the chat ID as sender.
5. The agent processes it and uses `send_telegram_message` to reply.

### WhatsApp flow

1. Baileys receives a WhatsApp message via its event system (runs in-process in the app container).
2. Checks the sender against the allowlist; drops the message if not allowed.
3. Downloads media attachments if present.
4. Enqueues the message with `source: "whatsapp"` and the sender's E.164 phone number.
5. The agent processes it and uses `send_whatsapp_message` to reply.

### Signal bridge flow

1. `signal-cli` receives a Signal message and emits it via SSE.
2. The bridge reads the SSE stream, extracts text/audio/attachments.
3. Forwards to `app:3001/chat` with `source: "signal"` and the phone number as sender.
4. The agent processes it and uses `send_signal_message` to reply.
5. `send_signal_message` calls `POST http://signal-bridge:8081/send`.
6. The bridge sends via `signal-cli`'s JSON-RPC API.

### Coder async flow

1. The agent calls `request_coding_task` with a plugin name and message.
2. The tool validates the plugin is editable, then sends `POST http://coder:3002/code` with `{ taskId, plugin, message }`.
3. The coder returns 202 immediately.
4. In a background thread, the coder spawns `claude -p` as the plugin's Unix user.
5. On completion, posts the result to `app:3001/chat` with `source: "coder"`.

### Plugin async tool flow

1. The agent calls `run_plugin_tool` for a tool marked `async: true`.
2. The plugin-runner returns 202 immediately.
3. The tool script runs in the background (5-minute timeout).
4. On completion, the plugin-runner posts the result to `app:3001/chat` with `source: "plugin:name/tool"`.

## Database schema

All tables are created with `CREATE TABLE IF NOT EXISTS` on startup. The schema is managed by the app, not by migrations.

### messages

Stores the full conversation history. Each row is a single agent message (user, assistant, or toolResult) serialized as JSONB. Scoped to an agent.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PRIMARY KEY | Auto-incrementing ID |
| role | TEXT | Message role |
| content | JSONB | Full message content |
| agent_id | INTEGER FK | Agent this message belongs to |
| sender_identity_id | INTEGER FK (nullable) | Identity of the external sender (set on inbound user messages from interlocutors) |
| sender_agent_id | INTEGER FK (nullable) | ID of the sending agent (set on inbound user messages from other agents) |
| created_at | TIMESTAMPTZ | Timestamp |

A CHECK constraint (`messages_at_most_one_sender`) enforces that at most one of `sender_identity_id` and `sender_agent_id` is non-null per row.

### memories

The agent's self-managed memory store. Full content is injected into the system prompt every turn (owner conversations only).

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PRIMARY KEY | Auto-incrementing ID |
| content | TEXT | Memory content |
| created_at | TIMESTAMPTZ | Creation timestamp |
| updated_at | TIMESTAMPTZ | Last update timestamp |

### scratchpad

Second-tier knowledge store. Only titles are injected into the system prompt; bodies are read on demand via SQL. Owner conversations only.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PRIMARY KEY | Auto-incrementing ID |
| title | TEXT | Short descriptive title |
| body | TEXT | Full content |
| created_at | TIMESTAMPTZ | Creation timestamp |
| updated_at | TIMESTAMPTZ | Last update timestamp |

### compactions

Stores conversation summaries created by background compaction. Scoped to an agent.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PRIMARY KEY | Auto-incrementing ID |
| summary | TEXT | Compacted conversation summary |
| up_to_message_id | INTEGER FK | Last message ID included in this compaction |
| agent_id | INTEGER FK | Agent this compaction belongs to |
| created_at | TIMESTAMPTZ | Timestamp |

### cron_entries

Scheduled tasks managed by the agent via the `manage_cron` tool.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PRIMARY KEY | Auto-incrementing ID |
| cron_expression | TEXT (nullable) | Standard cron expression (null if one-shot) |
| fire_at | TIMESTAMPTZ (nullable) | Absolute fire time for one-shot entries |
| note | TEXT | Human-readable description |
| last_fired_at | TIMESTAMPTZ (nullable) | When this entry last fired |

### pages

LLM-created web pages served at `/pages/<path>`.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PRIMARY KEY | Auto-incrementing ID |
| path | TEXT UNIQUE | URL path (no leading/trailing slashes) |
| mimetype | TEXT | MIME type for the Content-Type header |
| data | BYTEA | Page content (UTF-8 encoded) |
| is_public | BOOLEAN | Whether auth is required to view |
| queries | JSONB (nullable) | Named SQL queries: `{ queryName: "SELECT ..." }` |
| created_at | TIMESTAMPTZ | Creation timestamp |
| updated_at | TIMESTAMPTZ | Last update timestamp |

### scratchpad

See above.

### agents

Subagent definitions. Agent 1 is always the main agent, seeded on startup.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PRIMARY KEY | Auto-incrementing ID |
| name | TEXT | Display name |
| system_prompt | TEXT | Agent-specific system prompt |
| allowed_tools | TEXT[] | Whitelist of tool names (empty = no tools except send_agent_message) |
| created_at | TIMESTAMPTZ | Creation timestamp |

### interlocutors

Contact records. Each interlocutor can be assigned to an agent for message routing.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PRIMARY KEY | Auto-incrementing ID |
| display_name | TEXT UNIQUE | Human-readable name |
| owner | BOOLEAN | True for the owner record (enforced unique via partial index) |
| enabled | BOOLEAN | Whether this interlocutor can send messages |
| agent_id | INTEGER FK (nullable) | Agent to route messages to (null = drop) |
| created_at | TIMESTAMPTZ | Creation timestamp |

### interlocutor_identities

Maps external identities (phone numbers, chat IDs) to interlocutors.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PRIMARY KEY | Auto-incrementing ID |
| interlocutor_id | INTEGER FK | Parent interlocutor |
| service | TEXT | `"signal"`, `"telegram"`, `"whatsapp"` |
| identifier | TEXT (nullable) | Phone number or chat ID (nullable for soft-deletion) |
| created_at | TIMESTAMPTZ | Timestamp |

## Plugin system

Plugins are Node.js or Python packages that expose tools to the LLM agent. They are managed by the plugin-runner container.

### Plugin manifest (`plugin.json`)

Each plugin directory contains a `plugin.json` with:

```json
{
  "name": "plugin-name",
  "description": "What this plugin does",
  "tools": [
    {
      "name": "tool_name",
      "description": "What this tool does",
      "parameters": { /* JSON Schema */ },
      "async": false
    }
  ]
}
```

Parameter types include `string`, `integer`, `number`, `boolean`, and `file`. A `file` parameter signals that the caller will supply a file; the app base64-encodes the file contents and the plugin-runner materializes it to disk before the tool runs.

### Plugin lifecycle

- **Install:** `POST /install` with `{ url }` — clones the git repo into `/plugins/<name>`, creates a Unix user `plug_<name>`, sets `chmod 700` on the directory.
- **Update:** `POST /update` with `{ name }` — runs `git pull` in the plugin directory.
- **Remove:** `POST /remove` with `{ name }` — deletes the directory and Unix user.
- **Configure:** `POST /configure` with `{ name, config }` — writes `config.json` into the plugin directory (owned by the plugin user, `chmod 600`).
- **Create:** `POST /create` with `{ name }` — creates an empty editable plugin directory.

### Tool execution

`POST /bundles/:name/tools/:tool/run` with `{ params, taskId? }`. The plugin-runner:
1. Reads the plugin manifest.
2. For any `type: "file"` parameters, decodes the base64-encoded file contents from `params` and writes the file to `/tmp/<plugin_name>/` before spawning the tool. The parameter value passed to the tool on stdin is the resulting file path.
3. Runs the tool's entry point as the plugin's Unix user.
4. For sync tools: waits for completion and returns the result.
5. For async tools: returns 202 immediately; posts result to `app:3001/chat` on completion.

When the main app calls a tool with `type: "file"` parameters, it reads the file from disk and base64-encodes its contents before sending the request to the plugin-runner.

### Config isolation

Each plugin's `config.json` is owned by its Unix user and `chmod 600`. The plugin-runner reads it when executing tools (running as the plugin user). The main app never reads plugin config files directly. The LLM agent can write config via `configure_plugin` but cannot read it back — the tool only reports which keys are present or missing.

## Security model

### Authentication layers

1. **HTTP Basic Auth (port 3000):** All routes except the Telegram webhook and `/pages/*` require the password from `config.toml`. The password is checked on every request; there are no sessions or cookies.
2. **Per-row auth (pages):** Pages and page queries check `is_public` in the handler. Private pages require Basic Auth even though the route prefix is whitelisted.
3. **Internal server (port 3001):** No auth. Accessible only within the Docker network. Used by signal-bridge, plugin-runner, and coder for callbacks.
4. **Telegram webhook:** Validated by `x-telegram-bot-api-secret-token` header (a random secret registered with Telegram at startup).
5. **Plugin-runner config endpoint:** Requires `Authorization: Bearer <password>` (the app password). Only proxied from the authenticated main server.

### LLM isolation

- The LLM agent runs inside the app container but cannot read arbitrary files from the filesystem. All code execution happens in separate containers (python-runner, plugin-runner, coder).
- No tool gives the LLM the ability to read arbitrary files from the app container.
- The app container has no Python or other code execution runtimes installed.
- Plugin `config.json` files may contain secrets. No API endpoint or tool ever returns config values to the LLM. The `configure_plugin` tool only reports which keys are present or missing.
- Plugin permissions (`permissions` key in `config.json`) control which tools the LLM can see and call. `["*"]` = all tools, `[]` = plugin disabled, explicit list = only those tools. Permissions are set via the web UI only — the main app strips `permissions` from LLM-initiated configure requests so the LLM cannot escalate its own access.
- The Docker socket is never mounted into any container.

### Secret isolation (coder)

The coder entrypoint (running as root) reads `config.toml`, extracts only the model name into `/run/coder-env` (chmod 600), then execs the Python server. The LLM subprocess (`claude -p`) cannot read `config.toml` directly. Claude credentials are copied per-task into the plugin directory and cleaned up after.

## Configuration

Runtime config is loaded from `config.toml` (path overridable via `CONFIG_PATH` env var). `config.toml` is gitignored; `config.example.toml` is the template.

Key config sections:

- `provider`, `model`: LLM provider and model name.
- `apiKey` or `authFile`: Mutually exclusive. `apiKey` is a direct API key; `authFile` points to a JSON file with OAuth credentials.
- `publicHostname`: The public URL of the app (e.g. `https://bot.example.com`). Required.
- `password`: HTTP Basic Auth password. Optional; if absent, no auth is enforced.
- `[owner]`: Owner identity (name, Signal number, Telegram chat ID, WhatsApp number).
- `[signal]`, `[telegram]`, `[whatsapp]`: Optional messaging integrations.
- `[coder]`: Optional coder config (model name for Claude Code).

PostgreSQL connection is configured via environment variables (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`), defaulting to `postgres:5432/stavrobot`.

## Conventions

### TypeScript

- ESM (`"type": "module"`, `"module": "NodeNext"`). All local imports use `.js` extension.
- `strict: true`. All functions have explicit return type annotations.
- `import type` for type-only imports.
- Named exports only; no default exports.
- `unknown` instead of `any` for untyped data; narrow with type guards.
- Interfaces for object shapes; `camelCase` for variables/functions; `PascalCase` for interfaces/types.
- Standalone `async` functions, not classes, for application logic.
- `console.log` with `[stavrobot]` prefix for tracing; `console.error` for errors.
- Errors propagate; try/catch only at HTTP boundaries.
- Double quotes, `const` by default, trailing commas, semicolons, 2-space indentation.

### Python

- Statically typed function signatures (built-in types, not `typing` module).
- `snake_case` for functions/variables; `PascalCase` for classes.
- Docstrings on all functions.
- Specific exception types in `except` clauses.
- `if __name__ == "__main__":` entry point.
