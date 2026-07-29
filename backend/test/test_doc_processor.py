"""Contract tests for bounded and coordinated document ingestion."""

import importlib.util
import io
import json
import os
import unittest
import zipfile
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch


class FakeBody:
    def __init__(self, data):
        self.data = data

    def read(self, amount=None):
        return self.data if amount is None else self.data[:amount]


class FakeS3:
    def __init__(self):
        self.objects = {}
        self.copies = []
        self.deletes = []

    def add_object(self, bucket, key, data, content_type, batch_id, version_id="v1"):
        self.objects[(bucket, key, version_id)] = {
            "data": data,
            "ContentType": content_type,
            "Metadata": {"upload-batch-id": batch_id},
            "VersionId": version_id,
        }

    def _object(self, request):
        bucket = request["Bucket"]
        key = request["Key"]
        version = request.get("VersionId")
        if version:
            return self.objects[(bucket, key, version)]
        matches = [obj for (b, k, _v), obj in self.objects.items() if b == bucket and k == key]
        if not matches:
            raise KeyError((bucket, key))
        return matches[-1]

    def head_object(self, **kwargs):
        obj = self._object(kwargs)
        return {
            "ContentLength": len(obj["data"]),
            "ContentType": obj["ContentType"],
            "Metadata": obj["Metadata"],
            "VersionId": obj["VersionId"],
        }

    def get_object(self, **kwargs):
        return {"Body": FakeBody(self._object(kwargs)["data"])}

    def copy_object(self, **kwargs):
        self.copies.append(kwargs)

    def delete_object(self, **kwargs):
        self.deletes.append(kwargs)


class FakeBedrockAgent:
    def __init__(self):
        self.jobs = []
        self.active = False

    def list_ingestion_jobs(self, **_kwargs):
        summaries = [{"status": "IN_PROGRESS"}] if self.active else []
        return {"ingestionJobSummaries": summaries}

    def start_ingestion_job(self, **kwargs):
        self.jobs.append(kwargs)
        return {"ingestionJob": {"ingestionJobId": "job-1"}}


class FakeSqs:
    def __init__(self):
        self.messages = []

    def send_message(self, **kwargs):
        self.messages.append(kwargs)


class FakeTable:
    def __init__(self):
        self.items = {}

    def get_item(self, **kwargs):
        item = self.items.get(kwargs["Key"]["batchId"])
        return {"Item": deepcopy(item)} if item else {}

    def update_item(self, **kwargs):
        item = self.items[kwargs["Key"]["batchId"]]
        expression = kwargs["UpdateExpression"]
        values = kwargs["ExpressionAttributeValues"]

        if "processedTokens" in expression:
            token = values[":token"]
            if token in item.get("processedTokens", set()):
                raise AssertionError("test delivered a duplicate update")
            item.setdefault("processedTokens", set()).update(values[":tokens"])
            if "acceptedTokens" in expression:
                item.setdefault("acceptedTokens", set()).update(values[":tokens"])
            item["updatedAt"] = values[":updated_at"]
        elif "completedAt" in expression:
            if item["status"] != values[":uploading"]:
                raise AssertionError("invalid completion transition")
            item["status"] = values[":status"]
            item["completedAt"] = values[":completed_at"]
        elif "ingestionJobId" in expression:
            if item["status"] != values[":ready"]:
                raise AssertionError("invalid sync transition")
            item["status"] = values[":syncing"]
            item["ingestionJobId"] = values[":job_id"]
            item["syncStartedAt"] = values[":started_at"]
        else:
            raise AssertionError(f"Unhandled update: {expression}")
        return {"Attributes": deepcopy(item)}


class FakeDynamo:
    def __init__(self, tables):
        self.tables = tables

    def Table(self, name):  # noqa: N802 - mirrors boto3
        return self.tables[name]


def load_module():
    os.environ.update({
        "AWS_DEFAULT_REGION": "us-east-1",
        "AWS_EC2_METADATA_DISABLED": "true",
        "KNOWLEDGE_BASE_BUCKET": "kb-bucket",
        "ANALYTICS_TABLE": "analytics-table",
        "DOCUMENT_BATCHES_TABLE": "batch-table",
        "KNOWLEDGE_BASE_ID": "knowledge-base-id",
        "DATA_SOURCE_ID": "data-source-id",
        "SYNC_QUEUE_URL": "https://sqs.example/sync.fifo",
    })
    fake_s3 = FakeS3()
    fake_bedrock = FakeBedrockAgent()
    fake_sqs = FakeSqs()
    analytics = FakeTable()
    batches = FakeTable()
    clients = {
        "s3": fake_s3,
        "bedrock-agent": fake_bedrock,
        "sqs": fake_sqs,
    }

    # Analytics uses put_item only; keep that behavior separate from batch state.
    analytics.items = []
    analytics.put_item = lambda **kwargs: analytics.items.append(kwargs["Item"])
    dynamo = FakeDynamo({"analytics-table": analytics, "batch-table": batches})

    path = Path(__file__).parents[1] / "lambda" / "doc-processor" / "index.py"
    spec = importlib.util.spec_from_file_location("doc_processor_queue_test", path)
    module = importlib.util.module_from_spec(spec)
    with patch("boto3.client", side_effect=lambda name: clients[name]), patch(
        "boto3.resource", return_value=dynamo
    ):
        spec.loader.exec_module(module)
    return module, fake_s3, fake_bedrock, fake_sqs, analytics, batches


def zip_document(member):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types />")
        archive.writestr(member, "content")
    return output.getvalue()


class DocProcessorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        (
            cls.module,
            cls.s3,
            cls.bedrock,
            cls.sqs,
            cls.analytics,
            cls.batches,
        ) = load_module()

    def setUp(self):
        self.s3.objects.clear()
        self.s3.copies.clear()
        self.s3.deletes.clear()
        self.bedrock.jobs.clear()
        self.bedrock.active = False
        self.sqs.messages.clear()
        self.analytics.items.clear()
        self.batches.items.clear()

    @staticmethod
    def s3_event(key, size, version_id="v1"):
        notification = {
            "Records": [{
                "s3": {
                    "bucket": {"name": "uploads-bucket"},
                    "object": {
                        "key": urllib_quote(key),
                        "size": size,
                        "eTag": "abc",
                        "versionId": version_id,
                    },
                },
            }],
        }
        return {
            "Records": [{
                "eventSource": "aws:sqs",
                "body": json.dumps(notification),
            }],
        }

    def prepare_batch(self, batch_id, keys):
        self.batches.items[batch_id] = {
            "batchId": batch_id,
            "status": "uploading",
            "expectedCount": len(keys),
            "expectedKeys": keys,
        }

    def test_validates_nested_document_and_queues_one_batch_sync(self):
        batch_id = "a" * 32
        key = "uploads/Training/2026/guide.pdf"
        data = b"%PDF-1.7\ncontent"
        self.prepare_batch(batch_id, [key])
        self.s3.add_object("uploads-bucket", key, data, "application/pdf", batch_id)

        self.module.handler(self.s3_event(key, len(data)), None)

        kb_copies = [copy for copy in self.s3.copies if copy["Bucket"] == "kb-bucket"]
        self.assertEqual(kb_copies[0]["Key"], "documents/Training/2026/guide.pdf")
        self.assertEqual(self.batches.items[batch_id]["status"], "ready")
        self.assertEqual(len(self.sqs.messages), 1)
        self.assertEqual(self.bedrock.jobs, [])

        # An at-least-once S3 notification must not re-copy or re-count the file.
        self.module.handler(self.s3_event(key, len(data)), None)
        self.assertEqual(
            len([copy for copy in self.s3.copies if copy["Bucket"] == "kb-bucket"]),
            1,
        )
        self.assertEqual(len(self.sqs.messages), 2)
        self.assertEqual(
            self.sqs.messages[0]["MessageDeduplicationId"],
            self.sqs.messages[1]["MessageDeduplicationId"],
        )

    def test_rejects_disguised_content_before_knowledge_base_copy(self):
        batch_id = "b" * 32
        key = "uploads/Training/not-a-pdf.pdf"
        data = b"<script>alert(1)</script>"
        self.prepare_batch(batch_id, [key])
        self.s3.add_object("uploads-bucket", key, data, "application/pdf", batch_id)

        self.module.handler(self.s3_event(key, len(data)), None)

        self.assertFalse(any(copy["Bucket"] == "kb-bucket" for copy in self.s3.copies))
        self.assertTrue(any(copy["Key"].startswith("quarantine/") for copy in self.s3.copies))
        self.assertEqual(self.batches.items[batch_id]["status"], "failed")
        self.assertEqual(self.sqs.messages, [])

    def test_checks_office_container_structure(self):
        valid = zip_document("word/document.xml")
        self.module._validate_content(valid, "docx")
        with self.assertRaises(self.module.RejectedUpload):
            self.module._validate_content(zip_document("xl/workbook.xml"), "docx")

    def test_serializes_bedrock_sync_requests(self):
        batch_id = "c" * 32
        self.batches.items[batch_id] = {
            "batchId": batch_id,
            "status": "ready",
        }
        message = {"type": "document_batch_sync", "batchId": batch_id}

        self.bedrock.active = True
        with self.assertRaises(RuntimeError):
            self.module._process_sync_message(message)
        self.assertEqual(self.bedrock.jobs, [])

        self.bedrock.active = False
        self.module._process_sync_message(message)
        self.assertEqual(len(self.bedrock.jobs), 1)
        self.assertEqual(self.batches.items[batch_id]["status"], "syncing")

        # A duplicate FIFO delivery is idempotent.
        self.module._process_sync_message(message)
        self.assertEqual(len(self.bedrock.jobs), 1)

    def test_serializes_delete_sync_without_requiring_an_upload_batch(self):
        change_id = "d" * 32
        message = {"type": "document_change_sync", "changeId": change_id}

        self.module._process_sync_message(message)

        self.assertEqual(len(self.bedrock.jobs), 1)
        self.assertEqual(
            len(self.bedrock.jobs[0]["clientToken"]),
            64,
        )


def urllib_quote(value):
    from urllib.parse import quote_plus

    return quote_plus(value)


if __name__ == "__main__":
    unittest.main()
