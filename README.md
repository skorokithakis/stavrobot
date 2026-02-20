# Stavrobot

![](misc/stavrobot.jpg)

A personal AI assistant with persistent memory, sandboxed code execution, and Signal and Telegram integration.

## Features

- **Signal integration.** Two-way messaging via signal-cli, including voice note transcription (OpenAI STT).
- **Telegram integration.** Two-way messaging via a Telegram bot webhook, including voice note transcription (OpenAI STT).
- **Two-tier memory.** Tier 1: a self-managed memory store injected into the system prompt every turn (the agent decides what to remember). Tier 2: full read/write access to a PostgreSQL database via unrestricted SQL — the agent can create tables, query, and store anything.
- **Self-programming.** The agent can request a secondary coding agent to create new tools at runtime. Tools are executable scripts with a JSON manifest, discovered and invoked by the main agent.
- **Security.** The bot runs in isolated containers with no access to the host system. Code execution is sandboxed with timeouts and no access to secrets. Signal and Telegram allowlists restrict who can interact with the agent.
- **Sandboxed Python execution.** Arbitrary Python with pip dependencies via `uv`, isolated from the host environment.
- **Cron scheduling.** The agent can schedule its own recurring or one-shot reminders.
- **Conversation compaction.** Auto-summarizes long conversation histories to stay within context limits.
- **Web search and fetch.** Optional tools for searching the web and fetching/analyzing URLs via sub-agent LLM calls.
- **Database explorer.** A web UI at `/explorer` for browsing PostgreSQL tables, viewing schemas, and paginating through rows.
- **Pages.** The agent can create web pages. Pages are private (auth-required) by default, with an option to make individual pages public. Pages can query the database for dynamic content.

## Architecture

Five Docker containers: `app` (TypeScript server, exposes `POST /chat` on port 3000 and handles Telegram webhooks at `POST /telegram/webhook`), `postgres` (PostgreSQL 17 for persistent state), `signal-bridge` (Python daemon bridging Signal via signal-cli to the app), `tool-runner` (Node.js tool runner — lists, inspects, and executes custom tools), and `coder` (Claude Code headless agent for creating custom tools).

## Setup

### Config

1. Copy `config.example.toml` to `data/main/config.toml`.
2. Fill in API keys and settings. The example file has comments explaining each section.
3. At minimum, set `authFile` (or `apiKey`) and `publicHostname`. Everything else is optional.
4. Copy `env.example` to `.env` and set your timezone (`TZ`). Postgres credentials and other environment settings can also be overridden there. The defaults work out of the box with docker-compose.

### Claude Code setup

The `coder` container uses Claude Code with subscription auth (OAuth), separate from the main app's API key.

1. Start the containers: `docker compose up --build`
2. Log in: `docker compose exec -u coder coder claude` (it will prompt you to log in if you haven't).
3. Follow the browser-based OAuth flow.
4. Set `[coder].model` in your config to a Claude Code model alias (`sonnet`, `opus`, or `haiku`).

### Signal setup

1. Start the containers: `docker compose up --build`
2. Exec into the signal-bridge container: `docker compose exec signal-bridge bash`
3. Register: `signal-cli -u +YOUR_NUMBER register`
4. Verify with the code you receive: `signal-cli -u +YOUR_NUMBER verify CODE`
5. Set `[signal].account` and `[signal].allowedNumbers` in your config.
6. See the [signal-cli quickstart](https://github.com/AsamK/signal-cli/wiki/Quickstart) for details.

### Telegram setup

1. Message @BotFather on Telegram, create a new bot, and copy the token.
2. Message @userinfobot on Telegram to get your chat ID.
3. Set `[telegram].botToken`, `[telegram].webhookHost`, and `[telegram].allowedChatIds` in your config.
4. The webhook is registered automatically when the app starts.

### Running

```bash
docker compose up --build
```

The API is available at `http://localhost:10567/chat`. A Python CLI client (`client.py`) is included for interactive use.

### Without Docker

Requires Node.js >= 20 and a running PostgreSQL instance.

```bash
npm install && npm run build && npm start
```

Note: Python execution and Signal integration only work inside the Docker containers.

## License

[AGPL-3.0](LICENSE)
