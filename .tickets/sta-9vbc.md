---
id: sta-9vbc
status: open
deps: []
links: []
created: 2026-03-29T23:24:32Z
type: epic
priority: 2
assignee: Stavros Korokithakis
tags: [channels, architecture, exploratory]
---
# Design: extract inbound channels into standalone channel containers

## Summary

Exploratory design for extracting all four inbound communication channels (Signal, Telegram, WhatsApp, email) out of the main app into standalone Docker containers, each speaking a standard protocol with the main app. This is a significant architectural change.

The concept is called "channels" (not "services" or "plugins" — channels are a separate concept from the plugin system).

## Current state

Each channel is deeply wired into the main app:

- **Telegram**: Hardcoded webhook endpoint `POST /telegram/webhook` in index.ts, whitelisted in `isPublicRoute()`. Handler in `telegram.ts` validates Telegram's secret token, normalizes messages, calls `enqueueMessage()`. Send tool in `send-tools.ts` calls Telegram Bot API directly.
- **Email**: Hardcoded webhook endpoint `POST /email/webhook` in index.ts, whitelisted in `isPublicRoute()`. Handler in `email.ts` validates bearer token, parses RFC 822 with `mailparser`, calls `enqueueMessage()`. Send tool uses `nodemailer` via `email-api.ts`.
- **WhatsApp**: No webhook — persistent Baileys WebSocket connection managed in-process by the main app (`whatsapp.ts`). Listens on `messages.upsert` event, normalizes, calls `enqueueMessage()`. Send tool uses the same WASocket instance via `whatsapp-api.ts`. Auth state persisted to `data/whatsapp/`.
- **Signal**: Already a separate container (`signal-bridge/`). Python script wraps signal-cli, listens on SSE stream, POSTs to `app:3000/chat`. Main app has `signal.ts` for outbound only. Closest to the target architecture.

All four channels converge through `enqueueMessage()` in `queue.ts` with `{ source, sender, message, attachments }`. Routing goes through `resolveTargetAgent()` which checks allowlist and interlocutor identity mapping.

Files involved per channel:
- Telegram: `src/telegram.ts`, `src/telegram-api.ts`, `src/send-tools.ts`
- Email: `src/email.ts`, `src/email-api.ts`, `src/send-tools.ts`
- WhatsApp: `src/whatsapp.ts`, `src/whatsapp-api.ts`, `src/send-tools.ts`
- Signal: `signal-bridge/bridge.py`, `src/signal.ts`, `src/send-tools.ts`
- Shared: `src/queue.ts` (enqueueing), `src/allowlist.ts`, `src/index.ts` (route definitions)

## Proposed design

### Core concept

A channel is a long-running process in its own Docker container that bridges an external communication platform to the app's message queue. Each channel container speaks a standard protocol with the main app.

### Protocol (four interactions)

#### 1. Registration (channel → app, on startup)

Channel POSTs to `app:3000/channels/register` with metadata:
- `name`: channel identifier (e.g. "telegram", "signal")
- `sendUrl`: URL the app should POST to for outbound messages (e.g. "http://telegram-channel:3010/send")
- `webhookPath` (optional): if the channel needs a webhook proxy, the path to register (e.g. "/hooks/telegram")

App records this in memory (ephemeral). If the app restarts, channels re-register on their next restart or health check cycle.

#### 2. Webhook inbound (app → channel, synchronous) — for Telegram, email

External service hits `POST /hooks/<channel>` on the main app. App proxies the raw request (headers + body) to the channel container's webhook handler endpoint. Channel:
- Validates auth (e.g. Telegram secret token, email bearer token)
- Normalizes the message
- Returns structured response: `{ messages: [{ sender, message, attachments }] }` or error

App enqueues any returned messages with `source: "<channel-name>"` through the normal queue pipeline (allowlist check, interlocutor routing, etc.).

Key benefit: webhook channels don't need to know the app's URL. They just respond to proxied requests.

#### 3. Push inbound (channel → app, async) — for Signal, WhatsApp

Channels with persistent connections (WebSocket, SSE) push messages directly to `app:3000/chat` with `{ source: "<channel>", sender, message, files }`. This is exactly what Signal bridge already does today.

These channels need to know the app's URL, which they get from config or environment.

#### 4. Outbound send (app → channel)

Single unified agent tool: `send(channel, recipient, message, attachments)`. App looks up the channel's registered send URL, POSTs the message to it. Replaces the current four separate send tools (`send_signal_message`, `send_telegram_message`, `send_whatsapp_message`, `send_email`).

### Allowlist enforcement

The app continues to enforce the allowlist centrally. When a message arrives (via webhook proxy return or push inbound), the app checks the sender against the allowlist before enqueueing. This is a security gate and should not be delegated to channel code.

### Webhook auth

Each external service has its own auth scheme. Since the app just proxies raw requests, the channel container handles its own auth validation (checking Telegram's `X-Telegram-Bot-Api-Secret-Token` header, email's bearer token, etc.) and returns an error if validation fails.

The app only needs to know "this webhook path is claimed by this channel" (from registration).

### Config

Not yet decided. Options discussed:

- **(a) Centralized**: Keep channel config in `config.toml` under `[channels.telegram]` etc., mount into the channel container, channel reads its own section. Simpler for the user (one file), but couples channel config format to the main app.
- **(b) Per-channel**: Each channel has its own config file in a mounted directory (e.g. `data/channels/telegram/config.toml`). Channel owns its config independently. More files for the user to manage.
- **(c) App-delivered**: App passes config to the channel during registration or via an endpoint. More complex protocol.

No decision made yet. Leaning (a) for user simplicity or (b) for decoupling.

## Decisions made

1. **Channels, not plugins**: Channels are a separate concept from the plugin system. Different lifecycle, different protocol, different purpose.
2. **Container per channel**: Each channel runs in its own Docker container. This is the cleanest isolation model and lets each channel use whatever runtime it needs (Python for Signal bridge, Node for WhatsApp/Baileys, etc.).
3. **Standardized send tool**: One `send()` tool with channel name as the first argument, replacing four separate send tools. Signature: `send(channel, recipient, message, attachments)`.
4. **Push registration**: Channels register themselves with the app on startup (push model), rather than the app discovering them.
5. **Centralized allowlist**: App enforces allowlist, not channels.
6. **Two inbound patterns**: Webhook proxy (synchronous, for Telegram/email) and push inbound (async, for Signal/WhatsApp). Both converge into the same queue.

## Wrong turns / rejected ideas

1. **Channels as plugins**: Initially explored making channels a type of plugin within the existing plugin system. Rejected because plugins are short-lived script executions with a tool-call model, while channels need long-running processes, persistent connections, and bidirectional communication. Trying to shoehorn channels into the plugin model would require adding service processes, webhook forwarding, and inbound message injection to the plugin system — making it do too many unrelated things.

2. **"Services" naming**: Initially called these "services" but renamed to "channels" to make the scope clear — these are specifically for communication channels, not a general-purpose service abstraction. YAGNI.

3. **Plugin daemon mode**: Considered adding a `service` field to plugin manifests so the plugin-runner could manage long-running processes. Rejected as overcomplicating the plugin system for a use case that's fundamentally different.

## Open questions

1. **Config delivery mechanism**: See options above. Needs decision.

2. **Docker-compose complexity**: This adds up to four new containers (three net new, since Signal bridge already exists). Each needs its own Dockerfile, service definition, volume mounts, health checks, dependency ordering. For stateless webhook channels (Telegram, email) this feels heavyweight. Is there a lighter-weight option for those that doesn't compromise the architecture?

3. **Registration persistence**: If the app restarts, it loses the in-memory registration table. Channels would need to re-register. Options: (a) channels periodically re-register / heartbeat, (b) app stores registrations in the database, (c) app pulls registration from a known endpoint on each channel container on startup.

4. **WhatsApp complexity**: Baileys runs in-process with Node.js and maintains complex state (multi-file auth credentials, connection retry logic, QR code pairing flow). Moving it to its own container means reimplementing all the lifecycle management that currently lives in `whatsapp.ts`. The QR code flow for initial setup is particularly tricky since it currently logs to the main app's console.

5. **Signal bridge refactor**: Signal bridge already exists as a separate container but doesn't follow the proposed protocol (no registration, hardcoded app URL, custom send endpoint). How much do we refactor it vs. wrap it?

6. **Migration strategy**: Big-bang vs. incremental. Email is the simplest candidate for a proof-of-concept (pure webhook, no persistent connection, simple auth). Could validate the architecture with email first, then tackle the others.

7. **Interlocutor/routing generalization**: The `interlocutor_identities` table has a `service` column that currently stores hardcoded channel names. This should work as-is with dynamic channel names, but needs verification.

8. **Harbormaster compatibility**: `docker-compose.harbormaster.yml` must stay in sync with `docker-compose.yml`. Adding four containers means four new service definitions in both files.

## Design

See description for full design detail. Key architectural properties:

- Channel containers are stateless from the app's perspective (app stores no channel state, channels re-register)
- Two inbound patterns (webhook proxy vs push) converge into the same queue entry point
- Single outbound tool replaces four channel-specific tools
- Allowlist remains a centralized app concern
- Channel containers handle their own external auth validation


## Notes

**2026-03-29T23:31:58Z**

## Allowlist and interlocutor analysis

### Current allowlist design

The allowlist (`allowlist.json`) has hardcoded per-channel arrays with different value types:
- `signal: string[]` (phone numbers, exact match)
- `telegram: (number | string)[]` (chat IDs as numbers, plus `"*"` wildcard)
- `whatsapp: string[]` (phone numbers, exact match)
- `email: string[]` (addresses with glob pattern support: `*@example.com`, `user+*@gmail.com`)
- `notes: Record<string, string>` (human-readable labels for entries)

The `isInAllowlist()` function dispatches on hardcoded channel names with per-channel matching logic. Owner identities are auto-seeded from `config.toml [owner]` which has hardcoded `owner.signal`, `owner.telegram`, `owner.whatsapp`, `owner.email` fields.

The web UI at `/settings/allowlist` renders four hardcoded sections.

### Current interlocutor design

- `interlocutors` table: `id`, `display_name`, `agent_id`, `enabled`, `owner`
- `interlocutor_identities` table: `interlocutor_id`, `service` (free-text string), `identifier`
- The `service` column is already free-text — no constraint to the four hardcoded channels. This is good and requires no schema change.
- `resolveInterlocutor()` has one hardcoded branch: `if (service === "email")` uses wildcard/glob matching. All other services use exact identifier match.
- `resolveRecipient()` (for outbound) and `resolveInterlocutorByName()` are channel-agnostic already.

### Current routing pipeline (queue.ts)

- `GATED_SOURCES = ["signal", "telegram", "whatsapp", "email"]` — hardcoded. Only these go through allowlist + interlocutor gates.
- `INTERACTIVE_SOURCES` — same hardcoded list, controls message steering.
- AuthError handler (lines 225-243) sends login notifications via hardcoded channels.
- `isOwnerIdentity()` checks against hardcoded `config.owner.*` fields.

### What needs to change

1. **Allowlist structure**: Must become dynamic. Proposed: `{ [channelName]: string[] }` — all identifiers stored as strings. Drop numeric Telegram IDs (store as string "12345").

2. **Allowlist matching**: Three options were discussed:
   - (a) Channels declare match type during registration (`exact | glob | case-insensitive`)
   - (b) Channels validate their own identifiers (round-trip per inbound message)
   - (c) Everything is exact string match + `"*"` wildcard, channels normalize identifiers on both ends

   Leaning toward (c) for maximum simplicity in the app. Email glob patterns would move to the email channel itself.

3. **GATED_SOURCES / INTERACTIVE_SOURCES**: Must become dynamic, populated from registered channels.

4. **Owner identities**: `config.toml [owner]` section needs to become dynamic. E.g. `[owner.identities]` with arbitrary channel names as keys.

5. **AuthError notifications**: Instead of hardcoded per-channel send logic, send login notification back through the same channel using the unified send mechanism.

6. **Web UI**: Must render allowlist sections dynamically based on registered channels.

### What's already channel-agnostic

- `interlocutor_identities.service` column (free-text)
- `resolveRecipient()` and `resolveInterlocutorByName()`
- `manage_interlocutors` tool (mostly — help text mentions specific channels but the logic is generic)
- The queue's `enqueueMessage()` interface accepts any source string

**2026-03-29T23:34:25Z**

## Decision: allowlist matching uses glob syntax

All allowlist entries use simple glob matching: `*` matches any sequence of characters, everything else is literal. No regex, no special modes.

Examples:
- `+1234567890` — exact match on a phone number
- `*@example.com` — any email at that domain
- `*` — wildcard, matches everything (replaces the current per-channel `"*"` wildcard)
- `12345` — exact match on a Telegram chat ID

Implementation: the app escapes the entry into a regex internally (escape all regex-special characters, replace `*` with `.*`), but the user-facing format is always globs. This generalizes what email already does today to all channels.

The allowlist structure becomes `{ [channelName: string]: string[] }` plus a `notes` field. All identifiers are strings. Channels normalize identifiers before sending inbound messages (e.g. Telegram converts numeric chat IDs to strings, email lowercases addresses).

This means:
- No per-channel matching logic in the app
- No channel-specific identifier types (no `number[]` for Telegram)
- Channels own normalization, app owns matching
- The existing `matchesEmailEntry()` function becomes the universal matcher (renamed, generalized)

**2026-03-29T23:34:56Z**

## Remaining open questions

1. **Config delivery**: How do channel containers get their secrets (bot tokens, SMTP credentials, etc.)? Options discussed: (a) keep in `config.toml` under `[channels.<name>]`, mount into container; (b) per-channel config file in `data/channels/<name>/config.toml`; (c) app delivers config to channel via API. No decision yet.

2. **Registration persistence**: Channel registrations are proposed as in-memory in the app. If the app restarts, it loses them. Options: (a) channels periodically re-register / heartbeat; (b) app stores registrations in the database; (c) app pulls registration from a known endpoint on each channel container on startup. No decision yet.

3. **Docker-compose complexity**: Container-per-channel means four containers (three net new since Signal bridge already exists). For stateless webhook channels like Telegram and email, a whole container feels heavyweight — they're just an HTTP handler and some API calls. Need to decide whether this operational cost is acceptable or if there's a lighter-weight model for stateless channels that doesn't compromise the architecture.

4. **Owner identities**: `config.toml [owner]` currently has hardcoded per-channel fields (`owner.signal`, `owner.telegram`, `owner.whatsapp`, `owner.email`). These are used for: (a) auto-seeding the allowlist, (b) identifying owner messages to bypass allowlist/interlocutor gates, (c) routing owner messages to the main agent. Needs to become dynamic — e.g. `[owner.identities]` section with arbitrary channel names as keys like `telegram = "12345"`, `signal = "+1234"`.
