"""Contract tests for queued staff escalation delivery."""

import importlib.util
import json
import os
import unittest
from pathlib import Path
from unittest.mock import patch


class FakeClient:
    def __init__(self):
        self.requests = []

    def publish(self, **kwargs):
        self.requests.append(kwargs)

    def send_email(self, **kwargs):
        self.requests.append(kwargs)


class FakeTable:
    def __init__(self):
        self.items = []

    def put_item(self, **kwargs):
        self.items.append(kwargs["Item"])


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
        self.ses.requests.clear()
        self.table.items.clear()

    def test_unwraps_sqs_and_delivers_a_high_severity_alert(self):
        payload = {
            "sessionId": "session-1",
            "userId": "anonymous",
            "question": "There is an emergency",
            "answer": "Contact emergency services",
            "reason": 'Safety keyword detected: "emergency"',
            "confidence": 0.9,
        }
        event = {
            "Records": [{
                "eventSource": "aws:sqs",
                "body": json.dumps(payload),
            }],
        }

        result = self.module.handler(event, None)

        self.assertEqual(result["statusCode"], 200)
        self.assertEqual(len(self.sns.requests), 1)
        self.assertEqual(len(self.ses.requests), 1)
        self.assertEqual(self.table.items[0]["sessionId"], "session-1")
        self.assertEqual(self.table.items[0]["metadata"]["severity"], "HIGH")


if __name__ == "__main__":
    unittest.main()
