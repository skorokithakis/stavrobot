---
title: Skill authoring guide
description: Teaches Stavrobot the conventions for writing new skills — file format, front matter, body structure, tables, pages, scratchpad, memories, cron jobs, plugins, and design principles.
version: 1
author: Stavros Korokithakis
---

You are installing the skill authoring guide. Follow these steps in order.

## Step 1: Create the scratchpad entry

Create a scratchpad entry titled "Skill authoring guide" with the following content:

## File format

Skill files live in `skills/` and are named with short, descriptive, kebab-case names (e.g. `gym.md`, `meal-planning.md`, `finance.md`).

Every skill file has two parts: YAML front matter and a body.

**Front matter** — enclosed in `---` delimiters at the top:

```yaml
---
title: Gym tracking
description: Track workouts, exercises, body measurements, and view progress over time.
version: 1
author: Stavros Korokithakis
---
```

| Field | Required | Notes |
|-------|----------|-------|
| `title` | Yes | Human-readable name shown in the skill index |
| `description` | Yes | One-line summary |
| `version` | Yes | Integer, starting at 1. Increment on every change. |
| `author` | No | Who wrote the skill |

**Body** — plain-language instructions addressed directly to the bot. Use numbered steps with markdown headers (`## Step 1: ...`). The bot follows steps in order. The last step must always record the skill in the `skills` table.

## Body structure

- Address the bot directly: "Create a table...", "Store a scratchpad entry...", "Install the plugin from...".
- Use numbered steps: `## Step 1: Create the tables`, `## Step 2: Create the pages`, etc.
- Keep steps focused — one step per system (tables in one step, pages in another, etc.).
- The last step must always be "Record the skill" (see below).

## Database tables

The bot has full read/write access to PostgreSQL via `execute_sql`. Describe tables in plain language; the bot generates the SQL.

Always phrase table creation as "create if not exists" so the skill is safe to re-run.

Describe each table with its name, then each column with type, nullability, defaults, and constraints:

```
**`workouts`** — A single gym session.
- `id` (serial, primary key)
- `date` (date)
- `notes` (text) — how the session felt, energy level, etc.
- `duration_minutes` (integer, nullable)
```

**Column type guidance:**
- `text` for strings (never `varchar` with a length limit unless there is a real reason).
- `serial` for auto-incrementing integer primary keys.
- `integer` or `numeric` for numbers; use `numeric` when precision matters (weights, money).
- `date` for calendar dates; `timestamptz` for timestamps with timezone.
- `boolean` for true/false values.
- Mark columns `nullable` explicitly when they may be absent. Unmarked columns become `NOT NULL`.

**Foreign keys:** Describe as "references `other_table`" or "references `other_table(column)`".

## Pages

The bot creates web pages at `/pages/<path>` using `upsert_page`. Pages support live data via named SQL queries.

- Pages are private (requires authentication) by default. State visibility explicitly.
- Named queries are SQL strings stored alongside the page. The page's JavaScript fetches live data via `GET /api/pages/<path>/queries/<name>`.
- Query endpoints inherit the page's visibility: public pages expose public query endpoints; private pages require authentication for query access.
- Query parameters use `$param:name` placeholders in the SQL; the client passes values via query string (e.g. `?name=squat`).

Describe what the page should show and what queries it needs. Do not write HTML or JavaScript — the bot generates the implementation. Be specific about the data (tables, columns, ordering, filters) but leave visual design to the bot.

Example page description:

```
**`/pages/gym`** — Main dashboard.

Show the latest body measurement at the top of the page. Below that, list the most
recent 10 workouts in reverse chronological order. For each workout, show the date,
duration (if set), any notes, and a breakdown of every set performed: exercise name,
set number, reps, weight, and set notes.

Define two named queries:
- `recent_workouts`: returns the 10 most recent workouts joined with their sets and
  the exercise name, ordered by workout date descending then by set number ascending.
- `latest_measurement`: returns the single most recent row from `body_measurements`.
```

Parameterized query example:

```
- `exercise_progress`: parameterized by exercise name; returns the maximum weight
  lifted for that exercise per workout date, ordered by date ascending.
```

## Scratchpad

The scratchpad is a second-tier knowledge store managed via `manage_knowledge` with `store: "scratchpad"`. Entry titles appear in the bot's context on every turn; bodies are loaded on demand.

Use the scratchpad for reference material, detailed instructions, or domain knowledge the bot should be able to look up but does not need in context constantly. Examples: dietary preferences, a list of known exercises, a description of a workflow.

Give each entry a title (under 50 characters, descriptive enough to identify the content at a glance) and specify the body content.

Example:

```
## Step 2: Store dietary preferences in the scratchpad

Create a scratchpad entry titled "Dietary preferences" with the following content:

The user is vegetarian and avoids gluten. They prefer metric units for all measurements.
```

## Memories

Memories are managed via `manage_knowledge` with `store: "memory"`. The full content of every memory is injected into the bot's context on every turn.

Use memories only for things the bot needs to know constantly — facts relevant to almost every interaction. The bar is high. Most skills should not create memories. Use the scratchpad instead.

A memory is appropriate when the information would otherwise need to be looked up on nearly every turn. For example: "User prefers metric units for gym weights" is a reasonable memory if the user logs workouts daily. A list of 50 exercises is not — that belongs in the scratchpad.

Keep memory content concise (a few sentences at most).

Example:

```
## Step 2: Store a memory

Create a memory with the following content:

The user tracks gym workouts daily and prefers weights in kilograms.
```

## Cron jobs

The bot schedules tasks via `manage_cron`.

- **Recurring:** Use a cron expression (e.g. `0 9 * * *` for 9 AM daily).
- **One-shot:** Use an ISO 8601 datetime string.

Each cron entry has a `note` field — the message the bot receives when the entry fires. Write the note as if you were sending the bot a message at that time.

Use cron for periodic reminders, scheduled data collection, or recurring reports.

Example:

```
## Step 3: Set up a daily reminder

Create a cron entry with the expression `0 8 * * *` (8 AM every day) and the note:
"Remind the user to log their morning weight measurement."
```

## Plugins

The bot installs plugins from git URLs using `install_plugin`. Plugins extend the bot with capabilities beyond its built-in tools (e.g. a weather plugin, a calendar integration).

Official plugins are listed at `https://github.com/orgs/stavrobot/repositories`.

Use plugin installation only when the skill needs a capability that built-in tools cannot provide. If the skill only needs tables, pages, and knowledge entries, no plugin is needed.

Provide the git URL and any configuration the plugin needs.

Example:

```
## Step 2: Install the weather plugin

Install the plugin from `https://github.com/stavrobot/weather-plugin`. After installing,
configure it with the user's preferred location.
```

## Recording the skill

Every skill must end with a step that inserts a row into the `skills` table:

```
## Step N: Record the skill

Insert a row into the `skills` table for this skill:

- `name`: "your-skill-name"
- `url`: "https://stavrobot.stavros.io/skills/your-skill-name.md"
- `content`: the full text of this file
- `version`: the version from the front matter of this file
```

The `skills` table has columns: `name` (text, primary key), `url` (text), `content` (text), `version` (integer), `installed_at` (timestamp), `updated_at` (timestamp). It is created by the bootstrap skill.

## Design principles

**One domain per skill.** Focus on a single area: gym tracking, meal planning, finances. Do not bundle unrelated functionality. If two domains share a table, that is a sign they should be separate skills with a shared dependency, or that the domain boundary needs rethinking.

**Don't overlap with other skills.** Before creating tables, check whether an existing skill already covers the same domain. The skill index at `https://stavrobot.stavros.io/skills/index.md` lists all available skills.

**Describe, don't implement.** For pages, describe what they should show and what data they need — do not write HTML or JavaScript. For tables, describe columns and types — do not write SQL. Over-specifying implementation details wastes space and can constrain the bot unnecessarily.

**Idempotency.** Use "if not exists" language for table creation. A skill should be safe to install more than once and safe to re-run after a partial failure.

**Versioning.** Start at version 1. Increment whenever you change the skill. When the bot detects that the installed version is lower than the fetched version, it reads the old skill content from the database and the new content from the file, determines what changed, and presents a migration summary before applying it. Write skills so the migration path is clear from the diff: if you add a column, say so explicitly; if you rename a table, note the old name.

**Keep it concise.** Be specific about *what* (schema, page content, queries) but not *how* (exact SQL, exact HTML). A well-written skill is readable in under two minutes.

**Private by default.** Pages should be private unless there is a specific reason to make them public. State visibility explicitly in the skill.

**Memories sparingly.** Most skills should not create memories. If in doubt, use the scratchpad.

## Step 2: Record the skill

Insert a row into the `skills` table for this skill:

- `name`: "skill-authoring"
- `url`: "https://stavrobot.stavros.io/skills/skill-authoring.md"
- `content`: the full text of this file
- `version`: the version from the front matter of this file
