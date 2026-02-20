"""HTTP server that receives coding task requests and spawns claude -p as a subprocess."""

import base64
import http.server
import json
import os
import subprocess
import threading
import urllib.request
from http import HTTPStatus


APP_CHAT_URL = "http://app:3000/chat"
CODER_ENV_PATH = "/run/coder-env"
SYSTEM_PROMPT_PATH = "/app/system-prompt.txt"
TOOLS_DIR = "/tools/"
TASK_TIMEOUT_SECONDS = 600

# Lock to ensure only one Claude Code instance runs at a time.
_claude_lock = threading.Lock()
_claude_running = False


def read_coder_env() -> dict[str, str]:
    """Read password and model from the coder-env file written by entrypoint.sh."""
    env: dict[str, str] = {}
    with open(CODER_ENV_PATH) as f:
        for line in f:
            line = line.strip()
            if "=" in line:
                key, value = line.split("=", 1)
                env[key] = value
    return env


def post_result(message: str, password: str) -> None:
    """Post the coding task result back to the main app's /chat endpoint."""
    body = json.dumps({
        "message": message,
        "source": "coder",
        "sender": "coder-agent",
    }).encode()

    headers = {"Content-Type": "application/json"}
    if password:
        credentials = base64.b64encode(f"coder:{password}".encode()).decode()
        headers["Authorization"] = f"Basic {credentials}"

    request = urllib.request.Request(
        APP_CHAT_URL,
        data=body,
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        print(f"[stavrobot-coder] Result posted, HTTP {response.status}")


def run_coding_task(task_id: str, message: str) -> None:
    """Run claude -p in a subprocess and post the result back to the app."""
    global _claude_running

    print(f"[stavrobot-coder] Starting coding task {task_id}")

    env = read_coder_env()
    password = env.get("PASSWORD", "")
    model = env["MODEL"]

    try:
        result = subprocess.run(
            [
                "claude",
                "-p", message,
                "--output-format", "json",
                "--dangerously-skip-permissions",
                "--append-system-prompt-file", SYSTEM_PROMPT_PATH,
                "--no-session-persistence",
                "--model", model,
            ],
            cwd=TOOLS_DIR,
            capture_output=True,
            text=True,
            timeout=TASK_TIMEOUT_SECONDS,
        )

        print(f"[stavrobot-coder] Task {task_id} subprocess exited with code {result.returncode}")
        print(f"[stavrobot-coder] Task {task_id} stdout: {result.stdout}")
        if result.stderr:
            print(f"[stavrobot-coder] Task {task_id} stderr: {result.stderr}")

        output = json.loads(result.stdout)
        subtype = output.get("subtype", "")
        is_error = output.get("is_error", False)

        if subtype != "success" or is_error:
            errors = output.get("errors", [])
            result_text = "Coding task failed: " + "\n".join(str(e) for e in errors)
        else:
            result_text = output.get("result", "")

    except subprocess.TimeoutExpired:
        print(f"[stavrobot-coder] Task {task_id} timed out after {TASK_TIMEOUT_SECONDS}s")
        result_text = f"Coding task failed: timed out after {TASK_TIMEOUT_SECONDS} seconds."
    except Exception as error:
        print(f"[stavrobot-coder] Task {task_id} raised an exception: {error}")
        result_text = f"Coding task failed: {error}"
    finally:
        with _claude_lock:
            _claude_running = False

    print(f"[stavrobot-coder] Posting result for task {task_id}, length: {len(result_text)}")
    post_result(result_text, password)


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
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            payload = json.loads(body)
            task_id = payload["taskId"]
            message = payload["message"]

            print(f"[stavrobot-coder] Received coding task {task_id}: {message[:100]}")

            with _claude_lock:
                global _claude_running
                if _claude_running:
                    print(f"[stavrobot-coder] Rejecting task {task_id}: Claude Code already running")
                    self._send_json(
                        HTTPStatus.CONFLICT,
                        {"error": "Claude Code is already running. Only one instance can run at a time. Please try again after the previous run finishes."},
                    )
                    return
                _claude_running = True

            thread = threading.Thread(
                target=run_coding_task,
                args=(task_id, message),
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
