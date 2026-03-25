#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v zola &>/dev/null; then
	ZOLA_VERSION="0.22.1"
	echo "Zola not found, installing v${ZOLA_VERSION}..."
	mkdir -p "$REPO_ROOT/.bin"
	curl -sL "https://github.com/getzola/zola/releases/download/v${ZOLA_VERSION}/zola-v${ZOLA_VERSION}-x86_64-unknown-linux-gnu.tar.gz" | tar xz -C "$REPO_ROOT/.bin"
	export PATH="$REPO_ROOT/.bin:$PATH"
fi

rm -rf "$REPO_ROOT/public"

# Generate Zola content files for the skills section before building.
# These are derived from skills/*.md and are not committed (see .gitignore).
# Remove first to prevent ghost pages from deleted or renamed skills.
rm -rf "$REPO_ROOT/content/skills"
mkdir -p "$REPO_ROOT/content/skills"

cat >"$REPO_ROOT/content/skills/_index.md" <<'ZOLA_EOF'
+++
title = "Skills"
sort_by = "title"
template = "skills/list.html"
+++
ZOLA_EOF

if [ -d "$REPO_ROOT/skills" ]; then
	for skill_file in "$REPO_ROOT/skills/"*.md; do
		[ -f "$skill_file" ] || continue

		filename="$(basename "$skill_file")"
		slug="${filename%.md}"

		title="$(awk '/^---/{f=!f; next} f && /^title:/{sub(/^title:[[:space:]]*/, ""); print; exit}' "$skill_file")"
		description="$(awk '/^---/{f=!f; next} f && /^description:/{sub(/^description:[[:space:]]*/, ""); print; exit}' "$skill_file")"
		version="$(awk '/^---/{f=!f; next} f && /^version:/{sub(/^version:[[:space:]]*/, ""); print; exit}' "$skill_file")"
		author="$(awk '/^---/{f=!f; next} f && /^author:/{sub(/^author:[[:space:]]*/, ""); print; exit}' "$skill_file")"

		# Extract the body (everything after the closing --- of the front matter).
		# Count the first two --- delimiters (front matter open/close) and skip them.
		# Any --- lines after the second delimiter are body content and are printed verbatim.
		body="$(awk '/^---/ && count < 2 {count++; next} count >= 2' "$skill_file")"

		# Write a Zola content file with TOML front matter.
		# version and author go under [extra] since Zola only knows title/description natively.
		# is_bootstrap lets the list template render bootstrap separately from regular skills.
		is_bootstrap="false"
		[ "$filename" = "bootstrap.md" ] && is_bootstrap="true"

		{
			echo '+++'
			echo "title = $(printf '%s' "$title" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')"
			echo "description = $(printf '%s' "$description" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')"
			echo "template = \"skills/page.html\""
			echo ""
			echo "[extra]"
			echo "version = $(printf '%s' "$version" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')"
			echo "author = $(printf '%s' "$author" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')"
			echo "is_bootstrap = $is_bootstrap"
			echo '+++'
			echo ""
			printf '%s\n' "$body"
		} >"$REPO_ROOT/content/skills/${slug}.md"
	done
fi

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
