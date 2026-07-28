"""Focused bilingual and retrieval-consistency tests for the public chat Lambda."""

import importlib.util
import json
import os
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


class FakeTable:
    def __init__(self):
        self.items = []

    def put_item(self, Item):  # noqa: N803 - mirrors boto3
        self.items.append(Item)

    def query(self, **_kwargs):
        return {"Items": self.items}


class FakeDynamoResource:
    def __init__(self, table):
        self.table = table
        self.meta = MagicMock()

    def Table(self, _name):  # noqa: N802 - mirrors boto3
        return self.table


class FakeBedrockAgent:
    def get_prompt(self, **_kwargs):
        raise RuntimeError("Use packaged prompt in unit tests")


class FakeBedrockRetrieval:
    def __init__(self):
        self.requests = []

    def retrieve(self, **kwargs):
        self.requests.append(kwargs)
        return {
            "retrievalResults": [{
                "location": {"s3Location": {"uri": "s3://approved/source.pdf"}},
                "score": 0.8,
                "content": {"text": "Approved source text"},
            }]
        }


class FakeBedrockRuntime:
    def __init__(self):
        self.requests = []

    def converse(self, **kwargs):
        self.requests.append(kwargs)
        return {
            "output": {"message": {"content": [{"text": "Respuesta"}]}},
            "stopReason": "end_turn",
        }


def load_chat_module():
    os.environ.update({
        "AWS_DEFAULT_REGION": "us-east-1",
        "AWS_EC2_METADATA_DISABLED": "true",
        "KB_ID": "kb-test",
        "MODEL_ARN": "model-test",
        "CHAT_LOGS_TABLE": "chat-test",
        "GUARDRAIL_ID": "guardrail-test",
        "GUARDRAIL_VERSION": "1",
        "PROMPT_ID": "prompt-test",
        "PROMPT_VERSION": "1",
        "ALLOWED_ORIGIN": "https://public.example",
    })
    table = FakeTable()
    agent = FakeBedrockAgent()
    retrieval = FakeBedrockRetrieval()
    runtime = FakeBedrockRuntime()

    clients = {
        "bedrock-agent": agent,
        "bedrock-agent-runtime": retrieval,
        "bedrock-runtime": runtime,
        "lambda": MagicMock(),
    }

    module_path = Path(__file__).parents[1] / "lambda" / "chat-handler" / "index.py"
    spec = importlib.util.spec_from_file_location("chat_handler_language_test", module_path)
    module = importlib.util.module_from_spec(spec)
    with patch("boto3.client", side_effect=lambda name: clients[name]), patch(
        "boto3.resource", return_value=FakeDynamoResource(table)
    ):
        spec.loader.exec_module(module)
    return module, retrieval, runtime, table


class ChatLanguageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module, cls.retrieval, cls.runtime, cls.table = load_chat_module()

    def setUp(self):
        self.retrieval.requests.clear()
        self.runtime.requests.clear()
        self.table.items.clear()

    def test_spanish_prompt_requires_spanish_only(self):
        chunk = self.module.RetrievedChunk(
            source="s3://approved/source.pdf",
            score=0.8,
            content="Texto aprobado",
        )
        prompt = self.module.render_prompt("¿Cómo me uno?", "es", [chunk])
        self.assertIn("Respond only in natural Spanish", prompt)
        self.assertIn("Texto aprobado", prompt)
        self.assertNotIn("$search_results$", prompt)

    def test_invalid_language_is_rejected_before_generation(self):
        result = self.module.handle_chat({
            "body": json.dumps({"question": "Hello", "language": "fr"})
        })
        self.assertEqual(result["statusCode"], 400)
        self.assertIn("language", json.loads(result["body"])["error"])
        self.assertEqual(self.retrieval.requests, [])
        self.assertEqual(self.runtime.requests, [])

    def test_one_retrieval_drives_generation_confidence_and_sources(self):
        result = self.module.handle_chat({
            "body": json.dumps({"question": "¿Cómo me uno?", "language": "es"})
        })

        body = json.loads(result["body"])
        self.assertEqual(result["statusCode"], 200)
        self.assertEqual(len(self.retrieval.requests), 1)
        self.assertEqual(len(self.runtime.requests), 1)
        generated_prompt = self.runtime.requests[0]["messages"][0]["content"][0]["text"]
        self.assertIn("Approved source text", generated_prompt)
        self.assertEqual(body["sources"], ["s3://approved/source.pdf"])
        self.assertEqual(body["confidence"], 0.8)
        self.assertEqual(body["language"], "es")
        self.assertTrue(body["sessionToken"])
        self.assertEqual(self.table.items[-1]["language"], "es")
        self.assertEqual(
            self.table.items[-1]["chunkScores"][0]["source"],
            body["sources"][0],
        )

    def test_generation_applies_versioned_guardrail(self):
        self.module.handle_chat({
            "body": json.dumps({"question": "What are the requirements?"})
        })

        guardrail = self.runtime.requests[0]["guardrailConfig"]
        self.assertEqual(guardrail["guardrailIdentifier"], "guardrail-test")
        self.assertEqual(guardrail["guardrailVersion"], "1")
        self.assertEqual(guardrail["trace"], "enabled")

    def test_existing_session_requires_its_anonymous_bearer_token(self):
        first = self.module.handle_chat({
            "body": json.dumps({"question": "First question"})
        })
        first_body = json.loads(first["body"])
        calls_after_first = len(self.retrieval.requests)

        denied = self.module.handle_chat({
            "body": json.dumps({
                "question": "Follow-up",
                "sessionId": first_body["sessionId"],
            }),
        })
        self.assertEqual(denied["statusCode"], 403)
        self.assertEqual(len(self.retrieval.requests), calls_after_first)

        allowed = self.module.handle_chat({
            "headers": {"x-session-token": first_body["sessionToken"]},
            "body": json.dumps({
                "question": "Follow-up",
                "sessionId": first_body["sessionId"],
            }),
        })
        self.assertEqual(allowed["statusCode"], 200)

    def test_cors_is_scoped_to_the_public_distribution(self):
        result = self.module.handle_chat({
            "body": json.dumps({"question": "Hello"})
        })
        self.assertEqual(
            result["headers"]["Access-Control-Allow-Origin"],
            "https://public.example",
        )

    def test_jinja_does_not_evaluate_syntax_inside_user_input(self):
        prompt = self.module.render_prompt(
            "{{ 7 * 7 }}",
            "en",
            [],
        )
        self.assertIn("{{ 7 * 7 }}", prompt)
        self.assertNotIn("\n49\n", prompt)


if __name__ == "__main__":
    unittest.main()
