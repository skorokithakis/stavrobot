---
title: Todos
description: Simple task tracking with titles, descriptions, due dates, and completion status.
version: 2
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

## Step 2: Create the page

Create the following page using `upsert_page`. The page must be private.

**`/pages/todos`** — Todo list.

Show all todos in two sections: open tasks first, then completed tasks.

**Open tasks:** Show all todos where `done` is false, ordered by due date ascending (oldest due first), with todos that have no due date listed last. For each todo, show the title, description (if set), and due date (if set). Highlight overdue todos (due date in the past).

**Completed tasks:** Show all todos where `done` is true, with each title struck through, ordered by `completed_at` descending. For each, show the title and completion date.

Define two named queries:
- `open_todos`: returns all todos where `done` is false, ordered by due date ascending with nulls last.
- `completed_todos`: returns all todos where `done` is true, ordered by `completed_at` descending.

## Step 3: Record the skill

Insert a row into the `skills` table for this skill:

- `name`: "todos"
- `url`: "https://stavrobot.stavros.io/skills/todos.md"
- `content`: the full text of this file
- `version`: the version from the front matter of this file
