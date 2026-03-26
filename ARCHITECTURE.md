# Repository scout report

## Detected stack

- **Languages:**
  - Bash — primary build/orchestration language (`build-pages.sh`)
  - JavaScript (ESM, no TypeScript source) — plugin runner (`plugin-runner/dist/index.js`; compiled artifact, no source `.ts` found in repo)
  - Python 3 — used inline in `build-pages.sh` for JSON manipulation; plugin scripts run via `uv` (evidenced by `cache/plugins/*/uv/` trees)
  - HTML/Jinja2 — Zola templates (`templates/`)

- **Frameworks and major libraries:**
  - [Zola](https://www.getzola.org/) — static site generator (`config.toml`, `build-pages.sh` calls `zola build`)
  - Node.js built-in `http` module — plugin runner HTTP server (`plugin-runner/dist/index.js` line 1)
  - `uv` — Python plugin dependency manager (each plugin gets an isolated `uv` environment under `cache/plugins/<name>/uv/`)
  - Anthropic Claude API — primary LLM backend (`data/main/config.toml`: `provider = "anthropic"`, `model = "claude-opus-4-6"`)
  - OpenAI API — TTS, STT, embeddings (`data/main/config.toml`)
  - PostgreSQL — persistent storage (`data/main/config.toml` `[postgres]` section, `data/db-backups/*.sql.gz`)
  - Signal (signal-cli) — messaging integration (`data/signal-cli/`, `COMPOSE_PROFILES=signal` in `.envrc`)
  - WhatsApp (Baileys) — messaging integration (`data/whatsapp/`)
  - Telegram — messaging integration (`data/main/config.toml` `[telegram]`)
  - Claude Code — self-modification / coder container (`data/claude-code/`, `data/coder/`)

- **Build and packaging:**
  - `build-pages.sh` — the single build entry point; generates Zola content from `skills/*.md` and GitHub API, then calls `zola build`
  - `plugin-runner/dist/index.js` — pre-compiled JS artifact (no build step in this repo; source is elsewhere)
  - `node_modules/` present at root (no `package.json` found — likely a leftover or the `package.json` is gitignored)
  - Python plugins use `uv` shebangs for self-contained dependency management; no project-level `pyproject.toml`

- **Deployment and runtime:**
  - Docker Compose — implied by `INSTALL.md` (`docker compose up --build`), `data/postgres/`, and the `COMPOSE_PROFILES=signal` env var; no `docker-compose.yml` found in the repo (likely gitignored or in a sibling repo)
  - PostgreSQL container (`data/postgres/` directory, config references `host = "postgres"`)
  - signal-cli container (`data/signal-cli/`)
  - Plugin runner runs as a sidecar HTTP service at `http://app:3001/chat` (hardcoded in `plugin-runner/dist/index.js` line 9)
  - Plugins are isolated via dedicated Linux system users (`useradd --system`) and `chown`/`chmod 700` on their directories

---

## Conventions

- **Formatting and linting:** No linter config found (no `.eslintrc`, `ruff.toml`, `pyproject.toml`, `.pre-commit-config.yaml`, `Makefile`). The shell script uses `set -euo pipefail` consistently.

- **Type checking:** No type checker configured. The JS in `plugin-runner/dist/` is compiled output; no `tsconfig.json` found in the repo.

- **Testing:** No test framework found. No `tests/` directory, no `pytest`, no `jest`, no `vitest`.

- **Documentation conventions:**
  - `static/INSTALL.md` — AI-addressed installation guide (the bot reads and follows it)
  - `skills/*.md` — YAML-front-matter + plain-language instruction files addressed directly to the bot
  - `skills/skill-authoring.md` — canonical guide for writing new skills
  - `skills/bootstrap.md` — foundational skill that sets up the skill system
  - `content/` — Zola content pages (generated, not committed; see `.gitignore`)
  - `static/plugins/index.md` — bot-consumable plugin index (generated, not committed)

---

## Linting and testing commands

No linting, type-checking, or testing commands are configured in this repository. There is no `Makefile`, `justfile`, `Taskfile.yml`, `.pre-commit-config.yaml`, or `package.json` scripts section.

**Build:**
```bash
./build-pages.sh
```
Source: `build-pages.sh` — generates content from `skills/*.md` and GitHub API, then runs `zola build`. Output goes to `public/`.

**Content-only (no Zola build, no network fetch):**
```bash
./build-pages.sh --content-only
```
Source: `build-pages.sh` lines 7–12 — generates `content/skills/` and `static/plugins/index.md` without calling `zola build`.

**Note:** `build-pages.sh` fetches from `api.github.com` and `raw.githubusercontent.com` at build time. It requires `zola` on `PATH` or auto-downloads it to `.bin/`.

---

## Project structure hotspots

| Path | Role |
|------|------|
| `build-pages.sh` | Single build entry point — generates all Zola content and calls `zola build` |
| `skills/*.md` | Skill definitions — the primary "source of truth" for bot capabilities; each file is a versioned instruction set |
| `plugin-runner/dist/index.js` | Plugin runner HTTP server — handles plugin install, tool dispatch, user isolation, permissions, and async init |
| `data/main/config.toml` | Runtime configuration — LLM provider, messaging integrations, PostgreSQL, TTS/STT, feature flags |
| `data/app/allowlist.json` | Access control — which phone numbers/Telegram IDs can interact with the bot |
| `templates/` | Zola HTML templates for the public website (base, index, skills, plugins) |
| `static/` | Static assets served by Zola — `INSTALL.md` (AI-readable install guide), `style.css` |
| `content/` | Generated Zola content pages (gitignored; rebuilt on each `build-pages.sh` run) |
| `data/claude-code/` | Claude Code (coder container) state — conversation history, plugin marketplace, settings |
| `data/db-backups/` | PostgreSQL dump backups (`.sql.gz`) |
| `cache/plugins/` | Per-plugin `uv` environments and package archives (gitignored) |

**Boundaries:**
- `skills/` — human-authored, versioned, committed; the "skill library"
- `plugin-runner/` — compiled JS sidecar service; source lives elsewhere
- `python-runner/` and `signal-bridge/` — Python components (only `__pycache__` present; source likely gitignored or in a sibling repo)
- `data/` — all runtime state (gitignored); subdivided by service (`app`, `main`, `claude-code`, `coder`, `postgres`, `signal-cli`, `whatsapp`, `plugins`, `db-backups`)
- `cache/` — ephemeral plugin environments (gitignored)
- `misc/coding-team/` — branch-name list used by the coding team workflow (gitignored content)

---

## Do and don't patterns

### Do

- **Fail fast in shell scripts:** `build-pages.sh` opens with `set -euo pipefail` — errors abort immediately rather than silently continuing.
  - `build-pages.sh` line 2

- **Plugin user isolation:** Each plugin gets a dedicated Linux system user (`plug_<name>`), its directory is `chmod 700`, and ownership is set via `chown -R`. This is enforced both at install time and via a migration on startup.
  - `plugin-runner/dist/index.js` lines 18–67, 216–268

- **Explicit error code handling:** `useradd` exit code 9 (user exists) and `userdel` exit code 6 (user not found) are explicitly caught and treated as success; all other non-zero codes re-throw.
  - `plugin-runner/dist/index.js` lines 29–38, 47–54

- **Mandatory user approval for skill operations:** The bootstrap skill enforces a four-step approval gate (fetch → summarize → ask → apply) for every skill install and upgrade. No skill instruction can bypass this.
  - `skills/bootstrap.md` lines 30–45

- **Versioned skills with idempotent installation:** Skills carry an integer `version` field; upgrades are detected by comparing the fetched version against the database. Table creation uses "if not exists" language.
  - `skills/skill-authoring.md` lines 51, 209–211

- **Scratchpad over memory:** The skill authoring guide explicitly sets a high bar for memories (injected every turn) and prefers the scratchpad (loaded on demand) for most reference material.
  - `skills/skill-authoring.md` lines 125–143

- **Generated content is not committed:** `content/skills/`, `content/plugins/`, `static/plugins/`, `public/`, `cache/`, `data/`, `dist/`, `node_modules/` are all gitignored.
  - `.gitignore`

### Don't

- **Don't commit runtime state or secrets:** `data/` (all runtime config, credentials, WhatsApp pre-keys, Telegram tokens) and `.env` are gitignored. The `data/main/config.toml` present in the repo appears to be a live config with real API keys — this is a notable exception and likely intentional for a personal self-hosted project.
  - `.gitignore` lines 4–5, 10

- **Don't let plugins escape their sandbox:** Plugin names must match `[a-z0-9-]+`; plugins with non-conforming names are skipped during user migration. Symlink hardening is referenced in branch names (`symlink-hardening`).
  - `plugin-runner/dist/index.js` lines 250–253

- **Don't write HTML or SQL in skill files:** The skill authoring guide explicitly says "describe, don't implement" — skills describe what pages should show and what tables are needed; the bot generates the SQL and HTML.
  - `skills/skill-authoring.md` lines 207–208

---

## Open questions

1. **Where is the main application source?** The `python-runner/` and `signal-bridge/` directories contain only `__pycache__` — the actual `.py` source files are absent (likely gitignored or in a separate repo). The plugin runner's TypeScript source is also absent (only the compiled `dist/index.js` is present). It is unclear whether these live in a sibling repository or are intentionally excluded.

2. **Where is `docker-compose.yml`?** The `INSTALL.md` references `docker compose up --build` and the config references service hostnames (`postgres`, `app`), but no `docker-compose.yml` or `Dockerfile` is present in this repo. They may be gitignored or in a separate deployment repo.

3. **Is `node_modules/` at the root intentional?** There is a `node_modules/` directory at the repo root but no `package.json`. This is either a leftover artifact or the `package.json` is gitignored.

4. **`data/main/config.toml` contains live API keys and credentials.** This file is not gitignored (only `data/` as a whole is gitignored, but the file is present in the working tree). It is unclear whether this is intentional for a personal self-hosted project or an oversight.
