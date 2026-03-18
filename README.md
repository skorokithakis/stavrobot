# Stavrobot

![](misc/stavrobot.jpg)

Stavrobot is a personal AI assistant built with the principle of "all the access an AI assistant needs, and no more".

It has all the nice features of an AI assistant, but focuses on sandboxing, isolation, and minimal permissions. It's light and is deployed with only a `docker compose up`.

## Features

- **Secure.** Everything runs in a container, your host OS is completely invisible to the AI. The AI doesn't see any secrets unless you want it to.
- **Light.** Doesn't run one container per component. Plugins all run in a single container, separated by Unix permissions.
- **Use any model you want.** Local, OpenRouter, Anthropic/OpenAI. Whatever [Pi](https://pi.dev) supports, the bot can use.
- **Signal/Telegram/WhatsApp/Email integration.** Two-way messaging, with formatting, attachments, etc.
- **Three-tier knowledge.** Remembers everything without blowing out its context.  Intelligently and transparently retrieves data from its memory.
- **Low token usage.** Various optimizations have been made to be light on token usage. It even uses [TOON](https://github.com/toon-format/toon) internally.
- **Plugins.** Install plugins and extend Stavrobot's capabilities by just giving it a git repo URL. Plugins are isolated from each other — each runs as a dedicated system user with no access to other plugins' files or configuration.
- **Subagents.** The main agent can create subagents with their own conversation context, system prompt, and restricted tool access. Useful for talking to outside people to complete tasks or arrange things, while having a buffer between the outside person and the main agent.
- **Self-programming.** The agent can program and extend itself.
- **Sandboxed Python execution.** Arbitrary Python with pip dependencies via `uv`, isolated from the host environment.
- **Scheduling.** The agent can schedule its own recurring or one-shot tasks.

## Setup

### Config

1. Copy `config.example.toml` to `data/main/config.toml`.
2. Fill in API keys and settings. The example file has comments explaining each section.
3. At minimum, set `authFile` (or `apiKey`) and `publicHostname`. Everything else is optional.
4. Copy `env.example` to `.env` and set your timezone (`TZ`). Postgres credentials and other environment settings can also be overridden there. The defaults work out of the box with docker-compose.

### Authentication

The app supports two authentication modes: API key or OAuth.

- **API key:** Set `apiKey` in `config.toml`. No login or logout needed.
- **OAuth:** Set `authFile` in `config.toml` (a path where credentials will be stored). The login page below is for Anthropic; Pi supports other OAuth providers as well.
  - **Login:** Visit `<your-hostname>/providers/anthropic/login` in a browser. Follow the OAuth flow, paste the callback code, and credentials are saved to the auth file. If auth expires while the bot is running, it sends a message with the login URL to you via your messaging platform.
  - **Logout:** Delete the file at the `authFile` path. The bot will detect missing credentials on the next message and prompt you to log in again.

### Claude Code setup

The `coder` container uses Claude Code with subscription auth (OAuth), separate from the main app's API key.

1. Start the containers: `docker compose up --build`
2. Log in: `docker compose exec -u coder coder claude` (it will prompt you to log in if you haven't).
3. Follow the browser-based OAuth flow.
4. Set `[coder].model` in your config to a Claude Code model alias (`sonnet`, `opus`, or `haiku`).

### Signal setup

Signal requires a **separate phone number** — not your personal one. A prepaid SIM or VoIP number works.

1. Uncomment `COMPOSE_PROFILES=signal` in your `.env` file to enable the signal-bridge container.
2. Build the containers: `docker compose --profile signal build`
3. Register Signal on the container (pick one):
   - **Link to an existing Signal account:** `docker compose --profile signal run --rm --entrypoint bash signal-bridge -c 'signal-cli link -n "Stavrobot" | tee >(xargs -L 1 qrencode -t utf8)'` — scan the QR code with your phone (Signal > Settings > Linked devices).
   - **Register a new number:** `docker compose --profile signal run --rm --entrypoint bash signal-bridge -c 'signal-cli -u +YOUR_NUMBER register'`, then verify with `docker compose --profile signal run --rm --entrypoint bash signal-bridge -c 'signal-cli -u +YOUR_NUMBER verify CODE'`.
4. Set `[signal].account` in your config.
5. Start the containers: `docker compose up --build`
6. After first startup, add allowed numbers via the `/settings` web UI.
7. **Important:** signal-cli does not resolve phone numbers for contacts it hasn't messaged yet. The bot must send the first message to each contact by phone number before it can receive and identify incoming messages from them. To trigger this for the owner, run:
   ```
   docker compose exec app node -e "fetch('http://localhost:3001/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'Send the message \"Hello from Stavrobot\" to my Signal number.'})}).then(r=>r.text()).then(console.log)"
   ```
8. See the [signal-cli quickstart](https://github.com/AsamK/signal-cli/wiki/Quickstart) for details.

### Telegram setup

1. Message @BotFather on Telegram, create a new bot, and copy the token.
2. Message @userinfobot on Telegram to get your chat ID.
3. Set `[telegram].botToken` in your config.
4. After first startup, add allowed chat IDs via the `/settings` web UI.
5. The webhook is registered automatically when the app starts.

### WhatsApp setup

WhatsApp requires a **separate phone number**, as otherwise you'd be messaging yourself, which doesn't really work.

WhatsApp uses [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial WhatsApp Web library that links as a companion device (like WhatsApp Web). No separate phone number is needed — it links to your existing WhatsApp account.

**Risk:** Baileys uses an unofficial API. WhatsApp may ban accounts that use it. Use at your own risk.

1. Add a `[whatsapp]` section to your `config.toml` (see `config.example.toml` for the format).
2. Start the containers: `docker compose up --build`
3. A QR code will appear in the app logs (`docker compose logs -f app`).
4. Open WhatsApp on your phone, go to **Linked devices**, and scan the QR code.
5. The session persists across restarts in `./data/whatsapp`.
6. Add allowed phone numbers via the `/settings` web UI.

### Email setup

Email uses a Cloudflare Email Worker for inbound delivery and SMTP for outbound. See
`config.example.toml` for the complete worker code and detailed setup instructions.

1. Add an `[email]` section to your `config.toml` with SMTP credentials and a random `webhookSecret`.
2. Deploy the Cloudflare Email Worker (code in `config.example.toml`) and set the `WEBHOOK_URL` and `WEBHOOK_SECRET` environment variables on the worker.
3. In Cloudflare Email Routing, add a rule to forward inbound mail to the worker.
4. Add allowed sender addresses via the `/settings` web UI.

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

## Knowledge system

Stavrobot has a three-tier knowledge system: **memories**, a **scratchpad**, and the
**database**. It will manage these fairly well on its own, but they're important for you
to know because you will want to help the bot use them properly.

**Memories** are always injected into the system prompt wholesale. You should be frugal
with these, as they get included in the context every time, and having many of them can
increase the context. An example of a good memory would be "the user prefers chatting in
an informal style.", something that the bot should know about every time, even if that
costs in additional context length.

**The scratchpad** is where the bot keeps less frequently-accessed knowledge, but
knowledge that pertains to a topic. Scratchpad entries have a title and a body, and the
title gets injected into the context automatically. Use this for important, but
less-frequently needed things, things that usually pertain to a specific topic.

For example, a good scratchpad entry would be "dietary preferences", with details about
what you like to eat, when, etc. The bot will see that there's a topic "dietary
preferences", but not load the actual text itself into the context automatically, only
accessing it on-demand.

When you're talking to the bot about food, it will know there's a "dietary preferences"
scratchpad entry it can look at, and usually do that on its own.

**The database** is the third tier, for structured or bulk data that doesn't belong in
memories or the scratchpad. The bot has full read/write access to PostgreSQL via
unrestricted SQL, so it can create tables, run queries, and store anything. Use this for
things like lists, logs, structured records, or any data that's better queried than read
as prose.

The bot will usually know well enough what to use when, but sometimes you will want to
tell it explicitly what information to put where.

## Talking to other people

Stavrobot can message people on your behalf over Signal, Telegram, WhatsApp, or email. Need to schedule a
dinner with a friend? Tell the bot to find a time that works for both of you, and it
will message them, negotiate a date, and put it on your calendar. Want to arrange an
appointment, coordinate a group outing, or ask someone a question while you're busy?
Just tell the bot what you need and who to talk to.

The bot spins up a dedicated subagent for each conversation, with its own instructions
and context, so it can handle back-and-forth with the other person without cluttering
your main chat. When the task is done, it disables the contact and reports back to you.

To keep things safe, messaging requires two things before the bot can talk to someone:

1. **You add them to the allowlist.** Go to `/settings` and add their phone number
   (Signal or WhatsApp) or chat ID (Telegram). This is a one-time step per person. The
   bot cannot modify this list or message anyone not on it, no matter what.
2. **The bot creates a contact record.** When you ask the bot to message someone on the
   allowlist, it creates a contact record and spins up a dedicated subagent for the
   conversation. When the task is done, it disables the contact, which blocks messaging
   in both directions until you ask the bot to re-enable it.

A typical flow: you add your friend's phone number to the allowlist via `/settings` once,
then tell the bot "find a time for dinner with Alex next week". The bot creates a contact
record for Alex, spins up a subagent, messages Alex on Signal, goes back and forth to
find a date, and reports the result to you.

## Skills

Skills are plain-text instruction files that teach the bot new capabilities — things like
creating tables, storing knowledge, making pages, or following specific workflows. They
are not code; they are natural-language instructions the bot reads and follows.

To install the skill system, tell the bot to fetch
`https://stavrobot.stavros.io/bootstrap.md` and follow its instructions.

A full list of available skills is at
`https://stavrobot.stavros.io/skills/index.md`. To install a skill, just tell the bot to
fetch and install it from that URL. The bot will show you what the skill does and ask for
confirmation before proceeding.

Skill files live on the `pages` branch of this repo (served via Cloudflare Pages). To
contribute a skill, add a markdown file to `skills/` on that branch. Each skill file has
YAML front matter with `title`, `description`, `version`, and an optional `author`,
followed by the plain-language instructions in the body. See
[SKILL-AUTHORING.md](misc/SKILL-AUTHORING.md) for the full authoring guide. Submit a PR
against the `pages` branch.

## How to make your own plugin

See [PLUGIN.md](coder/PLUGIN.md) for everything you need to know to create a Stavrobot
plugin. The same document works as a reference for both humans and LLMs.

## Recommended plugins

Plugins are fairly necessary to enable core functionality for the bot, such as the
ability to "hear" voice notes, send voice notes back, be aware of places around you,
search the web, etc.

These capabilities are not provided out-of-the-box to give you the ability to customize
your bot however you want. You should install plugins, though, otherwise you will be
missing crucial functionality.

You can find some first-party plugins here:

https://github.com/orgs/stavrobot/repositories


## Architecture

Four Docker containers: `app` (TypeScript server, exposes `POST /chat` on port 3000, handles Telegram webhooks at `POST /telegram/webhook`, handles inbound email webhooks at `POST /email/webhook`, and runs WhatsApp in-process via Baileys), `postgres` (PostgreSQL 17 for persistent state), `plugin-runner` (Node.js server — lists, inspects, and executes plugins, both locally created and git-installed), and `coder` (Claude Code headless agent for creating and modifying editable plugins). The main agent can create subagents, each with their own conversation history, system prompt, and tool whitelist. Interlocutors are contact records assigned to agents for inbound message routing.

## License

[AGPL-3.0](LICENSE)
