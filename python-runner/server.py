"""HTTP server that accepts Python code and executes it via uv run."""

import http.server
import json
import os
import pwd
import signal
import subprocess
import sys
import tempfile
from http import HTTPStatus


PORT = 3003
TIMEOUT_SECONDS = 30
SIGKILL_GRACE_SECONDS = 5


def get_pythonrunner_ids() -> tuple[int, int]:
    """Return the uid and gid of the pythonrunner system user."""
    entry = pwd.getpwnam("pythonrunner")
    return entry.pw_uid, entry.pw_gid


def build_script_content(code: str, dependencies: list[str]) -> str:
    """Prepend a PEP 723 inline script metadata block if dependencies are given."""
    if not dependencies:
        return code
    dep_list = ", ".join(f'"{dep}"' for dep in dependencies)
    metadata = f"# /// script\n# dependencies = [{dep_list}]\n# ///\n"
    return metadata + code


def run_script(code: str, dependencies: list[str]) -> str:
    """Write code to a temp file, execute it via uv run, and return combined output."""
    try:
        uid, gid = get_pythonrunner_ids()
    except KeyError:
        return "Failed to spawn process: pythonrunner user not found."

    script_content = build_script_content(code, dependencies)

    with tempfile.NamedTemporaryFile(
        mode="w",
        suffix=".py",
        dir="/tmp",
        delete=False,
        prefix="python-runner-",
    ) as script_file:
        script_file.write(script_content)
        script_path = script_file.name

    # Make the temp file readable by the pythonrunner user.
    os.chmod(script_path, 0o644)

    print(
        f"[python-runner] Spawning uv run {script_path} as uid={uid} gid={gid}",
        file=sys.stderr,
    )

    env = {
        "PATH": os.environ.get("PATH", ""),
        "UV_CACHE_DIR": "/tmp/uv-cache",
        "UV_PYTHON_INSTALL_DIR": "/opt/uv/python",
    }

    try:
        try:
            process = subprocess.Popen(
                ["uv", "run", script_path],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd="/tmp",
                env=env,
                user=uid,
                group=gid,
                extra_groups=[],
            )
        except (OSError, subprocess.SubprocessError) as error:
            print(f"[python-runner] Failed to spawn process: {error}", file=sys.stderr)
            return f"Failed to spawn process: {error}"

        timed_out = False
        try:
            stdout_bytes, stderr_bytes = process.communicate(timeout=TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            timed_out = True
            process.send_signal(signal.SIGTERM)
            try:
                stdout_bytes, stderr_bytes = process.communicate(timeout=SIGKILL_GRACE_SECONDS)
            except subprocess.TimeoutExpired:
                process.kill()
                stdout_bytes, stderr_bytes = process.communicate()

        stdout = stdout_bytes.decode(errors="replace")
        stderr = stderr_bytes.decode(errors="replace")
        exit_code = process.returncode

        output = stdout
        if stderr:
            output += ("\n" if output else "") + f"stderr:\n{stderr}"

        if timed_out:
            timeout_message = f"Process timed out after {TIMEOUT_SECONDS} seconds."
            output += ("\n" if output else "") + timeout_message
            print(
                f"[python-runner] Script timed out, partial output length={len(output)}",
                file=sys.stderr,
            )
            return output if output else timeout_message

        if exit_code != 0:
            exit_message = f"Exit code: {exit_code}."
            output += ("\n" if output else "") + exit_message
            print(
                f"[python-runner] Script failed with exit code {exit_code}, output length={len(output)}",
                file=sys.stderr,
            )
            return output if output else f"Script exited with code {exit_code} and produced no output."

        if not output:
            print("[python-runner] Script succeeded with no output", file=sys.stderr)
            return "Script produced no output."

        print(f"[python-runner] Script succeeded, output length={len(output)}", file=sys.stderr)
        return output

    finally:
        try:
            os.unlink(script_path)
        except OSError:
            pass


class RequestHandler(http.server.BaseHTTPRequestHandler):
    """HTTP request handler for the python-runner server."""

    def log_message(self, format: str, *args: object) -> None:
        """Override to use the project log prefix."""
        print(f"[python-runner] {format % args}", file=sys.stderr)

    def do_POST(self) -> None:
        """Handle POST /run requests."""
        if self.path != "/run":
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return

        try:
            content_length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid Content-Length"})
            return
        body = self.rfile.read(content_length)

        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid JSON"})
            return

        if not isinstance(payload, dict) or "code" not in payload:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "missing required field: code"})
            return

        code = payload["code"]
        if not isinstance(code, str):
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "field 'code' must be a string"})
            return

        raw_dependencies = payload.get("dependencies") or []
        if not isinstance(raw_dependencies, list):
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "field 'dependencies' must be a list"})
            return
        if not all(isinstance(dep, str) for dep in raw_dependencies):
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "every element of 'dependencies' must be a string"})
            return
        dependencies: list[str] = raw_dependencies

        print(
            f"[python-runner] POST /run: code length={len(code)}, dependencies={len(dependencies)}",
            file=sys.stderr,
        )

        output = run_script(code, dependencies)
        self._send_json(HTTPStatus.OK, {"output": output})

    def do_GET(self) -> None:
        """Return 404 for all GET requests."""
        self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_PUT(self) -> None:
        """Return 404 for all PUT requests."""
        self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_DELETE(self) -> None:
        """Return 404 for all DELETE requests."""
        self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_PATCH(self) -> None:
        """Return 404 for all PATCH requests."""
        self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_OPTIONS(self) -> None:
        """Return 404 for all OPTIONS requests."""
        self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_HEAD(self) -> None:
        """Return 404 for all HEAD requests."""
        self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_TRACE(self) -> None:
        """Return 404 for all TRACE requests."""
        self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_CONNECT(self) -> None:
        """Return 404 for all CONNECT requests."""
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
    """Start the HTTP server on PORT."""
    server = http.server.ThreadingHTTPServer(("", PORT), RequestHandler)
    print(f"[python-runner] Listening on port {PORT}", file=sys.stderr)
    server.serve_forever()


if __name__ == "__main__":
    main()
