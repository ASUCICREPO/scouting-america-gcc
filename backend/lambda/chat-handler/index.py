"""Public volunteer chat API.

Each answer is generated from one Bedrock Knowledge Base retrieval. The exact
retrieved chunks drive generation, confidence, citations, and audit logging so
those views cannot drift apart. Bedrock Guardrails evaluates generation input
and output, while the production Jinja prompt is read from an immutable Bedrock
Prompt Management version.
"""

import hashlib
import hmac
import json
import os
import secrets
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from enum import IntEnum
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

import boto3
from boto3.dynamodb.conditions import Key
from jinja2 import Environment, StrictUndefined
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

# AWS clients are module-scoped and reused across warm invocations.
bedrock_agent = boto3.client("bedrock-agent")
bedrock_retrieval = boto3.client("bedrock-agent-runtime")
bedrock_runtime = boto3.client("bedrock-runtime")
ddb = boto3.resource("dynamodb")
lambda_client = boto3.client("lambda")

# Environment set by the CDK construct.
KB_ID = os.environ["KB_ID"]
MODEL_ARN = os.environ["MODEL_ARN"]
CHAT_LOGS_TABLE = os.environ["CHAT_LOGS_TABLE"]
GUARDRAIL_ID = os.environ["GUARDRAIL_ID"]
GUARDRAIL_VERSION = os.environ["GUARDRAIL_VERSION"]
PROMPT_ID = os.environ["PROMPT_ID"]
PROMPT_VERSION = os.environ["PROMPT_VERSION"]
ESCALATION_FUNCTION_ARN = os.environ.get("ESCALATION_FUNCTION_ARN", "")
CONFIDENCE_THRESHOLD = float(os.environ.get("CONFIDENCE_THRESHOLD", "0.7"))
SAFETY_KEYWORDS = json.loads(os.environ.get("SAFETY_KEYWORDS", "[]"))
ALLOWED_ORIGIN = os.environ["ALLOWED_ORIGIN"]

chat_table = ddb.Table(CHAT_LOGS_TABLE)

MAX_QUESTION_LENGTH = 4000
MAX_SESSION_ID_LENGTH = 128
PROMPT_PATH = Path(__file__).parent / "templates" / "chat_prompt.j2"
jinja = Environment(autoescape=False, undefined=StrictUndefined)


class HttpStatus(IntEnum):
    """HTTP response codes used by the Lambda proxy integration."""

    OK = 200
    BAD_REQUEST = 400
    FORBIDDEN = 403
    NOT_FOUND = 404
    INTERNAL_SERVER_ERROR = 500


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class ErrorResponse(StrictModel):
    error: str


class ChatRequest(StrictModel):
    question: str = Field(min_length=1, max_length=MAX_QUESTION_LENGTH)
    session_id: str | None = Field(
        default=None,
        alias="sessionId",
        min_length=1,
        max_length=MAX_SESSION_ID_LENGTH,
    )
    language: Literal["en", "es"] = "en"

    @field_validator("question")
    @classmethod
    def normalize_question(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Question must not be blank")
        return normalized


class FeedbackRequest(StrictModel):
    session_id: str = Field(alias="sessionId", min_length=1, max_length=MAX_SESSION_ID_LENGTH)
    message_id: str = Field(alias="messageId", min_length=1, max_length=64)
    feedback: Literal["positive", "negative"]


class RetrievedChunk(StrictModel):
    source: str
    score: float = Field(ge=0, le=1)
    content: str


class ChunkScore(StrictModel):
    source: str
    score: float
    chunk_text: str = Field(alias="chunkText")


class ChatLog(StrictModel):
    session_id: str = Field(alias="sessionId")
    timestamp: str
    user_id: str = Field(alias="userId")
    session_token_hash: str = Field(alias="sessionTokenHash")
    question: str
    answer: str
    sources: list[str]
    confidence: float
    chunk_scores: list[ChunkScore] = Field(alias="chunkScores")
    escalated: bool
    category: str = "general"
    language: Literal["en", "es"]
    created_at: str = Field(alias="createdAt")


class ChatResponse(StrictModel):
    answer: str
    sources: list[str]
    confidence: float
    session_id: str = Field(alias="sessionId")
    session_token: str = Field(alias="sessionToken")
    message_id: str = Field(alias="messageId")
    escalated: bool
    language: Literal["en", "es"]


class FeedbackResponse(StrictModel):
    status: Literal["ok"] = "ok"
    session_id: str = Field(alias="sessionId")
    message_id: str = Field(alias="messageId")
    feedback: Literal["positive", "negative"]


class HistoryTurn(StrictModel):
    question: str | None = None
    answer: str | None = None
    sources: list[str] | None = None
    confidence: float | None = None
    timestamp: str | None = None
    escalated: bool | None = None
    language: Literal["en", "es"] = "en"


class HistoryResponse(StrictModel):
    session_id: str = Field(alias="sessionId")
    history: list[HistoryTurn]


class ProxyResponse(StrictModel):
    status_code: int = Field(alias="statusCode")
    headers: dict[str, str]
    body: str


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _to_dynamodb(value: Any) -> Any:
    """Convert typed model data to DynamoDB-compatible values."""
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {key: _to_dynamodb(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_to_dynamodb(item) for item in value]
    return value


def api_response(status: HttpStatus, body: BaseModel | dict[str, Any]) -> dict[str, Any]:
    if isinstance(body, BaseModel):
        payload = body.model_dump(by_alias=True, mode="json", exclude_none=True)
    else:
        payload = body
    return ProxyResponse(
        statusCode=int(status),
        headers={
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
            "Vary": "Origin",
        },
        body=json.dumps(payload, ensure_ascii=False),
    ).model_dump(by_alias=True)


def _validation_error(error: ValidationError) -> ErrorResponse:
    first = error.errors(include_url=False)[0]
    location = ".".join(str(part) for part in first.get("loc", ()))
    message = first.get("msg", "Invalid request")
    return ErrorResponse(error=f"{location}: {message}" if location else message)


def _parse_body(event: dict[str, Any]) -> Any:
    return json.loads(event.get("body") or "{}")


def _request_header(event: dict[str, Any], name: str) -> str | None:
    expected = name.lower()
    for key, value in (event.get("headers") or {}).items():
        if key.lower() == expected and isinstance(value, str):
            return value
    return None


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _owns_session(session_id: str, token: str | None) -> bool:
    """Authorize a public caller without exposing history through a bare ID."""
    if not token:
        return False
    result = chat_table.query(
        KeyConditionExpression=Key("sessionId").eq(session_id),
        ProjectionExpression="sessionTokenHash",
        ScanIndexForward=True,
        Limit=1,
        ConsistentRead=True,
    )
    items = result.get("Items", [])
    expected = items[0].get("sessionTokenHash") if items else None
    return isinstance(expected, str) and hmac.compare_digest(expected, _token_hash(token))


@lru_cache(maxsize=1)
def get_prompt_template() -> str:
    """Fetch and cache the immutable Prompt Management template."""
    try:
        result = bedrock_agent.get_prompt(
            promptIdentifier=PROMPT_ID,
            promptVersion=PROMPT_VERSION,
        )
        for variant in result.get("variants", []):
            text = (
                (variant.get("templateConfiguration") or {})
                .get("text", {})
                .get("text")
            )
            if text:
                return text
        raise ValueError("Prompt version contains no text variant")
    except Exception as error:  # noqa: BLE001 - local version is a deployment-safe fallback
        print(f"Prompt Management lookup failed; using packaged prompt: {error}")
        return PROMPT_PATH.read_text(encoding="utf-8")


def _language_instruction(language: Literal["en", "es"]) -> str:
    if language == "es":
        return (
            "Respond only in natural Spanish. Translate headings, explanations, and "
            "list labels. Preserve official names, URLs, phone numbers, and document "
            "titles when translating them would reduce accuracy."
        )
    return "Respond in English."


def _retrieval_context(chunks: list[RetrievedChunk]) -> str:
    if not chunks:
        return "[No approved source excerpts were retrieved.]"

    sections = []
    for index, chunk in enumerate(chunks, start=1):
        # Prevent source text from closing the outer delimiter in the prompt.
        safe_content = chunk.content.replace("</approved_sources>", "&lt;/approved_sources&gt;")
        sections.append(
            f'<source index="{index}" uri="{chunk.source}">\n'
            f"{safe_content}\n"
            "</source>"
        )
    return "\n\n".join(sections)


def render_prompt(
    question: str,
    language: Literal["en", "es"],
    chunks: list[RetrievedChunk],
) -> str:
    """Render values as data; Jinja does not evaluate syntax inside those values."""
    template = jinja.from_string(get_prompt_template())
    return template.render(
        language_instruction=_language_instruction(language),
        retrieval_context=_retrieval_context(chunks),
        question=question,
    )


def retrieve_chunks(question: str) -> list[RetrievedChunk]:
    result = bedrock_retrieval.retrieve(
        knowledgeBaseId=KB_ID,
        retrievalQuery={"text": question},
        retrievalConfiguration={
            "vectorSearchConfiguration": {"numberOfResults": 5},
        },
    )
    chunks = []
    for item in result.get("retrievalResults", []) or []:
        chunks.append(RetrievedChunk(
            source=(item.get("location") or {}).get("s3Location", {}).get("uri", "unknown"),
            score=float(item.get("score", 0)),
            content=(item.get("content") or {}).get("text", ""),
        ))
    return chunks


def generate_answer(
    question: str,
    language: Literal["en", "es"],
    chunks: list[RetrievedChunk],
) -> tuple[str, str]:
    """Generate from the same chunks used for confidence and citations."""
    result = bedrock_runtime.converse(
        modelId=MODEL_ARN,
        messages=[{
            "role": "user",
            "content": [{"text": render_prompt(question, language, chunks)}],
        }],
        inferenceConfig={
            "maxTokens": 2000,
            "temperature": 0.1,
        },
        guardrailConfig={
            "guardrailIdentifier": GUARDRAIL_ID,
            "guardrailVersion": GUARDRAIL_VERSION,
            "trace": "enabled",
        },
    )
    content = ((result.get("output") or {}).get("message") or {}).get("content", [])
    answer = "\n".join(block["text"] for block in content if block.get("text")).strip()
    if not answer:
        answer = (
            "No pude encontrar una respuesta respaldada por los recursos aprobados."
            if language == "es"
            else "I could not find an answer supported by the approved resources."
        )
    return answer, result.get("stopReason", "")


def check_escalation(question: str, answer: str, confidence: float) -> tuple[bool, str]:
    """Return whether staff should review this turn and the audit reason."""
    combined = f"{question} {answer}".lower()
    for keyword in SAFETY_KEYWORDS:
        if keyword.lower() in combined:
            return True, f'Safety keyword detected: "{keyword}"'
    if confidence < CONFIDENCE_THRESHOLD:
        return True, f"Low confidence: {confidence:.2f}"
    return False, ""


def trigger_escalation(payload: dict[str, Any]) -> None:
    """Invoke the Escalation Router asynchronously on a best-effort basis."""
    if not ESCALATION_FUNCTION_ARN:
        return
    try:
        lambda_client.invoke(
            FunctionName=ESCALATION_FUNCTION_ARN,
            InvocationType="Event",
            Payload=json.dumps(payload).encode("utf-8"),
        )
    except Exception as error:  # noqa: BLE001 - answering should not depend on alert delivery
        print(f"Failed to trigger escalation: {error}")


def handle_chat(event: dict[str, Any]) -> dict[str, Any]:
    try:
        request = ChatRequest.model_validate(_parse_body(event))
    except json.JSONDecodeError:
        return api_response(
            HttpStatus.BAD_REQUEST,
            ErrorResponse(error="Request body must be valid JSON"),
        )
    except ValidationError as error:
        return api_response(HttpStatus.BAD_REQUEST, _validation_error(error))

    authz = (event.get("requestContext") or {}).get("authorizer") or {}
    user_id = (authz.get("claims") or {}).get("sub", "anonymous")
    if request.session_id:
        session_token = _request_header(event, "X-Session-Token")
        if not _owns_session(request.session_id, session_token):
            return api_response(
                HttpStatus.FORBIDDEN,
                ErrorResponse(error="Invalid session credentials"),
            )
        session_id = request.session_id
    else:
        session_id = str(uuid.uuid4())
        session_token = secrets.token_urlsafe(32)
    timestamp = _now()

    chunks = retrieve_chunks(request.question)
    answer, stop_reason = generate_answer(request.question, request.language, chunks)

    sources = list(dict.fromkeys(chunk.source for chunk in chunks if chunk.source != "unknown"))
    chunk_scores = [
        ChunkScore(
            source=chunk.source,
            score=chunk.score,
            chunkText=chunk.content[:200],
        )
        for chunk in chunks
    ]
    confidence = (
        sum(chunk.score for chunk in chunks) / len(chunks)
        if chunks
        else 0.3
    )

    escalate, reason = check_escalation(request.question, answer, confidence)
    if stop_reason == "guardrail_intervened":
        escalate = True
        reason = "Bedrock Guardrail intervened"

    if escalate:
        trigger_escalation({
            "sessionId": session_id,
            "userId": user_id,
            "question": request.question,
            "answer": answer,
            "reason": reason,
            "confidence": confidence,
            "language": request.language,
        })

    log = ChatLog(
        sessionId=session_id,
        timestamp=timestamp,
        userId=user_id,
        sessionTokenHash=_token_hash(session_token),
        question=request.question,
        answer=answer,
        sources=sources,
        confidence=confidence,
        chunkScores=chunk_scores,
        escalated=escalate,
        language=request.language,
        createdAt=timestamp,
    )
    chat_table.put_item(Item=_to_dynamodb(log.model_dump(by_alias=True)))

    return api_response(
        HttpStatus.OK,
        ChatResponse(
            answer=answer,
            sources=sources,
            confidence=confidence,
            sessionId=session_id,
            sessionToken=session_token,
            messageId=timestamp,
            escalated=escalate,
            language=request.language,
        ),
    )


def record_feedback(event: dict[str, Any]) -> dict[str, Any]:
    """Attach an idempotent thumbs-up/down rating to an existing chat turn."""
    try:
        request = FeedbackRequest.model_validate(_parse_body(event))
    except json.JSONDecodeError:
        return api_response(
            HttpStatus.BAD_REQUEST,
            ErrorResponse(error="Request body must be valid JSON"),
        )
    except ValidationError as error:
        return api_response(HttpStatus.BAD_REQUEST, _validation_error(error))

    if not _owns_session(
        request.session_id,
        _request_header(event, "X-Session-Token"),
    ):
        return api_response(
            HttpStatus.FORBIDDEN,
            ErrorResponse(error="Invalid session credentials"),
        )

    try:
        chat_table.update_item(
            Key={"sessionId": request.session_id, "timestamp": request.message_id},
            UpdateExpression="SET feedback = :f",
            ConditionExpression="attribute_exists(sessionId)",
            ExpressionAttributeValues={":f": request.feedback},
        )
    except ddb.meta.client.exceptions.ConditionalCheckFailedException:
        return api_response(
            HttpStatus.NOT_FOUND,
            ErrorResponse(error="Conversation turn not found"),
        )

    return api_response(
        HttpStatus.OK,
        FeedbackResponse(
            sessionId=request.session_id,
            messageId=request.message_id,
            feedback=request.feedback,
        ),
    )


def get_history(event: dict[str, Any]) -> dict[str, Any]:
    session_id = (event.get("pathParameters") or {}).get("sessionId")
    if not isinstance(session_id, str) or not session_id:
        return api_response(
            HttpStatus.BAD_REQUEST,
            ErrorResponse(error="sessionId is required"),
        )
    if len(session_id) > MAX_SESSION_ID_LENGTH:
        return api_response(
            HttpStatus.BAD_REQUEST,
            ErrorResponse(error=f"sessionId must be at most {MAX_SESSION_ID_LENGTH} characters"),
        )

    if not _owns_session(session_id, _request_header(event, "X-Session-Token")):
        return api_response(
            HttpStatus.FORBIDDEN,
            ErrorResponse(error="Invalid session credentials"),
        )

    result = chat_table.query(
        KeyConditionExpression=Key("sessionId").eq(session_id),
        ScanIndexForward=True,
    )
    history = [
        HistoryTurn(
            question=item.get("question"),
            answer=item.get("answer"),
            sources=item.get("sources"),
            confidence=float(item["confidence"]) if item.get("confidence") is not None else None,
            timestamp=item.get("timestamp"),
            escalated=item.get("escalated"),
            language=item.get("language", "en"),
        )
        for item in result.get("Items", [])
    ]
    return api_response(
        HttpStatus.OK,
        HistoryResponse(sessionId=session_id, history=history),
    )


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    http_method = event.get("httpMethod")
    resource = event.get("resource") or ""

    try:
        if http_method == "GET" and "history" in resource:
            return get_history(event)
        if http_method == "POST" and "feedback" in resource:
            return record_feedback(event)
        if http_method == "POST":
            return handle_chat(event)
        return api_response(
            HttpStatus.BAD_REQUEST,
            ErrorResponse(error="Invalid route"),
        )
    except Exception as error:  # noqa: BLE001 - avoid leaking implementation details
        print(f"Chat handler error: {error}")
        return api_response(
            HttpStatus.INTERNAL_SERVER_ERROR,
            ErrorResponse(error="Internal server error"),
        )
