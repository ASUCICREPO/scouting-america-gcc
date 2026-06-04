import {
  BedrockAgentRuntimeClient,
  RetrieveAndGenerateCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { randomUUID } from 'crypto';

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

// Main handler — API Gateway sends requests here
export const handler = async (event: any) => {
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
async function handleChat(event: any) {
  const body = JSON.parse(event.body || '{}');
  const { question, sessionId: existingSessionId } = body;

  // Get userId from Cognito claims (API Gateway passes this)
  const userId = event.requestContext?.authorizer?.claims?.sub || 'anonymous';

  if (!question) {
    return response(400, { error: 'Question is required' });
  }

  const sessionId = existingSessionId || randomUUID();
  const timestamp = new Date().toISOString();

  // Get system guardrails from Secrets Manager
  const guardrails = await getGuardrails();

  // Call Bedrock Knowledge Base — this searches docs and generates an answer
  const kbResponse = await bedrockClient.send(new RetrieveAndGenerateCommand({
    input: { text: question },
    retrieveAndGenerateConfiguration: {
      type: 'KNOWLEDGE_BASE',
      knowledgeBaseConfiguration: {
        knowledgeBaseId: KB_ID,
        modelArn: MODEL_ARN,
        generationConfiguration: {
          promptTemplate: {
            textPromptTemplate: `${guardrails}\n\nUser question: $query$\n\nAnswer using only the provided search results. Cite sources.`,
          },
        },
      },
    },
  }));

  // Extract the answer and sources from Bedrock response
  const answer = kbResponse.output?.text || 'I could not find an answer to your question.';
  const citations = kbResponse.citations || [];
  const sources = extractSources(citations);

  // Calculate confidence based on how many citations were found
  const confidence = citations.length > 0 ? Math.min(citations.length * 0.25, 1.0) : 0.3;

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

  // Save this conversation to DynamoDB
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
async function getHistory(event: any) {
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
async function triggerEscalation(payload: any) {
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
function response(statusCode: number, body: any) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': true,
    },
    body: JSON.stringify(body),
  };
}
