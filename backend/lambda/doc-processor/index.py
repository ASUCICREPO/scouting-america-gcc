"""Bounded document validation, copy, and Bedrock ingestion coordination.

S3 object notifications arrive through a standard SQS queue because S3 cannot
target FIFO queues directly. Each object is validated independently and copied
to the knowledge-base source prefix. Once every object in a browser upload
batch has reached a terminal state, one FIFO message serializes the Bedrock
``StartIngestionJob`` call for the shared data source.
"""

import hashlib
import io
import json
import os
import re
import time
import urllib.parse
import zipfile
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError

s3 = boto3.client("s3")
bedrock_agent = boto3.client("bedrock-agent")
sqs = boto3.client("sqs")
dynamodb = boto3.resource("dynamodb")

KNOWLEDGE_BASE_BUCKET = os.environ["KNOWLEDGE_BASE_BUCKET"]
ANALYTICS_TABLE = os.environ["ANALYTICS_TABLE"]
DOCUMENT_BATCHES_TABLE = os.environ["DOCUMENT_BATCHES_TABLE"]
KNOWLEDGE_BASE_ID = os.environ["KNOWLEDGE_BASE_ID"]
DATA_SOURCE_ID = os.environ["DATA_SOURCE_ID"]
SYNC_QUEUE_URL = os.environ["SYNC_QUEUE_URL"]

analytics_table = dynamodb.Table(ANALYTICS_TABLE)
document_batches_table = dynamodb.Table(DOCUMENT_BATCHES_TABLE)

# Keep worker-side validation aligned with Bedrock and the upload signer.
MAX_FILE_SIZE_BYTES = 50_000_000
MAX_ARCHIVE_ENTRIES = 5_000
MAX_UNCOMPRESSED_ARCHIVE_BYTES = 100 * 1024 * 1024
UPLOAD_BATCH_ID_RE = re.compile(r"^[a-f0-9]{32}$")

ALLOWED_FILE_TYPES = {
    ".csv": ("text/csv", MAX_FILE_SIZE_BYTES, "text"),
    ".docx": (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        MAX_FILE_SIZE_BYTES,
        "docx",
    ),
    ".pdf": ("application/pdf", MAX_FILE_SIZE_BYTES, "pdf"),
    ".txt": ("text/plain", MAX_FILE_SIZE_BYTES, "text"),
    ".xlsx": (
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        MAX_FILE_SIZE_BYTES,
        "xlsx",
    ),
}


class RejectedUpload(ValueError):
    """A permanent validation failure that should not be retried."""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _object_token(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def _extension(key: str) -> str:
    name = key.rsplit("/", 1)[-1]
    return f".{name.rsplit('.', 1)[-1].lower()}" if "." in name else ""


def _valid_upload_key(key: str) -> bool:
    if not isinstance(key, str) or not key.startswith("uploads/"):
        return False
    relative = key[len("uploads/"):]
    if not relative or len(relative) > 500 or ".." in relative or "//" in relative:
        return False
    if re.search(r"[\x00-\x1f\x7f]", relative):
        return False
    return all(segment and segment == segment.strip() and segment != "." for segment in relative.split("/"))


def _copy_source(bucket: str, key: str, version_id: str | None):
    source = {"Bucket": bucket, "Key": key}
    if version_id:
        source["VersionId"] = version_id
    return source


def _read_object(bucket: str, key: str, version_id: str | None) -> bytes:
    request = {"Bucket": bucket, "Key": key}
    if version_id:
        request["VersionId"] = version_id
    response = s3.get_object(**request)
    data = response["Body"].read(MAX_FILE_SIZE_BYTES + 1)
    if len(data) > MAX_FILE_SIZE_BYTES:
        raise RejectedUpload("object exceeds the application size limit")
    return data


def _validate_zip(data: bytes, required_member: str):
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            members = archive.infolist()
            if len(members) > MAX_ARCHIVE_ENTRIES:
                raise RejectedUpload("office archive contains too many entries")
            if sum(member.file_size for member in members) > MAX_UNCOMPRESSED_ARCHIVE_BYTES:
                raise RejectedUpload("office archive expands beyond the safe limit")
            names = {member.filename for member in members}
            if any(name.startswith("/") or ".." in name.split("/") for name in names):
                raise RejectedUpload("office archive contains an unsafe path")
            if "[Content_Types].xml" not in names or required_member not in names:
                raise RejectedUpload("office archive does not match its extension")
    except zipfile.BadZipFile as err:
        raise RejectedUpload("office document is not a valid ZIP container") from err


def _validate_content(data: bytes, kind: str):
    if kind == "pdf" and not data.startswith(b"%PDF-"):
        raise RejectedUpload("PDF signature is missing")
    if kind == "text":
        if b"\x00" in data:
            raise RejectedUpload("text document contains binary null bytes")
        try:
            data.decode("utf-8-sig")
        except UnicodeDecodeError as err:
            raise RejectedUpload("text document must be UTF-8 encoded") from err
    if kind == "docx":
        _validate_zip(data, "word/document.xml")
    if kind == "xlsx":
        _validate_zip(data, "xl/workbook.xml")


def _validate_object(bucket: str, key: str, version_id: str | None):
    if not _valid_upload_key(key):
        raise RejectedUpload("object key is outside the approved uploads prefix")

    exact_request = {"Bucket": bucket, "Key": key}
    if version_id:
        exact_request["VersionId"] = version_id
    head = s3.head_object(**exact_request)

    # Do not let an out-of-order notification overwrite a newer version of the
    # same key in the knowledge-base bucket.
    latest = s3.head_object(Bucket=bucket, Key=key)
    if version_id and latest.get("VersionId") and latest["VersionId"] != version_id:
        raise RejectedUpload("object version was superseded by a newer upload")

    batch_id = (head.get("Metadata") or {}).get("upload-batch-id", "")
    if not UPLOAD_BATCH_ID_RE.fullmatch(batch_id):
        raise RejectedUpload("signed upload batch metadata is missing")

    extension = _extension(key)
    type_config = ALLOWED_FILE_TYPES.get(extension)
    if not type_config:
        raise RejectedUpload("file extension is not allowed")
    expected_content_type, max_size, kind = type_config
    if head.get("ContentType") != expected_content_type:
        raise RejectedUpload("stored content type does not match the file extension")
    size = int(head.get("ContentLength") or 0)
    if size < 1 or size > max_size:
        raise RejectedUpload("stored object size is outside the allowed range")

    data = _read_object(bucket, key, version_id)
    if len(data) != size:
        raise RejectedUpload("stored object size changed during validation")
    _validate_content(data, kind)
    return batch_id, size, expected_content_type


def _queue_sync(batch_id: str):
    sqs.send_message(
        QueueUrl=SYNC_QUEUE_URL,
        MessageBody=json.dumps({"type": "document_batch_sync", "batchId": batch_id}),
        MessageGroupId=KNOWLEDGE_BASE_ID,
        MessageDeduplicationId=hashlib.sha256(f"batch:{batch_id}".encode("utf-8")).hexdigest(),
    )


def _finish_batch_if_ready(batch):
    processed = set(batch.get("processedTokens") or [])
    expected_count = int(batch.get("expectedCount") or 0)
    if len(processed) < expected_count or batch.get("status") != "uploading":
        return

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
                ":completed_at": _now_iso(),
            },
        )
    except ClientError as err:
        if err.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            raise
        return

    if new_status == "ready":
        _queue_sync(batch["batchId"])


def _record_batch_result(batch_id: str, key: str, accepted: bool):
    token = _object_token(key)
    values = {
        ":key": key,
        ":token": token,
        ":tokens": {token},
        ":updated_at": _now_iso(),
    }
    update = "SET updatedAt = :updated_at ADD processedTokens :tokens"
    if accepted:
        update += ", acceptedTokens :tokens"

    try:
        response = document_batches_table.update_item(
            Key={"batchId": batch_id},
            UpdateExpression=update,
            ConditionExpression="contains(expectedKeys, :key) AND not contains(processedTokens, :token)",
            ExpressionAttributeValues=values,
            ReturnValues="ALL_NEW",
        )
    except ClientError as err:
        if err.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            raise
        # Duplicate S3 delivery or a key that was already closed as failed.
        return

    _finish_batch_if_ready(response.get("Attributes") or {})


def _batch_accepts_object(batch_id: str, key: str) -> bool:
    """Authorize the signed object against its server-created batch manifest."""
    response = document_batches_table.get_item(
        Key={"batchId": batch_id},
        ConsistentRead=True,
    )
    batch = response.get("Item")
    if not batch or key not in set(batch.get("expectedKeys") or []):
        raise RejectedUpload("object is not present in its upload batch manifest")
    already_processed = _object_token(key) in set(batch.get("processedTokens") or [])
    if already_processed and batch.get("status") == "ready":
        # A previous invocation may have committed ``ready`` and then failed
        # while sending to SQS. The deterministic FIFO deduplication ID makes
        # this repair safe when the original send actually succeeded.
        _queue_sync(batch_id)
    return not already_processed


def _quarantine(bucket: str, key: str, version_id: str | None, batch_id: str, reason: str):
    safe_batch = batch_id if UPLOAD_BATCH_ID_RE.fullmatch(batch_id or "") else "unattributed"
    quarantine_key = f"quarantine/{safe_batch}/{_object_token(key)}-{key.rsplit('/', 1)[-1]}"
    s3.copy_object(
        CopySource=_copy_source(bucket, key, version_id),
        Bucket=bucket,
        Key=quarantine_key,
        MetadataDirective="REPLACE",
        Metadata={"rejection-reason": reason[:512]},
    )
    delete_request = {"Bucket": bucket, "Key": key}
    if version_id:
        delete_request["VersionId"] = version_id
    s3.delete_object(**delete_request)


def _write_analytics(file_name: str, file_size: int, elapsed_ms: int, status: str, reason=""):
    metadata = {
        "fileName": file_name,
        "fileSize": file_size,
        "processingTimeMs": elapsed_ms,
        "processedAt": _now_iso(),
        "status": status,
    }
    if reason:
        metadata["reason"] = reason
    analytics_table.put_item(Item={
        "eventType": "document_processing",
        "timestamp": _now_iso(),
        "metadata": metadata,
    })


def _process_s3_record(record):
    start_time = time.time()
    bucket = record["s3"]["bucket"]["name"]
    object_data = record["s3"]["object"]
    key = urllib.parse.unquote_plus(object_data["key"])
    version_id = object_data.get("versionId") or None
    file_name = key[len("uploads/"):] if key.startswith("uploads/") else key
    batch_id = ""
    file_size = int(object_data.get("size") or 0)

    print(f"Processing file: s3://{bucket}/{key} ({file_size} bytes)")
    try:
        batch_id, file_size, _content_type = _validate_object(bucket, key, version_id)
        if not _batch_accepts_object(batch_id, key):
            print(f"Skipping duplicate notification for s3://{bucket}/{key}")
            return
        s3.copy_object(
            CopySource=_copy_source(bucket, key, version_id),
            Bucket=KNOWLEDGE_BASE_BUCKET,
            Key=f"documents/{file_name}",
        )
        _record_batch_result(batch_id, key, accepted=True)
        elapsed_ms = int((time.time() - start_time) * 1000)
        _write_analytics(file_name, file_size, elapsed_ms, "accepted")
        print(f"Validated and copied to s3://{KNOWLEDGE_BASE_BUCKET}/documents/{file_name}")
    except RejectedUpload as err:
        reason = str(err)
        print(f"Rejected s3://{bucket}/{key}: {reason}")
        try:
            if not batch_id:
                request = {"Bucket": bucket, "Key": key}
                if version_id:
                    request["VersionId"] = version_id
                head = s3.head_object(**request)
                batch_id = (head.get("Metadata") or {}).get("upload-batch-id", "")
            # Superseded versions are left in version history and must not
            # delete or quarantine the current object at the same key.
            if reason != "object version was superseded by a newer upload":
                _quarantine(bucket, key, version_id, batch_id, reason)
            if UPLOAD_BATCH_ID_RE.fullmatch(batch_id):
                _record_batch_result(batch_id, key, accepted=False)
        except ClientError as quarantine_error:
            code = quarantine_error.response.get("Error", {}).get("Code")
            if code not in ("404", "NoSuchKey", "NotFound"):
                raise
        elapsed_ms = int((time.time() - start_time) * 1000)
        _write_analytics(file_name, file_size, elapsed_ms, "rejected", reason)


def _active_ingestion_job():
    response = bedrock_agent.list_ingestion_jobs(
        knowledgeBaseId=KNOWLEDGE_BASE_ID,
        dataSourceId=DATA_SOURCE_ID,
        sortBy={"attribute": "STARTED_AT", "order": "DESCENDING"},
        maxResults=10,
    )
    return next(
        (
            job for job in response.get("ingestionJobSummaries", [])
            if job.get("status") in ("STARTING", "IN_PROGRESS")
        ),
        None,
    )


def _process_sync_message(message):
    message_type = message.get("type")
    batch_id = message.get("batchId", "")
    change_id = message.get("changeId", "")
    is_batch = message_type == "document_batch_sync" and UPLOAD_BATCH_ID_RE.fullmatch(batch_id)
    is_change = message_type == "document_change_sync" and UPLOAD_BATCH_ID_RE.fullmatch(change_id)
    if not is_batch and not is_change:
        raise RejectedUpload("invalid document sync message")

    batch = None
    if is_batch:
        response = document_batches_table.get_item(Key={"batchId": batch_id}, ConsistentRead=True)
        batch = response.get("Item")
        if not batch:
            raise RejectedUpload("document batch does not exist")
        if batch.get("status") == "syncing":
            return
        if batch.get("status") != "ready":
            raise RuntimeError(f"document batch is not ready: {batch.get('status')}")
    if _active_ingestion_job():
        raise RuntimeError("another Bedrock ingestion job is still active")

    operation_id = batch_id if is_batch else change_id
    ingestion = bedrock_agent.start_ingestion_job(
        knowledgeBaseId=KNOWLEDGE_BASE_ID,
        dataSourceId=DATA_SOURCE_ID,
        clientToken=hashlib.sha256(f"{message_type}:{operation_id}".encode("utf-8")).hexdigest(),
    ).get("ingestionJob", {})
    if is_batch:
        document_batches_table.update_item(
            Key={"batchId": batch_id},
            UpdateExpression="SET #status = :syncing, ingestionJobId = :job_id, syncStartedAt = :started_at",
            ConditionExpression="#status = :ready",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={
                ":syncing": "syncing",
                ":ready": "ready",
                ":job_id": ingestion.get("ingestionJobId", "unknown"),
                ":started_at": _now_iso(),
            },
        )
    print(f"Started Bedrock ingestion for document operation {operation_id}")


def handler(event, _context):
    for record in event.get("Records", []):
        event_source = record.get("eventSource") or record.get("EventSource")
        if event_source == "aws:sqs":
            body = json.loads(record.get("body") or "{}")
            if body.get("type") in ("document_batch_sync", "document_change_sync"):
                _process_sync_message(body)
                continue
            for s3_record in body.get("Records", []):
                _process_s3_record(s3_record)
            continue
        _process_s3_record(record)
