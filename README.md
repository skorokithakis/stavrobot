# Stavrobot

![](misc/stavrobot.jpg)

A personal AI assistant with persistent memory, sandboxed code execution, and Signal integration.

## Features

- **Signal integration.** Two-way messaging via signal-cli, including voice note transcription (OpenAI STT).
- **Two-tier memory.** Tier 1: a self-managed memory store injected into the system prompt every turn (the agent decides what to remember). Tier 2: full read/write access to a PostgreSQL database via unrestricted SQL — the agent can create tables, query, and store anything.
- **Self-programming.** The agent can request a secondary coding agent to create new tools at runtime. Tools are executable scripts with a JSON manifest, discovered and invoked by the main agent.
- **Security.** Python runs as an unprivileged `pythonrunner` user with a stripped environment and a 30-second timeout. Custom tools run as `toolrunner` with the same restrictions. `config.toml` is `chmod 600` so sandboxed processes can't read secrets. A Signal allowlist restricts which phone numbers can interact with the agent.
- **Sandboxed Python execution.** Arbitrary Python with pip dependencies via `uv`, isolated from the host environment.
- **Cron scheduling.** The agent can schedule its own recurring or one-shot reminders.
- **Conversation compaction.** Auto-summarizes long conversation histories to stay within context limits.
- **Web search and fetch.** Optional tools for searching the web and fetching/analyzing URLs via sub-agent LLM calls.

## Architecture

Four Docker containers: `app` (TypeScript server, exposes `POST /chat` on port 3000), `postgres` (PostgreSQL 17 for persistent state), `signal-bridge` (Python daemon bridging Signal via signal-cli to the app), and `coder` (secondary LLM agent that creates custom tools on request).

## Setup

### Config

1. Copy `config.example.toml` to `data/main/config.toml`.
2. Fill in API keys and settings. The example file has comments explaining each section.
3. At minimum, set `apiKey` (or `authFile`) and the `[postgres]` section. Everything else is optional.

### Pi auth file (OAuth alternative to API key)

For Claude Pro/Max subscriptions, you can use OAuth instead of an API key:

1. Start the containers: `docker compose up --build`
2. Exec into the coder container: `docker compose exec coder sh`
3. Run `npx @mariozechner/pi-coding-agent`, then use the `/login` command and choose "Anthropic".
4. This generates an `auth.json` file. Set `authFile` in your config to point to it instead of `apiKey`.

### Signal setup

1. Start the containers: `docker compose up --build`
2. Exec into the signal-bridge container: `docker compose exec signal-bridge bash`
3. Register: `signal-cli -u +YOUR_NUMBER register`
4. Verify with the code you receive: `signal-cli -u +YOUR_NUMBER verify CODE`
5. Set `[signal].account` and `[signal].allowedNumbers` in your config.
6. See the [signal-cli quickstart](https://github.com/AsamK/signal-cli/wiki/Quickstart) for details.

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
