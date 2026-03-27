---
id: sta-9rsm
status: closed
deps: []
links: []
created: 2026-03-28T19:59:06Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Add custom endpoint config fields

Add baseUrl, contextWindow, maxTokens, and api to the Config interface. Validate: when baseUrl is present, contextWindow and maxTokens are required, authFile is forbidden. api defaults to openai-completions. When baseUrl is absent, these new fields are ignored. Update config.example.toml with commented examples for Ollama and Anthropic proxy.

## Acceptance Criteria

loadConfig() throws clear errors for: baseUrl+authFile, baseUrl without contextWindow, baseUrl without maxTokens. Existing configs without baseUrl work unchanged.

