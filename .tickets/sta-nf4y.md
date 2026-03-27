---
id: sta-nf4y
status: closed
deps: [sta-9rsm]
links: []
created: 2026-03-28T19:59:13Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Construct custom Model object when baseUrl is set

In createAgent(), when config.baseUrl is present, construct a Model object manually instead of calling getModel(). Use api from config (default openai-completions), provider and model as provider/id, baseUrl/contextWindow/maxTokens from config. Set reasoning: false, input: ['text', 'image'], zero costs. When baseUrl is absent, keep existing getModel() path unchanged.

## Acceptance Criteria

Agent starts successfully with a baseUrl config pointing to an OpenAI-compatible endpoint. Existing registry-based configs still work.

