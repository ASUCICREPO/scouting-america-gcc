"""Security contract tests for the admin dashboard Lambda."""

import importlib.util
import json
import os
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

from botocore.exceptions import ClientError


class FakeS3:
    def __init__(self):
        self.post_requests = []
        self.presigned_requests = []
        self.list_requests = []
        self.list_pages = []
        self.delete_requests = []
        self.heads = {}

    def generate_presigned_post(self, **kwargs):
        self.post_requests.append(kwargs)
        return {
            "url": "https://uploads.example",
            "fields": {"policy": "signed-policy", **kwargs["Fields"]},
        }

    def generate_presigned_url(self, operation, **kwargs):
        self.presigned_requests.append({"operation": operation, **kwargs})
        return "https://downloads.example/signed"

    def list_objects_v2(self, **kwargs):
        self.list_requests.append(kwargs)
        return self.list_pages[len(self.list_requests) - 1]

    def delete_objects(self, **kwargs):
        self.delete_requests.append(kwargs)
        return {"Errors": []}

    def head_object(self, **kwargs):
        key = kwargs["Key"]
        if key not in self.heads:
            raise ClientError({"Error": {"Code": "404", "Message": "missing"}}, "HeadObject")
        return self.heads[key]


class FakeSqs:
    def __init__(self):
        self.messages = []

    def send_message(self, **kwargs):
        self.messages.append(kwargs)


class FakeTable:
    def __init__(self):
        self.items = {}

    def put_item(self, **kwargs):
        item = kwargs["Item"]
        self.items[item["batchId"]] = item

    def get_item(self, **kwargs):
        item = self.items.get(kwargs["Key"]["batchId"])
        return {"Item": item.copy()} if item else {}

    def update_item(self, **kwargs):
        item = self.items[kwargs["Key"]["batchId"]]
        expression = kwargs["UpdateExpression"]
        values = kwargs["ExpressionAttributeValues"]
        if "processedTokens" in expression:
            item["finalizedAt"] = values[":finalized_at"]
            item.setdefault("processedTokens", set()).update(values[":tokens"])
        elif "completedAt" in expression:
            item["status"] = values[":status"]
            item["completedAt"] = values[":completed_at"]
        elif "finalizedAt" in expression:
            item["finalizedAt"] = values[":finalized_at"]
        else:
            raise AssertionError(f"Unhandled update: {expression}")
        return {"Attributes": item.copy()}


class FakeDynamo:
    def __init__(self):
        self.tables = {}

    def Table(self, name):  # noqa: N802 - mirrors boto3
        return self.tables.setdefault(name, FakeTable())


def load_module():
    os.environ.update({
        "AWS_DEFAULT_REGION": "us-east-1",
        "AWS_EC2_METADATA_DISABLED": "true",
        "CHAT_LOGS_TABLE": "chat-table",
        "ANALYTICS_LOGS_TABLE": "analytics-table",
        "DOCUMENT_BATCHES_TABLE": "document-batches-table",
        "DOCUMENT_BUCKET": "document-bucket",
        "KB_BUCKET": "kb-bucket",
        "KNOWLEDGE_BASE_ID": "kb-id",
        "DATA_SOURCE_ID": "data-source-id",
        "DOCUMENT_SYNC_QUEUE_URL": "https://sqs.example/sync.fifo",
        "ALLOWED_ORIGIN": "https://frontend.example",
    })
    fake_s3 = FakeS3()
    fake_sqs = FakeSqs()
    fake_dynamo = FakeDynamo()
    path = Path(__file__).parents[1] / "lambda" / "dashboard" / "index.py"
    spec = importlib.util.spec_from_file_location("dashboard_security_test", path)
    module = importlib.util.module_from_spec(spec)

    def fake_client(name):
        if name == "s3":
            return fake_s3
        if name == "sqs":
            return fake_sqs
        return MagicMock()

    with patch("boto3.client", side_effect=fake_client), patch(
        "boto3.resource", return_value=fake_dynamo
    ):
        spec.loader.exec_module(module)
    return module, fake_s3, fake_sqs, fake_dynamo.tables["document-batches-table"]


class DashboardSecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module, cls.s3, cls.sqs, cls.batches = load_module()

    def setUp(self):
        self.s3.post_requests.clear()
        self.s3.presigned_requests.clear()
        self.s3.list_requests.clear()
        self.s3.list_pages.clear()
        self.s3.delete_requests.clear()
        self.s3.heads.clear()
        self.sqs.messages.clear()
        self.batches.items.clear()

    def create_batch(self, files):
        return self.module.create_upload_batch({"body": json.dumps({"files": files})})

    def test_presigned_batch_binds_path_type_size_and_batch_metadata(self):
        result = self.create_batch([{
            "relativePath": "policies/2026/guide.pdf",
            "contentType": "application/pdf",
            "size": 1_234,
        }])

        self.assertEqual(result["statusCode"], 200)
        body = json.loads(result["body"])
        self.assertEqual(len(body["batchId"]), 32)
        self.assertEqual(body["uploads"][0]["key"], "uploads/policies/2026/guide.pdf")

        request = self.s3.post_requests[0]
        self.assertIn(["content-length-range", 1_234, 1_234], request["Conditions"])
        self.assertIn({"Content-Type": "application/pdf"}, request["Conditions"])
        self.assertIn(
            {"x-amz-meta-upload-batch-id": body["batchId"]},
            request["Conditions"],
        )
        self.assertEqual(
            self.batches.items[body["batchId"]]["expectedKeys"],
            ["uploads/policies/2026/guide.pdf"],
        )

    def test_rejects_extension_mime_mismatches_and_unsafe_paths(self):
        mismatch = self.create_batch([{
            "relativePath": "guide.pdf",
            "contentType": "image/png",
            "size": 100,
        }])
        traversal = self.create_batch([{
            "relativePath": "../guide.pdf",
            "contentType": "application/pdf",
            "size": 100,
        }])
        active_svg = self.create_batch([{
            "relativePath": "diagram.svg",
            "contentType": "image/svg+xml",
            "size": 100,
        }])

        self.assertEqual(mismatch["statusCode"], 400)
        self.assertEqual(traversal["statusCode"], 400)
        self.assertEqual(active_svg["statusCode"], 400)
        self.assertEqual(self.s3.post_requests, [])

    def test_rejects_formats_not_supported_by_the_configured_parser(self):
        result = self.create_batch([{
            "relativePath": "photos/camp.png",
            "contentType": "image/png",
            "size": 100,
        }])
        self.assertEqual(result["statusCode"], 400)

    def test_rejects_duplicate_normalized_paths(self):
        result = self.create_batch([
            {"relativePath": "a/guide.pdf", "contentType": "application/pdf", "size": 10},
            {"relativePath": "a/guide.pdf", "contentType": "application/pdf", "size": 10},
        ])
        self.assertEqual(result["statusCode"], 400)

    def test_response_cors_is_scoped_to_frontend_origin(self):
        result = self.module.respond(self.module.HttpStatus.OK, {"ok": True})
        self.assertEqual(
            result["headers"]["Access-Control-Allow-Origin"],
            "https://frontend.example",
        )

    def test_batch_completion_closes_missing_uploads_and_queues_valid_files(self):
        batch_id = "e" * 32
        uploaded_key = "uploads/A/one.pdf"
        missing_key = "uploads/B/two.pdf"
        uploaded_token = self.module._batch_token(uploaded_key)
        self.batches.items[batch_id] = {
            "batchId": batch_id,
            "status": "uploading",
            "expectedCount": 2,
            "expectedKeys": [uploaded_key, missing_key],
            "processedTokens": {uploaded_token},
            "acceptedTokens": {uploaded_token},
        }

        result = self.module.complete_upload_batch({
            "body": json.dumps({"batchId": batch_id, "failedKeys": [missing_key]}),
        })
        body = json.loads(result["body"])

        self.assertEqual(body["status"], "ready")
        self.assertEqual(self.batches.items[batch_id]["status"], "ready")
        self.assertEqual(len(self.sqs.messages), 1)

        # Retrying completion repairs a ready batch whose first queue send may
        # have failed. FIFO deduplication keeps an acknowledged send singular.
        retry = self.module.complete_upload_batch({
            "body": json.dumps({"batchId": batch_id, "failedKeys": []}),
        })
        self.assertEqual(json.loads(retry["body"])["status"], "ready")
        self.assertEqual(len(self.sqs.messages), 2)
        self.assertEqual(
            self.sqs.messages[0]["MessageDeduplicationId"],
            self.sqs.messages[1]["MessageDeduplicationId"],
        )

    def test_document_listing_reads_every_s3_page(self):
        now = datetime.now(timezone.utc)
        self.s3.list_pages.extend([
            {
                "Contents": [{"Key": "uploads/A/one.pdf", "Size": 1, "LastModified": now}],
                "NextContinuationToken": "page-2",
            },
            {
                "Contents": [{"Key": "uploads/B/two.pdf", "Size": 2, "LastModified": now}],
            },
        ])
        self.module.bedrock_agent.list_ingestion_jobs.return_value = {
            "ingestionJobSummaries": [],
        }

        result = self.module.get_documents({})
        body = json.loads(result["body"])

        self.assertEqual(body["total"], 2)
        self.assertEqual(self.s3.list_requests[1]["ContinuationToken"], "page-2")

    def test_download_forces_attachment_and_binary_content_type(self):
        result = self.module.get_document_download_url({
            "queryStringParameters": {"key": "uploads/Folder/camp guide.pdf"},
        })

        self.assertEqual(result["statusCode"], 200)
        params = self.s3.presigned_requests[0]["Params"]
        self.assertEqual(params["ResponseContentType"], "application/octet-stream")
        self.assertEqual(
            params["ResponseContentDisposition"],
            "attachment; filename*=UTF-8''camp%20guide.pdf",
        )

    def test_bulk_delete_queues_one_serialized_sync(self):
        keys = ["uploads/A/one.pdf", "uploads/B/two.pdf"]
        result = self.module.delete_document({"body": json.dumps({"keys": keys})})
        body = json.loads(result["body"])

        self.assertEqual(body["deletedKeys"], keys)
        self.assertEqual(len(self.s3.delete_requests), 2)
        self.assertEqual(
            self.s3.delete_requests[0]["Delete"]["Objects"],
            [{"Key": key} for key in keys],
        )
        self.assertEqual(len(self.sqs.messages), 1)
        message = json.loads(self.sqs.messages[0]["MessageBody"])
        self.assertEqual(message["type"], "document_change_sync")


if __name__ == "__main__":
    unittest.main()
