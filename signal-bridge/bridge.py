#!/usr/bin/env python3
"""
Signal bridge script that connects signal-cli to the stavrobot agent API.

Starts signal-cli as a subprocess, listens for incoming Signal messages via SSE,
forwards them to the agent API, and sends replies back via Signal.
"""

import base64
import http.client
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import tomllib
from datetime import datetime

from markdown_to_signal import convert_markdown
from signal_to_markdown import convert_signal_to_markdown

# Stored when signal-cli returns a RATE_LIMIT_FAILURE, cleared after a successful
# challenge submission. Only one pending challenge is tracked at a time.
_rate_limit_token: str | None = None
_rate_limit_retry_after_seconds: int | None = None


def log(message: str) -> None:
    """Log a message to stdout with timestamp."""
    timestamp = datetime.now().isoformat()
    print(f"[{timestamp}] {message}", flush=True)


class RequestCounter:
    """Thread-safe monotonically incrementing counter for JSON-RPC request IDs."""

    def __init__(self) -> None:
        """Initialise the counter at zero."""
        self._value: int = 0
        self._lock: threading.Lock = threading.Lock()

    def next(self) -> int:
        """Increment the counter and return the new value."""
        with self._lock:
            self._value += 1
            return self._value


def load_config() -> dict:
    """Load and parse the TOML configuration file."""
    config_path = "/app/config/config.toml"
    with open(config_path, "rb") as file:
        config = tomllib.load(file)
    return config


def wait_for_signal_cli_ready(timeout_seconds: int = 30) -> None:
    """Poll signal-cli health check endpoint until ready or timeout."""
    log("Waiting for signal-cli to be ready...")
    start_time = time.time()
    while time.time() - start_time < timeout_seconds:
        try:
            connection = http.client.HTTPConnection("localhost", 8080, timeout=2)
            connection.request("GET", "/api/v1/check")
            response = connection.getresponse()
            if response.status == 200:
                log("signal-cli is ready")
                connection.close()
                return
            connection.close()
        except (ConnectionRefusedError, OSError):
            pass
        time.sleep(0.5)
    raise TimeoutError("signal-cli did not become ready within timeout")


def start_signal_cli(account: str) -> subprocess.Popen:
    """Start signal-cli daemon as a subprocess."""
    command = [
        "signal-cli",
        "--trust-new-identities",
        "always",
        "-a",
        account,
        "daemon",
        "--http",
        "localhost:8080",
        "--receive-mode",
        "on-start",
        "--send-read-receipts",
    ]
    log(f"Starting signal-cli: {' '.join(command)}")
    process = subprocess.Popen(command)
    return process


def send_agent_request(message_text: str | None, source_number: str, files: list[dict] | None = None) -> str:
    """Send a message to the agent API and return the response.

    At least one of message_text or files must be provided.
    """
    log(f"send_agent_request: sending to agent API (message length={len(message_text) if message_text else 0}, files={len(files) if files else 0}, sender={source_number})")
    connection = http.client.HTTPConnection("app", 3001, timeout=60)
    payload: dict = {"source": "signal", "sender": source_number}
    if message_text is not None:
        payload["message"] = message_text
    if files is not None:
        payload["files"] = files
    body = json.dumps(payload)
    headers: dict[str, str] = {"Content-Type": "application/json"}
    connection.request("POST", "/chat", body, headers)
    response = connection.getresponse()
    response_data = response.read()
    connection.close()
    log(f"send_agent_request: agent API response status={response.status}, body length={len(response_data)}")

    if response.status != 200:
        log(f"send_agent_request: error response body: {response_data.decode()}")
        raise RuntimeError(f"Agent API returned status {response.status}")

    response_json = json.loads(response_data)
    if "response" not in response_json or not isinstance(response_json["response"], str):
        raise RuntimeError(
            f"Agent API returned unexpected response shape: {response_json!r}"
        )
    return response_json["response"]


def _extract_rate_limit_info(error: dict) -> tuple[str, int] | None:
    """Extract (token, retryAfterSeconds) from a signal-cli RATE_LIMIT_FAILURE error, or None."""
    results = (
        error.get("data", {})
        .get("response", {})
        .get("results", [])
    )
    if not isinstance(results, list):
        return None
    for result in results:
        if isinstance(result, dict) and result.get("type") == "RATE_LIMIT_FAILURE":
            token = result.get("token")
            retry_after = result.get("retryAfterSeconds")
            if isinstance(token, str) and isinstance(retry_after, int):
                return token, retry_after
    return None


def send_signal_message(
    recipient: str,
    message_text: str,
    request_id: int,
    text_styles: list[str] | None = None,
) -> str:
    """Send a message via signal-cli JSON-RPC.

    Returns "ok", "rate_limited", or "error".
    """
    global _rate_limit_token, _rate_limit_retry_after_seconds
    params: dict = {
        "recipient": [recipient],
        "message": message_text,
    }
    if text_styles:
        params["textStyle"] = text_styles
    connection = http.client.HTTPConnection("localhost", 8080, timeout=10)
    body = json.dumps({
        "jsonrpc": "2.0",
        "method": "send",
        "params": params,
        "id": request_id,
    })
    headers = {"Content-Type": "application/json"}
    connection.request("POST", "/api/v1/rpc", body, headers)
    response = connection.getresponse()
    response_data = response.read()
    connection.close()

    if response.status != 200:
        log(f"Warning: signal-cli send returned status {response.status}")
        return "error"

    result = json.loads(response_data)
    if "error" in result:
        log(f"Warning: signal-cli send failed: {result['error']}")
        rate_limit_info = _extract_rate_limit_info(result["error"])
        if rate_limit_info is not None:
            _rate_limit_token, _rate_limit_retry_after_seconds = rate_limit_info
            log(f"Rate limit detected, token stored, retryAfterSeconds={_rate_limit_retry_after_seconds}")
            return "rate_limited"
        return "error"

    return "ok"


def send_signal_message_with_attachment(
    recipient: str,
    message_text: str,
    request_id: int,
    attachment_paths: list[str],
) -> str:
    """Send a message with file attachments via signal-cli JSON-RPC.

    Returns "ok", "rate_limited", or "error".
    """
    global _rate_limit_token, _rate_limit_retry_after_seconds
    params: dict = {
        "recipient": [recipient],
        "message": message_text,
        "attachment": attachment_paths,
    }
    connection = http.client.HTTPConnection("localhost", 8080, timeout=10)
    body = json.dumps({
        "jsonrpc": "2.0",
        "method": "send",
        "params": params,
        "id": request_id,
    })
    headers = {"Content-Type": "application/json"}
    connection.request("POST", "/api/v1/rpc", body, headers)
    response = connection.getresponse()
    response_data = response.read()
    connection.close()

    if response.status != 200:
        log(f"Warning: signal-cli send returned status {response.status}")
        return "error"

    result = json.loads(response_data)
    if "error" in result:
        log(f"Warning: signal-cli send failed: {result['error']}")
        rate_limit_info = _extract_rate_limit_info(result["error"])
        if rate_limit_info is not None:
            _rate_limit_token, _rate_limit_retry_after_seconds = rate_limit_info
            log(f"Rate limit detected, token stored, retryAfterSeconds={_rate_limit_retry_after_seconds}")
            return "rate_limited"
        return "error"

    return "ok"


def make_send_handler(
    request_counter: RequestCounter,
) -> type[http.server.BaseHTTPRequestHandler]:
    """Return a request handler class closed over the given state."""

    class SendHandler(http.server.BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            if self.path == "/send":
                self._handle_send()
            elif self.path == "/challenge":
                self._handle_challenge()
            else:
                self.send_error_response(404, "Not found")

        def _handle_send(self) -> None:
            content_length = int(self.headers.get("Content-Length", 0))
            raw_body = self.rfile.read(content_length)

            try:
                body = json.loads(raw_body)
            except json.JSONDecodeError as error:
                self.send_error_response(400, f"Invalid JSON: {error}")
                return

            recipient = body.get("recipient")
            message_text = body.get("message", "")

            if not isinstance(recipient, str) or not recipient:
                self.send_error_response(400, "Missing or invalid recipient")
                return

            attachment_b64 = body.get("attachment")
            attachment_filename = body.get("attachmentFilename", "attachment.bin")

            if attachment_b64 is not None and not isinstance(attachment_b64, str):
                self.send_error_response(400, "attachment must be a base64-encoded string")
                return

            if not isinstance(attachment_filename, str):
                self.send_error_response(400, "attachmentFilename must be a string")
                return

            try:
                if attachment_b64 is not None:
                    try:
                        attachment_bytes = base64.b64decode(attachment_b64, validate=True)
                    except ValueError as error:
                        self.send_error_response(400, f"Invalid base64 attachment: {error}")
                        return
                    safe_filename = os.path.basename(attachment_filename) or "attachment.bin"
                    temp_dir = tempfile.mkdtemp()
                    temp_path = os.path.join(temp_dir, safe_filename)
                    with open(temp_path, "wb") as temp_file:
                        temp_file.write(attachment_bytes)
                    try:
                        send_result = send_signal_message_with_attachment(
                            recipient, message_text, request_counter.next(), [temp_path]
                        )
                    finally:
                        try:
                            shutil.rmtree(temp_dir)
                        except OSError as error:
                            log(f"Warning: failed to delete temp directory {temp_dir}: {error}")
                else:
                    plain_text, text_styles = convert_markdown(message_text)
                    send_result = send_signal_message(recipient, plain_text, request_counter.next(), text_styles)
            except (OSError, RuntimeError, json.JSONDecodeError) as error:
                log(f"Error in /send handler: {error}")
                self.send_error_response(500, str(error))
                return

            if send_result == "rate_limited":
                self.send_response(429)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "error": "rate_limited",
                    "retryAfterSeconds": _rate_limit_retry_after_seconds,
                }).encode())
                return

            if send_result == "error":
                self.send_error_response(502, "signal-cli failed to send message")
                return

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True}).encode())

        def _handle_challenge(self) -> None:
            global _rate_limit_token
            content_length = int(self.headers.get("Content-Length", 0))
            raw_body = self.rfile.read(content_length)

            try:
                body = json.loads(raw_body)
            except json.JSONDecodeError as error:
                self.send_error_response(400, f"Invalid JSON: {error}")
                return

            if not isinstance(body, dict):
                self.send_error_response(400, "Request body must be a JSON object")
                return

            if _rate_limit_token is None:
                self.send_error_response(400, "No pending rate limit challenge")
                return

            captcha = body.get("captcha")
            if not isinstance(captcha, str) or not captcha:
                self.send_error_response(400, "Missing or invalid captcha")
                return

            log(f"Submitting rate limit challenge, token={_rate_limit_token!r}, captcha length={len(captcha)}")
            try:
                connection = http.client.HTTPConnection("localhost", 8080, timeout=10)
                rpc_body = json.dumps({
                    "jsonrpc": "2.0",
                    "method": "submitRateLimitChallenge",
                    "params": {
                        "challenge": _rate_limit_token,
                        "captcha": captcha,
                    },
                    "id": request_counter.next(),
                })
                headers = {"Content-Type": "application/json"}
                connection.request("POST", "/api/v1/rpc", rpc_body, headers)
                response = connection.getresponse()
                response_data = response.read()
                connection.close()

                if response.status != 200:
                    log(f"Warning: signal-cli submitRateLimitChallenge returned status {response.status}")
                    self.send_error_response(502, f"signal-cli returned status {response.status}")
                    return

                result = json.loads(response_data)
            except (OSError, RuntimeError, json.JSONDecodeError) as error:
                log(f"Error in /challenge handler: {error}")
                self.send_error_response(500, str(error))
                return

            if "error" in result:
                log(f"Warning: signal-cli submitRateLimitChallenge failed: {result['error']}")
                self.send_response(502)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": result["error"]}).encode())
                return

            _rate_limit_token = None
            log("Rate limit challenge submitted successfully, token cleared")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True}).encode())

        def send_error_response(self, status: int, message: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": message}).encode())

        def log_message(self, format: str, *args: object) -> None:
            log(f"HTTP {self.address_string()} - {format % args}")

    return SendHandler


def start_http_server(
    request_counter: RequestCounter,
) -> None:
    """Start the HTTP server on port 8081 in a background daemon thread."""
    handler_class = make_send_handler(request_counter)
    server = http.server.HTTPServer(("0.0.0.0", 8081), handler_class)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    log("HTTP server listening on 0.0.0.0:8081")


def parse_sse_event(lines: list[str]) -> dict | None:
    """Parse SSE event lines into a dictionary."""
    event_type = None
    data = None

    for line in lines:
        if line.startswith("event:"):
            event_type = line[6:].strip()
        elif line.startswith("data:"):
            data = line[5:].strip()

    if event_type == "receive" and data:
        try:
            return json.loads(data)
        except json.JSONDecodeError:
            return None
    return None


def process_signal_event(
    event_data: dict,
    request_counter: RequestCounter,
) -> None:
    """Process a Signal receive event and handle the message."""
    envelope = event_data.get("envelope", {})
    log(f"Processing event: envelope keys={list(envelope.keys())}")

    source_number = envelope.get("sourceNumber")
    data_message = envelope.get("dataMessage")

    if not data_message:
        log(f"No dataMessage in envelope, skipping (source={source_number})")
        return

    message_text: str | None = data_message.get("message")
    log(f"dataMessage keys={list(data_message.keys())}, message_text={message_text!r}")

    if message_text:
        text_styles: list[dict] = data_message.get("textStyles", [])
        if text_styles:
            message_text = convert_signal_to_markdown(message_text, text_styles)
            log(f"Converted Signal formatting to Markdown: {message_text!r}")

    # Map of MIME type prefixes/exact types to file extensions for deriving filenames
    # when signal-cli does not provide one.
    mime_to_extension: dict[str, str] = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/gif": ".gif",
        "image/webp": ".webp",
        "application/pdf": ".pdf",
    }

    # Collect all attachments (including audio) to forward via the 'files' field.
    # Audio is no longer handled separately; it follows the same path as any other file.
    attachments = data_message.get("attachments", [])
    log(f"Attachments field in dataMessage: {attachments!r}")
    file_attachments: list[dict] = []
    if isinstance(attachments, list):
        log(f"Processing {len(attachments)} attachment(s)")
        for index, attachment in enumerate(attachments):
            if not isinstance(attachment, dict):
                log(f"Attachment {index}: skipping, not a dict: {attachment!r}")
                continue
            content_type = attachment.get("contentType", "")
            if not isinstance(content_type, str):
                log(f"Attachment {index}: skipping, contentType is not a string: {content_type!r}")
                continue
            attachment_id = attachment.get("id")
            if not isinstance(attachment_id, str):
                log(f"Attachment {index}: skipping, id is not a string: {attachment_id!r}")
                continue
            file_path = f"/root/.local/share/signal-cli/attachments/{attachment_id}"
            if not os.path.isfile(file_path):
                log(f"Attachment {index}: file not found at {file_path}, skipping")
                continue
            # Derive a filename: use the one signal-cli provides when available.
            # For audio, derive the extension from the MIME type (e.g. audio/aac -> voice-note.aac).
            # For other types, fall back to <id>.<extension> based on the content type.
            original_filename: str | None = attachment.get("filename")
            if not isinstance(original_filename, str) or not original_filename:
                if content_type.startswith("audio/"):
                    base_type = content_type.split(";")[0].strip()
                    extension = base_type.split("/")[1] if "/" in base_type else "bin"
                    original_filename = f"voice-note.{extension}"
                else:
                    extension = mime_to_extension.get(content_type, "")
                    original_filename = f"{attachment_id}{extension}"
            file_size = os.path.getsize(file_path)
            log(f"Attachment {index}: reading {file_path} ({file_size} bytes), content_type={content_type!r}, filename={original_filename!r}")
            try:
                with open(file_path, "rb") as attachment_file:
                    file_data_b64 = base64.b64encode(attachment_file.read()).decode("ascii")
            except OSError as error:
                log(f"Attachment {index}: error reading {file_path}: {error}")
                continue
            file_attachments.append({
                "data": file_data_b64,
                "filename": original_filename,
                "mimeType": content_type,
            })
            log(f"Attachment {index}: base64-encoded {file_size} bytes for forwarding")

    if not message_text and not file_attachments:
        log(f"No message text or file attachments, skipping (source={source_number})")
        return

    log(f"Received message from {source_number}: {message_text!r} (file_attachments={len(file_attachments)})")

    # The bridge does not reply directly on Signal. The agent uses the
    # send_signal_message tool to send replies, which hits our /send endpoint.
    try:
        agent_response = send_agent_request(message_text, source_number, file_attachments if file_attachments else None)
        log(f"Agent response: {agent_response}")
    except (OSError, RuntimeError, json.JSONDecodeError, KeyError, TypeError) as error:
        log(f"Error processing message: {error}")


def listen_to_sse_stream(
    request_counter: RequestCounter,
) -> None:
    """Connect to signal-cli SSE stream and process incoming messages."""
    log("Connecting to signal-cli event stream...")
    connection = http.client.HTTPConnection("localhost", 8080, timeout=None)
    connection.request("GET", "/api/v1/events")
    response = connection.getresponse()

    if response.status != 200:
        raise RuntimeError(f"Failed to connect to event stream: status {response.status}")

    log("Connected to event stream, listening for messages...")
    event_lines = []

    while True:
        line = response.readline()
        if not line:
            raise RuntimeError("SSE stream closed unexpectedly")

        line = line.decode("utf-8").rstrip("\n\r")

        if line == "":
            if event_lines:
                event_data = parse_sse_event(event_lines)
                if event_data:
                    process_signal_event(event_data, request_counter)
                event_lines = []
        else:
            event_lines.append(line)


def main() -> None:
    """Main entry point for the signal bridge."""
    log("Starting signal bridge...")

    config = load_config()

    signal_config = config.get("signal", {})
    if not isinstance(signal_config, dict):
        log("Error: [signal] section must be a table in config.toml")
        sys.exit(1)
    account = signal_config.get("account")

    if not isinstance(account, str) or not account:
        log("Error: account must be a non-empty string in [signal] section")
        sys.exit(1)

    log(f"Account: {account}")

    signal_cli_process = start_signal_cli(account)
    request_counter = RequestCounter()

    try:
        wait_for_signal_cli_ready()
        start_http_server(request_counter)
        listen_to_sse_stream(request_counter)
    except KeyboardInterrupt:
        log("Received interrupt, shutting down...")
    except Exception as error:
        log(f"Fatal error: {error}")
        raise
    finally:
        log("Terminating signal-cli...")
        signal_cli_process.terminate()
        try:
            signal_cli_process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            log("signal-cli did not terminate, killing...")
            signal_cli_process.kill()


if __name__ == "__main__":
    main()
