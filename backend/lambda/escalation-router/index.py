"""Escalation Router — consumes queued alerts when a conversation needs staff
attention (safety keywords, low confidence, or a response guardrail action).

Emails staff a formatted summary through SES for every escalation (SNS email
is plain text only, so the staff alert topic is kept for system alarms) and
tracks retry-safe delivery state in the AnalyticsLogs table.
"""

import html
import json
import os
import re
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import boto3
from botocore.exceptions import ClientError

ses_client = boto3.client("ses")
dynamodb = boto3.resource("dynamodb")

# Empty when the deployment did not set a staff alert email.
STAFF_EMAIL = os.environ.get("STAFF_EMAIL", "").strip()
ANALYTICS_TABLE = os.environ["ANALYTICS_TABLE"]
# Admin dashboard link for the "Next steps" section; omitted when unset.
DASHBOARD_URL = os.environ.get("DASHBOARD_URL", "")
COUNCIL_TIMEZONE = timezone(timedelta(hours=-7), "America/Phoenix")

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

    # Severity: safety keywords = HIGH, low confidence or guardrail = MEDIUM
    severity = "HIGH" if "safety keyword" in reason.lower() else "MEDIUM"
    record_timestamp = f"{timestamp}#{escalation_id}"
    alert = build_alert(
        question=question or "",
        answer=answer or "",
        reason=reason,
        confidence=float(confidence),
        language=event.get("language") or "en",
        timestamp=timestamp,
        session_id=session_id or "",
    )
    record = get_or_create_delivery_record(
        escalation_id,
        record_timestamp,
        timestamp,
        session_id,
        user_id,
        reason,
        confidence,
        severity,
    )
    delivery = record.get("delivery") or {}
    if delivery.get("status") == "COMPLETED":
        print(f"Escalation already delivered: {escalation_id}")
        return

    if not delivery.get("sesSent", False):
        send_email_alert(alert)
        mark_channel_delivered(record_timestamp, "sesSent")

    mark_delivery_complete(record_timestamp)


def send_email_alert(alert: dict) -> None:
    if not STAFF_EMAIL:
        print("No staff alert email is configured; skipping the alert email")
        return
    ses_client.send_email(
        Source=STAFF_EMAIL,  # must be verified in SES
        Destination={"ToAddresses": [STAFF_EMAIL]},
        Message={
            "Subject": {"Data": alert["subject"]},
            "Body": {
                "Text": {"Data": alert["text"]},
                "Html": {"Data": alert["html"]},
            },
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
            "sesSent": False,
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


_KINDS = {
    "safety": {
        "subject": "Safety follow-up needed: a volunteer's question to GCC Compass",
        "label": "Safety",
        "headline": "A volunteer raised a possible safety concern",
        "summary": "GCC Compass shared emergency contacts with the volunteer. Please review the conversation and follow up if needed.",
    },
    "guardrail": {
        "subject": "Review needed: GCC Compass blocked a response",
        "label": "Blocked response",
        "headline": "GCC Compass blocked a response",
        "summary": "The content filter stopped the reply to this question. Please review it and follow up with the volunteer if needed.",
    },
    "low_confidence": {
        "subject": "Follow-up needed: GCC Compass couldn't fully answer a volunteer",
        "label": "Needs follow-up",
        "headline": "GCC Compass couldn't fully answer a question",
        "summary": "The council documents didn't clearly cover this question. Please check the reply and follow up with the volunteer if needed.",
    },
}


def _alert_kind(reason: str) -> str:
    lowered = reason.lower()
    if "safety keyword" in lowered:
        return "safety"
    if "guardrail" in lowered:
        return "guardrail"
    return "low_confidence"


def _received_at(timestamp: str) -> str:
    try:
        moment = datetime.fromisoformat(timestamp.replace("Z", "+00:00")).astimezone(COUNCIL_TIMEZONE)
    except ValueError:
        return timestamp
    hour = moment.hour % 12 or 12
    return f"{moment:%A}, {moment:%B} {moment.day}, {moment.year} at {hour}:{moment:%M %p} (Arizona time)"


def _plain(markdown: str) -> str:
    """Strip Markdown so assistant replies read cleanly in an email."""
    text = re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)", r"\1 (\2)", markdown)
    text = re.sub(r"\*\*(.+?)\*\*|__(.+?)__", lambda m: m.group(1) or m.group(2), text)
    text = re.sub(r"^\s*#{1,6}\s*", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*[-*]\s+", "• ", text, flags=re.MULTILINE)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _html_block(markdown: str) -> str:
    """Render the reply's simple Markdown (bold, links, bullets) as email HTML."""
    parts, bullets = [], []

    def inline(line: str) -> str:
        line = html.escape(line)
        line = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", line)
        return re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)", r'<a href="\2" style="color:#005696">\1</a>', line)

    def flush() -> None:
        if bullets:
            items = "".join(f'<li style="margin:4px 0">{item}</li>' for item in bullets)
            parts.append(f'<ul style="margin:4px 0 12px;padding-left:20px">{items}</ul>')
            bullets.clear()

    for raw in markdown.splitlines():
        line = re.sub(r"^\s*#{1,6}\s*", "", raw).strip()
        if re.match(r"^[-*]\s+", line):
            bullets.append(inline(re.sub(r"^[-*]\s+", "", line)))
            continue
        flush()
        if line:
            parts.append(f'<p style="margin:0 0 10px">{inline(line)}</p>')
    flush()
    return "".join(parts)


def build_alert(*, question, answer, reason, confidence, language, timestamp, session_id) -> dict:
    """Subject plus plain-text and HTML bodies for the staff email."""
    kind_name = _alert_kind(reason)
    kind = _KINDS[kind_name]
    received = _received_at(timestamp)
    language_name = "Spanish" if language == "es" else "English"
    flagged = f"Answer confidence {round(confidence * 100)}%" if kind_name == "low_confidence" else reason

    steps = []
    if DASHBOARD_URL:
        steps.append(f"Open the admin dashboard to see the full conversation: {DASHBOARD_URL}")
    steps.append("Contact the volunteer or their unit leader if follow-up is needed.")

    text = "\n".join([
        kind["headline"],
        "",
        kind["summary"],
        "",
        f"Received: {received}",
        f"Flagged because: {flagged}",
        f"Language: {language_name}",
        "",
        "Question",
        question.strip(),
        "",
        "Reply from GCC Compass",
        _plain(answer),
        "",
        "Next steps",
        *[f"• {step}" for step in steps],
        "",
        f"Conversation reference: {session_id}",
    ])

    muted = "color:#6c7380;font-size:13px"
    label = "margin:20px 0 6px;color:#6c7380;font-size:12px;font-weight:600"
    eyebrow_color = "#b42318" if kind_name == "safety" else "#6c7380"
    button = (
        f'<p style="margin:24px 0 0"><a href="{html.escape(DASHBOARD_URL)}" '
        'style="display:inline-block;background:#c6752c;color:#ffffff;text-decoration:none;'
        'padding:10px 16px;border-radius:8px;font-size:14px;font-weight:500">Open the admin dashboard</a></p>'
        if DASHBOARD_URL else ""
    )
    html_body = f"""<!doctype html><html><body style="margin:0;padding:24px 12px;background:#f4f4f4;font-family:Inter,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#202938">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto">
<tr><td style="padding:0 4px 12px;font-size:14px;font-weight:600;color:#0d1526">GCC Compass</td></tr>
<tr><td style="background:#ffffff;border:1px solid #e3e6eb;border-radius:12px;padding:24px">
<p style="margin:0 0 4px;font-size:12px;font-weight:600;color:{eyebrow_color}">{html.escape(kind['label'])}</p>
<p style="margin:0 0 6px;font-size:18px;font-weight:600;line-height:1.35">{html.escape(kind['headline'])}</p>
<p style="margin:0;color:#4b5563">{html.escape(kind['summary'])}</p>
<p style="margin:16px 0 0;{muted}">{html.escape(received)} · {language_name}<br>Flagged because: {html.escape(flagged)}</p>
<p style="{label}">Question</p>
<div style="padding:12px 14px;background:#f6f7f9;border-radius:8px">{html.escape(question.strip())}</div>
<p style="{label}">Reply from GCC Compass</p>
<div>{_html_block(answer)}</div>
{button}
</td></tr>
<tr><td style="padding:12px 4px 0;{muted}">Conversation reference: {html.escape(session_id)}</td></tr>
</table></body></html>"""

    return {"subject": kind["subject"], "text": text, "html": html_body}
