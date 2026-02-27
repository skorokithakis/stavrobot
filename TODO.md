# TODO items

Work on these one at a time. Delete when the user confirms they're done:

- Pre-existing: subagent with `manage_agents.update` can escalate its own permissions.
  Severity: high if that permission is ever granted to a subagent.
  Not introduced by 18e74cef; pre-existing since the agents system was added.
  Root cause: `manage_agents` update action blocks modification of agent 1 (the main agent)
  but does not prevent a subagent from editing its own `allowed_tools` or those of other
  non-main agents.
  Relevant code:
    - `src/agents.ts:118-160` — update action handler.
    - `src/agents.ts:126-132` — only blocks `id === 1`.
  Repro:
    1. Create a subagent with `allowed_tools: ["manage_agents.update"]`.
    2. Instruct the subagent to update its own `allowed_tools` to include `execute_sql`.
    3. The update succeeds; the subagent now has `execute_sql` access on next prompt.
  Fix direction:
    - Enforce that only the main agent (agent 1) can change `allowed_tools` on any agent.
    - Or disallow self-targeted `allowed_tools` updates from subagents.
    - Or split the update action: allow subagents to update safe fields (name, system_prompt)
      but require main-agent context for `allowed_tools` changes.
  Tests to add:
    - Subagent cannot update its own `allowed_tools`.
    - Subagent cannot update another subagent's `allowed_tools`.
    - Main agent can still perform all legitimate updates.
