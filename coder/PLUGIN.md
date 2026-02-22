# Stavrobot plugin guide

## What is Stavrobot?

Stavrobot is a personal AI assistant that runs as a Docker-based service. It can be extended with plugins — collections of tools that the assistant can discover and run.

## What is a plugin?

A plugin is a directory (or git repository) containing one or more tools. Each tool is an executable script that receives JSON on stdin and writes JSON to stdout. Plugins are installed via the plugin-runner and placed in the `data/plugins/` directory.

## Directory structure

A plugin is typically a git repository. The plugin manifest lives at the repository root, and each tool is a subdirectory containing its own manifest and entrypoint.

```
my-plugin/                 # Repository root (e.g., github.com/user/my-plugin)
├── manifest.json          # Plugin manifest (required, at repo root)
├── init.py                # Init script (declared in manifest)
├── my_tool/
│   ├── manifest.json      # Tool manifest (required)
│   └── run.py             # Entrypoint (any executable filename)
└── another_tool/
    ├── manifest.json
    └── run.sh
```

When installed, the repository is cloned into `data/plugins/my-plugin/`.

## Plugin manifest

The `manifest.json` at the root of the plugin directory describes the plugin:

```json
{
  "name": "my-plugin",
  "description": "A short description of what this plugin provides.",
  "instructions": "Optional setup notes or usage guidance for the user.",
  "init": {
    "entrypoint": "init.py",
    "async": false
  }
}
```

- `name` (string, required): The plugin's unique identifier. Used to namespace tools. Must contain only lowercase letters, digits, and hyphens (`[a-z0-9-]`).
- `description` (string, required): A short description shown when listing plugins.
- `instructions` (string, optional): Setup notes or usage guidance for the user. See "Plugin instructions" below.
- `init` (object, optional): Declares an init script.
  - `entrypoint` (string, required): The filename of the executable script at the plugin root.
  - `async` (boolean, optional, defaults to false): If true, the init script runs in the background and does not block install/update.

## Plugin configuration

The plugin manifest can declare an optional `config` field listing configuration values the plugin needs:

```json
{
  "name": "google-calendar",
  "description": "Manage your Google Calendar.",
  "config": {
    "api_key": {
      "description": "Google Calendar API key",
      "required": true
    },
    "calendar_id": {
      "description": "Default calendar ID",
      "required": false
    }
  }
}
```

Each config entry has:

- `description` (string, required): Explains what this value is for.
- `required` (boolean, required): Whether the plugin needs this value to function.

Configuration values are stored in a `config.json` file at the plugin's root directory (next to `manifest.json`). This file is not part of the git repo — it is created after installation. It is a plain JSON object mapping config keys to their values:

```json
{
  "api_key": "your-api-key-here",
  "calendar_id": "primary"
}
```

Tools can read their plugin's configuration from `../config.json` relative to their working directory. The tool's working directory is its own subdirectory, one level below the plugin root.

## Plugin instructions

The plugin manifest can include an optional `instructions` field containing setup notes, usage guidance, or other information intended for the end user.

When a plugin is installed, updated, or inspected, the agent relays these instructions to the user verbatim. The agent will not follow the instructions itself.

Instructions longer than 5000 characters are truncated before being shown to the user.

## Init scripts

An init script is declared in the plugin manifest via the `init` field. The `entrypoint` value names the executable file at the plugin root. The script must be executable (`chmod +x`).

The init script runs automatically after install and after update. It runs as the plugin's system user with the same restricted environment as tools. The working directory is the plugin root (not a tool subdirectory). It receives no stdin input.

Anything the init script writes to stdout is captured and returned to the agent as `init_output` in the install/update response. Use this to report setup results, generated credentials, or other information the agent should see.

**Sync init** (default, `"async": false`): 30-second timeout. Blocks install/update until the script exits. A non-zero exit code or timeout fails the operation.

**Async init** (`"async": true`): 5-minute timeout. Does not block install/update — the operation completes immediately and the init result is delivered via callback when the script finishes. A non-zero exit code or timeout reports failure via callback.

Typical uses: downloading models, compiling native extensions, creating cache directories.

### Example: init.py

```python
#!/usr/bin/env -S uv run
# /// script
# dependencies = []
# ///

from pathlib import Path


def main() -> None:
    """Create a cache directory for the plugin."""
    Path("cache").mkdir(exist_ok=True)


main()
```

## Tool manifest

Each tool subdirectory contains its own `manifest.json`:

```json
{
  "name": "my_tool",
  "description": "What this tool does.",
  "entrypoint": "run.py",
  "async": false,
  "parameters": {
    "param_name": {
      "type": "string",
      "description": "What this parameter is for."
    }
  }
}
```

- `name` (string, required): The tool's name within the plugin.
- `description` (string, required): Shown when inspecting the plugin.
- `entrypoint` (string, required): The filename of the executable script inside the tool directory.
- `async` (boolean, optional, defaults to false): If true, the tool runs asynchronously and the result is delivered via callback instead of inline.
- `parameters` (object, required): Parameter schema. Each key is a parameter name; each value has `type` (`string`, `integer`, `number`, or `boolean`) and `description`. Use an empty object `{}` if the tool takes no parameters.

### Async tools

Only set `async: true` for tools that are expected to run for more than 30 seconds. Async tools add complexity because the result arrives as a separate message rather than inline, which can be disorienting for the agent. Prefer synchronous tools whenever possible.

## Runtime environment

Plugin tools run inside the `plugin-runner` Docker container, which is completely separate from the main app container. This means:

- Tools cannot access the app's filesystem, source code, secrets, or config.
- Each plugin runs as its own dedicated system user (`plug_<name>`). Plugin directories are restricted with `chmod 700`, so a plugin cannot read or write any other plugin's files or configuration. A plugin can only access its own directory (e.g., `/plugins/my-plugin/`).
- Tools can make outbound network requests (there is no network isolation).

The following runtimes and tools are available in the container:

- `uv` (with a pre-installed Python)
- `python3`
- `node` (Node.js 22)
- `git`
- `ssh` / `openssh-client`
- `curl`
- `build-essential` (gcc, make, etc.)

The environment passed to the tool process is minimal: only `PATH`, `UV_CACHE_DIR`, and `UV_PYTHON_INSTALL_DIR` are set. Variables like `HOME`, `USER`, and `PYTHONPATH` are not set.

## How tools are called

- The entrypoint is executed as a subprocess inside the plugin-runner container.
- The working directory is set to the tool's own subdirectory (e.g., `/plugins/my-plugin/my_tool/`).
- Parameters are passed as a JSON object on stdin.
- The tool must write a JSON object to stdout.
- Exit code 0 means success; non-zero means failure.
- Stderr is captured and returned as the error message on failure.
- There is a 30-second timeout.

## Writing tools in Python

Use a `uv` shebang so dependencies are resolved automatically at runtime:

```python
#!/usr/bin/env -S uv run
# /// script
# dependencies = ["requests"]
# ///
```

The script must be executable (`chmod +x run.py`).

## Writing tools in other languages

Any executable works — use a shebang line. Node.js and Python are available in the runtime environment. The script must be executable (`chmod +x`).

## Example: a complete tool

A Python tool that takes a `query` string and returns a result:

```python
#!/usr/bin/env -S uv run
# /// script
# dependencies = []
# ///

import json
import sys


def main() -> None:
    """Read a query from stdin and return a result."""
    params = json.load(sys.stdin)
    query = params["query"]
    result = f"You asked: {query}"
    json.dump({"result": result}, sys.stdout)


main()
```

With the accompanying `manifest.json`:

```json
{
  "name": "echo_query",
  "description": "Echoes the query back to the caller.",
  "entrypoint": "run.py",
  "parameters": {
    "query": {
      "type": "string",
      "description": "The query to echo."
    }
  }
}
```

## Example: a tool that reads config

A tool that reads an API key from `config.json`:

```python
#!/usr/bin/env -S uv run
# /// script
# dependencies = ["requests"]
# ///

import json
import sys
from pathlib import Path


def main() -> None:
    """Fetch data using an API key from config.json."""
    config = json.loads(Path("../config.json").read_text())
    api_key = config["api_key"]
    params = json.load(sys.stdin)
    # Use api_key and params["query"] to call an external API.
    json.dump({"result": f"Fetched with key ending in ...{api_key[-4:]}"}, sys.stdout)


main()
```

## Testing

Tools can be tested locally by piping JSON to stdin:

```bash
echo '{"query": "test"}' | ./run.py
```
