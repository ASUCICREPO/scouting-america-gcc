"""Escalation Router — consumes queued alerts when a conversation needs staff
attention (safety keywords, low confidence, or a response guardrail action).

Publishes an SNS alert (always), emails staff for HIGH-severity/safety cases,
and tracks retry-safe delivery state in the AnalyticsLogs table.
"""

import json
import os
from datetime import datetime, timezone
from decimal import Decimal

import boto3
from botocore.exceptions import ClientError

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
    escalation_id = event.get("escalationId")
    timestamp = event.get("timestamp")
    session_id = event.get("sessionId")
    user_id = event.get("userId")
    question = event.get("question")
    answer = event.get("answer")
    reason = event.get("reason") or ""
    confidence = event.get("confidence") or 0

    if not isinstance(escalation_id, str) or not escalation_id:
        raise ValueError("escalationId is required")
    if not isinstance(timestamp, str) or not timestamp:
        raise ValueError("timestamp is required")

    print(
        f"Escalation triggered: escalationId={escalation_id} "
        f"sessionId={session_id} reason={reason} confidence={confidence}"
    )

    # Severity: safety keywords = HIGH, low confidence = MEDIUM
    is_high_severity = "safety keyword" in reason.lower()
    severity = "HIGH" if is_high_severity else "MEDIUM"
    record_timestamp = f"{timestamp}#{escalation_id}"
    message = format_alert_message(session_id, user_id, question, answer, reason, confidence, severity)
    record = get_or_create_delivery_record(
        escalation_id,
        record_timestamp,
        timestamp,
        session_id,
        user_id,
        reason,
        confidence,
        severity,
        is_high_severity,
    )
    delivery = record.get("delivery") or {}
    if delivery.get("status") == "COMPLETED":
        print(f"Escalation already delivered: {escalation_id}")
        return

    if not delivery.get("snsSent", False):
        send_sns_alert(message, severity)
        mark_channel_delivered(record_timestamp, "snsSent")

    if is_high_severity and not delivery.get("sesSent", False):
        send_email_alert(message, severity)
        mark_channel_delivered(record_timestamp, "sesSent")

    mark_delivery_complete(record_timestamp)


def send_sns_alert(message: str, severity: str) -> None:
    sns_client.publish(
        TopicArn=SNS_TOPIC_ARN,
        Subject=f"[{severity}] GCC AI Assistant - Escalation Alert",
        Message=message,
    )


def send_email_alert(message: str, severity: str) -> None:
    ses_client.send_email(
        Source=STAFF_EMAIL,  # must be verified in SES
        Destination={"ToAddresses": [STAFF_EMAIL]},
        Message={
            "Subject": {"Data": f"[{severity}] GCC AI Assistant - Safety Escalation"},
            "Body": {"Text": {"Data": message}},
        },
    )


def get_or_create_delivery_record(
    escalation_id,
    record_timestamp,
    occurred_at,
    session_id,
    user_id,
    reason,
    confidence,
    severity,
    requires_ses,
):
    existing = analytics_table.get_item(
        Key={"eventType": "escalation", "timestamp": record_timestamp},
        ConsistentRead=True,
    ).get("Item")
    if existing:
        return existing

    now = _now_iso()
    item = {
        "eventType": "escalation",
        "timestamp": record_timestamp,
        "occurredAt": occurred_at,
        "escalationId": escalation_id,
        "sessionId": session_id,
        "userId": user_id,
        "reason": reason,
        "metadata": {
            "confidence": Decimal(str(confidence)),
            "severity": severity,
        },
        "delivery": {
            "status": "PENDING",
            "snsSent": False,
            "sesSent": not requires_ses,
        },
        "createdAt": now,
        "updatedAt": now,
    }
    try:
        analytics_table.put_item(
            Item=item,
            ConditionExpression="attribute_not_exists(eventType) AND attribute_not_exists(#ts)",
            ExpressionAttributeNames={"#ts": "timestamp"},
        )
        return item
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            raise
        concurrent = analytics_table.get_item(
            Key={"eventType": "escalation", "timestamp": record_timestamp},
            ConsistentRead=True,
        ).get("Item")
        if not concurrent:
            raise RuntimeError("Escalation idempotency record disappeared") from error
        return concurrent


def mark_channel_delivered(record_timestamp: str, channel: str) -> None:
    analytics_table.update_item(
        Key={"eventType": "escalation", "timestamp": record_timestamp},
        UpdateExpression="SET delivery.#channel = :sent, updatedAt = :updated",
        ExpressionAttributeNames={"#channel": channel},
        ExpressionAttributeValues={":sent": True, ":updated": _now_iso()},
    )


def mark_delivery_complete(record_timestamp: str) -> None:
    analytics_table.update_item(
        Key={"eventType": "escalation", "timestamp": record_timestamp},
        UpdateExpression="SET delivery.#status = :completed, updatedAt = :updated",
        ExpressionAttributeNames={"#status": "status"},
        ExpressionAttributeValues={":completed": "COMPLETED", ":updated": _now_iso()},
    )


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
