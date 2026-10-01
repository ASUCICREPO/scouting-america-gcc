# Retrieval and Answer Eval

`questions.json` holds questions with known answers from the sandbox documents. `run_eval.py` runs them against a deployed stack, so a change to parsing, chunking, retrieval or the prompt can be measured before and after.

## Required documents

The answers come from two documents that must be in the knowledge base of the stack under test:

| `source` in questions.json | Document |
|---|---|
| `report.pdf` | Grand Canyon Council September 2026 calendar |
| `OutdoorEthicsGuide.pdf` | Scouting America Outdoor Ethics Guide |

The repository is public, so these files are not committed. Upload them through the admin dashboard and wait for the sync to finish.

## What is measured

- **Retrieval** calls the chat Lambda's own `retrieve_chunks()` with the deployed function's environment. A question passes when one returned chunk from the expected document contains every `retrieval` phrase. A miss is labelled `ranked out` (the chunk is indexed but was not returned) or `not in index` (parsing or chunking lost it).
- **Answers** send the question to the public chat API. Every `answer` regex must match the lowercased answer and no `forbid` regex may match. Out-of-scope questions (`source: null`) pass when the bot says it could not find the answer.
- The summary also prints the confidence spread for in-scope and out-of-scope questions, and how many correct questions escalated.

## Running

From `backend/`, with credentials for the target account:

```bash
pip install boto3
AWS_REGION=us-east-1 python eval/run_eval.py --prefix test- --mode both --out /tmp/eval.json
```

| Option | Meaning |
|---|---|
| `--stack` | CloudFormation stack name (default `GrandCanyonCouncilChatbot`) |
| `--prefix` | Resource prefix the stack was deployed with, e.g. `test-` |
| `--mode` | `retrieval`, `chat` or `both` |
| `--only` | Run only these question IDs |
| `--out` | Write full results, including answers, as JSON |

`--mode retrieval` is fast and free of side effects. `--mode chat` creates real chat logs, analytics entries and escalations, so run it against the sandbox, not production.

## Adding questions

Each case needs a unique `id`, the `question`, a `language` (`en` or `es`), the `source` filename, the `retrieval` phrases, the `answer` regexes, and `tags`. Take answers from the document itself, not from the bot. Check that every retrieval phrase appears in the indexed text, since parsing may reword headings. `test/test_eval_questions.py` checks the file's shape.
