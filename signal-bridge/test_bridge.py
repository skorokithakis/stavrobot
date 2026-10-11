"""Tests for the Signal bridge's message parsing and recipient classification."""

import json
import os
import sys
import types
import unittest
from unittest.mock import patch

# Allow importing from the signal-bridge directory without installing.
sys.path.insert(0, os.path.dirname(__file__))

# Stub out mistune so bridge (via markdown_to_signal) can be imported without the package.
mistune_stub = types.ModuleType("mistune")
sys.modules.setdefault("mistune", mistune_stub)

import bridge  # noqa: E402

PHONE_NUMBER = "+15551234567"
UUID = "123e4567-e89b-12d3-a456-426614174000"
GROUP_ID = "group.abc123+/="


class FakeResponse:
    """Minimal stand-in for an http.client response."""

    def __init__(self, status: int = 200, body: bytes = b'{"result": {}}') -> None:
        """Store the canned status and body."""
        self.status = status
        self._body = body

    def read(self) -> bytes:
        """Return the canned body."""
        return self._body


class FakeHTTPConnection:
    """Records requests instead of opening a socket."""

    instances: list["FakeHTTPConnection"] = []

    def __init__(self, host: str, port: int, timeout: int | None = None) -> None:
        """Record the target of the connection."""
        self.host = host
        self.port = port
        self.timeout = timeout
        self.requests: list[dict] = []
        FakeHTTPConnection.instances.append(self)

    def request(self, method: str, path: str, body: str | None = None, headers: dict | None = None) -> None:
        """Record the outgoing request."""
        self.requests.append({"method": method, "path": path, "body": body, "headers": headers})

    def getresponse(self) -> FakeResponse:
        """Return a canned successful response."""
        return FakeResponse()

    def close(self) -> None:
        """No-op close."""


class ProcessSignalEventTests(unittest.TestCase):
    """process_signal_event decides the sender, participant, and label."""

    def test_direct_message_uses_the_source_number_and_has_no_participant(self) -> None:
        event = {
            "envelope": {
                "sourceNumber": PHONE_NUMBER,
                "sourceUuid": UUID,
                "sourceName": "Alice",
                "dataMessage": {"message": "hi"},
            }
        }
        with patch.object(bridge, "send_agent_request") as send:
            bridge.process_signal_event(event, bridge.RequestCounter())

        send.assert_called_once_with("hi", PHONE_NUMBER, None, None, "Alice")

    def test_sender_falls_back_to_the_uuid_when_source_number_is_missing(self) -> None:
        event = {
            "envelope": {
                "sourceUuid": UUID,
                "sourceName": "Alice",
                "dataMessage": {"message": "hi"},
            }
        }
        with patch.object(bridge, "send_agent_request") as send:
            bridge.process_signal_event(event, bridge.RequestCounter())

        # A direct message carries no participant, and the label is the profile name.
        send.assert_called_once_with("hi", UUID, None, None, "Alice")

    def test_sender_falls_back_to_the_uuid_when_source_number_is_empty(self) -> None:
        event = {
            "envelope": {
                "sourceNumber": "",
                "sourceUuid": UUID,
                "dataMessage": {"message": "hi"},
            }
        }
        with patch.object(bridge, "send_agent_request") as send:
            bridge.process_signal_event(event, bridge.RequestCounter())

        send.assert_called_once_with("hi", UUID, None, None, None)

    def test_group_message_is_routed_by_group_id_with_participant_and_label(self) -> None:
        event = {
            "envelope": {
                "sourceNumber": PHONE_NUMBER,
                "sourceUuid": UUID,
                "sourceName": "Alice",
                "dataMessage": {
                    "message": "hello group",
                    "groupInfo": {"groupId": GROUP_ID, "groupName": "The Group"},
                },
            }
        }
        with patch.object(bridge, "send_agent_request") as send:
            bridge.process_signal_event(event, bridge.RequestCounter())

        send.assert_called_once_with(
            "hello group",
            GROUP_ID,
            None,
            {"id": PHONE_NUMBER, "name": "Alice"},
            "The Group",
        )

    def test_group_message_falls_back_to_uuid_for_the_participant(self) -> None:
        event = {
            "envelope": {
                "sourceUuid": UUID,
                "dataMessage": {
                    "message": "hello group",
                    "groupInfo": {"groupId": GROUP_ID},
                },
            }
        }
        with patch.object(bridge, "send_agent_request") as send:
            bridge.process_signal_event(event, bridge.RequestCounter())

        # No sourceName, so the participant name falls back to their id, and the
        # group has no name to use as a label.
        send.assert_called_once_with(
            "hello group",
            GROUP_ID,
            None,
            {"id": UUID, "name": UUID},
            None,
        )


class RecipientParamTests(unittest.TestCase):
    """recipient_params classifies recipients as people or groups."""

    def setUp(self) -> None:
        """Reset the recorded connections before each test."""
        FakeHTTPConnection.instances = []

    def test_e164_phone_number_is_a_recipient(self) -> None:
        self.assertEqual(bridge.recipient_params(PHONE_NUMBER), {"recipient": [PHONE_NUMBER]})

    def test_uuid_is_a_recipient(self) -> None:
        self.assertEqual(bridge.recipient_params(UUID), {"recipient": [UUID]})

    def test_other_values_are_group_ids(self) -> None:
        self.assertEqual(bridge.recipient_params(GROUP_ID), {"groupId": GROUP_ID})

    def test_text_send_uses_the_recipient_list_for_a_phone_number(self) -> None:
        with patch("http.client.HTTPConnection", FakeHTTPConnection):
            result = bridge.send_signal_message(PHONE_NUMBER, "hello", 1)

        self.assertEqual(result, "ok")
        params = self._last_send_params()
        self.assertEqual(params["recipient"], [PHONE_NUMBER])
        self.assertNotIn("groupId", params)

    def test_text_send_uses_the_group_id_parameter_for_a_group(self) -> None:
        with patch("http.client.HTTPConnection", FakeHTTPConnection):
            result = bridge.send_signal_message(GROUP_ID, "hello", 1)

        self.assertEqual(result, "ok")
        params = self._last_send_params()
        self.assertEqual(params["groupId"], GROUP_ID)
        self.assertNotIn("recipient", params)

    def test_attachment_send_uses_the_recipient_list_for_a_uuid(self) -> None:
        with patch("http.client.HTTPConnection", FakeHTTPConnection):
            result = bridge.send_signal_message_with_attachment(UUID, "", 1, ["/tmp/a.bin"])

        self.assertEqual(result, "ok")
        params = self._last_send_params()
        self.assertEqual(params["recipient"], [UUID])
        self.assertNotIn("groupId", params)

    def test_attachment_send_uses_the_group_id_parameter_for_a_group(self) -> None:
        with patch("http.client.HTTPConnection", FakeHTTPConnection):
            result = bridge.send_signal_message_with_attachment(GROUP_ID, "", 1, ["/tmp/a.bin"])

        self.assertEqual(result, "ok")
        params = self._last_send_params()
        self.assertEqual(params["groupId"], GROUP_ID)
        self.assertNotIn("recipient", params)

    def _last_send_params(self) -> dict:
        """Return the JSON-RPC params of the most recent signal-cli send."""
        connection = FakeHTTPConnection.instances[-1]
        payload = json.loads(connection.requests[-1]["body"])
        self.assertEqual(payload["method"], "send")
        return payload["params"]


if __name__ == "__main__":
    unittest.main()
