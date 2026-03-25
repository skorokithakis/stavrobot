---
title: People and places
description: Keep track of the important people and places in your life. Store relationships, closeness ratings, notes, and tags, with fuzzy search powered by trigram matching. Stavrobot will proactively offer to remember new people and places as they come up in conversation, and surface relevant context when you mention them later.
version: 1
author: Stavros Korokithakis
---

This skill sets up a system for tracking the important people and places in the user's life. It creates database tables, indexes, and behavioral rules (stored as a scratchpad entry).

The system is designed for a user who mentions people and places in conversation. The bot should proactively offer to store new people and places when they come up naturally, and should surface relevant context (e.g. notes about a person, or pending todos at a location) when appropriate.

When other skills or tables reference people or places (e.g. a diary, a workout log, an event tracker), they should add foreign keys pointing to the `people` and `places` tables as appropriate. This keeps relationships centralized rather than duplicating names as plain text.

## Step 1: Enable the pg_trgm extension

Enable the `pg_trgm` extension if it does not already exist. This is needed for fuzzy/similarity search on names.

## Step 2: Create the `people` table

Create a table called `people` if it does not already exist, with these columns:

- `id` (serial, primary key)
- `name` (text, not null) - the person's full name.
- `relationship` (text, nullable) - how the user knows them (e.g. "close friend", "colleague", "partner", "pet").
- `notes` (text, nullable) - freeform notes about the person (nicknames, where they live, interests, anything useful to remember).
- `created_at` (timestamptz, default now())
- `closeness` (integer, nullable, check between 1 and 10) - how close the user is to this person. 1 = distant acquaintance, 10 = closest family/partner.

Create a trigram index on the `name` column using `gin_trgm_ops` for fuzzy search. This allows finding people even with typos or partial matches.

## Step 3: Create the `places` table

Create a table called `places` if it does not already exist, with these columns:

- `id` (serial, primary key)
- `name` (text, not null) - the place's name.
- `type` (text, nullable) - what kind of place it is (e.g. "restaurant", "bar", "cafe", "park", "workplace", "home", "gym").
- `location` (text, not null) - the city or area where the place is. Used for disambiguation when multiple places share a name.
- `notes` (text, nullable) - freeform notes. Use this for place-specific reminders, reviews, or anything worth remembering.
- `created_at` (timestamptz, default now())
- `tags` (text array, default empty array) - flexible tagging. The tag `want-to-visit` specifically marks places the user wants to visit in the future. Other useful tags: `visited`, `favorite`, `avoid`.
- `rating` (integer, nullable, check between 1 and 5) - the user's rating of the place.

Create a GIN index on the `tags` column for efficient tag-based filtering.

Create a trigram index on the `name` column using `gin_trgm_ops` for fuzzy search.

## Step 4: Store behavioral rules in the scratchpad

Create a scratchpad entry titled "People and places rules" with the following content:

---

**Rules for managing people and places:**

**Adding new entries:**
- Before adding any new person or place, always search existing entries to avoid duplicates. For people, use trigram similarity (the `%` operator or `similarity()` function with pg_trgm) and search both the `name` AND `notes` fields. For places, search `name` and `notes`.
- When the user mentions a new person or place that seems significant, ask for details before storing. For people: ask about their relationship to the user, any notes worth remembering, and optionally closeness. For places: ask about the type, location (default to the user's home city if not specified), any notes, and optionally rating and tags.
- Do not silently add minimal stubs. Get at least a name and relationship (for people) or name and location (for places) before creating a record.

**Searching and surfacing context:**
- When a person or place comes up in conversation that might be in the database, search for them and surface any useful context (notes, tags, rating, relationship). Don't do this for passing geographic mentions - only when the person or place is the subject of conversation.
- When the user says they are leaving a place (e.g. "I'm heading out" while at a known location), check open todos for anything tied to that place.

**Foreign key integration:**
- When other tables track events, logs, or entries that involve specific people or places, they should reference the `people` and `places` tables via foreign keys rather than storing names as plain text. This keeps data normalized and enables queries like "show me everything involving person X" across the whole system.

**Tags for places:**
- The `want-to-visit` tag marks places the user wants to try in the future. When the user says something like "I want to check out [place]", add or create the place with this tag.
- When the user asks for recommendations or "where should I go", query places with the `want-to-visit` tag.
- When the user visits a place tagged `want-to-visit`, remove the tag and optionally add `visited`.

---

## Step 5: Record the skill

Insert a row into the `skills` table for this skill:

- `name`: "people-and-places"
- `url`: "https://stavrobot.stavros.io/skills/people-and-places.md"
- `content`: the full text of this file
- `version`: the version from the front matter of this file
