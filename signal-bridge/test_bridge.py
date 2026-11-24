"""Tests for the Signal bridge's message parsing and recipient classification."""

import base64
import json
import os
import sys
import types
import unittest
from unittest.mock import mock_open, patch

# Allow importing from the signal-bridge directory without installing.
sys.path.insert(0, os.path.dirname(__file__))

# Stub out mistune only if it isn't installed, so real-mistune tests aren't affected.
try:
    import mistune  # noqa: F401
except ImportError:
    sys.modules["mistune"] = types.ModuleType("mistune")

import bridge  # noqa: E402

PHONE_NUMBER = "+15551234567"
UUID = "123e4567-e89b-12d3-a456-426614174000"
GROUP_ID = "group.abc123+/="
BOT_ACCOUNT = "+15550000001"
BOT_UUID = "00000000-0000-0000-0000-000000000001"
OTHER_PHONE_NUMBER = "+15550000002"
OTHER_UUID = "00000000-0000-0000-0000-000000000002"


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

        send.assert_called_once_with("hi", PHONE_NUMBER, None, None, "Alice", False)

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
        send.assert_called_once_with("hi", UUID, None, None, "Alice", False)

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

        send.assert_called_once_with("hi", UUID, None, None, None, False)

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
            False,
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
            False,
        )

    def test_group_message_mentioning_the_bot_addresses_the_bot(self) -> None:
        event = {
            "account": BOT_ACCOUNT,
            "envelope": {
                "sourceNumber": PHONE_NUMBER,
                "sourceUuid": UUID,
                "sourceName": "Alice",
                "dataMessage": {
                    "message": "\ufffc hello",
                    "mentions": [
                        {
                            "name": BOT_ACCOUNT,
                            "number": BOT_ACCOUNT,
                            "uuid": BOT_UUID,
                            "start": 0,
                            "length": 1,
                        }
                    ],
                    "groupInfo": {"groupId": GROUP_ID, "groupName": "The Group"},
                },
            },
        }
        with patch.object(bridge, "send_agent_request") as send:
            bridge.process_signal_event(event, bridge.RequestCounter())

        send.assert_called_once_with(
            "@you hello",
            GROUP_ID,
            None,
            {"id": PHONE_NUMBER, "name": "Alice"},
            "The Group",
            True,
        )

    def test_reply_to_the_bot_addresses_the_bot_and_prepends_the_quote(self) -> None:
        event = {
            "account": BOT_ACCOUNT,
            "envelope": {
                "sourceNumber": PHONE_NUMBER,
                "sourceUuid": UUID,
                "sourceName": "Alice",
                "dataMessage": {
                    "message": "thanks",
                    "quote": {
                        "id": 1,
                        "author": BOT_ACCOUNT,
                        "authorNumber": BOT_ACCOUNT,
                        "authorUuid": BOT_UUID,
                        "text": "hello there",
                        "attachments": [],
                    },
                },
            },
        }
        with patch.object(bridge, "send_agent_request") as send:
            bridge.process_signal_event(event, bridge.RequestCounter())

        send.assert_called_once_with(
            '[In reply to you: "hello there"]\nthanks',
            PHONE_NUMBER,
            None,
            None,
            "Alice",
            True,
        )

    def test_reply_to_another_person_mentioning_the_bot_addresses_the_bot(self) -> None:
        event = {
            "account": BOT_ACCOUNT,
            "envelope": {
                "sourceNumber": PHONE_NUMBER,
                "sourceName": "Alice",
                "dataMessage": {
                    "message": "\ufffc can you help",
                    "mentions": [
                        {
                            "name": BOT_ACCOUNT,
                            "number": BOT_ACCOUNT,
                            "uuid": BOT_UUID,
                            "start": 0,
                            "length": 1,
                        }
                    ],
                    "quote": {
                        "id": 2,
                        "author": OTHER_PHONE_NUMBER,
                        "authorNumber": OTHER_PHONE_NUMBER,
                        "authorUuid": OTHER_UUID,
                        "text": "some text",
                        "attachments": [],
                    },
                },
            },
        }
        with patch.object(bridge, "send_agent_request") as send:
            bridge.process_signal_event(event, bridge.RequestCounter())

        send.assert_called_once_with(
            '[In reply to +15550000002: "some text"]\n@you can you help',
            PHONE_NUMBER,
            None,
            None,
            "Alice",
            True,
        )

    def test_command_reply_does_not_get_a_quote_line(self) -> None:
        event = {
            "account": BOT_ACCOUNT,
            "envelope": {
                "sourceNumber": PHONE_NUMBER,
                "sourceName": "Alice",
                "dataMessage": {
                    "message": "/stop",
                    "quote": {
                        "id": 1,
                        "author": BOT_ACCOUNT,
                        "authorNumber": BOT_ACCOUNT,
                        "authorUuid": BOT_UUID,
                        "text": "hello there",
                        "attachments": [],
                    },
                },
            },
        }
        with patch.object(bridge, "send_agent_request") as send:
            bridge.process_signal_event(event, bridge.RequestCounter())

        send.assert_called_once_with("/stop", PHONE_NUMBER, None, None, "Alice", True)

    def test_attachment_only_reply_does_not_get_a_quote_line(self) -> None:
        event = {
            "account": BOT_ACCOUNT,
            "envelope": {
                "sourceNumber": PHONE_NUMBER,
                "sourceName": "Alice",
                "dataMessage": {
                    "attachments": [
                        {"id": "0000", "contentType": "image/png", "filename": "photo.png"}
                    ],
                    "quote": {
                        "id": 1,
                        "author": BOT_ACCOUNT,
                        "authorNumber": BOT_ACCOUNT,
                        "authorUuid": BOT_UUID,
                        "text": "hello there",
                        "attachments": [],
                    },
                },
            },
        }
        with patch.object(bridge.os.path, "isfile", return_value=True):
            with patch.object(bridge.os.path, "getsize", return_value=4):
                with patch("builtins.open", mock_open(read_data=b"data")):
                    with patch.object(bridge, "send_agent_request") as send:
                        bridge.process_signal_event(event, bridge.RequestCounter())

        send.assert_called_once_with(
            None,
            PHONE_NUMBER,
            [{
                "data": base64.b64encode(b"data").decode("ascii"),
                "filename": "photo.png",
                "mimeType": "image/png",
            }],
            None,
            "Alice",
            True,
        )

    def test_mentions_are_replaced_in_start_order_with_fallback_labels(self) -> None:
        event = {
            "account": BOT_ACCOUNT,
            "envelope": {
                "sourceNumber": PHONE_NUMBER,
                "dataMessage": {
                    "message": "\ufffc hi \ufffc",
                    # Deliberately out of order, as the sort by start must decide
                    # which placeholder belongs to which mention.
                    "mentions": [
                        {
                            "number": OTHER_PHONE_NUMBER,
                            "uuid": OTHER_UUID,
                            "start": 7,
                            "length": 1,
                        },
                        {"name": "Alice", "start": 0, "length": 1},
                    ],
                },
            },
        }
        with patch.object(bridge, "send_agent_request") as send:
            bridge.process_signal_event(event, bridge.RequestCounter())

        send.assert_called_once_with(
            "@Alice hi @+15550000002",
            PHONE_NUMBER,
            None,
            None,
            None,
            False,
        )

    def test_message_text_and_agent_response_are_not_logged(self) -> None:
        event = {
            "account": BOT_ACCOUNT,
            "envelope": {
                "sourceNumber": PHONE_NUMBER,
                "sourceName": "Alice",
                "dataMessage": {"message": "unique incoming text"},
            },
        }
        with patch.object(bridge, "send_agent_request", return_value="unique agent response"):
            with patch.object(bridge, "log") as log:
                bridge.process_signal_event(event, bridge.RequestCounter())

        logged_lines = [str(call.args[0]) for call in log.call_args_list]
        self.assertFalse(any("unique incoming text" in line for line in logged_lines))
        self.assertFalse(any("unique agent response" in line for line in logged_lines))


class QuoteFormattingTests(unittest.TestCase):
    """format_quote_line flattens whitespace, names an unknown author, and truncates."""

    def test_long_quote_is_flattened_and_truncated(self) -> None:
        quote = {
            "text": "a" * 200 + "\r \u2028\t" + "b" * 200,
        }

        line = bridge.format_quote_line(quote, BOT_ACCOUNT)

        self.assertEqual(
            line,
            '[In reply to unknown: "' + "a" * 200 + " " + "b" * 99 + '…"]',
        )


class SendAgentRequestTests(unittest.TestCase):
    """send_agent_request includes the addressed flag in the /chat body."""

    def test_addressed_to_bot_is_sent_as_a_boolean(self) -> None:
        FakeHTTPConnection.instances = []

        class SuccessfulConnection(FakeHTTPConnection):
            def getresponse(self) -> FakeResponse:
                return FakeResponse(body=b'{"response": "ok"}')

        with patch("http.client.HTTPConnection", SuccessfulConnection):
            bridge.send_agent_request("hi", PHONE_NUMBER, addressed_to_bot=True)

        payload = json.loads(FakeHTTPConnection.instances[-1].requests[-1]["body"])
        self.assertIs(payload["addressedToBot"], True)


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
