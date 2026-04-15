---
id: sta-kbble
status: in_progress
deps: []
links: []
created: 2026-04-15T02:10:39Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Add contextTokens config setting to control token budget

Add optional contextTokens setting to config.toml. This is the ceiling on tokens sent per LLM call (average usage ~half due to compaction sawtooth).

Effective context = min(contextTokens, model.contextWindow), floored at 10000. When omitted, defaults to model.contextWindow (preserving current behavior).

Derive all token budgets from effective context:
- Pre-send truncation budget = 80% of effective context (TRUNCATION_BUDGET_FRACTION = 0.8)
- Compaction threshold = 60% of effective context (COMPACTION_THRESHOLD_FRACTION = 0.6)  
- Keep budget after compaction = 50% of compaction threshold (COMPACTION_KEEP_FRACTION = 0.5)

Extract these three ratios as named constants in the source (not user-facing config).

Changes:
- config.ts: Replace compactionTokenThreshold with optional contextTokens on Config interface. Remove default/validation for compactionTokenThreshold.
- agent/index.ts: Compute effectiveContext from config.contextTokens and model.contextWindow (with 10k floor). Derive tokenBudget and compaction threshold from it. Pass compaction threshold to triggerCompactionIfNeeded instead of config.compactionTokenThreshold.
- agent/compaction.ts: The 0.5 keep fraction is already there, just make it a named constant.
- config.example.toml: Replace compactionTokenThreshold comment with contextTokens, noting it defaults to the model context window and average usage is ~half.
- config.test.ts: Update tests — remove compactionTokenThreshold tests, add contextTokens tests (undefined uses model default, explicit value works, floor of 10k enforced).

Non-goals: No changes to compaction algorithm logic. No per-model overrides.

## Acceptance Criteria

- contextTokens = 50000 results in: truncation budget 40k, compaction threshold 30k, keep budget 15k.
- Omitting contextTokens with a 200k model gives: truncation 160k, compaction 120k, keep 60k (note: current compaction was 80k, this changes).
- Floor of 10k enforced.
- npm test passes.
- npx tsc --noEmit passes.


## Notes

**2026-04-15T02:15:44Z**

Also log effective context, truncation budget, compaction threshold, and keep budget at startup (log.info with [stavrobot] prefix), so the user can verify their config is taking effect.

**2026-04-15T02:16:31Z**

Config key is contextTokensK (integer, in thousands). E.g. contextTokensK = 50 means 50,000 tokens. Multiply by 1000 internally. Floor is 10 (= 10k tokens). Startup log should also display in thousands for consistency.
