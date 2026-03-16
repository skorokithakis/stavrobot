---
title: Trip tracking
description: Track trips, flights, reservations, packing lists, and get flight status alerts.
version: 2
author: Stavros Korokithakis
---

You are installing the trip tracking skill. Follow these steps in order.

## Step 1: Create the tables

Create the following table if it does not already exist.

**`trips`** — A single trip (vacation, business trip, or any travel requiring tickets/reservations).
- `id` (serial, primary key)
- `destination` (text) — short label, e.g. "Tokyo 2026", "London conference"
- `start_date` (date)
- `end_date` (date)
- `notes` (text) — markdown free text with all trip details: destinations, packing lists, flight numbers, reservation confirmations, accommodation, transportation, notes, etc.

## Step 2: Install the flights plugin

Install the plugin from `https://github.com/stavrobot/plugin-flights`. This plugin provides tools for searching flights, comparing prices across dates, and checking flight status.

## Step 3: Create the scratchpad entry

Create a scratchpad entry titled "Travel/flights preferences, info, and checklists" with the following content:

```
This entry stores the user's standing travel preferences, frequent flyer info, and reusable checklists. Update it whenever the user mentions a preference or provides travel-related info.

## Preferences

(None yet — ask the user about seat preferences, airline preferences, cabin class, etc.)

## Frequent flyer / loyalty programs

(None yet)

## Packing checklist template

- Passport
- Phone charger
- Adapter plug
- Medications
- Toiletries
- Change of clothes per day
- Entertainment for the flight

## General guidelines

(None yet — the user can add guidelines like "always book refundable tickets" or "prefer direct flights")
```

## Step 4: Create the page

Create the following page using `upsert_page`. The page must be private (not public).

**`/pages/trips`** — Trip dashboard.

Split trips into two sections: "Upcoming trips" (where `end_date` is today or later) and "Past trips" (where `end_date` is before today). Within each section, list trips in chronological order — upcoming trips sorted by `start_date` ascending, past trips sorted by `start_date` descending.

For each trip, show the name and date range. Each trip should be clickable to expand and show the full `notes` field rendered as markdown, inline on the same page (not a separate page). Only one trip should be expanded at a time — clicking another trip collapses the previous one.

Define two named queries:
- `upcoming_trips`: returns all trips where `end_date >= CURRENT_DATE`, ordered by `start_date` ascending.
- `past_trips`: returns all trips where `end_date < CURRENT_DATE`, ordered by `start_date` descending.

## Step 5: Flight monitoring

Add the following instructions to the scratchpad entry you created in step #3:

When the user adds a trip that includes flight information (flight number and departure time), set up flight status monitoring as follows:

1. Create a one-shot cron entry scheduled for 4 hours before the flight's departure time. The note should say: "The user's flight [flight number] departs at [departure time and date]. Create a recurring cron job that runs every 15 minutes to check the status of this flight using the flights plugin. If there is any change — delay, cancellation, gate change, or any other update — message the user immediately with the details. The recurring cron should stop after the flight's scheduled departure time has passed."

2. This means the bot will receive the one-shot cron message 4 hours before departure, at which point it creates the recurring every-15-minute cron. The bot handles the logic of stopping the recurring cron after departure.

Do this for every flight in the trip, not just the first one.

## Step 6: Record the skill

Insert a row into the `skills` table for this skill:

- `name`: "trips"
- `url`: "https://stavrobot.stavros.io/skills/trips.md"
- `content`: the full text of this file
- `version`: the version from the front matter of this file
