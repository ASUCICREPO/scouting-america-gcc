"""Chat Handler — public volunteer chat endpoint.

Answers questions from the Bedrock Knowledge Base (RetrieveAndGenerate),
retrieves per-chunk scores in parallel for CI logging, escalates on safety
keywords or low confidence, and persists each turn to DynamoDB.
"""

import json
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key

# AWS clients (module-scoped — reused across warm invocations)
bedrock = boto3.client("bedrock-agent-runtime")
ddb = boto3.resource("dynamodb")
lambda_client = boto3.client("lambda")
secrets = boto3.client("secretsmanager")

# Env vars set by the CDK construct
KB_ID = os.environ["KB_ID"]
MODEL_ARN = os.environ["MODEL_ARN"]
CHAT_LOGS_TABLE = os.environ["CHAT_LOGS_TABLE"]
SECRETS_ARN = os.environ["SECRETS_ARN"]
ESCALATION_FUNCTION_ARN = os.environ.get("ESCALATION_FUNCTION_ARN", "")
CONFIDENCE_THRESHOLD = float(os.environ.get("CONFIDENCE_THRESHOLD", "0.7"))
SAFETY_KEYWORDS = json.loads(os.environ.get("SAFETY_KEYWORDS", "[]"))

chat_table = ddb.Table(CHAT_LOGS_TABLE)

# Caps the size of a single question to bound prompt size, Bedrock cost, and
# abuse on the public (unauthenticated) endpoint.
MAX_QUESTION_LENGTH = 4000

DEFAULT_PROMPT = (
    "You are the GCC AI Volunteer Support Assistant for Scouting America's "
    "Grand Canyon Council. Answer questions using ONLY approved GCC and "
    "Scouting America resources provided in the search results. If you cannot "
    "find the answer in the provided documents, say so clearly. For "
    "safety-sensitive topics (abuse, emergencies, injuries, youth protection), "
    "immediately direct the user to appropriate human contacts. Never make up "
    "information or present uncertain answers as definitive."
)


# ── Helpers ──────────────────────────────────────────────────────────────────

def _to_decimal(x):
    """DynamoDB stores numbers as Decimal; convert floats on write."""
    return Decimal(str(x))


def _to_float(x):
    if isinstance(x, Decimal):
        return float(x)
    return x


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def response(status_code: int, body):
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
        "body": json.dumps(body),
    }


def get_guardrails() -> str:
    """Reads the system prompt/guardrails from Secrets Manager."""
    try:
        secret = secrets.get_secret_value(SecretId=SECRETS_ARN)
        parsed = json.loads(secret.get("SecretString") or "{}")
        return parsed.get("systemPrompt") or DEFAULT_PROMPT
    except Exception:  # noqa: BLE001 - fall back to the default prompt
        return DEFAULT_PROMPT


def extract_sources(citations) -> list:
    """Extracts unique source document URIs from Bedrock KB citations."""
    sources = []
    for citation in citations or []:
        for ref in citation.get("retrievedReferences", []) or []:
            uri = (ref.get("location") or {}).get("s3Location", {}).get("uri")
            if uri and uri not in sources:
                sources.append(uri)
    return sources


def check_escalation(question: str, answer: str, confidence: float):
    """Returns (escalate: bool, reason: str) for safety keywords or low confidence."""
    combined = f"{question} {answer}".lower()
    for keyword in SAFETY_KEYWORDS:
        if keyword.lower() in combined:
            return True, f'Safety keyword detected: "{keyword}"'
    if confidence < CONFIDENCE_THRESHOLD:
        return True, f"Low confidence: {confidence:.2f}"
    return False, ""


def trigger_escalation(payload: dict):
    """Fires the Escalation Router Lambda asynchronously (best-effort)."""
    if not ESCALATION_FUNCTION_ARN:
        return
    try:
        lambda_client.invoke(
            FunctionName=ESCALATION_FUNCTION_ARN,
            InvocationType="Event",  # async — don't wait for a response
            Payload=json.dumps(payload).encode("utf-8"),
        )
    except Exception as err:  # noqa: BLE001
        print(f"Failed to trigger escalation: {err}")


# ── Route handlers ─────────────────────────────────────────────────────────

def _retrieve_and_generate(question: str, guardrails: str):
    prompt_template = (
        f"{guardrails}\n\n"
        "Search results:\n$search_results$\n\n"
        "User question: $query$\n\n"
        "Answer using only the provided search results. Respond in a clear, "
        "conversational tone. Do not include citation markers or source "
        "references in your answer."
    )
    return bedrock.retrieve_and_generate(
        input={"text": question},
        retrieveAndGenerateConfiguration={
            "type": "KNOWLEDGE_BASE",
            "knowledgeBaseConfiguration": {
                "knowledgeBaseId": KB_ID,
                "modelArn": MODEL_ARN,
                "generationConfiguration": {
                    "promptTemplate": {"textPromptTemplate": prompt_template},
                },
            },
        },
    )


def _retrieve_scores(question: str):
    try:
        return bedrock.retrieve(
            knowledgeBaseId=KB_ID,
            retrievalQuery={"text": question},
            retrievalConfiguration={
                "vectorSearchConfiguration": {"numberOfResults": 5},
            },
        )
    except Exception as err:  # noqa: BLE001 - best-effort, shouldn't block the answer
        print(f"Failed to retrieve scores: {err}")
        return None


def handle_chat(event):
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return response(400, {"error": "Request body must be valid JSON"})

    raw_question = body.get("question")
    existing_session_id = body.get("sessionId")

    # userId from Cognito claims if present (public endpoint → usually anonymous)
    authz = (event.get("requestContext") or {}).get("authorizer") or {}
    user_id = (authz.get("claims") or {}).get("sub", "anonymous")

    if not isinstance(raw_question, str) or not raw_question.strip():
        return response(400, {"error": "Question is required and must be a non-empty string"})
    question = raw_question.strip()
    if len(question) > MAX_QUESTION_LENGTH:
        return response(400, {"error": f"Question exceeds the maximum length of {MAX_QUESTION_LENGTH} characters"})

    if existing_session_id is not None and not isinstance(existing_session_id, str):
        return response(400, {"error": "sessionId must be a string"})

    session_id = existing_session_id or str(uuid.uuid4())
    timestamp = _now()

    guardrails = get_guardrails()

    # Generation and score retrieval are independent — RetrieveAndGenerate
    # doesn't return retrieval scores, so we run both Bedrock calls in parallel
    # to avoid paying two sequential round-trips.
    with ThreadPoolExecutor(max_workers=2) as pool:
        gen_future = pool.submit(_retrieve_and_generate, question, guardrails)
        scores_future = pool.submit(_retrieve_scores, question)
        kb_response = gen_future.result()
        retrieve_response = scores_future.result()

    answer = (kb_response.get("output") or {}).get("text") or "I could not find an answer to your question."
    citations = kb_response.get("citations", [])
    sources = extract_sources(citations)

    chunk_scores = []
    for result in (retrieve_response or {}).get("retrievalResults", []) or []:
        chunk_scores.append({
            "source": (result.get("location") or {}).get("s3Location", {}).get("uri", "unknown"),
            "score": result.get("score", 0),
            "chunkText": (result.get("content") or {}).get("text", "")[:200],
        })

    # Confidence = average of chunk scores; falls back to 0.3 when unavailable.
    if chunk_scores:
        confidence = sum(s["score"] for s in chunk_scores) / len(chunk_scores)
    else:
        confidence = 0.3

    escalate, reason = check_escalation(question, answer, confidence)
    if escalate:
        trigger_escalation({
            "sessionId": session_id,
            "userId": user_id,
            "question": question,
            "answer": answer,
            "reason": reason,
            "confidence": confidence,
        })

    # DynamoDB requires Decimal for floats — round-trip through the JSON encoder.
    item = json.loads(json.dumps({
        "sessionId": session_id,
        "timestamp": timestamp,
        "userId": user_id,
        "question": question,
        "answer": answer,
        "sources": sources,
        "confidence": confidence,
        "chunkScores": chunk_scores,
        "escalated": escalate,
        "category": "general",
        "createdAt": timestamp,
    }), parse_float=_to_decimal)
    chat_table.put_item(Item=item)

    return response(200, {
        "answer": answer,
        "sources": sources,
        "confidence": confidence,
        "sessionId": session_id,
        # messageId is the turn's DynamoDB sort key (timestamp). The client
        # sends it back on POST /chat/feedback to attach a rating to this turn.
        "messageId": timestamp,
        "escalated": escalate,
    })


def record_feedback(event):
    """Attach a thumbs up/down rating to a specific chat turn.

    Body: { sessionId, messageId, feedback } where messageId is the turn's
    timestamp (its DynamoDB sort key) returned by POST /chat. Idempotent —
    re-rating overwrites the previous value.
    """
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return response(400, {"error": "Request body must be valid JSON"})

    session_id = body.get("sessionId")
    message_id = body.get("messageId")
    feedback = body.get("feedback")

    if not isinstance(session_id, str) or not session_id:
        return response(400, {"error": "sessionId is required"})
    if not isinstance(message_id, str) or not message_id:
        return response(400, {"error": "messageId is required"})
    if feedback not in ("positive", "negative"):
        return response(400, {"error": "feedback must be 'positive' or 'negative'"})

    try:
        chat_table.update_item(
            Key={"sessionId": session_id, "timestamp": message_id},
            UpdateExpression="SET feedback = :f",
            # Only rate an existing turn — don't create a phantom item.
            ConditionExpression="attribute_exists(sessionId)",
            ExpressionAttributeValues={":f": feedback},
        )
    except ddb.meta.client.exceptions.ConditionalCheckFailedException:
        return response(404, {"error": "Conversation turn not found"})

    return response(200, {"status": "ok", "sessionId": session_id, "messageId": message_id, "feedback": feedback})


def get_history(event):
    session_id = (event.get("pathParameters") or {}).get("sessionId")
    if not session_id:
        return response(400, {"error": "sessionId is required"})

    result = chat_table.query(
        KeyConditionExpression=Key("sessionId").eq(session_id),
        ScanIndexForward=True,  # oldest first
    )
    history = [
        {
            "question": item.get("question"),
            "answer": item.get("answer"),
            "sources": item.get("sources"),
            "confidence": _to_float(item.get("confidence")),
            "timestamp": item.get("timestamp"),
            "escalated": item.get("escalated"),
        }
        for item in result.get("Items", [])
    ]
    return response(200, {"sessionId": session_id, "history": history})


# ── Entrypoint ───────────────────────────────────────────────────────────────

def handler(event, context):
    http_method = event.get("httpMethod")
    resource = event.get("resource") or ""

    try:
        if http_method == "GET" and "history" in resource:
            return get_history(event)
        if http_method == "POST" and "feedback" in resource:
            return record_feedback(event)
        if http_method == "POST":
            return handle_chat(event)
        return response(400, {"error": "Invalid route"})
    except Exception as err:  # noqa: BLE001
        print(f"Chat handler error: {err}")
        return response(500, {"error": "Internal server error"})
