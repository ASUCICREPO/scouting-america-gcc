"""Tests for the dashboard conversation feedback table."""

import json
import unittest
from datetime import datetime, timedelta, timezone

from test_dashboard_security import load_module


def iso(days_ago):
    moment = datetime.now(timezone.utc) - timedelta(days=days_ago)
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


class FeedbackTableTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_module()[0]

    def setUp(self):
        self.scans = []
        self.items = [
            {"sessionId": "s1", "timestamp": iso(1), "question": "rated up", "feedback": "positive"},
            {"sessionId": "s2", "timestamp": iso(2), "question": "rated down", "feedback": "negative"},
            {"sessionId": "s3", "timestamp": iso(3), "question": "never rated"},
            {"sessionId": "s4", "timestamp": iso(200), "question": "old and unrated"},
        ]

        def scan(**kwargs):
            self.scans.append(kwargs)
            return {"Items": self.items}

        self.module.chat_table.scan = scan

    def list_feedback(self, filter_val, limit="50", offset="0"):
        result = self.module.get_feedback({
            "queryStringParameters": {"filter": filter_val, "limit": limit, "offset": offset},
        })
        return json.loads(result["body"])

    def test_all_lists_every_turn_in_the_history_newest_first(self):
        body = self.list_feedback("all")

        self.assertEqual(body["total"], 4)
        self.assertEqual(
            [c["question"] for c in body["conversations"]],
            ["rated up", "rated down", "never rated", "old and unrated"],
        )
        self.assertIsNone(body["conversations"][2]["feedback"])
        self.assertNotIn("FilterExpression", self.scans[0])

    def test_rating_filters_only_return_matching_turns(self):
        self.assertEqual(
            [c["question"] for c in self.list_feedback("positive")["conversations"]],
            ["rated up"],
        )
        self.assertEqual(
            [c["question"] for c in self.list_feedback("negative")["conversations"]],
            ["rated down"],
        )

    def test_all_pages_through_the_history(self):
        body = self.list_feedback("all", limit="2", offset="2")

        self.assertEqual(body["total"], 4)
        self.assertEqual(
            [c["question"] for c in body["conversations"]],
            ["never rated", "old and unrated"],
        )

    def test_empty_history_says_there_are_no_conversations(self):
        self.items = []
        self.assertEqual(self.list_feedback("all")["note"], "No conversations yet")
        self.assertEqual(
            self.list_feedback("negative")["note"],
            "No feedback has been submitted yet",
        )


if __name__ == "__main__":
    unittest.main()
