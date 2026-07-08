import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

// AWS SDK clients
const snsClient = new SNSClient({});
const sesClient = new SESClient({});
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Env vars set by CDK construct
const SNS_TOPIC_ARN = process.env.SNS_TOPIC_ARN!;
const STAFF_EMAIL = process.env.STAFF_EMAIL!;
const ANALYTICS_TABLE = process.env.ANALYTICS_TABLE!;

// Payload sent by the Chat Handler when an escalation is needed
interface EscalationEvent {
  sessionId: string;
  userId: string;
  question: string;
  answer: string;
  reason: string;
  confidence: number;
}

interface AlertData extends EscalationEvent {
  severity: string;
}

// Called asynchronously by Chat Handler when escalation is needed
export const handler = async (event: EscalationEvent) => {
  const { sessionId, userId, question, answer, reason, confidence } = event;

  console.log('Escalation triggered:', { sessionId, reason, confidence });

  // Determine severity: safety keywords = HIGH, low confidence = MEDIUM
  const isHighSeverity = reason.toLowerCase().includes('safety keyword');
  const severity = isHighSeverity ? 'HIGH' : 'MEDIUM';
  const timestamp = new Date().toISOString();

  // Format the alert message for staff
  const message = formatAlertMessage({ sessionId, userId, question, answer, reason, confidence, severity });

  // Always send SNS notification (both HIGH and MEDIUM)
  await sendSnsAlert(message, severity);

  // Only send email for HIGH severity (safety-related)
  if (isHighSeverity) {
    await sendEmailAlert(message, severity);
  }

  // Log escalation event to AnalyticsLogs table
  await logEscalation({ sessionId, userId, reason, confidence, severity, timestamp });

  return { statusCode: 200, body: 'Escalation processed' };
};

// Publishes alert to SNS topic — staff subscribed to this get notified
async function sendSnsAlert(message: string, severity: string): Promise<void> {
  try {
    await snsClient.send(new PublishCommand({
      TopicArn: SNS_TOPIC_ARN,
      Subject: `[${severity}] GCC AI Assistant - Escalation Alert`,
      Message: message,
    }));
  } catch (err) {
    console.error('SNS publish failed:', err);
  }
}

// Sends direct email to staff for HIGH severity cases
async function sendEmailAlert(message: string, severity: string): Promise<void> {
  try {
    await sesClient.send(new SendEmailCommand({
      Source: STAFF_EMAIL, // must be verified in SES
      Destination: { ToAddresses: [STAFF_EMAIL] },
      Message: {
        Subject: { Data: `[${severity}] GCC AI Assistant - Safety Escalation` },
        Body: {
          Text: { Data: message },
        },
      },
    }));
  } catch (err) {
    console.error('SES email failed:', err);
  }
}

// Saves escalation event to DynamoDB for analytics tracking
async function logEscalation(data: { sessionId: string; userId: string; reason: string; confidence: number; severity: string; timestamp: string }): Promise<void> {
  try {
    await dynamoClient.send(new PutCommand({
      TableName: ANALYTICS_TABLE,
      Item: {
        eventType: 'escalation',
        timestamp: data.timestamp,
        sessionId: data.sessionId,
        userId: data.userId,
        reason: data.reason,
        metadata: {
          confidence: data.confidence,
          severity: data.severity,
        },
        createdAt: data.timestamp,
      },
    }));
  } catch (err) {
    console.error('Failed to log escalation:', err);
  }
}

// Formats a readable alert message for staff
function formatAlertMessage(data: AlertData): string {
  return `
🚨 ESCALATION ALERT — ${data.severity} SEVERITY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Reason: ${data.reason}
Confidence: ${(data.confidence * 100).toFixed(0)}%
Session: ${data.sessionId}
User: ${data.userId}

Volunteer's Question:
"${data.question}"

AI Response Given:
"${data.answer}"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Action Required: Please review and follow up if needed.
  `.trim();
}
