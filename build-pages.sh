#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v zola &>/dev/null; then
	ZOLA_VERSION="0.22.1"
	echo "Zola not found, installing v${ZOLA_VERSION}..."
	curl -sL "https://github.com/getzola/zola/releases/download/v${ZOLA_VERSION}/zola-v${ZOLA_VERSION}-x86_64-unknown-linux-gnu.tar.gz" | tar xz -C /usr/local/bin
fi

rm -rf "$REPO_ROOT/public"

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
