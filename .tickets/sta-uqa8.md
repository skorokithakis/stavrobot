---
id: sta-uqa8
status: closed
deps: []
links: []
created: 2026-04-08T00:00:00Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Persist OAuth login state across page reloads

The Anthropic OAuth login flow generates ephemeral PKCE state (verifier, challenge) and starts a local callback server inside `provider.login()`. All of this lives in the function closure and is lost if the SSE connection drops — which happens on page refresh, back button, or browser killing a backgrounded tab.

This makes login fragile: the user must complete the entire OAuth flow (click auth link → authenticate on claude.ai → copy redirect URL → paste it back) without the `/login` page ever reloading. If the page reloads at any point, the PKCE state is gone and the auth code from the old flow is useless.

## Current behavior

1. Every `/login/events` SSE connection starts a completely fresh OAuth flow (new PKCE verifier, new callback server, new auth URL).
2. If the page reloads, the old flow is cancelled and a new one starts. The user must click the new auth link and redo the entire login.
3. The callback server is inside the container, so `localhost:53692` is unreachable from the user's browser. The user must manually paste the redirect URL, which requires switching between browser tabs — increasing the chance of the page being killed.

## Desired behavior

If the user reloads the `/login` page while an OAuth flow is in progress, the page should reconnect to the existing flow and show the same auth URL / prompt state. The user should not have to restart the login from scratch.

## Possible approaches

1. **Server-side session**: persist the PKCE state and auth URL server-side (in memory or on disk). On reconnect, send the existing auth URL via SSE instead of starting a new flow. The callback server stays running. When the login completes or times out, clean up.

2. **Library-level support**: the pi-ai library's `loginAnthropic()` function would need to support detaching the callback server from the login promise, or accepting pre-generated PKCE state. This may require upstream changes.

3. **Client-side persistence**: store the auth URL in localStorage so it survives page reloads. The server still needs to keep the callback server and PKCE state alive on reconnect.

## Constraints

- The callback server and PKCE state live inside the pi-ai library's `loginAnthropic()` closure. Stavrobot cannot directly access or persist them without library changes or reimplementing the OAuth flow.
- Any solution needs a timeout to clean up abandoned flows.

## Acceptance criteria

1. Reloading the `/login` page during an in-progress OAuth flow does not restart the flow.
2. The user sees the same auth URL and can continue where they left off.
3. Abandoned flows are cleaned up after a reasonable timeout (e.g. 5 minutes).
