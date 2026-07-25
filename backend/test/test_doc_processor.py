"""Contract tests for queued document ingestion."""

import importlib.util
import json
import os
import unittest
from pathlib import Path
from unittest.mock import patch


class FakeS3:
    def __init__(self):
        self.copies = []

    def copy_object(self, **kwargs):
        self.copies.append(kwargs)


class FakeBedrockAgent:
    def __init__(self):
        self.jobs = []

    def start_ingestion_job(self, **kwargs):
        self.jobs.append(kwargs)


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
        "KNOWLEDGE_BASE_BUCKET": "kb-bucket",
        "ANALYTICS_TABLE": "analytics-table",
        "KNOWLEDGE_BASE_ID": "kb-id",
        "DATA_SOURCE_ID": "data-source-id",
    })
    fake_s3 = FakeS3()
    fake_bedrock = FakeBedrockAgent()
    table = FakeTable()
    clients = {"s3": fake_s3, "bedrock-agent": fake_bedrock}

    path = Path(__file__).parents[1] / "lambda" / "doc-processor" / "index.py"
    spec = importlib.util.spec_from_file_location("doc_processor_queue_test", path)
    module = importlib.util.module_from_spec(spec)
    with patch("boto3.client", side_effect=lambda name: clients[name]), patch(
        "boto3.resource", return_value=FakeDynamo(table)
    ):
        spec.loader.exec_module(module)
    return module, fake_s3, fake_bedrock, table


class DocProcessorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module, cls.s3, cls.bedrock, cls.table = load_module()

    def setUp(self):
        self.s3.copies.clear()
        self.bedrock.jobs.clear()
        self.table.items.clear()

    def test_unwraps_sqs_and_uses_an_idempotency_token(self):
        notification = {
            "Records": [{
                "s3": {
                    "bucket": {"name": "uploads-bucket"},
                    "object": {
                        "key": "uploads%2Fguide.pdf",
                        "size": 1234,
                        "eTag": "abc",
                        "versionId": "v1",
                    },
                },
            }],
        }
        event = {
            "Records": [{
                "eventSource": "aws:sqs",
                "body": json.dumps(notification),
            }],
        }

        self.module.handler(event, None)

        self.assertEqual(len(self.s3.copies), 1)
        self.assertEqual(self.s3.copies[0]["Key"], "documents/guide.pdf")
        self.assertEqual(len(self.bedrock.jobs), 1)
        token = self.bedrock.jobs[0]["clientToken"]
        self.assertEqual(len(token), 64)
        self.assertEqual(self.table.items[0]["metadata"]["fileName"], "guide.pdf")


if __name__ == "__main__":
    unittest.main()
