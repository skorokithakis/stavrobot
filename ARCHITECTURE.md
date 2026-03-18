# Architecture

Stavrobot is a single-user LLM-powered assistant (Anthropic Claude by default) exposed
as an HTTP server. It wraps the `@mariozechner/pi-agent-core` Agent class, persists
conversation history in PostgreSQL, and extends the agent with a plugin system that runs
arbitrary scripts in isolated Unix user accounts.

---

## Containers (docker-compose.yml)

| Service | Image / Build | Port | Role |
|---|---|---|---|
| `postgres` | `pgvector/pgvector:pg17` | internal | Primary database (with pgvector extension) |
| `app` | `./Dockerfile` | 10567→3000 | Main HTTP server + LLM agent |
| `plugin-runner` | `./plugin-runner` | internal:3003 | Executes plugin scripts |
| `coder` | `./coder` | internal:3002 | Runs `claude -p` for plugin authoring |
| `python-runner` | `./python-runner` | internal | Executes Python snippets |
| `pg-backup` | `pgvector/pgvector:pg17` | — | Hourly pg_dump to `./data/db-backups` |
| `signal-bridge` | `./signal-bridge` | internal:8081 | Signal protocol bridge (optional profile) |

All containers share `./data/main` (read-only) for `config.toml`. The `plugin-runner`
and `coder` containers share `./data/plugins` and `./cache/plugins`.

---

## Message flow

```
External caller (Telegram / Signal / WhatsApp / email / CLI)
  → POST /chat  (or webhook endpoint)
  → handleChatRequest  (src/index.ts)
  → enqueueMessage  (src/queue.ts)
  → processQueue  (single-threaded, serialises all turns)
  → resolveTargetAgent  (allowlist + interlocutor lookup)
  → handlePrompt  (src/agent.ts)
  → Agent.prompt  (@mariozechner/pi-agent-core)
  → tool callbacks (execute_sql, manage_plugins, run_plugin_tool, …)
  → response string returned to caller
```

Owner messages arriving while a turn is in progress are **steered** into the running
turn via `Agent.steer()` rather than queued. Non-owner messages are always queued.

The queue is a plain in-memory array (`queue: QueueEntry[]`) with a single `processing`
boolean flag. It is strictly single-threaded — only one `handlePrompt` call runs at a
time. Retries: up to 3 attempts with a 30-second delay between them.

---

## Async tool callback flow

Two patterns exist for long-running work that cannot block the HTTP response:

### Async plugin tools (`manifest.async = true`)
1. `app` calls `POST /bundles/<plugin>/tools/<tool>/run` on `plugin-runner`.
2. `plugin-runner` responds **202** immediately.
3. `plugin-runner` spawns the script in a detached `void (async () => { … })()` block
   with a 5-minute timeout.
4. On completion (success or failure), `plugin-runner` calls `postCallback()`, which
   POSTs `{ source: "plugin:<plugin>/<tool>", message: "…" }` to `app:3000/chat`.
5. The app enqueues this as a new message, which the agent processes as a follow-up.

### Async init scripts (`manifest.init.async = true`)
Same pattern, but triggered during `POST /install` or `POST /update`. The HTTP response
is sent before the init script runs. The source is `plugin:<plugin>/init`.

### Coder tasks (`request_coding_task` tool)
1. `app` calls `POST /code` on `coder` with `{ taskId, plugin, message }`.
2. `coder` responds **202** immediately and spawns a Python `Thread`.
3. The thread runs `claude -p` as the plugin's Unix user (10-minute timeout).
4. On completion, `coder` POSTs `{ source: "coder", message: "…" }` to `app:3000/chat`.
5. The app enqueues this as a new message.

All three callback paths re-enter the queue via `POST /chat` with Basic Auth using the
app password. The `source` field routes them to the main agent's conversation.

---

## Agent setup (src/agent.ts)

The single `Agent` instance is created in `createAgent()` and shared across all
conversations. Per-turn, `handlePrompt()` swaps the conversation history via
`agent.replaceMessages()` and sets the system prompt via `agent.setSystemPrompt()`.

### System prompt assembly (per turn)
- **Main agent**: `baseSystemPrompt` + optional `customPrompt` + timezone/hostname suffix
  + injected memories (full text) + scratchpad titles + plugin list.
- **Subagent**: `baseAgentPrompt` + timezone/hostname suffix + filtered plugin list
  (only plugins the subagent has access to, with tool-level detail) + subagent's own
  `system_prompt` from the DB.

### Tool filtering for subagents
Subagents have `allowed_tools TEXT[]` and `allowed_plugins TEXT[]` in the DB.
`filterToolsForSubagent()` wraps tool `execute` functions to enforce action-level
restrictions (e.g. `"manage_interlocutors.list"` allows only the `list` action).
`run_plugin_tool` is controlled exclusively by `allowed_plugins`, not `allowed_tools`.
The main agent (id=1) always has `allowed_tools = '{*}'` and `allowed_plugins = '{*}'`.

### Context compaction
After every turn where `messages.length > 40`, a background task (non-blocking) runs
`complete()` with the compaction prompt to summarise the oldest messages. The summary is
stored in `compactions` and prepended as a synthetic user message on the next load.
A `compactionInProgress` boolean prevents concurrent compaction runs.

### Context truncation
`truncateContext()` trims the largest text blocks first (by character count) to fit
within 80% of the model's context window. Applied via `transformContext` callback on
every `Agent.prompt()` call.

---

## Built-in tools (src/agent.ts)

| Tool name | Always present | Conditional |
|---|---|---|
| `execute_sql` | ✓ | |
| `manage_knowledge` | ✓ | |
| `manage_cron` | ✓ | |
| `run_python` | ✓ | |
| `manage_pages` | ✓ | |
| `manage_uploads` | ✓ | |
| `db_search` | ✓ | |
| `manage_files` | ✓ | |
| `manage_interlocutors` | ✓ | |
| `manage_agents` | ✓ | |
| `send_agent_message` | ✓ | |
| `manage_plugins` | ✓ | |
| `run_plugin_tool` | ✓ | |
| `request_coding_task` | | `config.coder` present |
| `send_signal_message` | ✓ | |
| `send_telegram_message` | | `config.telegram` present |
| `send_whatsapp_message` | | `config.whatsapp` present |
| `send_email` | | `config.email.smtpHost` present |

All tools are wrapped by `wrapToolWithLogging()` which logs the tool name, truncated
params, and truncated result at `info` level.

### db_search tool (src/search.ts)
- Tool name: `db_search`.
- Searches all public tables with text-like columns via PostgreSQL full-text search
  (`to_tsvector` / `plainto_tsquery`). Excludes `messages` and `compactions` tables
  from the table scan.
- Searches `messages` separately with a JSONB-aware text extraction query.
- If `config.embeddings` is present (OpenAI API key), also runs a semantic vector
  search on `message_embeddings` and merges results via Reciprocal Rank Fusion (RRF,
  k=60).
- Default limit: 10 rows per table; max: 20.

---

## Plugin system

Plugins live in `/plugins/<name>/` (shared volume between `plugin-runner` and `coder`).

### Directory layout
```
/plugins/<name>/
  manifest.json          # bundle manifest (name, description, config schema, init)
  config.json            # runtime config + permissions array (written by plugin-runner)
  <tool-name>/
    manifest.json        # tool manifest (name, description, entrypoint, parameters, async?)
    <entrypoint>         # executable script (any language, run via shebang)
```

### Security isolation
- Each plugin gets a dedicated system user `plug_<name>` (UID/GID created by
  `plugin-runner` via `useradd --system`).
- The plugin directory is `chmod 700` and owned by that user, so plugins cannot read
  each other's files or `config.json`.
- Scripts are spawned with `spawn(entrypoint, [], { uid, gid })` — never as root.
- `config.json` is never returned to the LLM agent; only key presence/absence is
  reported. The `permissions` key in `config.json` is set via the web UI only.
- The Docker socket is never mounted into any container.

### Tool execution (sync)
- `plugin-runner` receives `POST /bundles/<plugin>/tools/<tool>/run` with JSON body.
- Parameters of type `"file"` are base64-decoded from the request and materialised into
  `/tmp/<plugin>/` before the script runs.
- The script receives all parameters as JSON on stdin.
- stdout is captured and returned as `{ success: true, output: … }`.
- Files written to `/tmp/<plugin>/` by the script are base64-encoded and returned in
  `{ files: [{ filename, data }] }`.
- Timeout: 30 seconds.

### Tool execution (async)
- Same as sync, but `plugin-runner` returns 202 and posts the result back via
  `postCallback()` when done.
- Timeout: 5 minutes.

### Permissions
- `config.json` contains a `permissions` array: `["*"]` = all tools, `[]` = disabled,
  explicit list = only those tools.
- Checked on every tool run (read fresh from disk, no restart needed).
- The LLM cannot modify permissions; the `configure` action strips the `permissions`
  key before forwarding to `plugin-runner`.
- Plugins with an empty `permissions` array are hidden from the agent entirely (treated
  as not found in both `manage_plugins show` and `run_plugin_tool`).

---

## Database schema (key tables)

| Table | Purpose |
|---|---|
| `messages` | Per-agent conversation history (role, content JSONB, sender_identity_id, sender_agent_id) |
| `memories` | Always-injected knowledge (short facts, full text in system prompt every turn) |
| `compactions` | Summarised history snapshots (up_to_message_id boundary) |
| `scratchpad` | On-demand knowledge (title injected, body fetched on read via manage_knowledge) |
| `cron_entries` | Scheduled entries (cron expression or one-shot fire_at) |
| `pages` | LLM-authored pages (path, mimetype, data BYTEA, is_public, queries JSONB, version INTEGER); append-only versioning — each update inserts a new row; empty `data` is a tombstone |
| `agents` | Subagent definitions (name, system_prompt, allowed_tools TEXT[], allowed_plugins TEXT[]) |
| `interlocutors` | Contact records (display_name, owner bool, enabled bool, agent_id FK) |
| `interlocutor_identities` | Per-channel identifiers (service, identifier; nullable for soft-delete) |
| `message_embeddings` | OpenAI vector embeddings for semantic search (vector(1536)) |

Schema is initialised at startup via `initializeSchema*` functions in `src/database.ts`.
Migrations are additive `ALTER TABLE … ADD COLUMN IF NOT EXISTS` statements.

---

## Authentication

- All endpoints require HTTP Basic Auth (password from `config.toml`).
- Public exceptions whitelisted in `isPublicRoute()` (`src/index.ts`):
  - `POST /telegram/webhook`
  - `POST /email/webhook`
  - `GET /pages/*` (per-row `is_public` check inside the handler)
  - `GET /api/pages/*/queries/*` (per-page `is_public` check inside the handler)
- `plugin-runner` and `coder` also enforce Basic Auth on all endpoints.
- Outbound callbacks from `plugin-runner` and `coder` to `app:3000/chat` use the same
  password, read from `config.toml` at startup.

---

## Allowlist (src/allowlist.ts)

- Stored in `allowlist.json` (path overridable via `ALLOWLIST_PATH` env var).
- Per-service arrays: `signal` (strings), `telegram` (numbers or `"*"`), `whatsapp`
  (strings), `email` (strings, supports `*` glob wildcard before `@`).
- Owner identities are auto-seeded into the allowlist from `config.toml` on startup.
- The allowlist is a **hard gate** in the queue: messages from senders not in the list
  are silently dropped before reaching the agent.
- A **soft gate** follows: the sender must also exist in `interlocutor_identities` for
  an enabled interlocutor with an assigned agent.
- Outbound send tools (`send_signal_message`, `send_telegram_message`, etc.) also check
  the allowlist before sending.

---

## Configuration

- Runtime config: `config.toml` (path overridable via `CONFIG_PATH` env var).
- Template: `config.example.toml`.
- Postgres connection: environment variables (`PGHOST`, `PGPORT`, `PGUSER`,
  `PGPASSWORD`, `PGDATABASE`).
- Log level: `STAVROBOT_LOG_LEVEL` env var (`error`/`warn`/`info`/`debug`; default `info`).
- Feature gates in `config.toml` (presence of section enables the feature):
  - `[coder]` — enables `request_coding_task` tool and `manage_plugins create` action.
  - `[telegram]` — enables Telegram webhook + `send_telegram_message` tool.
  - `[whatsapp]` — enables WhatsApp (Baileys) + `send_whatsapp_message` tool.
  - `[email]` with `smtpHost` — enables `send_email` tool and SMTP transport.
  - `[embeddings]` — enables OpenAI vector embeddings worker and semantic search in `db_search`.
  - `[signal]` — enables Signal bridge integration (separate Docker profile).

---

## Inbound message sources

| Source string | Origin |
|---|---|
| `undefined` | CLI (`client.py`) |
| `"signal"` | Signal bridge webhook |
| `"telegram"` | Telegram webhook |
| `"whatsapp"` | WhatsApp (Baileys) |
| `"email"` | Email webhook |
| `"cron"` | Scheduler |
| `"coder"` | Coder agent callback |
| `"plugin:<name>/<tool>"` | Async plugin tool callback |
| `"agent"` | Subagent-to-agent message |
| `"upload"` | File upload trigger |

Internal sources (`cli`, `cron`, `coder`, `plugin:*`, `upload`) always route to the
main agent. External sources (`signal`, `telegram`, `whatsapp`, `email`) go through
allowlist + interlocutor lookup to determine the target agent.

---

## Key source files

| File | Role |
|---|---|
| `src/index.ts` | HTTP server, routing, auth middleware, all endpoint handlers |
| `src/agent.ts` | Agent setup, all built-in tool definitions, `handlePrompt`, compaction, truncation |
| `src/queue.ts` | Single-threaded message queue, routing, steering logic, retry |
| `src/database.ts` | All SQL queries, schema init, migrations |
| `src/config.ts` | Config loading and validation; loads prompt files |
| `src/search.ts` | `db_search` tool: full-text + optional semantic search with RRF merge |
| `src/plugin-tools.ts` | `manage_plugins`, `run_plugin_tool`, `request_coding_task` tools |
| `src/allowlist.ts` | Allowlist load/save/check; email glob matching |
| `src/scheduler.ts` | Cron scheduler |
| `src/embeddings.ts` | OpenAI embeddings worker (background polling loop) |
| `src/log.ts` | Levelled logger (`log.info`, `log.debug`, etc.) controlled by `STAVROBOT_LOG_LEVEL` |
| `prompts/system-prompt.txt` | Base system prompt for the main agent |
| `prompts/agent-prompt.txt` | Base system prompt for subagents |
| `prompts/compaction-prompt.txt` | Prompt used by the background compaction summariser |
| `plugin-runner/src/index.ts` | Plugin HTTP server (all logic in one file) |
| `coder/server.py` | Coder HTTP server, `claude -p` subprocess management |

---

## Coder subsystem

The `coder` container wraps the `claude` headless CLI binary. It:
1. Receives `POST /code { taskId, plugin, message }`.
2. Looks up the plugin directory's UID/GID from the filesystem.
3. Creates a matching Unix user in the coder container.
4. Copies `.credentials.json` into the plugin directory (owned by the plugin user).
5. Runs `claude -p <message> --output-format json --dangerously-skip-permissions` as
   the plugin user with `HOME` set to the plugin directory.
6. Copies refreshed credentials back and cleans up.
7. Posts the result to `app:3000/chat` with `source: "coder"`.

The LLM process cannot read `config.toml` because the entrypoint (running as root)
extracts only the needed values before exec-ing the server.
