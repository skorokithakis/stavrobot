#!/usr/bin/env python3
"""Interactive CLI client for stavrobot HTTP API."""
import json
import os
import sys
import urllib.error
import urllib.request


def get_server_url() -> str:
    """Return the server URL from environment or default."""
    return os.environ.get("STAVROBOT_URL") or "http://localhost:3000"


def send_message(url: str, message: str) -> str:
    """Send a message to the chat API and return the response.

    Raises urllib.error.URLError or urllib.error.HTTPError on network/HTTP errors.
    """
    request_data = json.dumps({"message": message}).encode("utf-8")
    request = urllib.request.Request(
        f"{url}/chat",
        data=request_data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    with urllib.request.urlopen(request) as response:
        response_data: dict[str, str] = json.loads(response.read().decode("utf-8"))
        return response_data["response"]


def main() -> None:
    """Run the interactive chat loop."""
    server_url = get_server_url()

    print(f"Connected to {server_url}")
    print("Type your message and press Enter. Press Ctrl+C or Ctrl+D to exit.\n")

    while True:
        try:
            user_input = input("> ").strip()

            if not user_input:
                break

            try:
                bot_response = send_message(server_url, user_input)
                print(bot_response)
            except (urllib.error.URLError, urllib.error.HTTPError) as error:
                print(f"Error communicating with server: {error}", file=sys.stderr)

        except (KeyboardInterrupt, EOFError):
            print()
            break

    print("Goodbye!")


if __name__ == "__main__":
    main()
