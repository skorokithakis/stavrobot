---
title: Todos
description: Simple task tracking with titles, descriptions, due dates, and completion status.
version: 1
author: Stavros Korokithakis
---

You are installing the todos skill. Follow these steps in order.

## Step 1: Create the todos table

Create the following table if it does not already exist.

**`todos`** — A single task.
- `id` (serial, primary key)
- `title` (text) — short name of the task
- `description` (text, nullable) — optional longer explanation
- `done` (boolean, nullable, default false)
- `created_at` (timestamptz, nullable, default now())
- `completed_at` (timestamptz, nullable) — set when the task is marked done
- `due_date` (date, nullable)

## Step 2: Record the skill

Insert a row into the `skills` table for this skill:

- `name`: "todos"
- `url`: "https://stavrobot.stavros.io/skills/todos.md"
- `content`: the full text of this file
- `version`: the version from the front matter of this file
