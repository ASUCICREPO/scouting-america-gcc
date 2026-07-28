"""Document ingestion worker — receives S3 notifications through SQS.

Copies the uploaded file into the knowledge-base bucket (which the Bedrock KB
data source reads) and starts an ingestion job. Bedrock handles PDF parsing,
chunking, and embedding natively. SQS retries transient failures and bounds
concurrency before this worker.
"""

import hashlib
import json
import os
import time
import urllib.parse
from datetime import datetime, timezone

import boto3

s3 = boto3.client("s3")
bedrock_agent = boto3.client("bedrock-agent")
dynamodb = boto3.resource("dynamodb")

KNOWLEDGE_BASE_BUCKET = os.environ["KNOWLEDGE_BASE_BUCKET"]
ANALYTICS_TABLE = os.environ["ANALYTICS_TABLE"]
KNOWLEDGE_BASE_ID = os.environ["KNOWLEDGE_BASE_ID"]
DATA_SOURCE_ID = os.environ["DATA_SOURCE_ID"]

analytics_table = dynamodb.Table(ANALYTICS_TABLE)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _s3_records(event):
    """Yield S3 records from the SQS envelope (and legacy direct events)."""
    for record in event.get("Records", []):
        event_source = record.get("eventSource") or record.get("EventSource")
        if event_source == "aws:sqs":
            notification = json.loads(record.get("body") or "{}")
            for s3_record in notification.get("Records", []):
                yield s3_record
        else:
            yield record


def handler(event, _context):
    for record in _s3_records(event):
        start_time = time.time()
        bucket = record["s3"]["bucket"]["name"]
        key = urllib.parse.unquote_plus(record["s3"]["object"]["key"])
        file_size = record["s3"]["object"].get("size", 0)
        etag = record["s3"]["object"].get("eTag", "")
        version_id = record["s3"]["object"].get("versionId", "")

        print(f"Processing file: s3://{bucket}/{key} ({file_size} bytes)")

        # Derive the filename by stripping the uploads/ prefix
        file_name = key[len("uploads/"):] if key.startswith("uploads/") else key

        # Copy from the document store to the KB bucket (KB data source reads documents/)
        s3.copy_object(
            CopySource={"Bucket": bucket, "Key": key},
            Bucket=KNOWLEDGE_BASE_BUCKET,
            Key=f"documents/{file_name}",
        )
        print(f"Copied to s3://{KNOWLEDGE_BASE_BUCKET}/documents/{file_name}")

        # Trigger Bedrock KB ingestion (native parsing/chunking/embedding)
        bedrock_agent.start_ingestion_job(
            knowledgeBaseId=KNOWLEDGE_BASE_ID,
            dataSourceId=DATA_SOURCE_ID,
            # Retrying the same SQS message cannot start duplicate jobs.
            clientToken=hashlib.sha256(
                f"{bucket}:{key}:{etag}:{version_id}".encode("utf-8")
            ).hexdigest(),
        )
        print("Started Bedrock Knowledge Base ingestion job")

        processing_time_ms = int((time.time() - start_time) * 1000)
        analytics_table.put_item(
            Item={
                "eventType": "document_processing",
                "timestamp": _now_iso(),
                "metadata": {
                    "fileName": file_name,
                    "fileSize": file_size,
                    "processingTimeMs": processing_time_ms,
                    "processedAt": _now_iso(),
                },
            }
        )
        print(f"Done ({processing_time_ms}ms)")
