"""Focused bilingual contract tests for the public chat Lambda."""

import importlib.util
import json
import os
import unittest
from pathlib import Path
from unittest.mock import patch


class FakeTable:
    def __init__(self):
        self.items = []

    def put_item(self, Item):  # noqa: N803 - mirrors boto3
        self.items.append(Item)


class FakeDynamoResource:
    def __init__(self, table):
        self.table = table

    def Table(self, _name):  # noqa: N802 - mirrors boto3
        return self.table


class FakeBedrock:
    def __init__(self):
        self.request = None

    def retrieve_and_generate(self, **kwargs):
        self.request = kwargs
        return {"output": {"text": "ok"}, "citations": []}


def load_chat_module():
    os.environ.update({
        "AWS_DEFAULT_REGION": "us-east-1",
        "AWS_EC2_METADATA_DISABLED": "true",
        "KB_ID": "kb-test",
        "MODEL_ARN": "model-test",
        "CHAT_LOGS_TABLE": "chat-test",
        "SECRETS_ARN": "secret-test",
    })
    table = FakeTable()
    bedrock = FakeBedrock()

    def fake_client(name):
        return bedrock if name == "bedrock-agent-runtime" else unittest.mock.MagicMock()

    module_path = Path(__file__).parents[1] / "lambda" / "chat-handler" / "index.py"
    spec = importlib.util.spec_from_file_location("chat_handler_language_test", module_path)
    module = importlib.util.module_from_spec(spec)
    with patch("boto3.client", side_effect=fake_client), patch(
        "boto3.resource", return_value=FakeDynamoResource(table)
    ):
        spec.loader.exec_module(module)
    return module, bedrock, table


class ChatLanguageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module, cls.bedrock, cls.table = load_chat_module()

    def test_spanish_prompt_requires_spanish_only(self):
        self.module._retrieve_and_generate("¿Cómo me uno?", "guardrails", "es")
        prompt = self.bedrock.request["retrieveAndGenerateConfiguration"][
            "knowledgeBaseConfiguration"
        ]["generationConfiguration"]["promptTemplate"]["textPromptTemplate"]
        self.assertIn("Respond ONLY in Spanish", prompt)
        self.assertIn("$search_results$", prompt)

    def test_invalid_language_is_rejected_before_generation(self):
        result = self.module.handle_chat({
            "body": json.dumps({"question": "Hello", "language": "fr"})
        })
        self.assertEqual(result["statusCode"], 400)
        self.assertIn("language must be", json.loads(result["body"])["error"])

    def test_selected_language_is_returned_and_persisted(self):
        self.table.items.clear()
        with patch.object(self.module, "get_guardrails", return_value="guardrails"), patch.object(
            self.module,
            "_retrieve_and_generate",
            return_value={"output": {"text": "Respuesta"}, "citations": []},
        ), patch.object(
            self.module, "_retrieve_scores", return_value={"retrievalResults": []}
        ), patch.object(
            self.module, "check_escalation", return_value=(False, "")
        ):
            result = self.module.handle_chat({
                "body": json.dumps({"question": "¿Cómo me uno?", "language": "es"})
            })

        body = json.loads(result["body"])
        self.assertEqual(result["statusCode"], 200)
        self.assertEqual(body["language"], "es")
        self.assertEqual(self.table.items[-1]["language"], "es")


if __name__ == "__main__":
    unittest.main()
