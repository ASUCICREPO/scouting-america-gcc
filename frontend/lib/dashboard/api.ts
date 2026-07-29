import { clearAdminSession, getValidIdToken } from './auth';

const API_BASE = process.env.NEXT_PUBLIC_DASHBOARD_API_URL || 'http://localhost:3002';

async function fetchApi(path: string, params?: Record<string, string>, options?: RequestInit) {
  const url = new URL(`${API_BASE}${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }

  // Always include Authorization header with Cognito ID token
  const token = await getValidIdToken();
  if (!token) {
    if (typeof window !== 'undefined') {
      window.location.href = '/admin';
    }
    throw new Error('Unauthorized');
  }
  const headers: Record<string, string> = {
    ...(options?.headers as Record<string, string> || {}),
  };
  if (token) {
    headers['Authorization'] = token;
  }

  const res = await fetch(url.toString(), {
    ...options,
    headers,
  });

  if (res.status === 401 || res.status === 403) {
    // Token expired or unauthorized — redirect to the admin login.
    clearAdminSession();
    if (typeof window !== 'undefined') {
      window.location.href = '/admin';
    }
    throw new Error('Unauthorized');
  }

  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export interface SummaryData {
  totalChats: number;
  totalSessions: number;
  totalUsers: number;
  avgConfidence: number;
  avgSessionLength: string;
  avgSessionMs: number;
  totalEscalations: number;
  escalationRate: number;
  totalDocuments: number;
  satisfactionRate: number;
  positiveCount: number;
  negativeCount: number;
  totalFeedback: number;
  feedbackNote?: string;
}

export interface ConversationPoint {
  date: string;
  count: number;
}

export interface FaqItem {
  question: string;
  count: number;
  avgConfidence: number;
  escalatedCount: number;
  lastAsked: string;
}

export type DocumentStatus = 'ready' | 'indexing' | 'pending' | 'failed';

export interface DocumentItem {
  key: string;
  fileName: string;
  fileSize: number;
  lastModified: string;
  /** Ingestion readiness derived from the Bedrock data-source job state. */
  status?: DocumentStatus;
}

export async function getSummary(days: number = 90): Promise<SummaryData> {
  return fetchApi('/dashboard/summary', { days: String(days) });
}

export async function getConversations(period: string = 'day'): Promise<{ data: ConversationPoint[]; total: number }> {
  return fetchApi('/dashboard/conversations', { period });
}

export async function getFaq(limit: number = 5): Promise<{ faq: FaqItem[]; totalUnique: number }> {
  return fetchApi('/dashboard/faq', { limit: String(limit) });
}

export async function getConfidence(period: string = 'day') {
  return fetchApi('/dashboard/confidence', { period });
}

export async function getEscalations() {
  return fetchApi('/dashboard/escalations');
}

export async function getDocuments(): Promise<{ documents: DocumentItem[]; total: number; indexing?: boolean }> {
  return fetchApi('/dashboard/documents');
}

export async function getDocumentDownloadUrl(key: string): Promise<{ url: string }> {
  return fetchApi('/dashboard/documents/download', { key });
}

export async function deleteDocuments(
  keys: string[],
): Promise<{ status: string; deletedKeys: string[]; failedKeys: string[] }> {
  return fetchApi('/dashboard/documents', undefined, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys }),
  });
}

/**
 * Request a size-enforced presigned POST policy for a document upload.
 *
 * `relativePath` carries the folder structure (e.g. "folderA/sub/report.pdf")
 * so the backend mirrors the dropped layout under uploads/ in S3. It also
 * doubles as the flat filename for single-file uploads.
 */
export interface UploadManifestFile {
  relativePath: string;
  contentType: string;
  size: number;
}

export interface PresignedDocumentUpload {
  relativePath: string;
  url: string;
  fields: Record<string, string>;
  key: string;
  maxSizeBytes: number;
}

export async function createUploadBatch(
  files: UploadManifestFile[],
): Promise<{ batchId: string; uploads: PresignedDocumentUpload[]; expiresIn: number }> {
  return fetchApi('/dashboard/documents/upload', undefined, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files }),
  });
}

export async function completeUploadBatch(
  batchId: string,
  failedKeys: string[],
): Promise<{ batchId: string; status: string; failedCount: number }> {
  return fetchApi('/dashboard/documents/upload/complete', undefined, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ batchId, failedKeys }),
  });
}

export async function getNegativeFeedback(limit: number = 50, offset: number = 0) {
  return fetchApi('/dashboard/negative-feedback', { limit: String(limit), offset: String(offset) });
}

export type FeedbackValue = 'positive' | 'negative';

export interface FeedbackConversation {
  sessionId: string;
  messageId: string;
  timestamp: string;
  userId?: string;
  question: string;
  answer: string;
  feedback: FeedbackValue;
  confidence: number;
  sources: string[];
  escalated: boolean;
  language: 'en' | 'es';
}

export interface SessionTurn {
  messageId: string;
  timestamp: string;
  question: string;
  answer: string;
  feedback?: FeedbackValue | null;
  confidence: number;
  sources: string[];
  escalated: boolean;
  language: 'en' | 'es';
}

/** List chat turns that received a thumbs up/down. filter: 'all' | 'positive' | 'negative'. */
export async function getFeedbackConversations(
  filter: 'all' | FeedbackValue = 'all',
  limit: number = 50,
  offset: number = 0,
): Promise<{ conversations: FeedbackConversation[]; total: number; offset: number; limit: number; filter: string; note?: string }> {
  return fetchApi('/dashboard/feedback', { filter, limit: String(limit), offset: String(offset) });
}

/** Full transcript for a session, used to render the conversation and highlight the rated turn. */
export async function getSessionTranscript(
  sessionId: string,
): Promise<{ sessionId: string; turns: SessionTurn[]; total: number }> {
  return fetchApi('/dashboard/session', { sessionId });
}
