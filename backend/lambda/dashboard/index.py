"""Admin Dashboard API — analytics/metrics + document management.

Single Cognito-authenticated admin surface. All routes require the caller to be
in the 'admin' group (validated here in addition to the API Gateway authorizer).
"""

import hashlib
import json
import os
import re
import time
import urllib.parse
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from enum import IntEnum

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError
from pydantic import BaseModel, ConfigDict, Field

ddb = boto3.resource("dynamodb")
s3 = boto3.client("s3")
bedrock_agent = boto3.client("bedrock-agent")
sqs = boto3.client("sqs")

CHAT_LOGS_TABLE = os.environ["CHAT_LOGS_TABLE"]
ANALYTICS_LOGS_TABLE = os.environ["ANALYTICS_LOGS_TABLE"]
DOCUMENT_BATCHES_TABLE = os.environ["DOCUMENT_BATCHES_TABLE"]
DOCUMENT_BUCKET = os.environ["DOCUMENT_BUCKET"]
KB_BUCKET = os.environ["KB_BUCKET"]
KNOWLEDGE_BASE_ID = os.environ["KNOWLEDGE_BASE_ID"]
DATA_SOURCE_ID = os.environ["DATA_SOURCE_ID"]
DOCUMENT_SYNC_QUEUE_URL = os.environ["DOCUMENT_SYNC_QUEUE_URL"]
ALLOWED_ORIGIN = os.environ["ALLOWED_ORIGIN"]

chat_table = ddb.Table(CHAT_LOGS_TABLE)
analytics_table = ddb.Table(ANALYTICS_LOGS_TABLE)
document_batches_table = ddb.Table(DOCUMENT_BATCHES_TABLE)

# Amazon Bedrock Knowledge Bases accepts source documents up to 50 MB.
MAX_FILE_SIZE_BYTES = 50_000_000
MAX_UPLOAD_BATCH_FILES = 500
UPLOAD_BATCH_TTL_SECONDS = 7 * 24 * 60 * 60
UPLOAD_BATCH_ID_RE = re.compile(r"^[a-f0-9]{32}$")

# Extension and MIME type are validated together. This is a conservative subset
# of the formats handled by the configured default Bedrock parser. Active SVG,
# images, presentations, executables, and generic archives are intentionally
# excluded.
ALLOWED_FILE_TYPES = {
    ".csv": ("text/csv", MAX_FILE_SIZE_BYTES),
    ".docx": (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        MAX_FILE_SIZE_BYTES,
    ),
    ".pdf": ("application/pdf", MAX_FILE_SIZE_BYTES),
    ".txt": ("text/plain", MAX_FILE_SIZE_BYTES),
    ".xlsx": (
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        MAX_FILE_SIZE_BYTES,
    ),
}
# ── Helpers ──────────────────────────────────────────────────────────────────

class HttpStatus(IntEnum):
    OK = 200
    NO_CONTENT = 204
    BAD_REQUEST = 400
    UNAUTHORIZED = 401
    FORBIDDEN = 403
    NOT_FOUND = 404
    METHOD_NOT_ALLOWED = 405
    INTERNAL_SERVER_ERROR = 500


class ProxyResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    status_code: int = Field(alias="statusCode")
    headers: dict[str, str]
    body: str


def _json_default(o):
    if isinstance(o, Decimal):
        return float(o)
    raise TypeError(f"Not serializable: {type(o)}")


def respond(status_code: HttpStatus, body):
    return ProxyResponse(
        statusCode=int(status_code),
        headers={
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
            "Vary": "Origin",
            "Access-Control-Allow-Headers": "Content-Type,Authorization",
            "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
        },
        body=json.dumps(body, default=_json_default),
    ).model_dump(by_alias=True)


def _num(x):
    if isinstance(x, bool):
        return None
    if isinstance(x, (int, float, Decimal)):
        return float(x)
    return None


def _r4(x: float) -> float:
    return round(x * 10000) / 10000


def _r2(x: float) -> float:
    return round(x * 100) / 100


def _epoch_ms(ts):
    if not ts:
        return None
    try:
        return int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000)
    except (ValueError, TypeError):
        return None


def _date_key(ts: str, period: str) -> str:
    if period == "month":
        return ts[:7]
    if period == "week":
        d = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        monday = d - timedelta(days=d.weekday())
        return monday.strftime("%Y-%m-%d")
    return ts[:10]


def _qs(event, name, default=None):
    params = event.get("queryStringParameters") or {}
    return params.get(name, default)


def validate_admin(event):
    authz = (event.get("requestContext") or {}).get("authorizer") or {}
    claims = authz.get("claims")
    if not claims:
        return respond(HttpStatus.UNAUTHORIZED, {"message": "Unauthorized: No authentication claims found"})
    groups = claims.get("cognito:groups") or ""
    group_list = groups if isinstance(groups, list) else [g.strip() for g in groups.split(",")]
    if "admin" not in group_list:
        return respond(HttpStatus.FORBIDDEN, {"message": "Forbidden: Admin group membership required"})
    return None


def validate_s3_key(key: str, allowed_prefix: str) -> bool:
    if not isinstance(key, str) or not key.startswith(allowed_prefix):
        return False
    relative = key[len(allowed_prefix):]
    if not relative or len(relative) > 500:
        return False
    if ".." in relative or "//" in relative:
        return False
    if re.search(r"[\x00-\x1f\x7f]", relative):
        return False
    return all(segment and segment == segment.strip() and segment != "." for segment in relative.split("/"))


def sanitize_relative_path(relative_path: str) -> str:
    """Sanitize a client-supplied relative path while preserving folder structure.

    Each path segment is cleaned independently and slashes are retained, so a
    dropped folder layout (e.g. ``folderA/sub/file.pdf``) is mirrored exactly
    under the ``uploads/`` prefix in S3. Path-traversal (``..``), leading
    slashes, control characters, and empty/``.`` segments are stripped.
    """
    if not isinstance(relative_path, str) or not relative_path:
        return ""
    normalized = relative_path.replace("\\", "/")
    if normalized.startswith("/") or len(normalized) > 500:
        return ""
    segments = normalized.split("/")
    if any(
        not segment
        or segment != segment.strip()
        or segment == "."
        or ".." in segment
        or re.search(r"[\x00-\x1f\x7f]", segment)
        for segment in segments
    ):
        return ""
    return normalized


def _file_extension(path: str) -> str:
    name = path.rsplit("/", 1)[-1]
    if "." not in name:
        return ""
    return f".{name.rsplit('.', 1)[-1].lower()}"


def validate_upload_file(file_request):
    """Return normalized upload metadata or a user-facing validation error."""
    if not isinstance(file_request, dict):
        return None, "Each file must be an object"

    relative_path = sanitize_relative_path(file_request.get("relativePath"))
    if not relative_path:
        return None, "Invalid relativePath"

    extension = _file_extension(relative_path)
    type_config = ALLOWED_FILE_TYPES.get(extension)
    if not type_config:
        return None, f"File extension not allowed: {extension or '(none)'}"

    expected_content_type, max_size = type_config
    content_type = file_request.get("contentType")
    if content_type != expected_content_type:
        return None, f"Content type does not match {extension}"

    file_size = file_request.get("size")
    if isinstance(file_size, bool) or not isinstance(file_size, int) or file_size < 1:
        return None, "File size must be a positive integer"
    if file_size > max_size:
        return None, f"File exceeds the {max_size}-byte limit for {extension}"

    return {
        "relativePath": relative_path,
        "contentType": content_type,
        "size": file_size,
        "maxSizeBytes": max_size,
        "key": f"uploads/{relative_path}",
    }, None


def _batch_token(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def _queue_batch_sync(batch_id: str):
    sqs.send_message(
        QueueUrl=DOCUMENT_SYNC_QUEUE_URL,
        MessageBody=json.dumps({"type": "document_batch_sync", "batchId": batch_id}),
        MessageGroupId=KNOWLEDGE_BASE_ID,
        MessageDeduplicationId=hashlib.sha256(f"batch:{batch_id}".encode("utf-8")).hexdigest(),
    )


def _complete_batch_if_ready(batch):
    processed = set(batch.get("processedTokens") or [])
    expected_count = int(batch.get("expectedCount") or 0)
    status = batch.get("status", "uploading")
    if status == "ready":
        # Re-sending the deterministic FIFO deduplication ID is safe and
        # repairs a prior attempt that committed the state transition but
        # failed before SQS acknowledged the message.
        _queue_batch_sync(batch["batchId"])
        return status
    if len(processed) < expected_count or status != "uploading":
        return status

    accepted = set(batch.get("acceptedTokens") or [])
    new_status = "ready" if accepted else "failed"
    try:
        document_batches_table.update_item(
            Key={"batchId": batch["batchId"]},
            UpdateExpression="SET #status = :status, completedAt = :completed_at",
            ConditionExpression="#status = :uploading",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={
                ":status": new_status,
                ":uploading": "uploading",
                ":completed_at": datetime.now(timezone.utc).isoformat(),
            },
        )
    except ClientError as err:
        if err.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            raise
        return batch.get("status", "uploading")

    if new_status == "ready":
        _queue_batch_sync(batch["batchId"])
    return new_status


def scan_with_time_filter(table, days_back=None):
    items = []
    kwargs = {}
    if days_back:
        cutoff = (
            (datetime.now(timezone.utc) - timedelta(days=days_back))
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )
        kwargs = {
            "FilterExpression": "#ts >= :cutoff",
            "ExpressionAttributeNames": {"#ts": "timestamp"},
            "ExpressionAttributeValues": {":cutoff": cutoff},
        }
    while True:
        resp = table.scan(**kwargs)
        items.extend(resp.get("Items", []))
        lek = resp.get("LastEvaluatedKey")
        if not lek:
            break
        kwargs["ExclusiveStartKey"] = lek
    return items


def query_by_event_type(event_type: str, days_back: int | None = None):
    items = []
    key_expr = Key("eventType").eq(event_type)
    if days_back:
        cutoff = (
            (datetime.now(timezone.utc) - timedelta(days=days_back))
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )
        key_expr = key_expr & Key("timestamp").gte(cutoff)
    kwargs = {"KeyConditionExpression": key_expr}
    while True:
        resp = analytics_table.query(**kwargs)
        items.extend(resp.get("Items", []))
        lek = resp.get("LastEvaluatedKey")
        if not lek:
            break
        kwargs["ExclusiveStartKey"] = lek
    return items


def aggregate_faq(chat_items):
    groups = {}
    for item in chat_items:
        q = (item.get("question") or "").strip()
        if not q:
            continue
        key = re.sub(r"[?.!]+$", "", re.sub(r"\s+", " ", q.lower()))
        g = groups.setdefault(
            key, {"question": q, "count": 0, "confidenceSum": 0.0, "escalatedCount": 0, "lastAsked": ""}
        )
        g["count"] += 1
        c = _num(item.get("confidence"))
        if c is not None:
            g["confidenceSum"] += c
        if item.get("escalated"):
            g["escalatedCount"] += 1
        ts = item.get("timestamp") or ""
        if ts > g["lastAsked"]:
            g["lastAsked"] = ts
    result = [
        {
            "question": g["question"],
            "count": g["count"],
            "avgConfidence": _r4(g["confidenceSum"] / g["count"]) if g["count"] > 0 else 0,
            "escalatedCount": g["escalatedCount"],
            "lastAsked": g["lastAsked"],
        }
        for g in groups.values()
    ]
    result.sort(key=lambda x: x["count"], reverse=True)
    return result


# ── Route handlers ─────────────────────────────────────────────────────────

def get_summary(event):
    days = int(_qs(event, "days", "90"))
    if days not in (1, 7, 30, 90):
        days = 90
    chat_items = scan_with_time_filter(chat_table, days)
    escalation_items = query_by_event_type("escalation", days)
    doc_items = query_by_event_type("document_processing", days)

    total_chats = len(chat_items)
    unique_sessions = len({i.get("sessionId") for i in chat_items})
    unique_users = len({i.get("userId") for i in chat_items if i.get("userId")})

    confidences = [c for c in (_num(i.get("confidence")) for i in chat_items) if c is not None]
    avg_conf = sum(confidences) / len(confidences) if confidences else 0

    total_esc = len(escalation_items)
    esc_rate = (total_esc / total_chats * 100) if total_chats > 0 else 0

    with_fb = [i for i in chat_items if i.get("feedback") in ("positive", "negative")]
    pos = len([i for i in with_fb if i.get("feedback") == "positive"])
    neg = len([i for i in with_fb if i.get("feedback") == "negative"])
    sat = (pos / len(with_fb) * 100) if with_fb else 0

    session_times = {}
    for item in chat_items:
        sid = item.get("sessionId")
        ts = _epoch_ms(item.get("timestamp"))
        if ts is None:
            continue
        st = session_times.get(sid)
        if not st:
            session_times[sid] = {"first": ts, "last": ts, "count": 1}
        else:
            st["first"] = min(st["first"], ts)
            st["last"] = max(st["last"], ts)
            st["count"] += 1
    durations = [s["last"] - s["first"] for s in session_times.values() if s["count"] > 1]
    avg_ms = sum(durations) / len(durations) if durations else 0

    body = {
        "totalChats": total_chats,
        "totalSessions": unique_sessions,
        "totalUsers": unique_users,
        "avgConfidence": _r4(avg_conf),
        "avgSessionLength": f"{int(avg_ms // 60000)}m {int((avg_ms % 60000) // 1000)}s",
        "avgSessionMs": avg_ms,
        "totalEscalations": total_esc,
        "escalationRate": _r2(esc_rate),
        "totalDocuments": len(doc_items),
        "satisfactionRate": _r2(sat),
        "positiveCount": pos,
        "negativeCount": neg,
        "totalFeedback": len(with_fb),
    }
    if not with_fb:
        body["feedbackNote"] = "Feedback tracking pending chatbot integration"
    return respond(HttpStatus.OK, body)


def get_conversations(event):
    period = _qs(event, "period", "day")
    chat_items = scan_with_time_filter(chat_table, 90)
    counts = {}
    for item in chat_items:
        ts = item.get("timestamp")
        if not ts:
            continue
        key = _date_key(ts, period)
        counts[key] = counts.get(key, 0) + 1
    data = [{"date": d, "count": c} for d, c in sorted(counts.items())]
    return respond(HttpStatus.OK, {"period": period, "data": data, "total": len(chat_items)})


def get_faq(event):
    limit = min(int(_qs(event, "limit", "5")), 100)
    chat_items = scan_with_time_filter(chat_table, 30)
    all_faq = aggregate_faq(chat_items)
    return respond(HttpStatus.OK, {"faq": all_faq[:limit], "totalUnique": len(all_faq)})


def get_faq_all(event):
    limit = min(int(_qs(event, "limit", "30")), 100)
    offset = int(_qs(event, "offset", "0"))
    chat_items = scan_with_time_filter(chat_table, 90)
    all_faq = aggregate_faq(chat_items)
    return respond(HttpStatus.OK, {"faq": all_faq[offset:offset + limit], "total": len(all_faq), "offset": offset, "limit": limit})


def get_confidence(event):
    period = _qs(event, "period", "day")
    chat_items = scan_with_time_filter(chat_table, 90)
    valid = [i for i in chat_items if _num(i.get("confidence")) is not None]

    distribution = {"veryLow": 0, "low": 0, "medium": 0, "high": 0, "veryHigh": 0}
    for item in valid:
        c = _num(item.get("confidence"))
        if c < 0.2:
            distribution["veryLow"] += 1
        elif c < 0.4:
            distribution["low"] += 1
        elif c < 0.6:
            distribution["medium"] += 1
        elif c < 0.8:
            distribution["high"] += 1
        else:
            distribution["veryHigh"] += 1

    trend = {}
    for item in valid:
        ts = item.get("timestamp")
        if not ts:
            continue
        key = _date_key(ts, period)
        t = trend.setdefault(key, {"sum": 0.0, "count": 0})
        t["sum"] += _num(item.get("confidence"))
        t["count"] += 1
    trend_data = [
        {"date": d, "avgConfidence": _r4(v["sum"] / v["count"]), "count": v["count"]}
        for d, v in sorted(trend.items())
    ]

    all_vals = sorted(_num(i.get("confidence")) for i in valid)
    avg = sum(all_vals) / len(all_vals) if all_vals else 0
    return respond(HttpStatus.OK, {
        "distribution": distribution,
        "trend": trend_data,
        "stats": {
            "total": len(all_vals),
            "average": _r4(avg),
            "median": _r4(all_vals[len(all_vals) // 2]) if all_vals else 0,
            "min": _r4(all_vals[0]) if all_vals else 0,
            "max": _r4(all_vals[-1]) if all_vals else 0,
        },
    })


def get_escalations(event):
    items = query_by_event_type("escalation")
    grouped = {}
    for item in items:
        metadata = item.get("metadata") or {}
        reason = item.get("reason") or metadata.get("reason") or "unknown"
        ts = item.get("occurredAt") or (item.get("timestamp") or "").split("#", 1)[0]
        conf = _num(metadata.get("confidence")) or 0
        g = grouped.setdefault(reason, {"count": 0, "lastOccurred": "", "confSum": 0.0})
        g["count"] += 1
        g["confSum"] += conf
        if ts > g["lastOccurred"]:
            g["lastOccurred"] = ts
    escalations = [
        {
            "reason": reason,
            "count": g["count"],
            "lastOccurred": g["lastOccurred"],
            "avgConfidence": _r4(g["confSum"] / g["count"]) if g["count"] > 0 else 0,
        }
        for reason, g in grouped.items()
    ]
    escalations.sort(key=lambda x: x["count"], reverse=True)
    return respond(HttpStatus.OK, {"escalations": escalations, "total": len(items)})


def get_negative_feedback(event):
    limit = min(int(_qs(event, "limit", "50")), 200)
    offset = int(_qs(event, "offset", "0"))
    chat_items = scan_with_time_filter(chat_table, 90)
    negatives = sorted(
        (i for i in chat_items if i.get("feedback") == "negative"),
        key=lambda i: i.get("timestamp") or "",
        reverse=True,
    )
    total = len(negatives)
    paginated = negatives[offset:offset + limit]
    body = {
        "total": total,
        "offset": offset,
        "limit": limit,
        "conversations": [
            {
                "sessionId": i.get("sessionId"),
                "timestamp": i.get("timestamp"),
                "userId": i.get("userId"),
                "question": i.get("question"),
                "answer": i.get("answer"),
                "confidence": _r4(_num(i.get("confidence"))) if _num(i.get("confidence")) is not None else 0,
                "sources": i.get("sources") or [],
                "escalated": i.get("escalated") or False,
                "language": i.get("language", "en"),
            }
            for i in paginated
        ],
    }
    if total == 0:
        body["note"] = "Feedback tracking pending chatbot integration — no feedback data exists yet"
    return respond(HttpStatus.OK, body)


def get_feedback(event):
    """List every chat turn that received a thumbs up/down.

    Query params:
      - filter: 'positive' | 'negative' | 'all' (default 'all')
      - limit, offset: pagination
    Each row is a single rated turn; the dashboard opens the full session and
    highlights this turn using (sessionId, messageId=timestamp).
    """
    filter_val = (_qs(event, "filter", "all") or "all").lower()
    wanted = {"positive", "negative"}
    if filter_val == "positive":
        wanted = {"positive"}
    elif filter_val == "negative":
        wanted = {"negative"}

    limit = min(int(_qs(event, "limit", "50")), 200)
    offset = int(_qs(event, "offset", "0"))

    chat_items = scan_with_time_filter(chat_table, 90)
    rated = sorted(
        (i for i in chat_items if i.get("feedback") in wanted),
        key=lambda i: i.get("timestamp") or "",
        reverse=True,
    )
    total = len(rated)
    paginated = rated[offset:offset + limit]
    conversations = [
        {
            "sessionId": i.get("sessionId"),
            # messageId == the turn's sort key; used to highlight in the transcript.
            "messageId": i.get("timestamp"),
            "timestamp": i.get("timestamp"),
            "userId": i.get("userId"),
            "question": i.get("question"),
            "answer": i.get("answer"),
            "feedback": i.get("feedback"),
            "confidence": _r4(_num(i.get("confidence"))) if _num(i.get("confidence")) is not None else 0,
            "sources": i.get("sources") or [],
            "escalated": i.get("escalated") or False,
            "language": i.get("language", "en"),
        }
        for i in paginated
    ]
    body = {"total": total, "offset": offset, "limit": limit, "filter": filter_val, "conversations": conversations}
    if total == 0:
        body["note"] = "No feedback has been submitted yet"
    return respond(HttpStatus.OK, body)


def get_session(event):
    """Return the full transcript for a session so the dashboard can render the
    whole conversation and highlight the turn that was rated.
    """
    session_id = _qs(event, "sessionId")
    if not session_id:
        return respond(HttpStatus.BAD_REQUEST, {"message": "sessionId parameter is required"})

    result = chat_table.query(
        KeyConditionExpression=Key("sessionId").eq(session_id),
        ScanIndexForward=True,  # oldest first
    )
    turns = [
        {
            "messageId": item.get("timestamp"),
            "timestamp": item.get("timestamp"),
            "question": item.get("question"),
            "answer": item.get("answer"),
            "feedback": item.get("feedback"),
            "confidence": _r4(_num(item.get("confidence"))) if _num(item.get("confidence")) is not None else 0,
            "sources": item.get("sources") or [],
            "escalated": item.get("escalated") or False,
            "language": item.get("language", "en"),
        }
        for item in result.get("Items", [])
    ]
    return respond(HttpStatus.OK, {"sessionId": session_id, "turns": turns, "total": len(turns)})


def get_ingestion_state():
    """Summarize the Bedrock data source's recent ingestion jobs.

    Returns a dict with ``active`` (a job is STARTING/IN_PROGRESS), ``lastComplete``
    (datetime of the most recent COMPLETE job), and ``lastFailed`` (datetime of the
    most recent FAILED job). Returns ``None`` if the status can't be determined, so
    the document list still renders even if this call is unavailable.
    """
    try:
        resp = bedrock_agent.list_ingestion_jobs(
            knowledgeBaseId=KNOWLEDGE_BASE_ID,
            dataSourceId=DATA_SOURCE_ID,
            sortBy={"attribute": "STARTED_AT", "order": "DESCENDING"},
            maxResults=10,
        )
    except Exception as err:  # noqa: BLE001 - status is best-effort
        print(f"list_ingestion_jobs failed: {err}")
        return None

    summaries = resp.get("ingestionJobSummaries", [])
    active = any(s.get("status") in ("STARTING", "IN_PROGRESS") for s in summaries)
    complete_times = [s.get("updatedAt") for s in summaries if s.get("status") == "COMPLETE" and s.get("updatedAt")]
    failed_times = [s.get("updatedAt") for s in summaries if s.get("status") == "FAILED" and s.get("updatedAt")]
    return {
        "active": active,
        "lastComplete": max(complete_times) if complete_times else None,
        "lastFailed": max(failed_times) if failed_times else None,
    }


def doc_ingestion_status(last_modified, state):
    """Classify a single document's readiness from the data-source ingestion state.

    Heuristic (Bedrock ingests the whole data source per job, not per file):
    - ready:    uploaded on/before the last COMPLETE job finished.
    - indexing: a job is running and this doc post-dates the last COMPLETE job.
    - failed:   the most recent job FAILED after this doc was uploaded.
    - pending:  uploaded, no job running yet, not covered by a COMPLETE job.
    """
    if state is None or last_modified is None:
        return "ready"  # can't determine — don't raise a false alarm

    last_complete = state.get("lastComplete")
    covered = bool(last_complete and last_modified <= last_complete)
    if covered:
        return "ready"

    if state.get("active"):
        return "indexing"

    last_failed = state.get("lastFailed")
    if last_failed and last_modified <= last_failed:
        return "failed"

    return "pending"


def get_documents(event):
    state = get_ingestion_state()
    documents = []
    list_request = {"Bucket": DOCUMENT_BUCKET, "Prefix": "uploads/"}
    while True:
        listed = s3.list_objects_v2(**list_request)
        for obj in listed.get("Contents", []):
            key = obj.get("Key")
            if not key or key == "uploads/":
                continue
            last_modified = obj.get("LastModified")
            documents.append({
                "key": key,
                "fileName": key[len("uploads/"):],
                "fileSize": obj.get("Size", 0),
                "lastModified": last_modified.astimezone(timezone.utc).isoformat().replace("+00:00", "Z") if last_modified else "",
                "status": doc_ingestion_status(last_modified, state),
            })
        continuation_token = listed.get("NextContinuationToken")
        if not continuation_token:
            break
        list_request["ContinuationToken"] = continuation_token
    documents.sort(key=lambda d: d["lastModified"], reverse=True)
    return respond(HttpStatus.OK, {
        "documents": documents,
        "total": len(documents),
        "indexing": bool(state and state.get("active")),
    })


def get_document_download_url(event):
    key = _qs(event, "key")
    if not key:
        return respond(HttpStatus.BAD_REQUEST, {"message": "key parameter is required"})
    if not validate_s3_key(key, "uploads/"):
        return respond(HttpStatus.FORBIDDEN, {"message": "Invalid document key"})
    filename = urllib.parse.quote(key.rsplit("/", 1)[-1], safe="")
    url = s3.generate_presigned_url(
        "get_object",
        Params={
            "Bucket": DOCUMENT_BUCKET,
            "Key": key,
            "ResponseContentDisposition": f"attachment; filename*=UTF-8''{filename}",
            "ResponseContentType": "application/octet-stream",
        },
        ExpiresIn=300,
    )
    return respond(HttpStatus.OK, {"url": url, "key": key})


def delete_document(event):
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return respond(HttpStatus.BAD_REQUEST, {"message": "Request body must be valid JSON"})
    if not isinstance(body, dict):
        return respond(HttpStatus.BAD_REQUEST, {"message": "Request body must be a JSON object"})

    keys = body.get("keys")
    if keys is None:
        query_key = _qs(event, "key")
        keys = [query_key] if query_key else []
    if not isinstance(keys, list) or not keys or len(keys) > 100:
        return respond(HttpStatus.BAD_REQUEST, {"message": "keys must contain 1 to 100 document keys"})
    if any(not validate_s3_key(key, "uploads/") for key in keys):
        return respond(HttpStatus.FORBIDDEN, {"message": "Invalid document key"})
    if len(set(keys)) != len(keys):
        return respond(HttpStatus.BAD_REQUEST, {"message": "Duplicate document keys are not allowed"})

    kb_keys = {f"documents/{key[len('uploads/')]}": key for key in keys}

    def delete_from_bucket(bucket, object_keys):
        try:
            result = s3.delete_objects(
                Bucket=bucket,
                Delete={"Objects": [{"Key": key} for key in object_keys], "Quiet": True},
            )
            return {error.get("Key") for error in result.get("Errors", []) if error.get("Key")}
        except ClientError as err:
            print(f"Bulk document delete failed in {bucket}: {err}")
            return set(object_keys)

    raw_failures = delete_from_bucket(DOCUMENT_BUCKET, keys)
    kb_failures = delete_from_bucket(KB_BUCKET, list(kb_keys))
    failed_keys = [
        key for key in keys
        if key in raw_failures or f"documents/{key[len('uploads/'):]}" in kb_failures
    ]
    deleted_keys = [key for key in keys if key not in failed_keys]

    # A successful KB delete changes the retrieval corpus even if removing the
    # matching raw object failed, so always serialize a sync for that mutation.
    if len(kb_failures) < len(kb_keys):
        change_id = uuid.uuid4().hex
        sqs.send_message(
            QueueUrl=DOCUMENT_SYNC_QUEUE_URL,
            MessageBody=json.dumps({"type": "document_change_sync", "changeId": change_id}),
            MessageGroupId=KNOWLEDGE_BASE_ID,
            MessageDeduplicationId=hashlib.sha256(f"delete:{change_id}".encode("utf-8")).hexdigest(),
        )

    return respond(HttpStatus.OK, {
        "status": "deleted" if not failed_keys else "partial",
        "deletedKeys": deleted_keys,
        "failedKeys": failed_keys,
    })


def create_upload_batch(event):
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return respond(HttpStatus.BAD_REQUEST, {"message": "Request body must be valid JSON"})
    if not isinstance(body, dict):
        return respond(HttpStatus.BAD_REQUEST, {"message": "Request body must be a JSON object"})

    files = body.get("files")
    if not isinstance(files, list) or not files:
        return respond(HttpStatus.BAD_REQUEST, {"message": "files must be a non-empty array"})
    if len(files) > MAX_UPLOAD_BATCH_FILES:
        return respond(
            HttpStatus.BAD_REQUEST,
            {"message": f"A batch may contain at most {MAX_UPLOAD_BATCH_FILES} files"},
        )

    validated = []
    seen_keys = set()
    for index, file_request in enumerate(files):
        upload_file, error = validate_upload_file(file_request)
        if error:
            return respond(HttpStatus.BAD_REQUEST, {"message": f"files[{index}]: {error}"})
        if upload_file["key"] in seen_keys:
            return respond(
                HttpStatus.BAD_REQUEST,
                {"message": f"Duplicate upload path: {upload_file['relativePath']}"},
            )
        seen_keys.add(upload_file["key"])
        validated.append(upload_file)

    batch_id = uuid.uuid4().hex
    uploads = []
    for upload_file in validated:
        content_type = upload_file["contentType"]
        metadata_field = "x-amz-meta-upload-batch-id"
        upload = s3.generate_presigned_post(
            Bucket=DOCUMENT_BUCKET,
            Key=upload_file["key"],
            Fields={
                "Content-Type": content_type,
                metadata_field: batch_id,
            },
            Conditions=[
                {"Content-Type": content_type},
                {metadata_field: batch_id},
                ["content-length-range", upload_file["size"], upload_file["size"]],
            ],
            ExpiresIn=300,
        )
        uploads.append({
            "relativePath": upload_file["relativePath"],
            "url": upload["url"],
            "fields": upload["fields"],
            "key": upload_file["key"],
            "maxSizeBytes": upload_file["maxSizeBytes"],
        })

    now = int(time.time())
    document_batches_table.put_item(Item={
        "batchId": batch_id,
        "status": "uploading",
        "expectedCount": len(validated),
        "expectedKeys": [upload_file["key"] for upload_file in validated],
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "expiresAt": now + UPLOAD_BATCH_TTL_SECONDS,
    })

    return respond(HttpStatus.OK, {
        "batchId": batch_id,
        "uploads": uploads,
        "expiresIn": 300,
    })


def complete_upload_batch(event):
    """Close an upload batch and account for browser-side transfer failures."""
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return respond(HttpStatus.BAD_REQUEST, {"message": "Request body must be valid JSON"})
    if not isinstance(body, dict):
        return respond(HttpStatus.BAD_REQUEST, {"message": "Request body must be a JSON object"})

    batch_id = body.get("batchId")
    failed_keys = body.get("failedKeys", [])
    if not isinstance(batch_id, str) or not UPLOAD_BATCH_ID_RE.fullmatch(batch_id):
        return respond(HttpStatus.BAD_REQUEST, {"message": "Invalid batchId"})
    if (
        not isinstance(failed_keys, list)
        or len(failed_keys) > MAX_UPLOAD_BATCH_FILES
        or any(not isinstance(key, str) for key in failed_keys)
    ):
        return respond(
            HttpStatus.BAD_REQUEST,
            {"message": f"failedKeys must contain at most {MAX_UPLOAD_BATCH_FILES} strings"},
        )

    response = document_batches_table.get_item(Key={"batchId": batch_id}, ConsistentRead=True)
    batch = response.get("Item")
    if not batch:
        return respond(HttpStatus.NOT_FOUND, {"message": "Upload batch not found"})

    expected_keys = set(batch.get("expectedKeys") or [])
    supplied_failures = set(failed_keys)
    if not supplied_failures.issubset(expected_keys):
        return respond(HttpStatus.BAD_REQUEST, {"message": "failedKeys contains an unknown object key"})

    # An XHR can miss S3's success response even though the object landed. Only
    # mark a reported failure complete when this batch's object is truly absent.
    confirmed_failures = set()
    for key in supplied_failures:
        try:
            head = s3.head_object(Bucket=DOCUMENT_BUCKET, Key=key)
            if (head.get("Metadata") or {}).get("upload-batch-id") != batch_id:
                confirmed_failures.add(key)
        except ClientError as err:
            if err.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
                confirmed_failures.add(key)
            else:
                raise

    if confirmed_failures:
        updated = document_batches_table.update_item(
            Key={"batchId": batch_id},
            UpdateExpression="SET finalizedAt = :finalized_at ADD processedTokens :tokens",
            ExpressionAttributeValues={
                ":tokens": {_batch_token(key) for key in confirmed_failures},
                ":finalized_at": datetime.now(timezone.utc).isoformat(),
            },
            ReturnValues="ALL_NEW",
        )
        batch = updated.get("Attributes") or batch
    else:
        document_batches_table.update_item(
            Key={"batchId": batch_id},
            UpdateExpression="SET finalizedAt = :finalized_at",
            ExpressionAttributeValues={
                ":finalized_at": datetime.now(timezone.utc).isoformat(),
            },
        )

    status = _complete_batch_if_ready(batch)
    return respond(HttpStatus.OK, {
        "batchId": batch_id,
        "status": status,
        "failedCount": len(confirmed_failures),
    })


# ── Route map + entrypoint ───────────────────────────────────────────────────

ROUTES = {
    "GET": {
        "/dashboard/summary": get_summary,
        "/dashboard/conversations": get_conversations,
        "/dashboard/faq": get_faq,
        "/dashboard/faq/all": get_faq_all,
        "/dashboard/confidence": get_confidence,
        "/dashboard/escalations": get_escalations,
        "/dashboard/negative-feedback": get_negative_feedback,
        "/dashboard/feedback": get_feedback,
        "/dashboard/session": get_session,
        "/dashboard/documents": get_documents,
        "/dashboard/documents/download": get_document_download_url,
    },
    "POST": {
        "/dashboard/documents/upload": create_upload_batch,
        "/dashboard/documents/upload/complete": complete_upload_batch,
    },
    "DELETE": {
        "/dashboard/documents": delete_document,
    },
}


def handler(event, context):
    method = event.get("httpMethod")
    path = event.get("path")
    print(f"Dashboard API: {method} {path}")

    if method == "OPTIONS":
        return respond(HttpStatus.NO_CONTENT, "")

    auth_error = validate_admin(event)
    if auth_error:
        return auth_error

    method_routes = ROUTES.get(method)
    if not method_routes:
        return respond(HttpStatus.METHOD_NOT_ALLOWED, {"message": f"Method not allowed: {method}"})

    route_handler = method_routes.get(path)
    if not route_handler:
        return respond(HttpStatus.NOT_FOUND, {"message": f"Route not found: {method} {path}"})

    try:
        return route_handler(event)
    except Exception as error:  # noqa: BLE001
        print(f"Dashboard API error: {error}")
        return respond(HttpStatus.INTERNAL_SERVER_ERROR, {"message": "Internal server error"})
