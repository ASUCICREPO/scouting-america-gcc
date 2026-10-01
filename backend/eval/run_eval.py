"""Measure retrieval and answer quality of a deployed stack against eval/questions.json.

Retrieval calls the chat Lambda's own retrieve_chunks() with the deployed
function's environment, so it always measures the production retrieval
settings. Chat mode sends each question to the public chat API.

Run from backend/ with credentials for the target account:

    python eval/run_eval.py --stack GrandCanyonCouncilChatbot --prefix test-
    python eval/run_eval.py --mode retrieval --only cal-wood-badge-dates
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

import boto3

BACKEND_DIR = Path(__file__).resolve().parents[1]
QUESTIONS_PATH = Path(__file__).with_name("questions.json")
CHAT_HANDLER_PATH = BACKEND_DIR / "lambda" / "chat-handler" / "index.py"

# Matches the "could not find it in the approved resources" reply the chat
# prompt asks for, in English and Spanish.
NO_ANSWER_RE = re.compile(
    r"(could ?n[o']t|can ?n[o']t|cannot|unable to|did ?n[o']t|do ?n[o']t) (find|locate|see|have)"
    r"|no (pude|puedo|encontr[eé]|tengo|hay información)",
)


def normalize(text: str) -> str:
    """Lowercase, drop Markdown emphasis, unify dashes, and collapse whitespace."""
    text = text.replace("*", "").replace("–", "-").replace("—", "-")
    return re.sub(r"\s+", " ", text).strip().lower()


def source_name(uri: str) -> str:
    return urllib.parse.unquote(uri).rsplit("/", 1)[-1]


def score_retrieval(case: dict[str, Any], chunks: list[Any]) -> dict[str, Any]:
    """Find the first chunk from the expected document that contains every expected phrase."""
    needles = [normalize(text) for text in case["retrieval"]]
    rank = None
    for index, chunk in enumerate(chunks, start=1):
        content = normalize(chunk.content)
        if source_name(chunk.source) == case["source"] and all(n in content for n in needles):
            rank = index
            break
    return {
        "hit": rank is not None,
        "rank": rank,
        "results": [
            {"source": source_name(c.source), "score": round(c.score, 4)} for c in chunks
        ],
    }


def score_answer(case: dict[str, Any], answer: str) -> dict[str, Any]:
    text = normalize(answer)
    if case["source"] is None:
        return {"pass": bool(NO_ANSWER_RE.search(text)), "missing": [], "forbidden": []}
    missing = [pattern for pattern in case["answer"] if not re.search(pattern, text)]
    forbidden = [pattern for pattern in case.get("forbid", []) if re.search(pattern, text)]
    return {"pass": not missing and not forbidden, "missing": missing, "forbidden": forbidden}


def stack_outputs(cfn: Any, stack: str) -> dict[str, str]:
    outputs = cfn.describe_stacks(StackName=stack)["Stacks"][0].get("Outputs", [])
    return {output["OutputKey"]: output["OutputValue"] for output in outputs}


def load_chat_handler(lambda_env: dict[str, str], region: str) -> Any:
    """Import the chat handler with the deployed function's environment."""
    os.environ.update(lambda_env)
    os.environ.setdefault("AWS_DEFAULT_REGION", region)
    spec = importlib.util.spec_from_file_location("deployed_chat_handler", CHAT_HANDLER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def indexed_texts(region: str, kb_id: str) -> dict[str, list[str]] | None:
    """Return every indexed chunk by document, or None if the store can't be listed."""
    storage = boto3.client("bedrock-agent", region_name=region).get_knowledge_base(
        knowledgeBaseId=kb_id
    )["knowledgeBase"]["storageConfiguration"]
    if storage.get("type") != "S3_VECTORS":
        return None
    vectors = boto3.client("s3vectors", region_name=region)
    request = {"indexArn": storage["s3VectorsConfiguration"]["indexArn"], "returnMetadata": True}
    texts: dict[str, list[str]] = {}
    while True:
        page = vectors.list_vectors(**request)
        for vector in page.get("vectors", []):
            metadata = vector.get("metadata", {})
            location = json.loads(metadata.get("AMAZON_BEDROCK_METADATA") or "{}")
            uri = (location.get("source") or {}).get("sourceLocation", "")
            texts.setdefault(source_name(uri), []).append(
                normalize(metadata.get("AMAZON_BEDROCK_TEXT", ""))
            )
        if not page.get("nextToken"):
            return texts
        request["nextToken"] = page["nextToken"]


def ask(api_url: str, origin: str, question: str, language: str) -> dict[str, Any]:
    body = json.dumps({"question": question, "language": language}).encode("utf-8")
    request = urllib.request.Request(
        urllib.parse.urljoin(api_url, "chat"),
        data=body,
        headers={"Content-Type": "application/json", "Origin": origin},
        method="POST",
    )
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as err:
            if err.code not in (429, 502, 503, 504) or attempt == 3:
                return {"error": f"HTTP {err.code}: {err.read()[:200]!r}"}
            time.sleep(2 ** attempt * 5)
    return {"error": "unreachable"}


def summarize(name: str, values: list[float]) -> str:
    if not values:
        return f"{name}: none"
    return (
        f"{name}: n={len(values)} min={min(values):.3f} "
        f"median={statistics.median(values):.3f} max={max(values):.3f}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--stack", default=os.environ.get("STACK_NAME", "GrandCanyonCouncilChatbot"))
    parser.add_argument("--prefix", default=os.environ.get("RESOURCE_PREFIX", ""))
    parser.add_argument("--region", default=os.environ.get("AWS_REGION", "us-east-1"))
    parser.add_argument("--mode", choices=["retrieval", "chat", "both"], default="both")
    parser.add_argument("--only", nargs="*", help="Run only these question IDs")
    parser.add_argument("--out", type=Path, help="Write full results as JSON")
    args = parser.parse_args()

    cases = json.loads(QUESTIONS_PATH.read_text())
    if args.only:
        cases = [case for case in cases if case["id"] in set(args.only)]

    outputs = stack_outputs(boto3.client("cloudformation", region_name=args.region), args.stack)
    lambda_env = boto3.client("lambda", region_name=args.region).get_function_configuration(
        FunctionName=f"{args.prefix}GCC-ChatHandler"
    )["Environment"]["Variables"]
    chat_handler = load_chat_handler(lambda_env, args.region)
    corpus = None

    results = []
    for case in cases:
        result: dict[str, Any] = {"id": case["id"], "tags": case.get("tags", [])}
        in_scope = case["source"] is not None

        if args.mode in ("retrieval", "both") and in_scope:
            retrieval = score_retrieval(case, chat_handler.retrieve_chunks(case["question"]))
            if not retrieval["hit"]:
                if corpus is None:
                    corpus = indexed_texts(args.region, lambda_env["KB_ID"]) or {}
                needles = [normalize(text) for text in case["retrieval"]]
                retrieval["inIndex"] = any(
                    all(n in text for n in needles) for text in corpus.get(case["source"], [])
                ) if corpus else None
            result["retrieval"] = retrieval

        if args.mode in ("chat", "both"):
            reply = ask(outputs["ChatApiUrl"], outputs["FrontendUrl"], case["question"], case["language"])
            result["chat"] = {
                **score_answer(case, reply.get("answer", "")),
                "confidence": reply.get("confidence"),
                "escalated": reply.get("escalated"),
                "answer": reply.get("answer") or reply.get("error"),
            }

        results.append(result)
        print(format_row(result), flush=True)

    print_summary(results)
    if args.out:
        args.out.write_text(json.dumps(results, indent=2, ensure_ascii=False) + "\n")
        print(f"\nWrote {args.out}")
    return 0


def format_row(result: dict[str, Any]) -> str:
    parts = [f"{result['id']:<34}"]
    retrieval = result.get("retrieval")
    if retrieval:
        if retrieval["hit"]:
            parts.append(f"retrieval PASS @{retrieval['rank']}")
        else:
            where = {True: "ranked out", False: "not in index", None: "?"}[retrieval.get("inIndex")]
            parts.append(f"retrieval FAIL ({where})")
    chat = result.get("chat")
    if chat:
        verdict = "PASS" if chat["pass"] else "FAIL"
        confidence = chat["confidence"]
        confidence = f"{confidence:.2f}" if isinstance(confidence, (int, float)) else "-"
        parts.append(f"answer {verdict} conf={confidence} escalated={chat['escalated']}")
        if chat["missing"] or chat["forbidden"]:
            parts.append(f"missing={chat['missing']} forbidden={chat['forbidden']}")
    if len(parts) == 1:
        parts.append("skipped (out-of-scope questions are only checked in chat mode)")
    return "  ".join(parts)


def print_summary(results: list[dict[str, Any]]) -> None:
    print("\n=== Summary ===")
    retrieved = [r["retrieval"] for r in results if "retrieval" in r]
    if retrieved:
        hits = sum(r["hit"] for r in retrieved)
        ranked_out = sum(1 for r in retrieved if not r["hit"] and r.get("inIndex"))
        missing = sum(1 for r in retrieved if not r["hit"] and r.get("inIndex") is False)
        print(
            f"Retrieval: {hits}/{len(retrieved)} found the expected chunk "
            f"({ranked_out} ranked out, {missing} not in index)"
        )
    answered = [r for r in results if "chat" in r]
    if answered:
        passed = sum(r["chat"]["pass"] for r in answered)
        print(f"Answers:   {passed}/{len(answered)} correct")
        tags = sorted({tag for r in answered for tag in r["tags"]})
        for tag in tags:
            tagged = [r for r in answered if tag in r["tags"]]
            print(f"  {tag:<14} {sum(r['chat']['pass'] for r in tagged)}/{len(tagged)}")

        def confidences(in_scope: bool) -> list[float]:
            return [
                r["chat"]["confidence"] for r in answered
                if ("out-of-scope" not in r["tags"]) == in_scope
                and isinstance(r["chat"]["confidence"], (int, float))
            ]

        print(summarize("Confidence (in scope)    ", confidences(True)))
        print(summarize("Confidence (out of scope)", confidences(False)))
        escalated = sum(
            1 for r in answered if "out-of-scope" not in r["tags"] and r["chat"]["escalated"]
        )
        in_scope_total = sum(1 for r in answered if "out-of-scope" not in r["tags"])
        print(f"In-scope answers escalated: {escalated}/{in_scope_total}")


if __name__ == "__main__":
    sys.exit(main())
