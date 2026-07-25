"""Admin Dashboard API — analytics/metrics + document management.

Single Cognito-authenticated admin surface. All routes require the caller to be
in the 'admin' group (validated here in addition to the API Gateway authorizer).
"""

import json
import os
import re
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from enum import IntEnum

import boto3
from boto3.dynamodb.conditions import Key
from pydantic import BaseModel, ConfigDict, Field

ddb = boto3.resource("dynamodb")
s3 = boto3.client("s3")
bedrock_agent = boto3.client("bedrock-agent")

CHAT_LOGS_TABLE = os.environ["CHAT_LOGS_TABLE"]
ANALYTICS_LOGS_TABLE = os.environ["ANALYTICS_LOGS_TABLE"]
DOCUMENT_BUCKET = os.environ["DOCUMENT_BUCKET"]
KB_BUCKET = os.environ["KB_BUCKET"]
KNOWLEDGE_BASE_ID = os.environ["KNOWLEDGE_BASE_ID"]
DATA_SOURCE_ID = os.environ["DATA_SOURCE_ID"]
ALLOWED_ORIGIN = os.environ["ALLOWED_ORIGIN"]

chat_table = ddb.Table(CHAT_LOGS_TABLE)
analytics_table = ddb.Table(ANALYTICS_LOGS_TABLE)

ALLOWED_CONTENT_TYPES = [
    # Documents
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",  # .docx
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",  # .xlsx
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",  # .pptx
    "application/msword",
    "application/vnd.ms-excel",
    # Text / data
    "text/csv",
    "text/plain",  # .txt
    # Images
    "image/svg+xml",
    "image/png",
    "image/jpeg",
]
MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024


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
    if not key:
        return False
    if ".." in key:
        return False
    if not key.startswith(allowed_prefix):
        return False
    if re.search(r"[\x00-\x1f]", key):
        return False
    return True


def sanitize_relative_path(relative_path: str) -> str:
    """Sanitize a client-supplied relative path while preserving folder structure.

    Each path segment is cleaned independently and slashes are retained, so a
    dropped folder layout (e.g. ``folderA/sub/file.pdf``) is mirrored exactly
    under the ``uploads/`` prefix in S3. Path-traversal (``..``), leading
    slashes, control characters, and empty/``.`` segments are stripped.
    """
    if not relative_path:
        return ""
    # Normalize Windows separators, drop any leading slashes.
    normalized = relative_path.replace("\\", "/").lstrip("/")
    segments = []
    for raw in normalized.split("/"):
        seg = raw.replace("..", "").strip()
        if not seg or seg == ".":
            continue
        seg = re.sub(r"[\x00-\x1f]", "", seg)
        if not seg:
            continue
        segments.append(seg)
    safe = "/".join(segments)
    if len(safe) > 500:
        safe = safe[:500]
    return safe


def sync_knowledge_base():
    try:
        bedrock_agent.start_ingestion_job(
            knowledgeBaseId=KNOWLEDGE_BASE_ID, dataSourceId=DATA_SOURCE_ID
        )
    except Exception as err:  # noqa: BLE001 - best effort; one job per source
        print(f"Failed to start KB ingestion after document change: {err}")


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


def query_by_event_type(event_type: str):
    items = []
    kwargs = {"KeyConditionExpression": Key("eventType").eq(event_type)}
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
    chat_items = scan_with_time_filter(chat_table, 90)
    escalation_items = query_by_event_type("escalation")
    doc_items = query_by_event_type("document_processing")

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
        ts = item.get("timestamp") or ""
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
    listed = s3.list_objects_v2(Bucket=DOCUMENT_BUCKET, Prefix="uploads/")
    state = get_ingestion_state()
    documents = []
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
    url = s3.generate_presigned_url(
        "get_object", Params={"Bucket": DOCUMENT_BUCKET, "Key": key}, ExpiresIn=300
    )
    return respond(HttpStatus.OK, {"url": url, "key": key})


def delete_document(event):
    key = _qs(event, "key")
    if not key:
        return respond(HttpStatus.BAD_REQUEST, {"message": "key parameter is required"})
    if not validate_s3_key(key, "uploads/"):
        return respond(HttpStatus.FORBIDDEN, {"message": "Invalid document key"})

    s3.delete_object(Bucket=DOCUMENT_BUCKET, Key=key)

    # Remove the copy from the KB bucket so it stops being ingested
    kb_key = f"documents/{key[len('uploads/'):]}"
    try:
        s3.delete_object(Bucket=KB_BUCKET, Key=kb_key)
    except Exception:  # noqa: BLE001 - fine if the KB copy doesn't exist
        print(f"KB bucket delete skipped: {kb_key}")

    # Re-sync so the deleted document's vectors are removed
    sync_knowledge_base()
    return respond(HttpStatus.OK, {"status": "deleted", "key": key})


def get_upload_url(event):
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return respond(HttpStatus.BAD_REQUEST, {"message": "Request body must be valid JSON"})

    # Prefer a folder-qualified relativePath (mirrors dropped folder structure);
    # fall back to a flat fileName for single-file uploads / older clients.
    relative_path = body.get("relativePath") or body.get("fileName")
    content_type = body.get("contentType")
    if not relative_path:
        return respond(HttpStatus.BAD_REQUEST, {"message": "relativePath or fileName is required"})

    safe_path = sanitize_relative_path(relative_path)
    if not safe_path:
        return respond(HttpStatus.BAD_REQUEST, {"message": "Invalid file path"})

    ct = content_type or "application/pdf"
    if ct not in ALLOWED_CONTENT_TYPES:
        return respond(HttpStatus.BAD_REQUEST, {"message": f"Content type not allowed. Allowed: {', '.join(ALLOWED_CONTENT_TYPES)}"})

    key = f"uploads/{safe_path}"
    upload = s3.generate_presigned_post(
        Bucket=DOCUMENT_BUCKET,
        Key=key,
        Fields={"Content-Type": ct},
        Conditions=[
            {"Content-Type": ct},
            ["content-length-range", 1, MAX_FILE_SIZE_BYTES],
        ],
        ExpiresIn=300,
    )
    return respond(HttpStatus.OK, {
        "url": upload["url"],
        "fields": upload["fields"],
        "key": key,
        "maxSizeBytes": MAX_FILE_SIZE_BYTES,
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
        "/dashboard/documents/upload": get_upload_url,
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
