---
title: Gym tracking
description: Track workouts, exercises, body measurements, and view progress over time.
version: 2
author: Stavros Korokithakis
---

You are installing the gym tracking skill. Follow these steps in order.

## Step 1: Create the tables

Create the following tables if they do not already exist.

**`exercises`** — Exercise catalog.
- `name` (text, primary key) — e.g. "bench press", "squat"
- `notes` (text) — form cues, variations, equipment notes

**`workouts`** — A single gym session.
- `id` (serial, primary key)
- `date` (date)
- `notes` (text) — how the session felt, energy level, etc.
- `duration_minutes` (integer, nullable)

**`workout_sets`** — Individual sets within a workout.
- `id` (serial, primary key)
- `workout_id` (integer, references `workouts`)
- `exercise_name` (text, references `exercises`)
- `set_number` (integer)
- `reps` (integer)
- `weight` (numeric) — in whatever unit the user prefers
- `notes` (text) — e.g. "felt easy", "failed on last rep"

**`body_measurements`** — Body weight and other measurements over time.
- `id` (serial, primary key)
- `date` (date)
- `weight` (numeric, nullable)
- `body_fat_percentage` (numeric, nullable)
- `notes` (text)

## Step 2: Create the pages

Create the following four pages using `upsert_page`. All pages must be private (not public).

**`/pages/gym`** — Workout list.

Show the latest body measurement at the top of the page. Below that, list the most recent workouts in reverse chronological order. For each workout, show the date, duration (if set), notes, and a brief summary (e.g. number of exercises and total sets). Each workout should be a clickable link to its detail page at `/pages/gym/workout?id=<workout_id>`.

Define two named queries:
- `recent_workouts`: returns recent workouts ordered by date descending, with a count of distinct exercises and total sets for each.
- `latest_measurement`: returns the single most recent row from `body_measurements`.

**`/pages/gym/workout`** — Workout detail.

Shows the full detail of a single workout, identified by the `id` query parameter. Display the date, duration (if set), notes, and a full breakdown of every set performed: exercise name, set number, reps, weight, and set notes. Group sets by exercise.

Define one named query:
- `workout_detail`: parameterized by workout id; returns all sets for that workout joined with the exercise name, ordered by exercise name then set number.

**`/pages/gym/progress`** — Progress tracking.

Show two charts:
1. Body weight over time, plotted from all rows in `body_measurements` that have a non-null weight.
2. Weight progression for a selected exercise over time. The user picks an exercise from a dropdown; the chart updates to show the maximum weight lifted for that exercise per workout date.

Define three named queries:
- `body_weight_history`: returns all `body_measurements` rows with a non-null weight, ordered by date ascending.
- `exercise_list`: returns all exercise names from the `exercises` table, ordered alphabetically.
- `exercise_progress`: parameterized by exercise name; returns the maximum weight lifted for that exercise per workout date, ordered by date ascending.

**`/pages/gym/exercises`** — Exercise catalog.

Show a simple table listing all exercises with their name and notes, ordered alphabetically by name.

Define one named query:
- `all_exercises`: returns all rows from `exercises`, ordered by name ascending.

## Step 3: Record the skill

Insert a row into the `skills` table for this skill:

- `name`: "gym"
- `url`: "https://stavrobot.stavros.io/skills/gym.md"
- `content`: the full text of this file
- `version`: the version from the front matter of this file
