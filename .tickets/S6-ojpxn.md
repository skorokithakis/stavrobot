---
id: S6-ojpxn
status: closed
deps: [S6-dmffu]
links: []
created: 2026-05-30T00:10:49Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Reconcile OAuth login flow with new pi-ai callback API

Objective: adapt src/login.ts (and src/auth.ts if needed) to the OAuthLoginCallbacks / OAuthProvider API as it exists in the installed @earendil-works/pi-ai@0.78.0, so the project type-checks cleanly.

Background: pi-ai 0.75.5 reshaped OAuthLoginCallbacks. Per current upstream docs the shape is roughly:
  onAuth(params: { url: string }): void
  onDeviceCode(params: { userCode: string; verificationUri: string }): void
  onPrompt(params: { message: string }): Promise<string>
The changelog also mentions onSelect becoming required. The current src/login.ts uses onAuth({url, instructions}), onProgress(message), and onManualCodeInput() — signatures that have changed or been removed. Do NOT trust the docs blindly: inspect the actual installed type definitions in node_modules/@earendil-works/pi-ai (the .d.ts for the /oauth entry, e.g. dist/oauth.d.ts) and the OAuthProvider.login signature. Implement against the REAL installed types.

Scope:
- src/login.ts: update the object passed to provider.login(...) to match the installed OAuthLoginCallbacks. Map whatever the new callbacks are onto the existing SSE-based browser flow:
  * Keep emitting the auth URL to the browser (the existing 'auth' SSE event).
  * Preserve the manual-code-paste path (user pastes redirect URL/code) — figure out which callback now carries that (likely onPrompt). If onManualCodeInput no longer exists, fold its behavior into the appropriate callback.
  * If a callback was removed (e.g. onProgress) and has no replacement, drop the corresponding SSE 'progress' emission or wire it to whatever exists. Do not invent library behavior.
  * If onDeviceCode / onSelect are now required, implement them sensibly for a remote single-user browser flow (e.g. surface device code via the existing SSE channel; for onSelect, if the provider offers a choice, pick the configured provider/flow deterministically — this is a single-user bot).
- src/auth.ts: verify getOAuthProvider, provider.refreshToken, provider.getApiKey still exist with compatible signatures; adjust only if the installed types require it. If pi-ai now prefers refreshOAuthToken/getOAuthApiKey free functions, prefer keeping the existing provider-method approach if it still compiles; only switch if the methods were removed.

Non-goals:
- Do not redesign the SSE/reconnect/timeout machinery in login.ts; keep its structure. Only adapt the callback contract.
- Do not change auth.ts retry/backoff logic.
- Do not add new config options.

Constraints/caveats:
- Never rely on undocumented/internal library behavior (per AGENTS.md). Implement against the public exported types only.
- Let errors propagate; do not add defensive try/catch beyond what exists.
- The goal of this ticket is a clean 'npx tsc --noEmit'. Runtime OAuth correctness will be smoke-tested manually by the user afterward; make the mapping faithful to the old behavior so that smoke test is likely to pass.
- If the actual installed type differs materially from the description above (e.g. onSelect is NOT required, or onManualCodeInput still exists), follow the installed type and note the discrepancy in your completion report.

## Design

The login flow is a remote browser flow over SSE, not a local-terminal flow: the auth URL is shown in the browser, and the user pastes the redirect URL/code back. Whatever the new callbacks are, the manual-paste path must remain functional because the library's local callback server cannot receive the redirect in a remote deployment.

## Acceptance Criteria

npx tsc --noEmit passes with zero errors. src/login.ts compiles against the installed @earendil-works/pi-ai OAuthLoginCallbacks type. The manual code/URL paste path is preserved. The completion report states the ACTUAL installed callback shape found in the .d.ts and notes any divergence from the ticket description. ready for implementation

