#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

rm -rf "$REPO_ROOT/public"

# Build the Zola site into public/.
zola build

# Copy raw skill .md files into the Zola output so they're served as-is at
# their original URLs (the bot fetches these as raw markdown).
mkdir -p "$REPO_ROOT/public/skills"

# Write the index header unconditionally; rows are appended per skill file below.
{
	echo "# Skills"
	echo ""
	echo "| File | Title | Description | Version |"
	echo "|------|-------|-------------|---------|"
} >"$REPO_ROOT/public/skills/index.md"

if [ -d "$REPO_ROOT/skills" ]; then
	for skill_file in "$REPO_ROOT/skills/"*.md; do
		[ -f "$skill_file" ] || continue

		filename="$(basename "$skill_file")"
		cp "$skill_file" "$REPO_ROOT/public/skills/$filename"

		title="$(awk '/^---/{f=!f; next} f && /^title:/{sub(/^title:[[:space:]]*/, ""); print; exit}' "$skill_file")"
		description="$(awk '/^---/{f=!f; next} f && /^description:/{sub(/^description:[[:space:]]*/, ""); print; exit}' "$skill_file")"
		version="$(awk '/^---/{f=!f; next} f && /^version:/{sub(/^version:[[:space:]]*/, ""); print; exit}' "$skill_file")"

		echo "| $filename | $title | $description | $version |" >>"$REPO_ROOT/public/skills/index.md"
	done
fi
