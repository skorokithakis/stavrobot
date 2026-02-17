#!/usr/bin/env python3
"""
Signal bridge script that connects signal-cli to the stavrobot agent API.

Starts signal-cli as a subprocess, listens for incoming Signal messages via SSE,
forwards them to the agent API, and sends replies back via Signal.
"""

import http.client
import json
import subprocess
import sys
import time
import tomllib
from datetime import datetime

from markdown_to_signal import convert_markdown


def log(message: str) -> None:
    """Log a message to stdout with timestamp."""
    timestamp = datetime.now().isoformat()
    print(f"[{timestamp}] {message}", flush=True)


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


def send_agent_request(message_text: str) -> str:
    """Send a message to the agent API and return the response."""
    connection = http.client.HTTPConnection("app", 3000, timeout=60)
    body = json.dumps({"message": message_text})
    headers = {"Content-Type": "application/json"}
    connection.request("POST", "/chat", body, headers)
    response = connection.getresponse()
    response_data = response.read()
    connection.close()

    if response.status != 200:
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
) -> None:
    """Send a message via signal-cli JSON-RPC."""
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
        return

    result = json.loads(response_data)
    if "error" in result:
        log(f"Warning: signal-cli send failed: {result['error']}")


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


def process_signal_event(event_data: dict, allowed_numbers: list[str], request_counter: list[int]) -> None:
    """Process a Signal receive event and handle the message."""
    envelope = event_data.get("envelope", {})

    source_number = envelope.get("sourceNumber")
    data_message = envelope.get("dataMessage")

    if not data_message:
        return

    message_text = data_message.get("message")
    if not message_text:
        return

    if source_number not in allowed_numbers:
        log(f"Ignoring message from unauthorized number: {source_number}")
        return

    log(f"Received message from {source_number}: {message_text}")

    try:
        agent_response = send_agent_request(message_text)
        log(f"Agent response: {agent_response}")
        plain_text, text_styles = convert_markdown(agent_response)
        request_counter[0] += 1
        send_signal_message(source_number, plain_text, request_counter[0], text_styles)
        log(f"Sent reply to {source_number}")
    except (OSError, RuntimeError, json.JSONDecodeError, KeyError, TypeError) as error:
        log(f"Error processing message: {error}")
        error_message = "Sorry, I encountered an error processing your message."
        request_counter[0] += 1
        send_signal_message(source_number, error_message, request_counter[0])


def listen_to_sse_stream(allowed_numbers: list[str]) -> None:
    """Connect to signal-cli SSE stream and process incoming messages."""
    log("Connecting to signal-cli event stream...")
    connection = http.client.HTTPConnection("localhost", 8080, timeout=None)
    connection.request("GET", "/api/v1/events")
    response = connection.getresponse()

    if response.status != 200:
        raise RuntimeError(f"Failed to connect to event stream: status {response.status}")

    log("Connected to event stream, listening for messages...")
    request_counter = [0]
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

    try:
        wait_for_signal_cli_ready()
        listen_to_sse_stream(allowed_numbers)
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
