"""Escalation Router — invoked asynchronously by the Chat Handler when a
conversation needs staff attention (safety keywords or low confidence).

Publishes an SNS alert (always), emails staff for HIGH-severity/safety cases,
and logs the escalation to the AnalyticsLogs table.
"""

import json
import os
from datetime import datetime, timezone
from decimal import Decimal

import boto3

sns_client = boto3.client("sns")
ses_client = boto3.client("ses")
dynamodb = boto3.resource("dynamodb")

SNS_TOPIC_ARN = os.environ["SNS_TOPIC_ARN"]
STAFF_EMAIL = os.environ["STAFF_EMAIL"]
ANALYTICS_TABLE = os.environ["ANALYTICS_TABLE"]

analytics_table = dynamodb.Table(ANALYTICS_TABLE)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _escalation_messages(event):
    """Yield escalation payloads from SQS, with direct events for local use."""
    records = event.get("Records") if isinstance(event, dict) else None
    if not records:
        yield event
        return

    for record in records:
        event_source = record.get("eventSource") or record.get("EventSource")
        if event_source != "aws:sqs":
            raise ValueError(f"Unsupported escalation event source: {event_source}")
        yield json.loads(record.get("body") or "{}")


def handler(event, _context):
    for message in _escalation_messages(event):
        process_escalation(message)
    return {"statusCode": 200, "body": "Escalation processed"}


def process_escalation(event):
    session_id = event.get("sessionId")
    user_id = event.get("userId")
    question = event.get("question")
    answer = event.get("answer")
    reason = event.get("reason") or ""
    confidence = event.get("confidence") or 0

    print(f"Escalation triggered: sessionId={session_id} reason={reason} confidence={confidence}")

    # Severity: safety keywords = HIGH, low confidence = MEDIUM
    is_high_severity = "safety keyword" in reason.lower()
    severity = "HIGH" if is_high_severity else "MEDIUM"
    timestamp = _now_iso()

    message = format_alert_message(session_id, user_id, question, answer, reason, confidence, severity)

    # Always send the SNS notification (HIGH and MEDIUM)
    send_sns_alert(message, severity)

    # Email staff only for HIGH severity (safety-related)
    if is_high_severity:
        send_email_alert(message, severity)

    log_escalation(session_id, user_id, reason, confidence, severity, timestamp)

def send_sns_alert(message: str, severity: str) -> None:
    try:
        sns_client.publish(
            TopicArn=SNS_TOPIC_ARN,
            Subject=f"[{severity}] GCC AI Assistant - Escalation Alert",
            Message=message,
        )
    except Exception as err:  # noqa: BLE001 - best-effort alerting
        print(f"SNS publish failed: {err}")


def send_email_alert(message: str, severity: str) -> None:
    try:
        ses_client.send_email(
            Source=STAFF_EMAIL,  # must be verified in SES
            Destination={"ToAddresses": [STAFF_EMAIL]},
            Message={
                "Subject": {"Data": f"[{severity}] GCC AI Assistant - Safety Escalation"},
                "Body": {"Text": {"Data": message}},
            },
        )
    except Exception as err:  # noqa: BLE001 - best-effort alerting
        print(f"SES email failed: {err}")


def log_escalation(session_id, user_id, reason, confidence, severity, timestamp) -> None:
    try:
        analytics_table.put_item(
            Item={
                "eventType": "escalation",
                "timestamp": timestamp,
                "sessionId": session_id,
                "userId": user_id,
                "reason": reason,
                "metadata": {
                    "confidence": Decimal(str(confidence)),
                    "severity": severity,
                },
                "createdAt": timestamp,
            }
        )
    except Exception as err:  # noqa: BLE001 - best-effort logging
        print(f"Failed to log escalation: {err}")


def format_alert_message(session_id, user_id, question, answer, reason, confidence, severity) -> str:
    return (
        f"""🚨 ESCALATION ALERT — {severity} SEVERITY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Reason: {reason}
Confidence: {round(confidence * 100)}%
Session: {session_id}
User: {user_id}

Volunteer's Question:
"{question}"

AI Response Given:
"{answer}"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Action Required: Please review and follow up if needed."""
    ).strip()
