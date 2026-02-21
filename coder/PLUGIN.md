# Stavrobot plugin guide

## What is Stavrobot?

Stavrobot is a personal AI assistant that runs as a Docker-based service. It can be extended with plugins — bundles of tools that the assistant can discover and run.

## What is a plugin?

A plugin is a directory (or git repository) containing one or more tools. Each tool is an executable script that receives JSON on stdin and writes JSON to stdout. Plugins are placed in the `data/tools/` directory, where the tool-runner container picks them up automatically.

## Directory structure

```
my-plugin/
  manifest.json          # Bundle manifest (required)
  my_tool/
    manifest.json        # Tool manifest (required)
    run.py               # Entrypoint (any executable filename)
  another_tool/
    manifest.json
    run.sh
```

## Bundle manifest

The `manifest.json` at the root of the plugin directory describes the bundle:

```json
{
  "name": "my-plugin",
  "description": "A short description of what this plugin provides.",
  "instructions": "Optional setup notes or usage guidance for the user."
}
```

- `name` (string, required): The plugin's unique identifier. Used to namespace tools.
- `description` (string, required): A short description shown when listing bundles.
- `instructions` (string, optional): Setup notes or usage guidance for the user. See "Plugin instructions" below.

## Plugin configuration

The bundle manifest can declare an optional `config` field listing configuration values the plugin needs:

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

Tools can read their plugin's configuration from `../config.json` relative to their working directory. The tool's working directory is its own subdirectory, one level below the bundle root.

## Plugin instructions

The bundle manifest can include an optional `instructions` field containing setup notes, usage guidance, or other information intended for the end user.

When a plugin is installed, updated, or inspected, the agent relays these instructions to the user verbatim. The agent will not follow the instructions itself.

Instructions longer than 5000 characters are truncated before being shown to the user.

## Tool manifest

Each tool subdirectory contains its own `manifest.json`:

```json
{
  "name": "my_tool",
  "description": "What this tool does.",
  "entrypoint": "run.py",
  "parameters": {
    "param_name": {
      "type": "string",
      "description": "What this parameter is for."
    }
  }
}
```

- `name` (string, required): The tool's name within the bundle.
- `description` (string, required): Shown when inspecting the bundle.
- `entrypoint` (string, required): The filename of the executable script inside the tool directory.
- `parameters` (object, required): Parameter schema. Each key is a parameter name; each value has `type` (`string`, `integer`, `number`, or `boolean`) and `description`. Use an empty object `{}` if the tool takes no parameters.

## How tools are called

- The entrypoint is executed as a subprocess by the tool-runner container.
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
