"""Security contract tests for the admin dashboard Lambda."""

import importlib.util
import json
import os
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


class FakeS3:
    def __init__(self):
        self.post_request = None

    def generate_presigned_post(self, **kwargs):
        self.post_request = kwargs
        return {
            "url": "https://uploads.example",
            "fields": {"policy": "signed-policy"},
        }


class FakeDynamo:
    def Table(self, _name):  # noqa: N802 - mirrors boto3
        return MagicMock()


def load_module():
    os.environ.update({
        "AWS_DEFAULT_REGION": "us-east-1",
        "AWS_EC2_METADATA_DISABLED": "true",
        "CHAT_LOGS_TABLE": "chat-table",
        "ANALYTICS_LOGS_TABLE": "analytics-table",
        "DOCUMENT_BUCKET": "document-bucket",
        "KB_BUCKET": "kb-bucket",
        "KNOWLEDGE_BASE_ID": "kb-id",
        "DATA_SOURCE_ID": "data-source-id",
        "ALLOWED_ORIGIN": "https://admin.example",
    })
    fake_s3 = FakeS3()
    path = Path(__file__).parents[1] / "lambda" / "dashboard" / "index.py"
    spec = importlib.util.spec_from_file_location("dashboard_security_test", path)
    module = importlib.util.module_from_spec(spec)

    def fake_client(name):
        return fake_s3 if name == "s3" else MagicMock()

    with patch("boto3.client", side_effect=fake_client), patch(
        "boto3.resource", return_value=FakeDynamo()
    ):
        spec.loader.exec_module(module)
    return module, fake_s3


class DashboardSecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module, cls.s3 = load_module()

    def test_presigned_post_enforces_server_side_file_size(self):
        result = self.module.get_upload_url({
            "body": json.dumps({
                "relativePath": "policies/guide.pdf",
                "contentType": "application/pdf",
            }),
        })

        self.assertEqual(result["statusCode"], 200)
        self.assertIn(
            ["content-length-range", 1, 25 * 1024 * 1024],
            self.s3.post_request["Conditions"],
        )
        body = json.loads(result["body"])
        self.assertEqual(body["fields"], {"policy": "signed-policy"})

    def test_response_cors_is_scoped_to_admin_origin(self):
        result = self.module.respond(self.module.HttpStatus.OK, {"ok": True})
        self.assertEqual(
            result["headers"]["Access-Control-Allow-Origin"],
            "https://admin.example",
        )


if __name__ == "__main__":
    unittest.main()
