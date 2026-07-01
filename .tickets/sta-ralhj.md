---
id: sta-ralhj
status: closed
deps: []
links: []
created: 2026-07-01T21:37:33Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Timing-safe password comparison in all three services

Objective: replace === / == password comparison with constant-time comparison.

- src/index.ts checkBasicAuth (~line 85): compare sha256 digests of provided and expected password via crypto.timingSafeEqual (hashing sidesteps the length-mismatch restriction).
- plugin-runner/src/index.ts (~line 427): same.
- coder/server.py (~line 294): use hmac.compare_digest.

Non-goals: no rate limiting, no auth scheme changes.

Run npm test.


## Notes

**2026-07-01T21:40:43Z**

ready for implementation
