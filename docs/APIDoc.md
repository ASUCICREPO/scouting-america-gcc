# Grand Canyon Council Scout AI APIs

This reference documents the two REST APIs deployed by the `GrandCanyonCouncilChatbot` CDK stack:

- A public API for chat, history, and response feedback
- A Cognito-protected API for dashboard analytics and document management

The APIs use API Gateway Lambda proxy integrations. Examples below show the JSON body received by an HTTP client, not the internal Lambda proxy envelope.

## Base URLs

Each deployment has separate CloudFormation outputs:

```text
CHAT_API_URL=<ChatApiUrl output without trailing slash>
DASHBOARD_API_URL=<DashboardApiUrl output without trailing slash>
```

Both normally follow this pattern:

```text
https://API_ID.execute-api.REGION.amazonaws.com/prod
```

Do not assume the public and dashboard API IDs are the same.

## Common Headers

| Header | Public chat API | Dashboard API | Description |
| --- | --- | --- | --- |
| `Content-Type: application/json` | Required for POST | Required for POST | JSON request body |
| `X-Session-Token` | Required after the first turn | Not used | Anonymous bearer credential returned when a chat is created |
| `Authorization: ID_TOKEN` | Not used | Required | Raw Cognito ID token containing the `admin` group |

The public and admin applications use separate CloudFront distributions. Public API CORS is limited to the public distribution; dashboard API and upload-bucket CORS are limited to the admin distribution.

## Public Chat API

Public routes do not require a user account. A new chat receives a high-entropy anonymous `sessionToken`; continuing a session, loading its history, and recording feedback require that token in `X-Session-Token`. A bare session ID is not sufficient.

### POST /chat

Generate a grounded English or Spanish response and persist the turn.

#### Request

```json
{
  "question": "What can you tell me about Camp Geronimo?",
  "sessionId": "optional-existing-session-uuid",
  "language": "en"
}
```

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `question` | string | Yes | Non-empty after trimming; maximum 4,000 characters |
| `sessionId` | string | No | Continue an existing session; a UUID is generated when omitted |
| `language` | string | No | `en` or `es`; defaults to `en` |

When `sessionId` is supplied, also send the `sessionToken` returned when the session was created:

```http
X-Session-Token: ANONYMOUS_SESSION_TOKEN
```

Spanish example:

```json
{
  "question": "¿Qué me puedes contar sobre Camp Geronimo?",
  "language": "es"
}
```

#### Success Response

```json
{
  "answer": "## Camp Geronimo\n\n...",
  "sources": [
    "s3://demo-gcc-knowledge-base-data/documents/Camp Geronimo Map.pdf"
  ],
  "confidence": 0.8234,
  "sessionId": "5901a24e-d15b-4f10-8c1f-example",
  "sessionToken": "high-entropy-anonymous-bearer-token",
  "messageId": "2026-07-15T16:42:18.123Z",
  "escalated": false,
  "language": "en"
}
```

| Field | Type | Description |
| --- | --- | --- |
| `answer` | string | Markdown-formatted model response |
| `sources` | string[] | Unique S3 URIs for the exact chunks used to generate the answer |
| `confidence` | number | Average of up to five retrieval scores; `0.3` fallback if unavailable |
| `sessionId` | string | Conversation identifier |
| `sessionToken` | string | Anonymous bearer credential; persist securely with the local session |
| `messageId` | string | Turn identifier and DynamoDB sort key; use for feedback |
| `escalated` | boolean | Whether safety wording or low confidence triggered escalation |
| `language` | `en` or `es` | Language contract used for generation |

#### Errors

| Status | Condition | Example body |
| --- | --- | --- |
| `400` | Invalid JSON | `{"error":"Request body must be valid JSON"}` |
| `400` | Missing/empty question | `{"error":"Question is required and must be a non-empty string"}` |
| `400` | Question over 4,000 characters | `{"error":"Question exceeds the maximum length of 4000 characters"}` |
| `400` | Non-string session ID | `{"error":"sessionId must be a string"}` |
| `400` | Unsupported language | `{"error":"language must be 'en' or 'es'"}` |
| `403` | Missing or invalid session credential on an existing session | `{"error":"Invalid session credentials"}` |
| `500` | Unhandled Bedrock, DynamoDB, or internal error | `{"error":"Internal server error"}` |

### GET /chat/history/{sessionId}

Return all persisted turns for a session in chronological order.

Required header:

```http
X-Session-Token: ANONYMOUS_SESSION_TOKEN
```

#### Response

```json
{
  "sessionId": "5901a24e-d15b-4f10-8c1f-example",
  "history": [
    {
      "question": "What can you tell me about Camp Geronimo?",
      "answer": "## Camp Geronimo\n\n...",
      "sources": ["s3://bucket/documents/example.pdf"],
      "confidence": 0.8234,
      "timestamp": "2026-07-15T16:42:18.123Z",
      "escalated": false,
      "language": "en"
    }
  ]
}
```

An unknown session or invalid bearer credential returns `403` without revealing whether the session exists.

### POST /chat/feedback

Attach or replace a thumbs-up/down rating on a specific chat turn.

Required header:

```http
X-Session-Token: ANONYMOUS_SESSION_TOKEN
```

#### Request

```json
{
  "sessionId": "5901a24e-d15b-4f10-8c1f-example",
  "messageId": "2026-07-15T16:42:18.123Z",
  "feedback": "positive"
}
```

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `sessionId` | string | Yes | Non-empty |
| `messageId` | string | Yes | Exact `messageId` returned by `POST /chat` |
| `feedback` | string | Yes | `positive` or `negative` |

#### Success Response

```json
{
  "status": "ok",
  "sessionId": "5901a24e-d15b-4f10-8c1f-example",
  "messageId": "2026-07-15T16:42:18.123Z",
  "feedback": "positive"
}
```

The operation is idempotent for a given value and can replace the previous rating.

| Status | Condition |
| --- | --- |
| `400` | Invalid JSON, missing IDs, or unsupported feedback value |
| `403` | Missing or invalid anonymous session credential |
| `404` | The session/message key does not identify an existing turn |
| `500` | Internal error |

## Dashboard Authentication

All dashboard routes require two checks:

1. API Gateway validates the Cognito ID token.
2. The dashboard Lambda verifies that the token's `cognito:groups` claim contains `admin`.

Send the raw ID token:

```http
Authorization: eyJraWQiOiJ...
```

The current frontend does not prefix the value with `Bearer`.

Common auth errors:

```json
{"message":"Unauthorized: No authentication claims found"}
```

```json
{"message":"Forbidden: Admin group membership required"}
```

API Gateway can return its own unauthorized response before the Lambda runs.

## Dashboard Analytics API

### GET /dashboard/summary

Return a 90-day aggregate summary plus all recorded escalation and document-processing event counts.

```json
{
  "totalChats": 125,
  "totalSessions": 48,
  "totalUsers": 0,
  "avgConfidence": 0.7812,
  "avgSessionLength": "3m 12s",
  "avgSessionMs": 192000,
  "totalEscalations": 4,
  "escalationRate": 3.2,
  "totalDocuments": 57,
  "satisfactionRate": 86.67,
  "positiveCount": 26,
  "negativeCount": 4,
  "totalFeedback": 30
}
```

`feedbackNote` is included when there are no ratings.

### GET /dashboard/conversations

Return conversation-turn volume grouped by day, week, or month for records from the last 90 days.

| Query | Required | Default | Values |
| --- | --- | --- | --- |
| `period` | No | `day` | `day`, `week`, `month` |

```json
{
  "period": "day",
  "data": [
    {"date": "2026-07-14", "count": 18},
    {"date": "2026-07-15", "count": 27}
  ],
  "total": 45
}
```

### GET /dashboard/faq

Return the most frequently normalized questions from the last 30 days.

| Query | Required | Default | Limit |
| --- | --- | --- | --- |
| `limit` | No | `5` | Maximum 100 |

```json
{
  "faq": [
    {
      "question": "What can you tell me about Camp Geronimo?",
      "count": 12,
      "avgConfidence": 0.8123,
      "escalatedCount": 1,
      "lastAsked": "2026-07-15T16:42:18.123Z"
    }
  ],
  "totalUnique": 21
}
```

### GET /dashboard/faq/all

Return paginated FAQ groups calculated from the last 90 days.

| Query | Required | Default | Limit |
| --- | --- | --- | --- |
| `limit` | No | `30` | Maximum 100 |
| `offset` | No | `0` | Zero-based offset |

```json
{
  "faq": [],
  "total": 0,
  "offset": 0,
  "limit": 30
}
```

### GET /dashboard/confidence

Return confidence distribution, grouped trend, and descriptive statistics for the last 90 days.

| Query | Required | Default | Values |
| --- | --- | --- | --- |
| `period` | No | `day` | `day`, `week`, `month` |

```json
{
  "distribution": {
    "veryLow": 1,
    "low": 2,
    "medium": 5,
    "high": 20,
    "veryHigh": 10
  },
  "trend": [
    {"date": "2026-07-15", "avgConfidence": 0.7912, "count": 12}
  ],
  "stats": {
    "total": 38,
    "average": 0.7711,
    "median": 0.79,
    "min": 0.14,
    "max": 0.97
  }
}
```

Distribution buckets are `<0.2`, `<0.4`, `<0.6`, `<0.8`, and `>=0.8`.

### GET /dashboard/escalations

Return escalation events grouped by reason.

```json
{
  "escalations": [
    {
      "reason": "Low confidence: 0.52",
      "count": 3,
      "lastOccurred": "2026-07-15T16:42:18.123Z",
      "avgConfidence": 0.52
    }
  ],
  "total": 3
}
```

### GET /dashboard/negative-feedback

Return negatively rated turns from the last 90 days, newest first.

| Query | Required | Default | Limit |
| --- | --- | --- | --- |
| `limit` | No | `50` | Maximum 200 |
| `offset` | No | `0` | Zero-based offset |

```json
{
  "total": 1,
  "offset": 0,
  "limit": 50,
  "conversations": [
    {
      "sessionId": "session-id",
      "timestamp": "2026-07-15T16:42:18.123Z",
      "userId": "anonymous",
      "question": "Question",
      "answer": "Answer",
      "confidence": 0.65,
      "sources": [],
      "escalated": true,
      "language": "en"
    }
  ]
}
```

### GET /dashboard/feedback

Return all rated turns from the last 90 days, newest first.

| Query | Required | Default | Values/limit |
| --- | --- | --- | --- |
| `filter` | No | `all` | `all`, `positive`, `negative` |
| `limit` | No | `50` | Maximum 200 |
| `offset` | No | `0` | Zero-based offset |

```json
{
  "total": 1,
  "offset": 0,
  "limit": 50,
  "filter": "all",
  "conversations": [
    {
      "sessionId": "session-id",
      "messageId": "2026-07-15T16:42:18.123Z",
      "timestamp": "2026-07-15T16:42:18.123Z",
      "userId": "anonymous",
      "question": "Question",
      "answer": "Answer",
      "feedback": "positive",
      "confidence": 0.81,
      "sources": [],
      "escalated": false,
      "language": "es"
    }
  ]
}
```

### GET /dashboard/session

Return a complete session transcript so the dashboard can highlight the rated turn.

| Query | Type | Required |
| --- | --- | --- |
| `sessionId` | string | Yes |

```json
{
  "sessionId": "session-id",
  "turns": [
    {
      "messageId": "2026-07-15T16:42:18.123Z",
      "timestamp": "2026-07-15T16:42:18.123Z",
      "question": "Question",
      "answer": "Answer",
      "feedback": "positive",
      "confidence": 0.81,
      "sources": [],
      "escalated": false,
      "language": "en"
    }
  ],
  "total": 1
}
```

A missing `sessionId` returns `400`.

## Dashboard Document API

All object operations are restricted to keys below `uploads/`.

### GET /dashboard/documents

List uploaded documents and inferred ingestion status.

```json
{
  "documents": [
    {
      "key": "uploads/Camp Forms/example.pdf",
      "fileName": "Camp Forms/example.pdf",
      "fileSize": 245760,
      "lastModified": "2026-07-15T16:42:18Z",
      "status": "ready"
    }
  ],
  "total": 1,
  "indexing": false
}
```

Status is one of `ready`, `indexing`, `pending`, or `failed`.

### POST /dashboard/documents/upload

Create a five-minute presigned S3 POST policy. The API does not receive the file bytes.

#### Request

```json
{
  "relativePath": "Camp Forms/example.pdf",
  "contentType": "application/pdf"
}
```

`fileName` is accepted as a legacy alternative to `relativePath`.

Allowed content types:

```text
application/pdf
application/vnd.openxmlformats-officedocument.wordprocessingml.document
application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
application/vnd.openxmlformats-officedocument.presentationml.presentation
application/msword
application/vnd.ms-excel
text/csv
text/plain
image/svg+xml
image/png
image/jpeg
```

#### Response

```json
{
  "url": "https://presigned-s3-url.example/...",
  "fields": {
    "Content-Type": "application/pdf",
    "key": "uploads/Camp Forms/example.pdf",
    "policy": "...",
    "x-amz-algorithm": "...",
    "x-amz-credential": "...",
    "x-amz-date": "...",
    "x-amz-signature": "..."
  },
  "key": "uploads/Camp Forms/example.pdf",
  "maxSizeBytes": 26214400
}
```

Submit every returned field as multipart form data, followed by the file field. The signed policy enforces the exact content type and a file size from 1 byte through 25 MB; S3 rejects uploads outside that range.

| Status | Condition |
| --- | --- |
| `400` | Invalid JSON, missing path, invalid sanitized path, or unsupported content type |
| `401/403` | Invalid auth or non-admin |
| `500` | Internal error |

### GET /dashboard/documents/download

Return a five-minute presigned S3 GET URL.

| Query | Type | Required | Rule |
| --- | --- | --- | --- |
| `key` | string | Yes | Must begin with `uploads/` and contain no traversal/control characters |

```json
{
  "url": "https://presigned-s3-url.example/...",
  "key": "uploads/Camp Forms/example.pdf"
}
```

### DELETE /dashboard/documents

Delete the raw upload and matching `documents/` knowledge-base object, then request a new Bedrock ingestion job.

| Query | Type | Required | Rule |
| --- | --- | --- | --- |
| `key` | string | Yes | Must begin with `uploads/` and pass path validation |

```json
{
  "status": "deleted",
  "key": "uploads/Camp Forms/example.pdf"
}
```

`400` indicates a missing key; `403` indicates an invalid key.

## Rate Limits

| API | Steady rate | Burst |
| --- | --- | --- |
| Public chat API | 100 requests/second | 200 |
| Dashboard API | 50 requests/second | 100 |

These are API Gateway stage throttles, not guaranteed per-user quotas. API Gateway can return `429 Too Many Requests`. AWS account-level quotas can impose additional limits.

## Common Status Codes

| Status | Meaning |
| --- | --- |
| `200` | Successful JSON response |
| `204` | CORS preflight handled by the dashboard Lambda when invoked |
| `400` | Invalid request body, field, or query parameter |
| `401` | Missing, invalid, or expired Cognito authentication |
| `403` | Authenticated caller is not an admin, or document key is invalid |
| `404` | Route/turn not found |
| `405` | Unsupported dashboard HTTP method |
| `429` | API Gateway throttle exceeded |
| `500` | Internal handler or downstream AWS service error |

## Client Examples

### TypeScript Public Chat

```typescript
const response = await fetch(`${CHAT_API_URL}/chat`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    question: "¿Qué me puedes contar sobre Camp Geronimo?",
    language: "es",
  }),
});

if (!response.ok) throw new Error(`Chat failed: ${response.status}`);
const turn = await response.json();
```

### TypeScript Dashboard Summary

```typescript
const response = await fetch(`${DASHBOARD_API_URL}/dashboard/summary`, {
  headers: { Authorization: cognitoIdToken },
});

if (!response.ok) throw new Error(`Dashboard failed: ${response.status}`);
const summary = await response.json();
```

### Python Public Chat

```python
import requests

response = requests.post(
    f"{CHAT_API_URL}/chat",
    json={
        "question": "What training do I need as a new volunteer?",
        "language": "en",
    },
    timeout=35,
)
response.raise_for_status()
print(response.json()["answer"])
```

### cURL Feedback

```bash
curl -sS -X POST "$CHAT_API_URL/chat/feedback" \
  -H 'Content-Type: application/json' \
  -d '{
    "sessionId": "SESSION_ID",
    "messageId": "MESSAGE_ID",
    "feedback": "positive"
  }'
```

## DynamoDB Records

### Chat Logs Table

Primary key: `sessionId` + `timestamp`.

Representative item:

```json
{
  "sessionId": "session-id",
  "timestamp": "2026-07-15T16:42:18.123Z",
  "userId": "anonymous",
  "question": "Question",
  "answer": "Answer",
  "sources": [],
  "confidence": 0.81,
  "chunkScores": [],
  "escalated": false,
  "category": "general",
  "language": "en",
  "feedback": "positive",
  "createdAt": "2026-07-15T16:42:18.123Z"
}
```

### Analytics Logs Table

Primary key: `eventType` + `timestamp`. Current values of `eventType` are `escalation` and `document_processing`.

## API Change Checklist

- Update the API Gateway construct and Lambda route map together.
- Keep frontend API wrappers and TypeScript interfaces aligned.
- Preserve Cognito authorization on every dashboard method.
- Add bounded validation for public input.
- Add or update Jest/Python tests.
- Update this document and the architecture guide.

## Related Documentation

- [Architecture Deep Dive](./architectureDeepDive.md)
- [Development Guide](./developmentGuide.md)
- [Modification Guide](./modificationGuide.md)
- [Deployment Guide](./deploymentGuide.md)
