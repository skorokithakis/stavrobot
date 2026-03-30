# Installing Stavrobot

You are an AI coding assistant helping a user install Stavrobot, a personal AI assistant. Walk the user through each step interactively, prompting them for information as needed. Do not dump all the steps at once — go one at a time, wait for the user to complete each step before moving on.

## Step 0: Check prerequisites

Make sure Docker and Docker Compose are installed. If not, help the user install them before continuing.

## Step 1: Download Stavrobot

Download and extract the repository. The user may not have git installed, so prefer the zip download:

```bash
curl -L https://github.com/skorokithakis/stavrobot/archive/refs/heads/master.zip -o stavrobot.zip
unzip stavrobot.zip
cd stavrobot-master
```

If the user has git, they can clone instead:

```bash
git clone https://github.com/skorokithakis/stavrobot.git
cd stavrobot
```

## Step 2: Set up the environment file

Copy the example environment file:

```bash
cp env.example .env
```

Ask the user for their timezone (e.g. `America/New_York`, `Europe/London`, `Asia/Tokyo`). Generate a random secure password for Postgres. Edit `.env` and set:

- `TZ` to the user's timezone.
- `POSTGRES_PASSWORD` to the generated secure password.

## Step 3: Create a Telegram bot

The user needs to do two things on Telegram. Walk them through both:

1. **Create a bot:** Tell the user to open Telegram and message [@BotFather](https://t.me/BotFather). They should send `/newbot`, follow the prompts to pick a name and username, and then copy the bot token BotFather gives them. Wait for the user to provide the token.

2. **Get their chat ID:** Tell the user to message [@userinfobot](https://t.me/userinfobot) on Telegram. It will reply with their user ID (a number). Wait for the user to provide it.

## Step 4: Set up the config file

Copy the example config:

```bash
mkdir -p data/main
cp config.example.toml data/main/config.toml
```

Ask the user for the following, one at a time:

1. **Password:** A password for the web UI (HTTP Basic Auth). Generate a random one and show it to the user, or let them pick their own. Set the `password` field.
2. **Public hostname:** The HTTPS URL where the server will be reachable (e.g. `https://bot.example.com`). This is needed for Telegram webhooks. If the user is just testing locally, they can use a tunnel like ngrok or Cloudflare Tunnel. Set `publicHostname`.
3. **Owner name:** The user's first name. Set `[owner].name`.
4. **Telegram chat ID:** The number from step 3. Uncomment and set `[owner].telegram`.
5. **Telegram bot token:** The token from step 3. Set `[telegram].botToken`.

## Step 5: Start Stavrobot

```bash
docker compose up --build
```

Tell the user this will take a few minutes on first run. Once they see log output indicating the server is ready, they should message their bot on Telegram. It should respond. They can also chat via the web interface at their public hostname.

## Step 6: Verify

Ask the user to send a message to their bot on Telegram and confirm it replies. If it does, the installation is complete.

## What's next

Stavrobot supports more than just Telegram. Once the user is comfortable with the basics, they can set up additional features by following the instructions in the README:

- **Signal integration** — two-way messaging over Signal (requires a separate phone number).
- **WhatsApp integration** — two-way messaging over WhatsApp via the Baileys library.
- **Email integration** — inbound email via a Cloudflare Email Worker, outbound via SMTP.
- **Claude Code (coder container)** — lets Stavrobot write and modify its own plugins using Claude Code with subscription auth.
- **Skills** — plain-text instruction files that teach the bot new capabilities (gym tracking, meal planning, etc.). Tell the bot to fetch `https://stavrobot.stavros.io/skills/bootstrap.md` to get started.
- **Plugins** — extend the bot's capabilities. Browse available plugins at https://github.com/orgs/stavrobot/repositories.
