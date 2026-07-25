"""Contract tests for immutable chat audit archival."""

import importlib.util
import json
import os
import unittest
from pathlib import Path
from unittest.mock import patch


class FakeS3:
    def __init__(self):
        self.puts = []

    def put_object(self, **kwargs):
        self.puts.append(kwargs)


def load_module():
    os.environ.update({
        "AWS_DEFAULT_REGION": "us-east-1",
        "AWS_EC2_METADATA_DISABLED": "true",
        "ARCHIVE_BUCKET": "archive-bucket",
    })
    fake_s3 = FakeS3()
    path = Path(__file__).parents[1] / "lambda" / "chat-archiver" / "index.py"
    spec = importlib.util.spec_from_file_location("chat_archiver_test", path)
    module = importlib.util.module_from_spec(spec)
    with patch("boto3.client", return_value=fake_s3):
        spec.loader.exec_module(module)
    return module, fake_s3


class ChatArchiverTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module, cls.s3 = load_module()

    def setUp(self):
        self.s3.puts.clear()

    def test_archives_insert_without_exposing_session_in_the_key(self):
        event = {
            "Records": [{
                "eventID": "stream-event-1",
                "eventName": "INSERT",
                "dynamodb": {
                    "NewImage": {
                        "sessionId": {"S": "private-session-id"},
                        "timestamp": {"S": "2026-07-24T12:34:56.000Z"},
                        "question": {"S": "How do I join?"},
                        "confidence": {"N": "0.8"},
                    },
                },
            }],
        }

        result = self.module.handler(event, None)

        self.assertEqual(result, {"batchItemFailures": []})
        self.assertEqual(len(self.s3.puts), 1)
        archived = self.s3.puts[0]
        self.assertNotIn("private-session-id", archived["Key"])
        self.assertIn("year=2026/month=07/day=24", archived["Key"])
        body = json.loads(archived["Body"].decode("utf-8"))
        self.assertEqual(body["sessionId"], "private-session-id")
        self.assertEqual(body["confidence"], 0.8)

    def test_ignores_feedback_updates(self):
        result = self.module.handler(
            {"Records": [{"eventID": "event-2", "eventName": "MODIFY"}]},
            None,
        )
        self.assertEqual(result, {"batchItemFailures": []})
        self.assertEqual(self.s3.puts, [])


if __name__ == "__main__":
    unittest.main()
