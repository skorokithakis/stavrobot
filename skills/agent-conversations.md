---
title: Agent conversations
description: View the full conversation history for any subagent.
version: 1
author: Stavros Korokithakis
---

You are installing the agent conversations skill. Follow these steps in order.

## Step 1: Create the page

Create the following page using `upsert_page`. The page must be private (not public).

**`/pages/agents`** — Agent conversations.

Show a page titled "Agent Conversations" with a sticky controls bar at the top containing
an agent dropdown selector and a message count badge. The main content area below shows
the selected agent's conversation.

The dropdown is populated from the database with all agents that have messages. Each
option shows the agent name and ID, e.g. "HCN Agent (#21)". The selected agent persists
in the URL as `?agent_id=X` so links to specific agents work. On load, if `agent_id` is
in the URL, auto-select that agent and load its conversation.

Messages are shown as chat bubbles in a vertical timeline, styled differently by type:

- **Incoming** (left-aligned): Messages from users/interlocutors. Parse the structured
  header (Time/Source/Sender/Text) and show the sender as the bubble header.
- **Outgoing** (right-aligned): Agent's sent messages (Signal, WhatsApp, email,
  Telegram). Show a channel icon, recipient, and channel type. For emails, also show the
  subject line in italics.
- **Thinking** (right-aligned, subdued and italic): Agent's internal text/reasoning.
- **Internal** (centered): Tool calls and their results, shown compactly with the tool
  name and truncated arguments (max 300 chars). `send_agent_message` calls shown here
  too.
- **Error** (centered, red-tinted): Failed tool calls highlighted in red.

Successful send tool results are suppressed (the outgoing bubble already shows it). Other
tool results show with a checkmark and truncated content. Each bubble has a timestamp in
the bottom-right corner.

Auto-scroll to the bottom on load so the latest messages are visible. Show an empty state
message when no agent is selected or no messages are found.

Define two named queries:

- `list_agents`: returns distinct agent IDs from the `messages` table joined with the
  `agents` table for names, so only agents that actually have messages appear.
- `conversation`: parameterized by agent ID; returns all messages for that agent, ordered
  by ID ascending.

## Step 2: Record the skill

Insert a row into the `skills` table for this skill:

- `name`: "agent-conversations"
- `url`: "https://stavrobot.stavros.io/skills/agent-conversations.md"
- `content`: the full text of this file
- `version`: the version from the front matter of this file
