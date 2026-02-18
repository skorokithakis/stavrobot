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
import subprocess
import sys
import tempfile
import threading
import time
import tomllib
from datetime import datetime

from markdown_to_signal import convert_markdown


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
    config_path = "/app/config.toml"
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


def send_agent_request(message_text: str | None, source_number: str, audio: str | None = None, audio_content_type: str | None = None) -> str:
    """Send a message to the agent API and return the response.

    Either message_text or audio (or both) must be provided.
    """
    log(f"send_agent_request: sending to agent API (message length={len(message_text) if message_text else 0}, audio={'yes' if audio else 'no'}, audio_content_type={audio_content_type!r}, sender={source_number})")
    connection = http.client.HTTPConnection("app", 3000, timeout=60)
    payload: dict = {"source": "signal", "sender": source_number}
    if message_text is not None:
        payload["message"] = message_text
    if audio is not None:
        payload["audio"] = audio
        if audio_content_type is not None:
            payload["audioContentType"] = audio_content_type
    body = json.dumps(payload)
    headers = {"Content-Type": "application/json"}
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


def send_signal_message(
    recipient: str,
    message_text: str,
    request_id: int,
    text_styles: list[str] | None = None,
) -> bool:
    """Send a message via signal-cli JSON-RPC. Returns True on success, False on failure."""
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
        return False

    result = json.loads(response_data)
    if "error" in result:
        log(f"Warning: signal-cli send failed: {result['error']}")
        return False

    return True


def send_signal_message_with_attachment(
    recipient: str,
    message_text: str,
    request_id: int,
    attachment_paths: list[str],
) -> bool:
    """Send a message with file attachments via signal-cli JSON-RPC. Returns True on success, False on failure."""
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
        return False

    result = json.loads(response_data)
    if "error" in result:
        log(f"Warning: signal-cli send failed: {result['error']}")
        return False

    return True


def make_send_handler(
    allowed_numbers: list[str],
    request_counter: RequestCounter,
) -> type[http.server.BaseHTTPRequestHandler]:
    """Return a request handler class closed over the given state."""

    class SendHandler(http.server.BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            if self.path != "/send":
                self.send_error_response(404, "Not found")
                return

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

            if recipient not in allowed_numbers:
                self.send_error_response(403, "Recipient not in allowed numbers")
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
                    suffix = "." + attachment_filename.rsplit(".", 1)[-1] if "." in attachment_filename else ".bin"
                    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temp_file:
                        temp_file.write(attachment_bytes)
                        temp_path = temp_file.name
                    try:
                        success = send_signal_message_with_attachment(
                            recipient, message_text, request_counter.next(), [temp_path]
                        )
                    finally:
                        try:
                            os.unlink(temp_path)
                        except OSError as error:
                            log(f"Warning: failed to delete temp file {temp_path}: {error}")
                else:
                    plain_text, text_styles = convert_markdown(message_text)
                    success = send_signal_message(recipient, plain_text, request_counter.next(), text_styles)
            except (OSError, RuntimeError, json.JSONDecodeError) as error:
                log(f"Error in /send handler: {error}")
                self.send_error_response(500, str(error))
                return

            if not success:
                self.send_error_response(502, "signal-cli failed to send message")
                return

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
    allowed_numbers: list[str],
    request_counter: RequestCounter,
) -> None:
    """Start the HTTP server on port 8081 in a background daemon thread."""
    handler_class = make_send_handler(allowed_numbers, request_counter)
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
    allowed_numbers: list[str],
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

    if source_number not in allowed_numbers:
        log(f"Ignoring message from unauthorized number: {source_number}")
        return

    message_text: str | None = data_message.get("message")
    log(f"dataMessage keys={list(data_message.keys())}, message_text={message_text!r}")

    # Check for audio attachments and forward them to the agent API as base64.
    audio_b64: str | None = None
    audio_content_type: str | None = None
    attachments = data_message.get("attachments", [])
    log(f"Attachments field in dataMessage: {attachments!r}")
    if isinstance(attachments, list):
        log(f"Processing {len(attachments)} attachment(s)")
        for index, attachment in enumerate(attachments):
            if not isinstance(attachment, dict):
                log(f"Attachment {index}: skipping, not a dict: {attachment!r}")
                continue
            content_type = attachment.get("contentType", "")
            log(f"Attachment {index}: contentType={content_type!r}, keys={list(attachment.keys())}")
            if not isinstance(content_type, str) or not content_type.startswith("audio/"):
                log(f"Attachment {index}: skipping, not an audio type")
                continue
            attachment_id = attachment.get("id")
            if not isinstance(attachment_id, str):
                log(f"Attachment {index}: skipping, id is not a string: {attachment_id!r}")
                continue
            file_path = f"/root/.local/share/signal-cli/attachments/{attachment_id}"
            if not os.path.isfile(file_path):
                log(f"Attachment {index}: file not found at {file_path}, skipping")
                continue
            file_size = os.path.getsize(file_path)
            log(f"Reading voice note: {file_path} ({file_size} bytes)")
            try:
                with open(file_path, "rb") as audio_file:
                    audio_b64 = base64.b64encode(audio_file.read()).decode("ascii")
            except OSError as error:
                log(f"Error reading voice note {file_path}: {error}")
                continue
            audio_content_type = content_type
            log(f"Attachment {index}: base64-encoded {file_size} bytes for forwarding, content_type={content_type!r}")
            # Only forward the first audio attachment.
            break

    if not message_text and audio_b64 is None:
        log(f"No message text or audio attachment, skipping (source={source_number})")
        return

    log(f"Received message from {source_number}: {message_text!r} (audio={'yes' if audio_b64 else 'no'}, audio_content_type={audio_content_type!r})")

    # The bridge does not reply directly on Signal. The agent uses the
    # send_signal_message tool to send replies, which hits our /send endpoint.
    try:
        agent_response = send_agent_request(message_text, source_number, audio_b64, audio_content_type)
        log(f"Agent response: {agent_response}")
    except (OSError, RuntimeError, json.JSONDecodeError, KeyError, TypeError) as error:
        log(f"Error processing message: {error}")


def listen_to_sse_stream(
    allowed_numbers: list[str],
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
                    process_signal_event(event_data, allowed_numbers, request_counter)
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
    allowed_numbers = signal_config.get("allowedNumbers", [])

    if not isinstance(account, str):
        log("Error: account must be a string in [signal] section")
        sys.exit(1)

    if not isinstance(allowed_numbers, list) or not all(isinstance(number, str) for number in allowed_numbers):
        log("Error: allowedNumbers must be a list of strings in [signal] section")
        sys.exit(1)

    if not account:
        log("Error: No account configured in [signal] section")
        sys.exit(1)

    if not allowed_numbers:
        log("Warning: No allowed numbers configured, will ignore all messages")

    log(f"Account: {account}")
    log(f"Allowed numbers: {allowed_numbers}")

    signal_cli_process = start_signal_cli(account)
    request_counter = RequestCounter()

    try:
        wait_for_signal_cli_ready()
        start_http_server(allowed_numbers, request_counter)
        listen_to_sse_stream(allowed_numbers, request_counter)
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
