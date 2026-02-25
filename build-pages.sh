#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

rm -rf "$REPO_ROOT/output"

mkdir -p "$REPO_ROOT/output"

mkdir -p "$REPO_ROOT/output/skills"

# Write the index header unconditionally; rows are appended per skill file below.
{
	echo "# Skills"
	echo ""
	echo "| File | Title | Description | Version |"
	echo "|------|-------|-------------|---------|"
} >"$REPO_ROOT/output/skills/index.md"

if [ -d "$REPO_ROOT/skills" ]; then
	for skill_file in "$REPO_ROOT/skills/"*.md; do
		# The glob expands to a literal string when there are no matches, so skip
		# if the path doesn't actually exist.
		[ -f "$skill_file" ] || continue

		filename="$(basename "$skill_file")"
		cp "$skill_file" "$REPO_ROOT/output/skills/$filename"

		# Extract front matter values. awk reads between the first pair of --- lines
		# and prints the value for each key we care about.
		title="$(awk '/^---/{f=!f; next} f && /^title:/{sub(/^title:[[:space:]]*/, ""); print; exit}' "$skill_file")"
		description="$(awk '/^---/{f=!f; next} f && /^description:/{sub(/^description:[[:space:]]*/, ""); print; exit}' "$skill_file")"
		version="$(awk '/^---/{f=!f; next} f && /^version:/{sub(/^version:[[:space:]]*/, ""); print; exit}' "$skill_file")"

		echo "| $filename | $title | $description | $version |" >>"$REPO_ROOT/output/skills/index.md"
	done
fi
