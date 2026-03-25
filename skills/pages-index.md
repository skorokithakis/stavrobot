---
title: Pages index
description: Creates a central directory page that lists all pages registered in the system. Each page is shown as a clickable card with its path, public/private status, and last update time. Useful for navigating between skill-generated pages.
version: 1
author: Stavros Korokithakis
---

You are installing the pages index skill. Follow these steps in order.

## Step 1: Create the page

Create the following page using `upsert_page`. The page must be private (not public).

**`/pages/index`** — Pages index.

Show a clean, single centered column listing all pages registered in the system,
excluding this page itself. Each entry is a clickable card that links to
`/pages/<path>`. Each card displays the page path, a badge indicating whether the page
is public or private, and the date it was last updated. If there are no pages to show,
display a friendly empty state message. The layout should be minimal and work well on
mobile.

Define one named query:

- `pages`: `SELECT path, is_public, created_at, updated_at FROM pages WHERE path != 'index' ORDER BY path`

## Step 2: Record the skill

Insert a row into the `skills` table for this skill:

- `name`: "pages-index"
- `url`: "https://stavrobot.stavros.io/skills/pages-index.md"
- `content`: the full text of this file
- `version`: the version from the front matter of this file
