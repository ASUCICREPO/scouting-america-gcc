"""Append new chat turns to the object-locked S3 audit archive."""

import hashlib
import json
import os
from decimal import Decimal
from typing import Any

import boto3
from boto3.dynamodb.types import TypeDeserializer

s3 = boto3.client("s3")
ARCHIVE_BUCKET = os.environ["ARCHIVE_BUCKET"]
deserializer = TypeDeserializer()


def _json_default(value: Any) -> int | float:
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    raise TypeError(f"Cannot serialize {type(value).__name__}")


def _deserialize(image: dict[str, Any]) -> dict[str, Any]:
    return {key: deserializer.deserialize(value) for key, value in image.items()}


def _archive(record: dict[str, Any]) -> None:
    # Feedback updates remain in DynamoDB; the immutable archive captures the
    # original answer as delivered to the user.
    if record.get("eventName") != "INSERT":
        return

    image = ((record.get("dynamodb") or {}).get("NewImage") or {})
    item = _deserialize(image)
    session_id = str(item["sessionId"])
    timestamp = str(item["timestamp"])
    date = timestamp[:10] if len(timestamp) >= 10 else "unknown-date"
    year, month, day = (date.split("-") + ["unknown", "unknown", "unknown"])[:3]
    session_hash = hashlib.sha256(session_id.encode("utf-8")).hexdigest()
    event_id = record.get("eventID") or hashlib.sha256(
        f"{session_id}:{timestamp}".encode("utf-8")
    ).hexdigest()
    key = (
        f"chat/year={year}/month={month}/day={day}/"
        f"session={session_hash}/{event_id}.json"
    )

    s3.put_object(
        Bucket=ARCHIVE_BUCKET,
        Key=key,
        Body=json.dumps(item, default=_json_default, ensure_ascii=False).encode("utf-8"),
        ContentType="application/json",
    )


def handler(event: dict[str, Any], _context: Any) -> dict[str, list[dict[str, str]]]:
    failures = []
    for record in event.get("Records", []):
        try:
            _archive(record)
        except Exception as error:  # noqa: BLE001 - return failed stream item for retry
            print(f"Failed to archive stream record {record.get('eventID')}: {error}")
            failures.append({"itemIdentifier": record.get("eventID", "unknown")})
    return {"batchItemFailures": failures}
