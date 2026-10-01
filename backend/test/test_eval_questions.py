"""Checks for the retrieval/answer eval question set and its scoring rules."""

import importlib.util
import json
import re
import unittest
from pathlib import Path
from types import SimpleNamespace

EVAL_DIR = Path(__file__).parents[1] / "eval"


def load_runner():
    spec = importlib.util.spec_from_file_location("run_eval", EVAL_DIR / "run_eval.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class EvalQuestionSetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cases = json.loads((EVAL_DIR / "questions.json").read_text())

    def test_ids_are_unique(self):
        ids = [case["id"] for case in self.cases]
        self.assertEqual(len(ids), len(set(ids)))

    def test_cases_are_well_formed(self):
        for case in self.cases:
            with self.subTest(case=case["id"]):
                self.assertIn(case["language"], {"en", "es"})
                self.assertTrue(case["question"].strip())
                if case["source"] is None:
                    self.assertIn("out-of-scope", case["tags"])
                    self.assertNotIn("answer", case)
                    continue
                self.assertTrue(case["retrieval"])
                self.assertTrue(case["answer"])
                for pattern in case["answer"] + case.get("forbid", []):
                    re.compile(pattern)

    def test_set_covers_out_of_scope_and_spanish_questions(self):
        tags = [tag for case in self.cases for tag in case["tags"]]
        self.assertGreaterEqual(tags.count("out-of-scope"), 3)
        self.assertGreaterEqual(tags.count("spanish"), 3)


class EvalScoringTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runner = load_runner()

    def test_answer_patterns_tolerate_markdown_and_dash_styles(self):
        case = {
            "source": "report.pdf",
            "answer": [r"sep(t(ember)?)?\.? 25\b", r"\b27\b"],
        }
        result = self.runner.score_answer(case, "It runs **September 25**–27, 2026.")
        self.assertTrue(result["pass"])

    def test_answer_fails_on_missing_or_forbidden_facts(self):
        case = {
            "source": "report.pdf",
            "answer": ["thursday"],
            "forbid": [r"wednesday, sep(t(ember)?)?\.? 3\b"],
        }
        result = self.runner.score_answer(case, "It is Wednesday, September 3.")
        self.assertFalse(result["pass"])
        self.assertEqual(result["missing"], ["thursday"])
        self.assertEqual(len(result["forbidden"]), 1)

    def test_day_patterns_do_not_match_inside_the_year(self):
        case = {"source": "report.pdf", "answer": [r"\b20\b"]}
        self.assertFalse(self.runner.score_answer(case, "September 2026")["pass"])

    def test_out_of_scope_passes_only_on_a_no_answer_reply(self):
        case = {"source": None}
        self.assertTrue(self.runner.score_answer(
            case,
            "I could not find the answer in the council's approved resources.",
        )["pass"])
        self.assertTrue(self.runner.score_answer(
            case,
            "No pude encontrar esa información en los recursos aprobados.",
        )["pass"])
        self.assertFalse(self.runner.score_answer(case, "Camp costs $350 per week.")["pass"])

    def test_retrieval_requires_the_expected_document_and_all_phrases(self):
        case = {"source": "report.pdf", "retrieval": ["Wood Badge", "September 18"]}
        chunks = [
            SimpleNamespace(source="s3://kb/documents/Other.pdf", score=0.7,
                            content="Wood Badge on September 18"),
            SimpleNamespace(source="s3://kb/documents/report.pdf", score=0.6,
                            content="- Friday, **September 18**, 2026: 2026 Wood Badge"),
        ]
        result = self.runner.score_retrieval(case, chunks)
        self.assertEqual(result["rank"], 2)

        self.assertFalse(self.runner.score_retrieval(case, chunks[:1])["hit"])


if __name__ == "__main__":
    unittest.main()
