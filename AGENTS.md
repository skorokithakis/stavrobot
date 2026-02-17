# Agents

This file contains instructions for AI coding agents operating in this repository.

## Project overview

Stavrobot is a TypeScript HTTP server that wraps an LLM-powered agent (Anthropic Claude
by default) with access to a PostgreSQL database via a SQL execution tool. It exposes a
single `POST /chat` endpoint. A Python CLI client (`client.py`) provides an interactive
REPL. The project is containerized with Docker and docker-compose.

## Build, run, and test commands

```bash
# Install dependencies
npm install

# Build (compile TypeScript to dist/)
npm run build

# Run the compiled server
npm start

# Run in dev mode (tsx, no compile step)
npm run dev

# Type-check without emitting (useful for CI or quick validation)
npx tsc --noEmit

# Docker
docker compose up --build
```

There is no test framework configured. No test runner, no test files. If tests are added,
use vitest (it works well with ESM and TypeScript).

There is no linter or formatter configured. If one is added, use Biome (single tool for
both linting and formatting with good TypeScript ESM support).

## Code style: TypeScript

### Module system

- The project uses ESM (`"type": "module"` in package.json, `"module": "NodeNext"` in
  tsconfig).
- All local imports must use the `.js` extension (e.g., `import { loadConfig } from
  "./config.js"`), even though the source files are `.ts`. This is required by NodeNext
  module resolution.

### Imports

- Use `import type` for type-only imports (e.g., `import type { Config } from
  "./config.js"`). This is enforced by strict mode and tree-shaking.
- Order: third-party modules first, then local modules (with `./` prefix).
- Named exports only. No default exports.

### Typing

- `strict: true` is enabled in tsconfig. All code must satisfy strict type checking.
- All functions must have explicit return type annotations, including `Promise<void>`.
- Use interfaces for object shapes (e.g., `Config`, `PostgresConfig`).
- Use `unknown` instead of `any` for untyped data, then narrow with type guards or
  assertions. The only exception is when a library API forces `any`.
- Type assertions should be used sparingly. When necessary, cast through `unknown` first
  (e.g., `TOML.parse(content) as unknown as Config`).

### Naming

- `camelCase` for variables, functions, and parameters.
- `PascalCase` for interfaces and type aliases.
- No abbreviations. Prefer `message` over `msg`, `response` over `res`, `request` over
  `req`.

### Functions and structure

- Use standalone `async` functions, not classes, for application logic.
- The `Agent` class from the library is the only class used directly.
- Keep functions small and focused. Each file in `src/` has a clear responsibility:
  `config.ts` (loading config), `database.ts` (Postgres operations), `agent.ts`
  (LLM agent setup and prompting), `index.ts` (HTTP server and entry point).

### Error handling

- Let exceptions propagate. Do not add defensive try/catch blocks unless the function
  is the boundary where the error must be handled (e.g., the HTTP request handler in
  `index.ts`).
- At HTTP boundaries, catch errors and return structured JSON error responses with
  appropriate status codes.
- Use `error instanceof Error ? error.message : String(error)` when converting unknown
  caught values to strings.

### Comments

- Comments explain "why", not "what". Do not add comments that just describe what the
  next few lines do.
- Comments should be full sentences, properly capitalized, ending with a full stop.
- Currently the codebase has almost no comments because the code is straightforward. Do
  not add unnecessary comments.

### Formatting

- Use double quotes for strings.
- Use `const` by default, `let` only when reassignment is needed. Never use `var`.
- Trailing commas in multiline constructs.
- Semicolons at end of statements.
- 2-space indentation.

## Code style: Python

The Python code (`client.py`) is a standalone CLI client with no third-party dependencies.

- All function signatures must be statically typed (parameters and return types).
- Use built-in types for annotations (`list`, `dict`, `str`, etc.), not `typing` module
  equivalents.
- `snake_case` for functions and variables, `PascalCase` for classes.
- Docstrings on all functions.
- Use specific exception types in `except` clauses, never bare `except`.
- Standard `if __name__ == "__main__":` entry point pattern.

## Configuration

- Runtime config is loaded from `config.toml` (or path in `CONFIG_PATH` env var).
- `config.toml` is gitignored. `config.example.toml` is the template.
- Do not commit secrets or API keys.

## Docker

- Multi-stage Dockerfile: build stage compiles TypeScript, production stage copies only
  compiled JS and production dependencies.
- docker-compose runs Postgres 17 and the app, with a health check on Postgres before
  the app starts.
- The app listens on port 3000 by default (configurable via `PORT` env var).

## Version control

- The repo uses Jujutsu (`jj`) alongside git.
- When asked to commit, run `jj diff` first, then `jj describe -m` with a message
  describing the whole change.
- Do not mention AI in commit messages. Write them as if the human wrote the code.

## General rules

- Do not write forgiving code. Let errors propagate rather than silently catching them.
- Titles and headings: capitalize only the first letter, not every word.
- No emojis unless explicitly requested.
- If unsure what to do, stop and ask for instructions rather than guessing.
- When adding new features, present a plan and ask for confirmation before implementing.
