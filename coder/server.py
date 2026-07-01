"""HTTP server that receives coding task requests and spawns claude -p as a subprocess."""

import base64
import hmac
import http.server
import json
import os
import re
import shutil
import subprocess
import time
import tomllib
import urllib.error
import urllib.request
from threading import Thread
from http import HTTPStatus


APP_CHAT_URL = "http://app:3000/chat"
CONFIG_PATH = "/root/config/config.toml"
SYSTEM_PROMPT_PATH = "/app/system-prompt.txt"
PLUGINS_DIR = "/plugins/"
TASK_TIMEOUT_SECONDS = 600
MAX_USERNAME_LENGTH = 32
CODER_CREDENTIALS_PATH = "/home/coder/.claude/.credentials.json"
PLUGIN_NAME_RE = re.compile(r"^[a-z0-9-]+$")

# Delays before each retry of post_result, in seconds. The initial attempt is
# immediate and each entry here is one additional retry, so the whole array is
# consumed. The app may be briefly unreachable during a restart and there is no
# persistent outbox, so without these retries a coding task result would be
# silently lost forever.
CALLBACK_RETRY_DELAYS_SECONDS = [5, 15, 30, 60, 120]


def load_config() -> tuple[str, str, str | None, str | None]:
    """Read config.toml and return (password, model, api_key, coder_base_url).

    Raises SystemExit if the password is missing, since the server must not
    start without authentication configured.
    """
    with open(CONFIG_PATH, "rb") as f:
        config = tomllib.load(f)

    password = config.get("password")
    if not password:
        print("[stavrobot-coder] Fatal: 'password' is missing from config.toml")
        raise SystemExit(1)

    coder_section = config.get("coder", {})
    model = coder_section["model"]

    api_key: str | None = config.get("apiKey") or None
    base_url: str | None = config.get("baseUrl") or None
    if base_url is not None and base_url.endswith("/v1"):
        base_url = base_url[:-3]

    return password, model, api_key, base_url


PASSWORD, MODEL, API_KEY, BASE_URL = load_config()


def ensure_plugin_user(plugin_name: str, uid: int, gid: int) -> None:
    """Create a system user matching the plugin-runner's user for this plugin.

    The plugin directory is owned by a user created in the plugin-runner container.
    This container needs a matching passwd entry so subprocess.run(user=uid) works
    correctly and the claude CLI can resolve the running user.
    """
    username = f"plug_{plugin_name.replace('-', '_')}"[:MAX_USERNAME_LENGTH]
    try:
        group_result = subprocess.run(
            ["groupadd", "--system", "--gid", str(gid), username],
            capture_output=True, check=False,
        )
        # Exit code 9 means the group already exists, which is fine.
        if group_result.returncode not in (0, 9):
            print(f"[stavrobot-coder] Warning: groupadd exited with code {group_result.returncode} for {username}: {group_result.stderr.decode(errors='replace').strip()}")

        user_result = subprocess.run(
            ["useradd", "--system", "--no-create-home", "--uid", str(uid), "--gid", str(gid), username],
            capture_output=True, check=False,
        )
        # Exit code 9 means the user already exists, which is fine.
        if user_result.returncode not in (0, 9):
            print(f"[stavrobot-coder] Warning: useradd exited with code {user_result.returncode} for {username}: {user_result.stderr.decode(errors='replace').strip()}")
    except FileNotFoundError:
        print(f"[stavrobot-coder] Warning: useradd/groupadd not available, skipping user creation for {username}")


def setup_plugin_credentials(plugin_dir: str, uid: int, gid: int) -> None:
    """Copy claude credentials into the plugin directory so claude can run as the plugin user."""
    plugin_claude_dir = os.path.join(plugin_dir, ".claude")
    plugin_credentials = os.path.join(plugin_claude_dir, ".credentials.json")
    # A symlink here could redirect credential writes to an attacker-controlled path.
    if os.path.islink(plugin_claude_dir):
        os.remove(plugin_claude_dir)
    os.makedirs(plugin_claude_dir, exist_ok=True)
    # Re-check after makedirs to close the TOCTOU window between the symlink removal
    # above and the directory creation: a racing plugin could have replaced the newly
    # created directory with a symlink before we get here.
    if os.path.islink(plugin_claude_dir):
        raise RuntimeError(f"Race condition detected: {plugin_claude_dir} is a symlink after makedirs")
    # Guard against the credentials file itself being a symlink, which would cause
    # shutil.copy2 (running as root) to overwrite the symlink target instead of
    # creating a regular file.
    if os.path.islink(plugin_credentials):
        os.unlink(plugin_credentials)
    shutil.copy2(CODER_CREDENTIALS_PATH, plugin_credentials)
    # Use lchown instead of chown so that if a symlink somehow exists at these paths
    # we change ownership of the symlink itself rather than following it.
    os.lchown(plugin_claude_dir, uid, gid)
    os.chmod(plugin_claude_dir, 0o700)
    os.lchown(plugin_credentials, uid, gid)
    os.chmod(plugin_credentials, 0o600)


def teardown_plugin_credentials(plugin_dir: str) -> None:
    """Copy refreshed credentials back to the coder home and clean up the plugin copy."""
    plugin_claude_dir = os.path.join(plugin_dir, ".claude")
    plugin_credentials = os.path.join(plugin_claude_dir, ".credentials.json")
    if os.path.islink(plugin_claude_dir):
        # If the plugin replaced the directory with a symlink, just remove the symlink
        # rather than following it and deleting whatever it points to.
        os.remove(plugin_claude_dir)
        return
    if os.path.exists(plugin_credentials):
        # The plugin's claude subprocess ran as the plugin user and could have replaced
        # .credentials.json with a symlink. Since this copy runs as root, following a
        # symlink here would allow the plugin to read arbitrary root-owned files.
        if os.path.islink(plugin_credentials):
            print(f"[stavrobot-coder] Warning: {plugin_credentials} is a symlink; skipping credential copy-back")
        else:
            shutil.copy2(plugin_credentials, CODER_CREDENTIALS_PATH)
    shutil.rmtree(plugin_claude_dir, ignore_errors=True)


def make_auth_header() -> str:
    """Return the Basic Auth header value for outbound requests to the app.

    The format is Basic Auth with an empty username: base64(":password").
    """
    token = base64.b64encode(f":{PASSWORD}".encode()).decode()
    return f"Basic {token}"


def post_result(message: str) -> None:
    """Post the coding task result back to the main app's internal /chat endpoint.

    Retries on network errors and non-2xx responses with growing backoff. The
    caller (run_coding_task) runs in a daemon thread and its outer except would
    swallow any URLError that escaped here, so retries must live inside this
    function for the result to actually be delivered.
    """
    body = json.dumps({
        "message": message,
        "source": "coder",
        "sender": "coder-agent",
    }).encode()

    headers = {
        "Content-Type": "application/json",
        "Authorization": make_auth_header(),
    }

    attempt = 0
    while True:
        attempt += 1
        request = urllib.request.Request(
            APP_CHAT_URL,
            data=body,
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request) as response:
                status = response.status
            print(f"[stavrobot-coder] Result posted (attempt {attempt}), HTTP {status}")
            return
        except urllib.error.HTTPError as error:
            print(f"[stavrobot-coder] Result got HTTP {error.code} on attempt {attempt}: {error.reason}")
        except urllib.error.URLError as error:
            print(f"[stavrobot-coder] Result post failed on attempt {attempt}: {error.reason}")

        delay_index = attempt - 1
        if delay_index >= len(CALLBACK_RETRY_DELAYS_SECONDS):
            print(f"[stavrobot-coder] Giving up on result post after {attempt} attempts")
            return
        delay = CALLBACK_RETRY_DELAYS_SECONDS[delay_index]
        print(f"[stavrobot-coder] Retrying result post in {delay}s")
        time.sleep(delay)


def run_coding_task(task_id: str, message: str, plugin: str) -> None:
    """Run claude -p in a subprocess and post the result back to the app."""
    if not PLUGIN_NAME_RE.match(plugin):
        raise ValueError(f"Invalid plugin name: {plugin!r}")

    print(f"[stavrobot-coder] Starting coding task {task_id} for plugin {plugin!r}")

    cwd = os.path.join(PLUGINS_DIR, plugin)

    use_api_key_auth = API_KEY is not None and BASE_URL is not None
    credentials_set_up = False
    result_text = ""

    try:
        stat = os.stat(cwd)
        uid = stat.st_uid
        gid = stat.st_gid

        # The plugin directory is owned by a system user created in the plugin-runner
        # container. Create a matching user in this container so the claude subprocess
        # has a valid passwd entry.
        ensure_plugin_user(plugin, uid, gid)

        if use_api_key_auth:
            print(f"[stavrobot-coder] Using API key auth for task {task_id}")
        else:
            # Copy credentials into the plugin directory so claude can authenticate when
            # running as the plugin user. HOME is set to the plugin directory so claude
            # finds .claude/.credentials there.
            setup_plugin_credentials(cwd, uid, gid)
            credentials_set_up = True

        # Ensure the per-plugin cache directory exists and is owned by the plugin user.
        cache_dir = f"/cache/{plugin}/uv"
        os.makedirs(cache_dir, exist_ok=True)
        # The -h flag makes chown change ownership of symlinks themselves rather than
        # following them, preventing a plugin from using a symlink in its cache directory
        # to cause root to chown an arbitrary file.
        subprocess.run(["chown", "-R", "-h", f"{uid}:{gid}", f"/cache/{plugin}"], check=True)

        username = f"plug_{plugin.replace('-', '_')}"[:MAX_USERNAME_LENGTH]
        subprocess_env = {
            "HOME": cwd,
            "PATH": "/home/coder/.local/bin:/usr/local/bin:/usr/bin:/bin",
            "USER": username,
            "LOGNAME": username,
            "SHELL": "/bin/bash",
            "UV_CACHE_DIR": f"/cache/{plugin}/uv",
            "UV_PYTHON_INSTALL_DIR": "/opt/uv/python",
            "SSL_CERT_FILE": "/etc/ssl/certs/ca-certificates.crt",
            "REQUESTS_CA_BUNDLE": "/etc/ssl/certs/ca-certificates.crt",
        }

        if use_api_key_auth:
            assert API_KEY is not None and BASE_URL is not None
            subprocess_env["ANTHROPIC_API_KEY"] = API_KEY
            subprocess_env["ANTHROPIC_BASE_URL"] = BASE_URL

        print(f"[stavrobot-coder] Running as uid={uid} gid={gid} in {cwd}")

        result = subprocess.run(
            [
                "claude",
                "-p", message,
                "--output-format", "json",
                "--dangerously-skip-permissions",
                "--append-system-prompt-file", SYSTEM_PROMPT_PATH,
                "--no-session-persistence",
                "--model", MODEL,
            ],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=TASK_TIMEOUT_SECONDS,
            user=uid,
            group=gid,
            env=subprocess_env,
        )

        print(f"[stavrobot-coder] Task {task_id} subprocess exited with code {result.returncode}")
        print(f"[stavrobot-coder] Task {task_id} stdout: {result.stdout}")
        if result.stderr:
            print(f"[stavrobot-coder] Task {task_id} stderr: {result.stderr}")

        if not result.stdout.strip():
            stderr_snippet = result.stderr.strip()[:500] if result.stderr else "no output"
            result_text = f"Coding task failed: claude produced no output (exit code {result.returncode}). stderr: {stderr_snippet}"
        else:
            output = json.loads(result.stdout)
            subtype = output.get("subtype", "")
            is_error = output.get("is_error", False)

            if subtype != "success" or is_error:
                errors = output.get("errors", [])
                error_detail = "\n".join(str(e) for e in errors) if errors else output.get("result", "unknown error")
                result_text = "Coding task failed: " + error_detail
            else:
                result_text = output.get("result", "")
                usage_footer = (
                    "\n\n---\n"
                    "To use this plugin:\n"
                    "- list_plugins: see all available plugins\n"
                    "- show_plugin(name): see tools in a plugin and their parameters\n"
                    "- run_plugin_tool(plugin, tool, parameters): run a tool"
                )
                result_text = result_text + usage_footer

    except subprocess.TimeoutExpired:
        print(f"[stavrobot-coder] Task {task_id} timed out after {TASK_TIMEOUT_SECONDS}s")
        result_text = f"Coding task failed: timed out after {TASK_TIMEOUT_SECONDS} seconds."
    except Exception as error:
        print(f"[stavrobot-coder] Task {task_id} raised an exception: {error}")
        result_text = f"Coding task failed: {error}"
    finally:
        if credentials_set_up:
            teardown_plugin_credentials(cwd)

    print(f"[stavrobot-coder] Posting result for task {task_id}, length: {len(result_text)}")
    post_result(result_text)


def check_auth(auth_header: str | None) -> bool:
    """Return True if the Authorization header contains the correct Basic Auth password."""
    if not auth_header:
        return False
    if not auth_header.startswith("Basic "):
        return False
    try:
        decoded = base64.b64decode(auth_header[len("Basic "):]).decode()
    except Exception:
        return False
    # The format is ":password" (empty username).
    _, _, provided_password = decoded.partition(":")
    # compare_digest raises TypeError on non-ASCII str values, so compare the
    # UTF-8 encoded bytes directly.
    return hmac.compare_digest(provided_password.encode("utf-8"), PASSWORD.encode("utf-8"))


class RequestHandler(http.server.BaseHTTPRequestHandler):
    """HTTP request handler for the claude-code server."""

    def log_message(self, format: str, *args: object) -> None:
        """Override to use the project log prefix."""
        print(f"[stavrobot-coder] {format % args}")

    def do_GET(self) -> None:
        """Handle GET requests."""
        if self.path == "/health":
            self._send_json(HTTPStatus.OK, {"status": "ok"})
        else:
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_POST(self) -> None:
        """Handle POST requests."""
        if self.path == "/code":
            if not check_auth(self.headers.get("Authorization")):
                self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
                return

            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            payload = json.loads(body)
            task_id = payload["taskId"]
            message = payload["message"]
            plugin = payload["plugin"]

            if not PLUGIN_NAME_RE.match(plugin):
                print(f"[stavrobot-coder] Rejecting task {task_id}: invalid plugin name: {plugin!r}")
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": f"Invalid plugin name: {plugin!r}"})
                return

            plugin_dir = os.path.join(PLUGINS_DIR, plugin)
            if not os.path.isdir(plugin_dir):
                print(f"[stavrobot-coder] Rejecting task {task_id}: plugin directory not found: {plugin_dir}")
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": f"Plugin directory not found: {plugin!r}"})
                return

            print(f"[stavrobot-coder] Received coding task {task_id} for plugin {plugin!r}: {message[:100]}")

            thread = Thread(
                target=run_coding_task,
                args=(task_id, message, plugin),
                daemon=True,
            )
            thread.start()

            self._send_json(HTTPStatus.ACCEPTED, {"taskId": task_id})
        else:
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def _send_json(self, status: HTTPStatus, data: dict[str, str]) -> None:
        """Send a JSON response with the given status code and data."""
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    """Start the HTTP server."""
    port = int(os.environ.get("PORT", "3002"))
    server = http.server.ThreadingHTTPServer(("", port), RequestHandler)
    print(f"[stavrobot-coder] Listening on port {port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
