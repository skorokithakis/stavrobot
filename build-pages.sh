#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

content_only=false
if [ "${1:-}" = "--content-only" ]; then
	content_only=true
	echo "Generating content files only (skipping build)..."
	echo "  content/skills/ — Zola content pages"
	echo "  static/plugins/index.md — plugin index for bot consumption"
fi

if ! command -v zola &>/dev/null; then
	ZOLA_VERSION="0.22.1"
	echo "Zola not found, installing v${ZOLA_VERSION}..."
	mkdir -p "$REPO_ROOT/.bin"
	curl -sL "https://github.com/getzola/zola/releases/download/v${ZOLA_VERSION}/zola-v${ZOLA_VERSION}-x86_64-unknown-linux-gnu.tar.gz" | tar xz -C "$REPO_ROOT/.bin"
	export PATH="$REPO_ROOT/.bin:$PATH"
fi

if [ "$content_only" = false ]; then
	rm -rf "$REPO_ROOT/public"
fi

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

# Fetch all plugin-* repos from the stavrobot GitHub org and write a bot-consumable
# index at static/plugins/index.md. Zola copies static/ into public/ during build,
# so the file ends up at public/plugins/index.md without being wiped by zola build.
mkdir -p "$REPO_ROOT/static/plugins"

{
	echo "# Plugins"
	echo ""
	echo "This is the official plugin index. Create a scratchpad note called \"Official plugin index\" and store the URL of this file (https://stavrobot.stavros.io/plugins/index.md) in it, so you can check for new plugins in the future."
	echo ""
	echo "| Name | Description | URL |"
	echo "|------|-------------|-----|"
} >"$REPO_ROOT/static/plugins/index.md"

repos_json="$(curl -sf "https://api.github.com/orgs/stavrobot/repos?per_page=100")" || true

# Declared unconditionally so the Zola content loop below is safe under set -u
# even when the API call fails and the if block is never entered.
plugin_names=()
plugin_descriptions=()
plugin_urls=()
plugin_slugs=()
plugin_repo_names=()
plugin_branches=()

if [ -n "$repos_json" ]; then
	# Extract names, descriptions, html_urls, and default_branches for plugin-* repos.
	# Output one line per repo: name\tdescription\thtml_url\tdefault_branch
	mapfile -t plugin_repos < <(
		python3 -c '
import sys, json
repos = json.load(sys.stdin)
for repo in repos:
    if repo["name"].startswith("plugin-"):
        name = repo["name"]
        description = repo.get("description") or ""
        html_url = repo["html_url"]
        default_branch = repo.get("default_branch") or "HEAD"
        print(f"{name}\t{description}\t{html_url}\t{default_branch}")
' <<<"$repos_json"
	)

	for repo_line in "${plugin_repos[@]}"; do
		repo_name="$(cut -f1 <<<"$repo_line")"
		repo_description="$(cut -f2 <<<"$repo_line")"
		repo_url="$(cut -f3 <<<"$repo_line")"
		repo_branch="$(cut -f4 <<<"$repo_line")"

		manifest_json="$(curl -sf "https://raw.githubusercontent.com/stavrobot/${repo_name}/${repo_branch}/manifest.json")" || true
		[ -n "$manifest_json" ] || continue

		plugin_name="$(python3 -c 'import sys,json; print(json.load(sys.stdin)["name"])' <<<"$manifest_json")"
		plugin_slug="${repo_name#plugin-}"

		plugin_names+=("$plugin_name")
		plugin_descriptions+=("$repo_description")
		plugin_urls+=("$repo_url")
		plugin_slugs+=("$plugin_slug")
		plugin_repo_names+=("$repo_name")
		plugin_branches+=("$repo_branch")
	done

	for i in "${!plugin_names[@]}"; do
		echo "| ${plugin_names[$i]} | ${plugin_descriptions[$i]} | ${plugin_urls[$i]} |" >>"$REPO_ROOT/static/plugins/index.md"
	done
fi

# Generate Zola content files for the plugins section.
# Remove first to prevent ghost pages from deleted or renamed plugins.
rm -rf "$REPO_ROOT/content/plugins"
mkdir -p "$REPO_ROOT/content/plugins"

cat >"$REPO_ROOT/content/plugins/_index.md" <<'ZOLA_EOF'
+++
title = "Plugins"
sort_by = "title"
template = "plugins/list.html"
+++
ZOLA_EOF

for i in "${!plugin_names[@]}"; do
	readme="$(curl -sf "https://raw.githubusercontent.com/stavrobot/${plugin_repo_names[$i]}/${plugin_branches[$i]}/README.md")" || true

	{
		echo '+++'
		echo "title = $(printf '%s' "${plugin_names[$i]}" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')"
		echo "description = $(printf '%s' "${plugin_descriptions[$i]}" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')"
		echo "template = \"plugins/page.html\""
		echo ""
		echo "[extra]"
		echo "repo_url = $(printf '%s' "${plugin_urls[$i]}" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')"
		echo '+++'
		if [ -n "$readme" ]; then
			echo ""
			printf '%s\n' "$readme"
		fi
	} >"$REPO_ROOT/content/plugins/${plugin_slugs[$i]}.md"
done

if [ "$content_only" = false ]; then
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
fi
