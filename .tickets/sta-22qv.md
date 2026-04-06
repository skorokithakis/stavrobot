---
id: sta-22qv
status: closed
deps: []
links: []
created: 2026-04-06T10:18:33Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Add reverse proxy note to README

Add a note after the 'Running' section (after line 129, 'The API is available at http://localhost:10567/chat.') explaining that Docker Compose only exposes the app on localhost:10567 and users need to set up a reverse proxy for external access. The exact text to add after line 129:

A blank line, then:

**Note:** Docker Compose only exposes the app on `localhost:10567`. To make it accessible externally (required for Telegram/Signal webhooks and the `publicHostname` setting), set up a reverse proxy (e.g. Nginx, Caddy) pointing to `localhost:10567`. You can also expose the port directly, but this is not recommended as traffic will be unencrypted.

After editing, run: jj describe -m 'Add reverse proxy note to README'

