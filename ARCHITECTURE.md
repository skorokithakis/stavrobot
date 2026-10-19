# Architecture

Stavrobot is a single-user LLM-powered assistant (Anthropic Claude by default) exposed
as an HTTP server. It wraps the `@earendil-works/pi-agent-core` Agent class, persists
conversation history in PostgreSQL, and extends the agent with a plugin system that runs
arbitrary scripts in isolated Unix user accounts.

---

## Containers (docker-compose.yml)

| Service | Image / Build | Port | Role |
|---|---|---|---|
| `postgres` | `pgvector/pgvector:pg17` | internal | Primary database (with pgvector extension) |
| `app` | `./Dockerfile` | 10567→3000 | Main HTTP server + LLM agent |
| `plugin-runner` | `./plugin-runner` | internal:3003 | Executes plugin scripts |
| `coder` | `./coder` | internal:3002 | Runs `claude -p` for plugin authoring (optional, `coder` profile) |
| `python-runner` | `./python-runner` | internal | Executes Python snippets |
| `pg-backup` | `pgvector/pgvector:pg17` | — | Hourly pg_dump to `./data/db-backups` |
| `signal-bridge` | `./signal-bridge` | internal:8081 | Signal protocol bridge (optional profile) |

The app mounts `./data/main` read-write at `/app/config` so its configuration editor can
update `config.toml`. `plugin-runner`, `coder`, `signal-bridge`, and `python-runner`
mount it read-only and load it only when they start. The `plugin-runner` and `coder`
containers share `./data/plugins` and `./cache/plugins`.

---

## Message flow

```
External caller (Telegram / Signal / WhatsApp / email / Pebble Index / CLI)
  → POST /chat  (or webhook endpoint)
  → request handler  (src/index.ts)
  → enqueueMessage  (src/queue.ts)
  → processQueue  (single-threaded, serialises all turns)
  → resolveTargetAgent  (allowlist + interlocutor lookup)
  → handlePrompt  (src/agent/index.ts)
  → Agent.prompt  (@earendil-works/pi-agent-core)
  → tool callbacks (execute_sql, manage_plugins, run_plugin_tool, …)
  → response string returned to synchronous callers
```

Webhook handlers acknowledge the request before their queued message is processed.

`POST /chat` also accepts an optional boolean `async` field. With `async: true`, the
handler validates the request and submits it through `enqueueMessage` once, then returns
`202 {"accepted":true}` without awaiting the turn. When the field is omitted or `false`,
the caller waits for the normal response string. The async path does not bypass the
queue, so its serialization, routing, `/stop`, and owner-steering behavior remain the
same. A present non-boolean `async` value is rejected before raw file attachments are
written.

`POST /chat` also accepts two optional fields that channels may supply:
`participant` (`{ id, name }`, the individual who sent a group message) and
`senderLabel` (a human-readable platform label for the sender). Malformed values are
ignored. The participant is threaded through the queue into `formatUserMessage`, which
adds a `Participant: <name> (<id>)` line between Sender and Text and appends ` [owner]`
when the participant id matches an owner identity. `senderLabel` is used only to annotate
rejected senders in the buffer below; it never overrides the Sender line, which is the
owner-controlled interlocutor display name.

Group messages are routed by the group's channel ID, carried in `sender`: a Telegram group
uses its negative chat ID and a Signal group uses its group ID. The allowlist and the
interlocutor lookup match against that ID, so a group is a first-class interlocutor rather
than a collection of its members. The `Participant` line names the individual member who
sent the message within the group.

Owner messages arriving while a turn is in progress are **steered** into the running
turn via `Agent.steer()` rather than queued. Non-owner messages are always queued.

The queue is a plain in-memory array (`queue: QueueEntry[]`) with a single `processing`
boolean flag. It is strictly single-threaded — only one `handlePrompt` call runs at a
time. `handlePrompt` additionally enforces this with a module-level `handlePromptInProgress`
flag that throws if re-entered, turning any future queue re-entrancy bug into a loud
failure instead of silent state corruption.

Retries: up to 3 attempts with a 30-second delay between them. A turn that fails *before*
any message beyond the initial user row is persisted is retried normally. A turn that
fails *after* the subscribe callback has persisted an assistant or toolResult message
throws `TurnProgressPersistedError` from `handlePrompt`; the queue treats this as
terminal (no retry) because reloading the persisted messages would replay every tool
side effect that already ran (duplicate outbound messages, duplicate external calls).
The same applies to other non-retryable failures: `AbortError`, `AuthError`, and
HTTP 400/401 provider errors bypass the retry loop and resolve with a user-facing
message. Only 400 and 401 are special-cased; other 4xx errors (e.g. 429 rate
limits, 403 forbidden) follow the normal retry path.

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

Each callback path (`postCallback` in the plugin-runner, `post_result` in the coder)
retries the POST with growing backoff (5s, 15s, 30s, 60s, 120s between attempts) on
network errors and non-2xx responses, so a brief app restart does not silently lose an
async result. There is no persistent outbox: if every retry fails, the result is logged
as an error and discarded.

---

## Agent setup (src/agent/index.ts)

The single `Agent` instance is created in `createAgent()` and shared across all
conversations. Per-turn, `handlePrompt()` swaps the conversation history and system
prompt by assigning `agent.state.messages` directly, with the rebuilt system prompt as
the leading `system` message. Since Pi 0.86 the transcript owns the prompt and
`agent.state.systemPrompt` is read-only. System messages are never persisted to the
`messages` table; only user, assistant, and toolResult rows are saved.

### Main agent identity

The main agent is seeded at startup by `seedOwner()` in `src/database.ts` with a fixed
`INSERT … VALUES (1, 'main', '', '{*}', '{*}') ON CONFLICT (id) DO UPDATE …`. Its
database ID is always `1` — this is an invariant of the seed INSERT and must not change.
After seeding, the ID is cached in a module-level variable and exposed via
`getMainAgentId()` (also in `src/database.ts`). All routing, permission checks, and
user-facing strings use `getMainAgentId()` rather than the literal `1`. The only place
the literal `1` appears is the seed INSERT itself (`src/database.ts`).

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
After every turn whose history exceeds the compaction threshold (60% of the effective
context budget), a background task (non-blocking) runs `escalatingSummarize()` on the
oldest messages. The summarizer input is first truncated to the compaction threshold, so
an oversized summary from a previous run cannot grow the compaction row. The summarizer
tries the compaction prompt; if the result is empty or not shorter than the input it
retries with a bullet-point prompt, and if that also fails it falls back to deterministic
truncation capped at 10% of the effective context, keeping the newest material. The summary
is stored in `compactions` and prepended as a synthetic user message on the next load.
Each save inserts the new row and deletes that agent's older rows in the same transaction,
so only the latest compaction per agent is kept. A `compactionInProgress` boolean prevents
concurrent compaction runs.

### Context truncation
`truncateContext()` trims the largest text blocks first (by character count) to fit
within 80% of the model's context window. Applied via `transformContext` callback on
every `Agent.prompt()` call.

---

## Built-in tools (src/agent/index.ts)

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

/plugins/.git-installed/<name>   # empty marker file; presence means git-installed (non-editable)
```

### Git-installed vs editable plugins
- A plugin is **editable** unless `plugin-runner` installed it from git. The coder
  edits editable plugins, so this flag determines whether `manage_plugins update` and
  the coder may operate on a plugin.
- Editability is recorded by a marker file at `/plugins/.git-installed/<name>` (the
  directory is root-owned and not writable by plugin users). `isEditable(name)` is
  simply "marker does not exist" — the old check for a `.git` directory was wrong,
  because the coder may run `git init` in an editable plugin.
- `install` writes the marker once the clone is moved into place and removes it again
  if a later install step fails and the plugin directory is removed, so the marker
  only exists while its plugin does. `remove` deletes the marker (force, since editable
  plugins have none).
- On startup, if `/plugins/.git-installed/` does not exist it is created and a marker
  is written for every plugin directory that currently has a `.git` directory (one-time
  migration for plugins installed before markers existed). Markers are staged in a
  temporary dot-prefixed directory that is renamed into place once the scan completes,
  so a crash cannot leave a partial marker directory behind. If the directory already
  exists, startup does nothing, so a later `git init` does not reclassify a plugin.
- Directory scans (`loadBundles`, `migrateExistingPlugins`) skip all dot-prefixed
  entries (`.git-installed`, its temp directory, `.tmp-install-*`); valid plugin names
  never start with a dot.

### Security isolation
- Each plugin gets a dedicated system user `plug_<name>` (UID/GID created by
  `plugin-runner` via `useradd --system`).
- The plugin directory is `chmod 700` and owned by that user, so plugins cannot read
  each other's files or `config.json`.
- Scripts are spawned with `spawn(entrypoint, [], { uid, gid })` — never as root.
- `config.json` is never returned to the LLM agent; only key presence/absence is
  reported. The `permissions` key in `config.json` is set via the web UI only.
- The app's plugin config proxy (`GET /api/settings/plugins/<name>/config`) likewise
  never returns config values to the browser: it rewrites the plugin-runner response to
  `{ schema, set }`, where `schema` holds only each key's description/required flag
  (manifest defaults are stripped) and `set` is a boolean per key. Saving still goes
  through `POST /configure`, which accepts values and merges them server-side.
- The Docker socket is never mounted into any container.

### Tool execution (sync)
- `plugin-runner` receives `POST /bundles/<plugin>/tools/<tool>/run` with JSON body.
- `run_plugin_tool` accepts either a single parameter object or a JSON array of them.
  An array runs the tool once per item, sequentially, and returns one result with each
  call numbered (1-based). A failed call does not stop the rest of the batch.
  File-type parameters are resolved per item. Arrays are rejected for async tools; empty
  arrays return an error.
- Each run gets a fresh `/tmp/stavrobot-run-<uuid>/` directory, owned by the plugin
  user and mode 700, so overlapping runs of the same plugin cannot interfere.
- Parameters of type `"file"` are base64-decoded from the request and materialised into
  that run directory before the script runs. Its path is passed to the script as
  `STAVROBOT_TEMP_DIR`.
- The script receives all parameters as JSON on stdin.
- stdout is captured and returned as `{ success: true, output: … }`.
- Files written to the run directory by the script are base64-encoded and returned in
  `{ files: [{ filename, data }] }`.
- The run directory is deleted after the run, including on every early-return and error
  path. Leftover `/tmp/stavrobot-run-*` directories from a crashed process are removed
  at plugin-runner startup.
- Older runner versions used a shared `/tmp/<plugin>/` directory. After each run, if
  that legacy directory contains files, the runner logs a warning and deletes it
  without transporting those files.
- On the main app side, files returned by a run are written to a fresh
  `/tmp/stavrobot-temp/output-<uuid>/` directory (one per call; in a batch, one per item,
  and only when the call returned files). Nothing is cleared at call start, so files from
  earlier calls stay usable and parallel calls cannot delete each other's files. `run_python`
  uses the same scheme. The scheduler deletes `output-*` directories (recursively), and
  `upload-*` files, older than 3 days.
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
| `compactions` | Summarised history snapshots (up_to_message_id boundary); only the latest row per agent is retained |
| `scratchpad` | On-demand knowledge (title injected, body fetched on read via manage_knowledge) |
| `cron_entries` | Scheduled entries (cron expression or one-shot fire_at) |
| `pages` | LLM-authored pages (path, mimetype, data BYTEA, is_public, queries JSONB, mutations JSONB, version INTEGER); append-only versioning — each update inserts a new row; empty `data` is a tombstone |
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
  - `POST /email/webhook`
  - `GET /pages/*` (per-row `is_public` check inside the handler)
  - `GET /api/pages/*/queries/*` (per-page `is_public` check inside the handler)
- `POST /api/pages/*/mutations/*` is deliberately not public. It always requires Basic
  Auth, regardless of the page's `is_public` flag, and also requires a JSON content type
  as CSRF protection.
- `POST /pebble-index/webhook` requires Basic Auth. It accepts a multipart Pebble Index
  ring recording and queues it directly for the main agent.
- `plugin-runner` and `coder` also enforce Basic Auth on all endpoints.
- Outbound callbacks from `plugin-runner` and `coder` to `app:3000/chat` use the same
  password, read from `config.toml` at startup.

## Web UI

- `GET /settings/config` serves the configuration editor. It loads the raw file through
  `GET /api/settings/config`, which returns `{ content }` from `CONFIG_PATH`.
- `PUT /api/settings/config` accepts `{ content: string }`, validates it with
  `parseConfig`, copies the current file to `<CONFIG_PATH>.bak`, and writes the raw
  submitted content. It responds before exiting after 500ms; Docker Compose restarts the
  app through its `restart: unless-stopped` policy.
- Saving interrupts any in-progress agent turn. `plugin-runner`, `coder`,
  `signal-bridge`, and `python-runner` do not reload `config.toml`, so changes affecting
  them require manually restarting those containers.

The configuration editor endpoints use the default Basic Auth policy and are never
public.

### Pages

- `GET /` is the Overview (chat) page. `GET /settings` is the Settings screen, which
  links to Config, provider login, and the Signal captcha; the desktop sidebar reaches
  the same destinations directly.
- `GET /settings/allowlist`, `GET /settings/plugins`, `GET /settings/config`,
  `GET /login`, `GET /explorer`, and `GET /signal/captcha` serve the remaining pages.
  `GET /plugins` redirects to `/settings/plugins`.
- Every page renders its content into the shared shell, except `/login` and
  `/signal/captcha`, which use the centered no-nav variant.
- The database explorer reads the schema from `GET /api/explorer/tables/<table>`, where
  each column carries `name`, `type`, `nullable`, and `primaryKey`.

### Shared UI assets and shell

- `GET /assets/sb.css` serves the shared admin stylesheet (kept as the TypeScript string
  module `src/sb-css.ts`, adapted from `design/sb.css`). Light is the default; dark is
  applied via `prefers-color-scheme`.
- `GET /assets/fonts/<file>.woff2` serves the self-hosted IBM Plex Sans (400/500/600) and
  IBM Plex Mono (400/500) latin subsets. The files are read from the `@fontsource`
  packages at startup; only a fixed allow-list of filenames is served.
- Both asset routes require Basic Auth (they are not in `isPublicRoute`), and the CSP
  includes `font-src 'self'`.
- `src/shell.ts` renders the shared page chrome: desktop sidebar with nav and an
  online/model/uptime footer, a mobile header and a five-tab bottom bar, or a centered
  card for no-nav pages (login, captcha). Pages render their own content into it.
- `src/uptime.ts` owns the process start time and uptime formatting so every page shell
  can display it.

---

## Allowlist (src/allowlist.ts)

- Stored in `allowlist.json` (path overridable via `ALLOWLIST_PATH` env var).
- Per-service arrays: `signal` (strings; E.164 phone numbers, UUIDs, or group IDs),
  `telegram` (numbers or `"*"`), `whatsapp` (strings), `email` (strings, supports `*`
  glob wildcard before `@`).
- Owner identities are auto-seeded into the allowlist from `config.toml` on startup.
- The allowlist is a **hard gate**: messages from senders not in the list are dropped
  before reaching the agent. The channel handlers for Telegram, email, and WhatsApp
  check the allowlist themselves and return before enqueuing, so they call
  `recordRejectedSender` at that early gate; the queue calls it for external sources
  that do not pre-check (the Signal bridge posts straight to `/chat`). Each rejection is
  therefore counted exactly once.
- Senders dropped by the hard gate are kept in an in-memory `recordRejectedSender` /
  `getRejectedSenders` buffer (last 50, newest first, deduplicated by
  `service` + `identifier`, each with `label`, `lastSeen`, and `count`). Soft-gate drops
  (unknown interlocutor) are not recorded. `GET /api/settings/allowlist` returns the
  buffer as `rejected`, and the settings page lists it under "Recently rejected" with an
  Add button that inserts the identifier into the matching allowlist. The buffer is
  in-memory only and is cleared on restart.
- A **soft gate** follows: the sender must also exist in `interlocutor_identities` for
  an enabled interlocutor with an assigned agent.
- Outbound send tools (`send_signal_message`, `send_telegram_message`, etc.) also check
  the allowlist before sending.

---

## LLM provider configuration

The provider and model are set at the top level of `config.toml`:

```toml
provider = "anthropic"          # any KnownProvider string from pi-ai
model    = "claude-opus-5-5"
```

`getBuiltinModel(provider, model)` from `@earendil-works/pi-ai/providers/all` looks up
the model in a static registry (`models.generated.js`). The registry maps `(provider,
modelId)` to a `Model` object that carries `api`, `baseUrl`, `contextWindow`,
`maxTokens`, and optional `compat` overrides.

### Supported providers (from pi-ai `KnownProvider` type)

`amazon-bedrock`, `ant-ling`, `anthropic`, `google`, `google-vertex`, `openai`,
`azure-openai-responses`, `openai-codex`, `radius`, `nvidia`, `deepseek`,
`github-copilot`, `xai`, `groq`, `cerebras`, `openrouter`, `vercel-ai-gateway`,
`zai`, `zai-coding-cn`, `mistral`, `minimax`, `minimax-cn`, `moonshotai`,
`moonshotai-cn`, `huggingface`, `fireworks`, `together`, `baseten`, `opencode`,
`opencode-go`, `kimi-coding`, `cloudflare-workers-ai`, `cloudflare-ai-gateway`,
`qwen-token-plan`, `qwen-token-plan-cn`, `qwen-token-plan-individual`, `xiaomi`,
`xiaomi-token-plan-cn`, `xiaomi-token-plan-ams`, `xiaomi-token-plan-sgp`.

### API backends (from pi-ai `KnownApi` type)

| API string |
|---|
| `openai-completions` |
| `mistral-conversations` |
| `openai-responses` |
| `azure-openai-responses` |
| `openai-codex-responses` |
| `anthropic-messages` |
| `bedrock-converse-stream` |
| `google-generative-ai` |
| `google-vertex` |
| `pi-messages` |

### Authentication

Exactly one of these must be set in `config.toml`:
- `apiKey = "..."` — static API key, passed directly to the provider.
- `authFile = "/path/to/auth.json"` — OAuth credentials file (for Claude Pro/Max
  subscriptions). `src/auth.ts` locates the provider with `builtinProviders()` from
  `@earendil-works/pi-ai/providers/all` and uses its `auth.oauth` implementation.
  Existing untagged OAuth records are normalized in memory; an expired credential is
  refreshed with `oauth.refresh(credential, AbortSignal.timeout(30_000))` and written
  back with its `"oauth"` type tag. `oauth.toAuth(credential)` derives the API key.

When the library's `oauth.login()` asks which login method to use (a `select` prompt),
`src/login.ts` prefers the headless methods in the order `copy_code`, `device_code`,
`device-code`, then `browser`, falling back to the first option. The browser flow's
loopback callback port (53692) is never reachable from the user's browser, so the
copy-code and device-code flows are the only usable ones. With Anthropic's `copy_code`,
the provider shows a code after authorization that the user pastes into the Stavrobot
login page. Device-code flows go the other way: Stavrobot shows the code and the user
enters it on the provider's site.

The `getApiKey(config)` function in `src/auth.ts` resolves whichever is configured and
returns a plain string. The `Agent` receives it through `getApiKey: () => getApiKey(config)`
and explicitly uses `streamFn: streamSimple` from `@earendil-works/pi-ai/compat`, which
forwards the key to the provider stream function as `options.apiKey`.

### OpenAI-compatible endpoints

Any provider whose models use `api: "openai-completions"` is handled by
`streamOpenAICompletions` in pi-ai. The OpenAI SDK client is constructed with
`baseURL: model.baseUrl`, so pointing `baseUrl` at a custom endpoint (LiteLLM, Ollama,
vLLM, etc.) is sufficient. Compatibility quirks (whether to send `store`, `developer`
role, `reasoning_effort`, `max_tokens` vs `max_completion_tokens`, etc.) are
auto-detected from the `baseUrl` or can be overridden via `model.compat`.

When `baseUrl` is set in `config.toml`, `src/agent/index.ts` constructs a `Model` object
manually instead of calling `getModel()`. `contextWindow` and `maxTokens` are required.
`api` defaults to `"openai-completions"` if omitted; the only accepted values are
`"openai-completions"` and `"anthropic-messages"`. `authFile` is forbidden (only `apiKey`
is supported with a custom endpoint). `reasoning` is opt-in and defaults to false; when set
to true it sets `reasoning: true` on the constructed `Model`, so Pi sends `thinkingLevel`
to the endpoint (as `reasoning_effort` for `openai-completions`). It is ignored when
`baseUrl` is not set.

---

## Configuration

- Runtime config: `config.toml` (path overridable via `CONFIG_PATH` env var).
- Template: `config.example.toml`.
- Postgres connection: environment variables (`PGHOST`, `PGPORT`, `PGUSER`,
  `PGPASSWORD`, `PGDATABASE`).
- Log level: `STAVROBOT_LOG_LEVEL` env var (`error`/`warn`/`info`/`debug`; default `info`).
- Feature gates in `config.toml` (presence of section enables the feature):
  - `[coder]` — enables `request_coding_task` tool and `manage_plugins create` action (also requires the `coder` Docker Compose profile).
  - `[telegram]` — enables Telegram long polling + `send_telegram_message` tool.
  - `[whatsapp]` — enables WhatsApp (Baileys) + `send_whatsapp_message` tool.
  - `[email]` with `smtpHost` — enables `send_email` tool and SMTP transport.
  - `[embeddings]` — enables OpenAI vector embeddings worker and semantic search in `db_search`.
  - `[signal]` — enables Signal bridge integration (separate Docker profile).

---

## Inbound message sources

| Source string | Origin |
|---|---|
| `undefined` | Direct HTTP call (no source header) |
| `"signal"` | Signal bridge |
| `"telegram"` | Telegram long polling |
| `"whatsapp"` | WhatsApp (Baileys) |
| `"email"` | Email webhook |
| `"pebble-index"` | Pebble Index ring webhook |
| `"cron"` | Scheduler |
| `"coder"` | Coder agent callback |
| `"plugin:<name>/<tool>"` | Async plugin tool callback |
| `"agent"` | Subagent-to-agent message |
| `"upload"` | File upload trigger |

Internal sources (`cli`, `cron`, `coder`, `plugin:*`, `upload`) always route to the
main agent. External sources (`signal`, `telegram`, `whatsapp`, `email`) go through
allowlist + interlocutor lookup to determine the target agent. The Basic-authenticated
`pebble-index` source routes directly to the main agent without those gates.

---

## Signal bridge (signal-bridge/bridge.py)

The `signal-bridge` container runs `signal-cli` in JSON-RPC daemon mode. It exposes an
HTTP server on port 8081 (the app calls it to send) and, for each inbound message, POSTs
to `app:3000/chat` with `source: "signal"` (it never replies on Signal directly).

Inbound: the bridge extracts text and attachments from each signal-cli envelope. A
message that carries `groupInfo` is routed by the group ID, with `participant` set to the
individual sender (`{ id, name }`) and `senderLabel` set to the group name. Outside a
group, the sender is the individual's phone number or, when no phone number is present
(e.g. phone number privacy is enabled), their UUID; `senderLabel` is the profile name.
Messages with neither text nor attachments are skipped.

Outbound: `POST /send` accepts `{ recipient, message?, attachment?, attachmentFilename? }`.
A recipient that is an E.164 phone number (`+` followed by digits) or a UUID is addressed
with signal-cli's `recipient` list; anything else is treated as a base64 group ID and
addressed with the `groupId` parameter. `POST /challenge` supplies a captcha token when
Signal rate-limits the account.

---

## Key source files

| File | Role |
|---|---|
| `src/index.ts` | HTTP server, routing, auth middleware, all endpoint handlers |
| `src/pebble-index.ts` | Pebble Index multipart ring webhook handler |
| `src/agent/index.ts` | Agent setup, all built-in tool definitions, `handlePrompt`, compaction, truncation |
| `src/queue.ts` | Single-threaded message queue, routing, steering logic, retry |
| `src/database.ts` | All SQL queries, schema init, migrations |
| `src/config.ts` | Config loading and validation; loads prompt files |
| `src/search.ts` | `db_search` tool: full-text + optional semantic search with RRF merge |
| `src/plugin-tools.ts` | `manage_plugins`, `run_plugin_tool`, `request_coding_task` tools |
| `src/allowlist.ts` | Allowlist load/save/check; email glob matching |
| `src/scheduler.ts` | Cron scheduler |
| `src/embeddings.ts` | OpenAI embeddings worker (background polling loop) |
| `src/log.ts` | Levelled logger (`log.info`, `log.debug`, etc.) controlled by `STAVROBOT_LOG_LEVEL` |
| `src/assets.ts` | Shared stylesheet and self-hosted font HTTP handlers |
| `src/sb-css.ts` | Shared admin stylesheet as a TypeScript string, adapted from `design/sb.css` |
| `src/shell.ts` | Shared page shell (sidebar, mobile header and tab bar, centered no-nav layout) |
| `src/uptime.ts` | Process start time and uptime formatting |
| `prompts/system-prompt.txt` | Base system prompt for the main agent |
| `prompts/agent-prompt.txt` | Base system prompt for subagents |
| `prompts/compaction-prompt.txt` | Prompt used by the background compaction summariser |
| `plugin-runner/src/index.ts` | Plugin HTTP server (all logic in one file) |
| `coder/server.py` | Coder HTTP server, `claude -p` subprocess management |
| `signal-bridge/bridge.py` | Signal bridge: signal-cli event handling, `/send`, `/challenge` |

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

Authentication is selected from the `[coder]` section only. With no `[coder].apiKey`/`[coder].baseUrl` the coder uses the subscription OAuth credentials described above. When both are set, it passes them to `claude` as `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL` and skips the credentials copy. Setting only one of the two is a startup error, and the top-level `apiKey`/`baseUrl` never affect the coder.

A background thread runs `claude update` as the coder user (uid/gid 9999) at startup
and every 24 hours, keeping the CLI current; the native installer swaps versions
atomically, so in-flight tasks are unaffected.

The LLM process cannot read `config.toml` because the entrypoint (running as root)
extracts only the needed values before exec-ing the server.
