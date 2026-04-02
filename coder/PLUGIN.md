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
├── README.md              # Plugin documentation (required)
├── init.py                # Init script (declared in manifest)
├── my_tool/
│   ├── manifest.json      # Tool manifest (required)
│   └── run.py             # Entrypoint (any executable filename)
└── another_tool/
    ├── manifest.json
    └── run.sh
```

When installed, the repository is cloned into `data/plugins/my-plugin/`.

## New plugin

If creating a new plugin:

1. Make sure the plugin directory is a git repository, named `plugin-<distinctive name>`.
2. .gitignore config.json and all usual gitignored files for the stack (e.g.
   __pycache__, .pyc, and other such files). NEVER READ config.json, it contains secrets.
3. Delete/do not commit PLUGIN.md
4. When done, if everything is working and tested, commit and push to that repo.


## README

Every plugin must include a `README.md` at the repository root. The README should contain:

- A summary of what the plugin does and why a user would want to install it.
- Installation instructions (e.g., "Tell Stavrobot to install <git URL>", or any required configuration values and how to obtain them).

This is the first thing a potential user sees when browsing the repository, so it should be concise and practical.

## Plugin manifest

The `manifest.json` at the root of the plugin directory describes the plugin:

```json
{
  "name": "my-plugin",
  "description": "A short description of what this plugin provides, in the imperative mood (e.g. 'Manage your Google Maps places').",
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
      "required": false,
      "default": "primary"
    }
  }
}
```

Each config entry has:

- `description` (string, required): Explains what this value is for.
- `required` (boolean, required): Whether the plugin needs this value to function.
- `default` (any, optional): An initial value written to `config.json` at install time (and for newly-added keys on update). Once written, it behaves like any user-set value and can be overwritten with `configure_plugin`. Keys with a default do not require user action after install.

Configuration values are stored in a `config.json` file at the plugin's root directory (next to `manifest.json`). This file is not part of the git repo — it is created after installation. It is a plain JSON object mapping config keys to their values:

```json
{
  "api_key": "your-api-key-here",
  "calendar_id": "primary"
}
```

Tools can read their plugin's configuration from `../config.json` relative to their working directory. The tool's working directory is its own subdirectory, one level below the plugin root.

## Permissions

Each plugin has a `permissions` key in `config.json` that controls which of the plugin's tools the LLM is allowed to call. It is added automatically at install time and managed by the user via the web settings page — plugin authors do not need to declare or manage it.

- `["*"]` (the default) means all tools are available.
- `[]` means the plugin is disabled entirely.
- An explicit list like `["tool_a", "tool_b"]` restricts the LLM to only those tools.

```json
{
  "api_key": "your-api-key-here",
  "permissions": ["tool_a", "tool_b"]
}
```

Tools must not read or depend on the `permissions` key. It is reserved for the system.

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
- `parameters` (object, required): Parameter schema. Each key is a parameter name; each value has `type` (`string`, `integer`, `number`, `boolean`, or `file`) and `description`. Use an empty object `{}` if the tool takes no parameters. See "Receiving files" for how `file` parameters work.

### Async tools

Only set `async: true` for tools that are expected to run for more than 30 seconds. Async tools add complexity because the result arrives as a separate message rather than inline, which can be disorienting for the agent. Prefer synchronous tools whenever possible.

## Producing files

Synchronous tools can produce files by writing them to `/tmp/<plugin_name>/` (where `<plugin_name>` is the plugin's `name` from the manifest). After the tool exits, the plugin-runner scans that directory and transports any files it finds to the main app. The agent is told the directory where the files were saved and can construct the full path.

Rules:

- Only top-level files are transported. Subdirectories are ignored.
- The directory is cleared before and after each tool run. Do not rely on files persisting between runs.
- Maximum total file size per tool run is 25 MB. If the limit is exceeded, no files are transported and a warning is logged.
- File transport works for both synchronous and asynchronous tools. For async tools, the files are delivered as attachments alongside the callback message.

The tool's text output should reference produced files by filename (e.g., `"Generated audio: output.mp3"`). The agent will combine that with the directory path it receives to locate the file.

Common use cases: TTS audio, generated images, exported data files.

### Example: a tool that produces an audio file

```python
#!/usr/bin/env -S uv run
# /// script
# dependencies = ["gtts"]
# ///

import json
import sys
from pathlib import Path


def main() -> None:
    """Convert text to speech and write the audio file to the output directory."""
    params = json.load(sys.stdin)

    from gtts import gTTS

    output_dir = Path("/tmp/my-plugin")
    output_dir.mkdir(parents=True, exist_ok=True)
    tts = gTTS(params["text"])
    tts.save(output_dir / "output.mp3")
    json.dump({"file": "output.mp3"}, sys.stdout)


main()
```

## Receiving files

To accept a file from the user, declare a parameter with `"type": "file"` in the tool manifest. When the LLM calls `run_plugin_tool`, it passes the absolute path to the file (e.g. a path it received from an incoming attachment or from `manage_files`). The system reads the file, transports it to the plugin-runner container, and writes it into the plugin's temp directory (`/tmp/<plugin_name>/`). At runtime, the parameter value in the JSON on stdin will be the materialized file path (e.g., `/tmp/my-plugin/voice-note.ogg`), ready to read.

Use `"type": "file"` any time a tool needs to operate on a file the user has sent (audio, images, documents, etc.) rather than asking the user to provide the file contents as text.

Rules:

- The same `/tmp/<plugin_name>/` directory is used for both input and output files. Input files are written before the tool runs; output files are scanned after.
- The directory is cleared before each tool run, so input files from a previous run are not present.
- The same 25 MB size limit applies to input files.

### Example: a tool that receives an audio file

Tool manifest:

```json
{
  "name": "transcribe",
  "description": "Transcribe an audio file.",
  "entrypoint": "run.py",
  "parameters": {
    "audio": {
      "type": "file",
      "description": "The audio file to transcribe."
    }
  }
}
```

Tool entrypoint:

```python
#!/usr/bin/env -S uv run
# /// script
# dependencies = ["openai-whisper"]
# ///

import json
import sys


def main() -> None:
    """Transcribe an audio file passed as a file path."""
    params = json.load(sys.stdin)

    import whisper

    model = whisper.load_model("base")
    result = model.transcribe(params["audio"])
    json.dump({"text": result["text"]}, sys.stdout)


main()
```

## Runtime environment

Plugin tools run inside the `plugin-runner` Docker container, which is completely separate from the main app container. This means:

- Tools cannot access the app's filesystem, source code, secrets, or config.
- Each plugin runs as its own dedicated system user (`plug_<name>`). Plugin directories are restricted with `chmod 700`, so a plugin cannot read or write any other plugin's files or configuration. A plugin can only access its own directory (e.g., `/plugins/my-plugin/`) and its temporary output directory (`/tmp/<plugin_name>/`).
- Tools can make outbound network requests (there is no network isolation).

The following runtimes and tools are available in the container:

- `uv` (with a pre-installed Python)
- `python3`
- `node` (Node.js 22)
- `git`
- `ssh` / `openssh-client`
- `curl`
- `build-essential` (gcc, make, etc.)

The environment passed to the tool process is minimal: only `PATH`, `UV_CACHE_DIR`, `UV_PYTHON_INSTALL_DIR`, `SSL_CERT_FILE`, and `HOME` are set. `HOME` points to a writable per-plugin cache directory (`/cache/<plugin-name>/home`). `SSL_CERT_FILE` points to the system CA bundle so HTTPS requests work out of the box. Variables like `USER` and `PYTHONPATH` are not set.

## How tools are called

- The entrypoint is executed as a subprocess inside the plugin-runner container.
- The working directory is set to the tool's own subdirectory (e.g., `/plugins/my-plugin/my_tool/`).
- Parameters are passed as a JSON object on stdin.
- The tool must write a JSON object to stdout. Be thoughtful about the data you return — tool output consumes context in the LLM conversation, so each field should earn its place. Consider whether a personal assistant would plausibly use a given piece of data when deciding what to include. For example, a place-search tool should return the name, address, rating, opening hours, phone number, and website — but probably not the business registration number or raw API metadata. When in doubt, lean towards including the field rather than dropping it, but don't blindly pass through entire API responses.
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

## Writing tools in Node.js

In Node.js, read stdin using file descriptor `0`, not the path `"/dev/stdin"`. The plugin-runner spawns tools with socketpair-backed stdio, and opening `/dev/stdin` as a path fails with `ENXIO` because the kernel rejects `open()` on a socket.

```javascript
#!/usr/bin/env node

const fs = require("fs");

const input = fs.readFileSync(0, "utf-8");
const params = JSON.parse(input);
```

The script must be executable (`chmod +x run.js`).

## Writing tools in other languages

Any executable works — use a shebang line. Node.js and Python are available in the runtime environment. The script must be executable (`chmod +x`).

## Parameter validation

The plugin runner automatically validates parameters before the tool script runs:

- Unknown keys (not declared in the tool manifest's `parameters`) are rejected with HTTP 400. The error response includes the full parameter schema so the caller can self-correct.
- Wrong types are rejected for `string`, `number`, `integer`, and `boolean` parameters. `file` parameters are exempt because they are already handled by the file materialization code.

Tools no longer need to implement unknown-parameter rejection or type validation themselves. Existing validation code in tools is harmless and can be left in place, but new tools do not need it.

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
  "description": "Echo the query back to the caller.",
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
