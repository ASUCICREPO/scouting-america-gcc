"""Escalation Router — consumes queued alerts when a conversation needs staff
attention (safety keywords, low confidence, or a response guardrail action).

Publishes an SNS alert (always), emails staff for HIGH-severity/safety cases,
and tracks retry-safe delivery state in the AnalyticsLogs table.
"""

import html
import json
import os
import re
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import boto3
from botocore.exceptions import ClientError

sns_client = boto3.client("sns")
ses_client = boto3.client("ses")
dynamodb = boto3.resource("dynamodb")

SNS_TOPIC_ARN = os.environ["SNS_TOPIC_ARN"]
STAFF_EMAIL = os.environ["STAFF_EMAIL"]
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

    # Severity: safety keywords = HIGH, low confidence = MEDIUM
    is_high_severity = "safety keyword" in reason.lower()
    severity = "HIGH" if is_high_severity else "MEDIUM"
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
        is_high_severity,
    )
    delivery = record.get("delivery") or {}
    if delivery.get("status") == "COMPLETED":
        print(f"Escalation already delivered: {escalation_id}")
        return

    if not delivery.get("snsSent", False):
        send_sns_alert(alert)
        mark_channel_delivered(record_timestamp, "snsSent")

    if is_high_severity and not delivery.get("sesSent", False):
        send_email_alert(alert)
        mark_channel_delivered(record_timestamp, "sesSent")

    mark_delivery_complete(record_timestamp)


def send_sns_alert(alert: dict) -> None:
    # SNS email only supports plain text.
    sns_client.publish(TopicArn=SNS_TOPIC_ARN, Subject=alert["subject"], Message=alert["text"])


def send_email_alert(alert: dict) -> None:
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


_KINDS = {
    "safety": {
        "subject": "Safety follow-up needed: a volunteer's question to GCC Compass",
        "headline": "A volunteer raised a possible safety concern",
        "summary": "GCC Compass shared emergency contacts with the volunteer. Please review the conversation and follow up if needed.",
        "priority": "High (safety)",
        "color": "#b42318",
    },
    "guardrail": {
        "subject": "Review needed: GCC Compass blocked a response",
        "headline": "GCC Compass blocked a response",
        "summary": "The content filter stopped the reply to this question. Please review it and follow up with the volunteer if needed.",
        "priority": "Medium",
        "color": "#b54708",
    },
    "low_confidence": {
        "subject": "Follow-up needed: GCC Compass couldn't fully answer a volunteer",
        "headline": "GCC Compass couldn't fully answer a question",
        "summary": "The council documents didn't clearly cover this question. Please check the reply and follow up with the volunteer if needed.",
        "priority": "Medium",
        "color": "#b54708",
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
    return f"{moment:%A}, {moment:%B} {moment.day}, {moment.year} at {moment:%I:%M %p}".replace(" 0", " ") + " (Arizona time)"


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
        return re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)", r'<a href="\2" style="color:#0e5ea1">\1</a>', line)

    def flush() -> None:
        if bullets:
            items = "".join(f'<li style="margin:4px 0">{item}</li>' for item in bullets)
            parts.append(f'<ul style="margin:8px 0 12px;padding-left:20px">{items}</ul>')
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
    """Subject, plain-text body (SNS and SES fallback), and HTML body (SES)."""
    kind = _KINDS[_alert_kind(reason)]
    received = _received_at(timestamp)
    language_name = "Spanish" if language == "es" else "English"
    detail = reason if _alert_kind(reason) != "low_confidence" else f"Answer confidence {round(confidence * 100)}%"
    reply = _plain(answer)

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
        f"Priority: {kind['priority']}",
        f"Flagged because: {detail}",
        f"Language: {language_name}",
        "",
        "VOLUNTEER'S QUESTION",
        question.strip(),
        "",
        "GCC COMPASS REPLIED",
        reply,
        "",
        "NEXT STEPS",
        *[f"• {step}" for step in steps],
        "",
        "—",
        f"Automated message from GCC Compass. Conversation reference: {session_id}",
    ])

    rows = "".join(
        f'<tr><td style="padding:4px 16px 4px 0;color:#6c7380;white-space:nowrap">{label}</td>'
        f'<td style="padding:4px 0;color:#202938">{html.escape(value)}</td></tr>'
        for label, value in (
            ("Received", received),
            ("Priority", kind["priority"]),
            ("Flagged because", detail),
            ("Language", language_name),
        )
    )
    button = (
        f'<p style="margin:20px 0 0"><a href="{html.escape(DASHBOARD_URL)}" '
        'style="display:inline-block;background:#c6752c;color:#ffffff;text-decoration:none;'
        'padding:10px 18px;border-radius:6px;font-weight:600">Open the admin dashboard</a></p>'
        if DASHBOARD_URL else ""
    )
    html_body = f"""<!doctype html><html><body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#202938">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;margin:0 auto;background:#ffffff;border:1px solid #e3e6eb;border-radius:10px">
<tr><td style="padding:18px 24px;border-bottom:1px solid #e3e6eb;font-weight:600;color:#003f87">GCC Compass</td></tr>
<tr><td style="padding:24px">
<p style="margin:0 0 6px"><span style="display:inline-block;padding:2px 10px;border-radius:100px;background:{kind['color']};color:#ffffff;font-size:12px;font-weight:600">{html.escape(kind['priority'])}</span></p>
<h1 style="margin:8px 0 8px;font-size:20px;line-height:1.3">{html.escape(kind['headline'])}</h1>
<p style="margin:0 0 18px;color:#4b5563">{html.escape(kind['summary'])}</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:0 0 20px">{rows}</table>
<p style="margin:0 0 6px;font-size:12px;font-weight:600;letter-spacing:.04em;color:#6c7380">VOLUNTEER'S QUESTION</p>
<div style="margin:0 0 20px;padding:12px 14px;background:#f6f7f9;border-left:3px solid #003f87;border-radius:4px">{html.escape(question.strip())}</div>
<p style="margin:0 0 6px;font-size:12px;font-weight:600;letter-spacing:.04em;color:#6c7380">GCC COMPASS REPLIED</p>
<div style="margin:0;padding:12px 14px;background:#f6f7f9;border-left:3px solid #c9ced6;border-radius:4px">{_html_block(answer)}</div>
{button}
</td></tr>
<tr><td style="padding:14px 24px;border-top:1px solid #e3e6eb;font-size:12px;color:#6c7380">Automated message from GCC Compass. Conversation reference: {html.escape(session_id)}</td></tr>
</table></body></html>"""

    return {"subject": kind["subject"], "text": text, "html": html_body}
