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
			echo "title = $(printf '%s' "$title" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read(), ensure_ascii=False))')"
			echo "description = $(printf '%s' "$description" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read(), ensure_ascii=False))')"
			echo "template = \"skills/page.html\""
			echo ""
			echo "[extra]"
			echo "version = $(printf '%s' "$version" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read(), ensure_ascii=False))')"
			echo "author = $(printf '%s' "$author" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read(), ensure_ascii=False))')"
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

# Parse a manifest.json on stdin and print name, summary, and description as
# tab-separated fields. Exits non-zero if the JSON is missing or unparseable.
parse_manifest() {
	python3 -c '
import re, sys, json
manifest = json.load(sys.stdin)
def clean(value):
    return re.sub(r"\s+", " ", value).strip()
print("\t".join([
    clean(manifest["name"]),
    clean(manifest.get("summary") or ""),
    clean(manifest.get("description") or ""),
]))
'
}

{
	echo "# Plugins"
	echo ""
	echo "This is the official plugin index. Create a scratchpad note called" \
		"\"Official plugin index\" and store the this list of plugins, so you always" \
		"know what plugins are available. Also, store the URL of this file" \
		"(https://stavrobot.stavros.io/plugins/index.md) in it, so you can check for" \
		"new plugins in the future. Finally, create a cron entry to fire every Sunday" \
		"at some point in the early morning (during the user's regular sleeping hours)" \
		"to update the scratchpad entry from the plugin index. The cron entry should" \
		"not message the user."
	echo ""
	echo "The Source column shows where each plugin comes from. Official plugins are" \
		"maintained by the Stavrobot project. Third-party plugins are written by other" \
		"people and are not reviewed or audited. Tell the user this before you install" \
		"a third-party plugin."
	echo ""
	echo "| Name | Description | URL | Source |"
	echo "|------|-------------|-----|--------|"
} >"$REPO_ROOT/static/plugins/index.md"

# Use a GitHub token if available to avoid API rate limits on shared CI IPs.
gh_auth=()
if [ -n "${GITHUB_TOKEN:-}" ]; then
	gh_auth=(-H "Authorization: token $GITHUB_TOKEN")
fi

repos_json="$(curl -sf "${gh_auth[@]}" "https://api.github.com/orgs/stavrobot/repos?per_page=100")" || true

# Parallel arrays describing every plugin (official and third-party). They are
# filled in below and then sorted together by display name.
plugin_names=()
plugin_descriptions=()
plugin_urls=()
plugin_slugs=()
plugin_sources=()
plugin_readmes=()

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
' <<<"$repos_json" | sort
	)

	for repo_line in "${plugin_repos[@]}"; do
		repo_name="$(cut -f1 <<<"$repo_line")"
		repo_description="$(cut -f2 <<<"$repo_line")"
		repo_url="$(cut -f3 <<<"$repo_line")"
		repo_branch="$(cut -f4 <<<"$repo_line")"

		manifest_json="$(curl -sf "https://raw.githubusercontent.com/stavrobot/${repo_name}/${repo_branch}/manifest.json")" || true
		[ -n "$manifest_json" ] || continue

		manifest_fields="$(parse_manifest <<<"$manifest_json")"
		plugin_name="$(cut -f1 <<<"$manifest_fields")"
		manifest_summary="$(cut -f2 <<<"$manifest_fields")"
		plugin_slug="${repo_name#plugin-}"

		# A manifest summary takes precedence over the GitHub repo description.
		plugin_description="$repo_description"
		if [ -n "$manifest_summary" ]; then
			plugin_description="$manifest_summary"
		fi

		readme="$(curl -sf "https://raw.githubusercontent.com/stavrobot/${repo_name}/${repo_branch}/README.md")" || true

		plugin_names+=("$plugin_name")
		plugin_descriptions+=("$plugin_description")
		plugin_urls+=("$repo_url")
		plugin_slugs+=("$plugin_slug")
		plugin_sources+=("official")
		plugin_readmes+=("$readme")
	done
fi

# Third-party plugins come from external-plugins.toml, a committed list of plain
# git URLs. Each URL is shallow-cloned, so no GitHub API or branch name is needed.
if [ -f "$REPO_ROOT/external-plugins.toml" ]; then
	# A malformed or unreadable list is a configuration error and should fail the
	# build, unlike an unreachable third-party repo, which is skipped below.
	if ! external_urls_output="$(python3 - "$REPO_ROOT/external-plugins.toml" <<'PY'
import sys
import tomllib

with open(sys.argv[1], "rb") as handle:
    data = tomllib.load(handle)

for entry in data.get("plugin", []):
    url = entry.get("url", "")
    if url:
        print(url)
PY
)"; then
		echo "Failed to parse $REPO_ROOT/external-plugins.toml (requires Python 3.11+ for tomllib)." >&2
		exit 1
	fi

	external_urls=()
	if [ -n "$external_urls_output" ]; then
		mapfile -t external_urls <<<"$external_urls_output"
	fi

	# A hung clone (for example an unreachable private repo prompting for
	# credentials) must not stall the deploy, so disable prompts and bound the
	# clone time. The trap removes an in-progress clone if the script is
	# interrupted.
	export GIT_TERMINAL_PROMPT=0
	export GIT_ASKPASS=/bin/false
	export SSH_ASKPASS=/bin/false

	clone_dir=""
	cleanup_clone() {
		if [ -n "$clone_dir" ]; then
			rm -rf "$clone_dir"
		fi
	}
	trap cleanup_clone EXIT

	for url in "${external_urls[@]}"; do
		url_trimmed="${url%/}"
		url_trimmed="${url_trimmed%.git}"

		url_path="${url_trimmed#*://}"
		repo_segment="${url_path##*/}"
		owner_path="${url_path%/*}"
		owner_segment="${owner_path##*/}"

		repo_slug="${repo_segment#plugin-}"
		plugin_slug="$(printf '%s-%s' "$owner_segment" "$repo_slug" | python3 -c 'import re, sys; print(re.sub(r"[^a-z0-9-]", "-", sys.stdin.read().strip().lower()))')"

		# Skip slug collisions so a third-party entry cannot overwrite an
		# existing page.
		slug_taken=false
		for existing_slug in "${plugin_slugs[@]}"; do
			if [ "$existing_slug" = "$plugin_slug" ]; then
				slug_taken=true
				break
			fi
		done
		if [ "$slug_taken" = true ]; then
			echo "Skipping third-party plugin (slug '$plugin_slug' already used): $url" >&2
			continue
		fi

		clone_dir="$(mktemp -d)"
		if ! timeout 120 git clone --depth 1 --quiet "$url" "$clone_dir"; then
			echo "Skipping third-party plugin (clone failed): $url" >&2
			rm -rf "$clone_dir"
			continue
		fi

		# `-f` follows symlinks, which could publish files from the build machine.
		if [ -L "$clone_dir/manifest.json" ] || [ -L "$clone_dir/README.md" ]; then
			echo "Skipping third-party plugin (manifest.json or README.md is a symlink): $url" >&2
			rm -rf "$clone_dir"
			continue
		fi

		if [ ! -f "$clone_dir/manifest.json" ]; then
			echo "Skipping third-party plugin (no manifest.json): $url" >&2
			rm -rf "$clone_dir"
			continue
		fi

		if ! manifest_fields="$(parse_manifest <"$clone_dir/manifest.json")"; then
			echo "Skipping third-party plugin (invalid manifest.json): $url" >&2
			rm -rf "$clone_dir"
			continue
		fi

		plugin_name="$(cut -f1 <<<"$manifest_fields")"
		manifest_summary="$(cut -f2 <<<"$manifest_fields")"
		manifest_description="$(cut -f3 <<<"$manifest_fields")"

		# Use the manifest summary when present, otherwise the manifest description.
		plugin_description="$manifest_description"
		if [ -n "$manifest_summary" ]; then
			plugin_description="$manifest_summary"
		fi

		readme=""
		if [ -f "$clone_dir/README.md" ]; then
			# Neutralise Zola shortcode delimiters so a third-party README cannot
			# invoke an unknown shortcode and fail the whole build. Also escape the
			# opening angle bracket of <script> tags as an HTML entity so a
			# third-party README cannot inject a script that the CSP generator below
			# would then hash and whitelist. A backslash escape is not enough: markdown
			# passes it through verbatim inside a raw HTML block, leaving a real script
			# element, whereas &lt; is rendered as text in inline and block contexts.
			readme="$(python3 - "$clone_dir/README.md" <<'PY'
import re
import sys

with open(sys.argv[1], "r", encoding="utf-8", errors="replace") as handle:
    text = handle.read()

# Bash command substitution strips NUL bytes after Python exits, so remove them
# first to prevent NUL-injected shortcodes from becoming raw delimiters later.
text = text.replace("\x00", "")

text = re.sub(r"(\{)(?=[{%])", r"\1\\", text)
text = re.sub(r"<(?=/?script)", "&lt;", text, flags=re.IGNORECASE)

sys.stdout.write(text)
PY
)"
		fi

		plugin_names+=("$plugin_name")
		plugin_descriptions+=("$plugin_description")
		plugin_urls+=("$url")
		plugin_slugs+=("$plugin_slug")
		plugin_sources+=("third-party")
		plugin_readmes+=("$readme")

		rm -rf "$clone_dir"
	done
fi

# Sort all plugins together by display name. The trailing index breaks ties and
# preserves collection order for plugins with identical names.
sorted_indices=()
while IFS= read -r sort_line; do
	sorted_indices+=("${sort_line##*$'\t'}")
done < <(
	for i in "${!plugin_names[@]}"; do
		printf '%s\t%s\n' "${plugin_names[$i]}" "$i"
	done | LC_ALL=C sort
)

for i in "${sorted_indices[@]}"; do
	table_name="${plugin_names[$i]//|/\\|}"
	table_description="${plugin_descriptions[$i]//|/\\|}"
	echo "| $table_name | $table_description | ${plugin_urls[$i]} | ${plugin_sources[$i]} |" >>"$REPO_ROOT/static/plugins/index.md"
done

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

for i in "${sorted_indices[@]}"; do
	{
		echo '+++'
		echo "title = $(printf '%s' "${plugin_names[$i]}" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read(), ensure_ascii=False))')"
		echo "description = $(printf '%s' "${plugin_descriptions[$i]}" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read(), ensure_ascii=False))')"
		echo "template = \"plugins/page.html\""
		echo ""
		echo "[extra]"
		echo "repo_url = $(printf '%s' "${plugin_urls[$i]}" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read(), ensure_ascii=False))')"
		echo "source = $(printf '%s' "${plugin_sources[$i]}" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read(), ensure_ascii=False))')"
		echo '+++'
		if [ -n "${plugin_readmes[$i]}" ]; then
			echo ""
			printf '%s\n' "${plugin_readmes[$i]}"
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

	# Write the Cloudflare Pages _headers file. The script-src hashes are derived
	# from the built HTML because minify_html rewrites the inline script bodies,
	# so hashing the templates would produce hashes the browser never sees.
	python3 - "$REPO_ROOT/public" <<'PY'
import base64
import hashlib
import pathlib
import sys
from html.parser import HTMLParser


# Collect inline script bodies, ignoring scripts with a real src attribute.
# HTMLParser handles a quoted ">" inside an attribute and whitespace in the
# closing tag, both of which defeat a regex-based extraction.
class ScriptBodyExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_script = False
        self.has_src = False
        self.body_parts = []
        self.bodies = []

    def handle_starttag(self, tag, attrs):
        if tag == "script":
            self.in_script = True
            self.has_src = any(name == "src" for name, _ in attrs)
            self.body_parts = []

    def handle_data(self, data):
        if self.in_script:
            self.body_parts.append(data)

    def handle_endtag(self, tag):
        if tag == "script" and self.in_script:
            if not self.has_src:
                self.bodies.append("".join(self.body_parts))
            self.in_script = False


public = pathlib.Path(sys.argv[1])
hashes = set()
for path in public.rglob("*.html"):
    extractor = ScriptBodyExtractor()
    extractor.feed(path.read_text(encoding="utf-8"))
    extractor.close()
    for body in extractor.bodies:
        digest = hashlib.sha256(body.encode("utf-8")).digest()
        hashes.add("'sha256-" + base64.b64encode(digest).decode("ascii") + "'")

policy = (
    "default-src 'none'; "
    "script-src " + " ".join(sorted(hashes)) + "; "
    "style-src 'self'; "
    "img-src 'self' https: data:; "
    "connect-src https://api.github.com; "
    "base-uri 'none'; "
    "form-action 'none'; "
    "frame-ancestors 'none'"
)

(public / "_headers").write_text(
    f"/*\n  Content-Security-Policy: {policy}\n",
    encoding="utf-8",
)
PY
fi
