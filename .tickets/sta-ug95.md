---
id: sta-ug95
status: closed
deps: []
links: []
created: 2026-04-08T20:56:33Z
type: task
priority: 1
assignee: Stavros Korokithakis
---
# Survive page reloads during OAuth login flow

Decouple the OAuth flow lifetime from the SSE connection lifetime in src/login.ts. Currently, if the /login page reloads, the active provider.login() call is cancelled and the user must re-authorize from scratch. Instead, keep the flow alive and let new SSE connections attach to it.

**What to change (all in src/login.ts):**

1. Add module-level mutable state for the SSE pipe and flow context:
   - `activeResponse: http.ServerResponse | null` — the current SSE response to write events to.
   - `activeIsConnected: boolean` — whether the current SSE connection is alive.
   - `lastAuthEvent: { url, instructions } | null` — the most recent onAuth payload, for replay.
   - `lastPromptMessage: string | null` — the most recent prompt message (from onManualCodeInput or onPrompt), for replay.

2. In handleLoginEvents, when a new SSE connection arrives and activeLoginPromise is non-null:
   - Do NOT cancel the existing flow. Skip the cancellation block entirely.
   - Update activeResponse to point to the new response. Set activeIsConnected = true.
   - Replay stored state: if lastAuthEvent is set, send an 'auth' SSE event. If lastPromptMessage is set, send a 'prompt' SSE event. If pendingPromptResolver is null and lastPromptMessage was set, the prompt was already answered — send a 'progress' event like 'Waiting for authorization...' or similar.
   - Wire the new request's 'close' handler to set activeIsConnected = false (but NOT abort the flow).
   - Return early — do not call provider.login() again.

3. When activeLoginPromise is null (no active flow), start a new flow as today, but:
   - The onAuth callback stores its payload in lastAuthEvent before sending the SSE event.
   - The onManualCodeInput and onPrompt callbacks store the prompt message in lastPromptMessage.
   - All SSE writes go through activeResponse/activeIsConnected instead of closure-local variables.
   - The disconnect handler sets activeIsConnected = false but does NOT call loginAbortReject or cancel the flow.

4. Add a flow timeout: when the flow starts, set a setTimeout (5 minutes). If the flow is still active when it fires, cancel it and clean up all module-level state. Clear the timeout on successful completion or explicit cancellation.

5. Clean up module-level state (lastAuthEvent, lastPromptMessage, activeResponse, etc.) when the flow completes (success or error), same as the existing finally block cleans up loginAbortReject/activeLoginPromise.

6. Remove the existing cancellation logic (the block that checks activeLoginPromise and calls loginAbortReject). The loginAbortReject/loginCancelled machinery can be removed entirely — it was only needed because reconnection used to mean restarting the flow.

**Keep the existing loginFlowCounter** — it is still useful for ensuring stale disconnect handlers do not interfere.

**Non-goals:** Do not change the HTML/JS client side beyond what is needed (EventSource already auto-reconnects on its own, which is what triggers the new SSE connection). Do not change the pi-ai library. Do not change handleLoginRespond.

## Acceptance Criteria

1. Reloading the /login page during an active OAuth flow does not restart the flow — the same auth URL and prompt are shown.
2. The authorization code obtained before the reload still works.
3. Abandoned flows (no reconnection) are cleaned up after ~5 minutes.
4. npx tsc --noEmit passes.
5. Fresh login (no active flow) still works as before.

