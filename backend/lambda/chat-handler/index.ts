import {
  BedrockAgentRuntimeClient,
  RetrieveAndGenerateCommand,
  RetrieveCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { randomUUID } from 'crypto';

interface EscalationPayload {
  sessionId: string;
  userId: string;
  question: string;
  answer: string;
  reason: string;
  confidence: number;
}

// AWS SDK clients
const bedrockClient = new BedrockAgentRuntimeClient({});
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambdaClient = new LambdaClient({});
const secretsClient = new SecretsManagerClient({});

// Env vars set by CDK construct
const KB_ID = process.env.KB_ID!;
const MODEL_ARN = process.env.MODEL_ARN!;
const CHAT_LOGS_TABLE = process.env.CHAT_LOGS_TABLE!;
const SECRETS_ARN = process.env.SECRETS_ARN!;
const ESCALATION_FUNCTION_ARN = process.env.ESCALATION_FUNCTION_ARN!;
const CONFIDENCE_THRESHOLD = parseFloat(process.env.CONFIDENCE_THRESHOLD || '0.7');
const SAFETY_KEYWORDS = JSON.parse(process.env.SAFETY_KEYWORDS || '[]');

// Caps the size of a single question to bound prompt size, Bedrock cost, and
// abuse on the public (unauthenticated) endpoint.
const MAX_QUESTION_LENGTH = 4000;

// Main handler — API Gateway sends requests here
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const httpMethod = event.httpMethod;
  const path = event.resource;

  try {
    // Route: GET /chat/history/{sessionId}
    if (httpMethod === 'GET' && path.includes('history')) {
      return await getHistory(event);
    }

    // Route: POST /chat
    if (httpMethod === 'POST') {
      return await handleChat(event);
    }

    return response(400, { error: 'Invalid route' });
  } catch (err: any) {
    console.error('Chat handler error:', err);
    return response(500, { error: 'Internal server error' });
  }
};

// Handles the main chat — volunteer asks a question, we get an answer from Bedrock KB
async function handleChat(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return response(400, { error: 'Request body must be valid JSON' });
  }

  const { question: rawQuestion, sessionId: existingSessionId } = body;

  // Get userId from Cognito claims (API Gateway passes this)
  const userId = event.requestContext?.authorizer?.claims?.sub || 'anonymous';

  // Validate the question: must be a non-empty string within the length cap.
  if (typeof rawQuestion !== 'string' || rawQuestion.trim().length === 0) {
    return response(400, { error: 'Question is required and must be a non-empty string' });
  }
  const question = rawQuestion.trim();
  if (question.length > MAX_QUESTION_LENGTH) {
    return response(400, { error: `Question exceeds the maximum length of ${MAX_QUESTION_LENGTH} characters` });
  }

  // If a session id is supplied it must be a string (it becomes a DynamoDB key).
  if (existingSessionId !== undefined && typeof existingSessionId !== 'string') {
    return response(400, { error: 'sessionId must be a string' });
  }

  const sessionId = existingSessionId || randomUUID();
  const timestamp = new Date().toISOString();

  // Get system guardrails from Secrets Manager
  const guardrails = await getGuardrails();

  // Generation (RetrieveAndGenerate) and score retrieval (Retrieve) are
  // independent — RetrieveAndGenerate doesn't return retrieval scores, so we
  // still need the second call for CI logging. Run them in parallel to avoid
  // paying the latency of two sequential Bedrock round-trips.
  const [kbResponse, retrieveResponse] = await Promise.all([
    bedrockClient.send(new RetrieveAndGenerateCommand({
      input: { text: question },
      retrieveAndGenerateConfiguration: {
        type: 'KNOWLEDGE_BASE',
        knowledgeBaseConfiguration: {
          knowledgeBaseId: KB_ID,
          modelArn: MODEL_ARN,
          generationConfiguration: {
            promptTemplate: {
              textPromptTemplate: `${guardrails}\n\nSearch results:\n$search_results$\n\nUser question: $query$\n\nAnswer using only the provided search results. Cite sources.`,
            },
          },
        },
      },
    })),
    bedrockClient.send(new RetrieveCommand({
      knowledgeBaseId: KB_ID,
      retrievalQuery: { text: question },
      retrievalConfiguration: {
        vectorSearchConfiguration: {
          numberOfResults: 5,
        },
      },
    })).catch((err) => {
      // Score retrieval is best-effort — a failure shouldn't block the answer.
      console.error('Failed to retrieve scores:', err);
      return undefined;
    }),
  ]);

  // Extract the answer and sources from the generation response
  const answer = kbResponse.output?.text || 'I could not find an answer to your question.';
  const citations = kbResponse.citations || [];
  const sources = extractSources(citations);

  // Per-chunk retrieval scores (CI logging)
  const chunkScores: { source: string; score: number; chunkText: string }[] =
    (retrieveResponse?.retrievalResults || []).map((result: any) => ({
      source: result.location?.s3Location?.uri || 'unknown',
      score: result.score ?? 0,
      chunkText: (result.content?.text || '').substring(0, 200),
    }));

  // Calculate confidence using actual retrieval scores (average of chunk scores)
  // Falls back to 0.3 if no scores available
  const confidence = chunkScores.length > 0
    ? chunkScores.reduce((sum, s) => sum + s.score, 0) / chunkScores.length
    : 0.3;

  // Check if we need to escalate (safety keywords or low confidence)
  const needsEscalation = checkEscalation(question, answer, confidence);

  // If escalation needed, trigger the Escalation Router Lambda
  if (needsEscalation.escalate) {
    await triggerEscalation({
      sessionId,
      userId,
      question,
      answer,
      reason: needsEscalation.reason,
      confidence,
    });
  }

  // Save this conversation to DynamoDB (includes per-chunk CI scores)
  await dynamoClient.send(new PutCommand({
    TableName: CHAT_LOGS_TABLE,
    Item: {
      sessionId,
      timestamp,
      userId,
      question,
      answer,
      sources,
      confidence,
      chunkScores, // Per-chunk retrieval scores for CI logging
      escalated: needsEscalation.escalate,
      category: 'general', // future: auto-categorize questions
      createdAt: timestamp,
    },
  }));

  return response(200, {
    answer,
    sources,
    confidence,
    sessionId,
    escalated: needsEscalation.escalate,
  });
}

// Returns conversation history for a given session
async function getHistory(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const sessionId = event.pathParameters?.sessionId;

  if (!sessionId) {
    return response(400, { error: 'sessionId is required' });
  }

  const result = await dynamoClient.send(new QueryCommand({
    TableName: CHAT_LOGS_TABLE,
    KeyConditionExpression: 'sessionId = :sid',
    ExpressionAttributeValues: { ':sid': sessionId },
    ScanIndexForward: true, // oldest first
  }));

  const history = (result.Items || []).map((item: any) => ({
    question: item.question,
    answer: item.answer,
    sources: item.sources,
    confidence: item.confidence,
    timestamp: item.timestamp,
    escalated: item.escalated,
  }));

  return response(200, { sessionId, history });
}

// Reads the system prompt/guardrails from Secrets Manager
async function getGuardrails(): Promise<string> {
  try {
    const secret = await secretsClient.send(new GetSecretValueCommand({
      SecretId: SECRETS_ARN,
    }));
    const parsed = JSON.parse(secret.SecretString || '{}');
    return parsed.systemPrompt || getDefaultPrompt();
  } catch {
    return getDefaultPrompt();
  }
}

// Default system prompt if Secrets Manager fails or is empty
function getDefaultPrompt(): string {
  return `You are the GCC AI Volunteer Support Assistant for Scouting America's Grand Canyon Council. 
Answer questions using ONLY approved GCC and Scouting America resources provided in the search results. 
If you cannot find the answer in the provided documents, say so clearly. 
For safety-sensitive topics (abuse, emergencies, injuries, youth protection), immediately direct the user to appropriate human contacts.
Never make up information or present uncertain answers as definitive.`;
}

// Checks if we need to escalate: safety keywords or low confidence
function checkEscalation(question: string, answer: string, confidence: number) {
  const combined = `${question} ${answer}`.toLowerCase();

  // Check safety keywords
  for (const keyword of SAFETY_KEYWORDS) {
    if (combined.includes(keyword.toLowerCase())) {
      return { escalate: true, reason: `Safety keyword detected: "${keyword}"` };
    }
  }

  // Check confidence threshold
  if (confidence < CONFIDENCE_THRESHOLD) {
    return { escalate: true, reason: `Low confidence: ${confidence.toFixed(2)}` };
  }

  return { escalate: false, reason: '' };
}

// Triggers the Escalation Router Lambda asynchronously
async function triggerEscalation(payload: EscalationPayload) {
  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: ESCALATION_FUNCTION_ARN,
      InvocationType: 'Event', // async — don't wait for response
      Payload: Buffer.from(JSON.stringify(payload)),
    }));
  } catch (err) {
    console.error('Failed to trigger escalation:', err);
  }
}

// Extracts source document references from Bedrock KB citations
function extractSources(citations: any[]): string[] {
  const sources: string[] = [];
  for (const citation of citations) {
    const refs = citation.retrievedReferences || [];
    for (const ref of refs) {
      const uri = ref.location?.s3Location?.uri;
      if (uri && !sources.includes(uri)) {
        sources.push(uri);
      }
    }
  }
  return sources;
}

// Helper to format API Gateway responses
function response(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}
