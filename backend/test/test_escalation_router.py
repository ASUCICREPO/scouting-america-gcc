"""Contract tests for queued staff escalation delivery."""

import importlib.util
import json
import os
import unittest
from pathlib import Path
from unittest.mock import patch

from botocore.exceptions import ClientError


class FakeClient:
    def __init__(self):
        self.requests = []
        self.error = None

    def publish(self, **kwargs):
        if self.error:
            raise self.error
        self.requests.append(kwargs)

    def send_email(self, **kwargs):
        if self.error:
            raise self.error
        self.requests.append(kwargs)


class FakeTable:
    def __init__(self):
        self.records = {}

    @staticmethod
    def _key(value):
        return value["eventType"], value["timestamp"]

    @property
    def items(self):
        return list(self.records.values())

    def get_item(self, **kwargs):
        item = self.records.get(self._key(kwargs["Key"]))
        return {"Item": item} if item else {}

    def put_item(self, **kwargs):
        key = self._key(kwargs["Item"])
        if key in self.records and kwargs.get("ConditionExpression"):
            raise ClientError(
                {"Error": {"Code": "ConditionalCheckFailedException"}},
                "PutItem",
            )
        self.records[key] = kwargs["Item"]

    def update_item(self, **kwargs):
        item = self.records[self._key(kwargs["Key"])]
        names = kwargs["ExpressionAttributeNames"]
        values = kwargs["ExpressionAttributeValues"]
        if "#channel" in names:
            item["delivery"][names["#channel"]] = values[":sent"]
        if "#status" in names:
            item["delivery"][names["#status"]] = values[":completed"]
        item["updatedAt"] = values[":updated"]


class FakeDynamo:
    def __init__(self, table):
        self.table = table

    def Table(self, _name):  # noqa: N802 - mirrors boto3
        return self.table


def load_module():
    os.environ.update({
        "AWS_DEFAULT_REGION": "us-east-1",
        "AWS_EC2_METADATA_DISABLED": "true",
        "SNS_TOPIC_ARN": "arn:aws:sns:us-east-1:123456789012:alerts",
        "STAFF_EMAIL": "staff@example.org",
        "ANALYTICS_TABLE": "analytics-table",
    })
    sns = FakeClient()
    ses = FakeClient()
    table = FakeTable()
    clients = {"sns": sns, "ses": ses}

    path = Path(__file__).parents[1] / "lambda" / "escalation-router" / "index.py"
    spec = importlib.util.spec_from_file_location("escalation_router_queue_test", path)
    module = importlib.util.module_from_spec(spec)
    with patch("boto3.client", side_effect=lambda name: clients[name]), patch(
        "boto3.resource", return_value=FakeDynamo(table)
    ):
        spec.loader.exec_module(module)
    return module, sns, ses, table


class EscalationRouterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module, cls.sns, cls.ses, cls.table = load_module()

    def setUp(self):
        self.sns.requests.clear()
        self.sns.error = None
        self.ses.requests.clear()
        self.ses.error = None
        self.table.records.clear()

    @staticmethod
    def payload():
        return {
            "escalationId": "session-1:2026-07-29T00:00:00.000Z",
            "timestamp": "2026-07-29T00:00:00.000Z",
            "sessionId": "session-1",
            "userId": "anonymous",
            "question": "There is an emergency",
            "answer": "Contact emergency services",
            "reason": 'Safety keyword detected: "emergency"',
            "confidence": 0.9,
        }

    @staticmethod
    def sqs_event(payload):
        return {
            "Records": [{
                "eventSource": "aws:sqs",
                "body": json.dumps(payload),
            }],
        }

    def test_unwraps_sqs_and_delivers_a_high_severity_alert(self):
        result = self.module.handler(self.sqs_event(self.payload()), None)

        self.assertEqual(result["statusCode"], 200)
        self.assertEqual(len(self.sns.requests), 1)
        self.assertEqual(len(self.ses.requests), 1)
        self.assertEqual(self.table.items[0]["sessionId"], "session-1")
        self.assertEqual(self.table.items[0]["occurredAt"], self.payload()["timestamp"])
        self.assertIn("#session-1:", self.table.items[0]["timestamp"])
        self.assertEqual(self.table.items[0]["metadata"]["severity"], "HIGH")
        self.assertEqual(self.table.items[0]["delivery"]["status"], "COMPLETED")

    def test_sns_failure_propagates_for_sqs_retry(self):
        self.sns.error = RuntimeError("SNS unavailable")

        with self.assertRaisesRegex(RuntimeError, "SNS unavailable"):
            self.module.handler(self.sqs_event(self.payload()), None)

        self.assertEqual(self.ses.requests, [])
        self.assertEqual(self.table.items[0]["delivery"]["status"], "PENDING")
        self.assertFalse(self.table.items[0]["delivery"]["snsSent"])

    def test_retry_resumes_after_sns_when_ses_failed(self):
        event = self.sqs_event(self.payload())
        self.ses.error = RuntimeError("SES unavailable")

        with self.assertRaisesRegex(RuntimeError, "SES unavailable"):
            self.module.handler(event, None)

        self.assertEqual(len(self.sns.requests), 1)
        self.assertTrue(self.table.items[0]["delivery"]["snsSent"])
        self.assertFalse(self.table.items[0]["delivery"]["sesSent"])

        self.ses.error = None
        self.module.handler(event, None)

        self.assertEqual(len(self.sns.requests), 1)
        self.assertEqual(len(self.ses.requests), 1)
        self.assertEqual(self.table.items[0]["delivery"]["status"], "COMPLETED")

    def test_completed_duplicate_does_not_send_notifications_again(self):
        event = self.sqs_event(self.payload())

        self.module.handler(event, None)
        self.module.handler(event, None)

        self.assertEqual(len(self.sns.requests), 1)
        self.assertEqual(len(self.ses.requests), 1)

    def test_medium_severity_uses_sns_without_direct_ses_email(self):
        payload = self.payload()
        payload["reason"] = "Low confidence: 0.42"

        self.module.handler(self.sqs_event(payload), None)

        self.assertEqual(len(self.sns.requests), 1)
        self.assertEqual(self.ses.requests, [])
        self.assertEqual(self.table.items[0]["metadata"]["severity"], "MEDIUM")
        self.assertTrue(self.table.items[0]["delivery"]["sesSent"])
        self.assertEqual(self.table.items[0]["delivery"]["status"], "COMPLETED")

    def test_invalid_queue_payload_raises_for_redrive(self):
        with self.assertRaisesRegex(ValueError, "escalationId is required"):
            self.module.handler(self.sqs_event({"sessionId": "session-1"}), None)


if __name__ == "__main__":
    unittest.main()
