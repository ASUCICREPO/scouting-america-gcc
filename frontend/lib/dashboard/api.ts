import { getIdToken } from './auth';

const API_BASE = process.env.NEXT_PUBLIC_DASHBOARD_API_URL || 'http://localhost:3002';

async function fetchApi(path: string, params?: Record<string, string>, options?: RequestInit) {
  const url = new URL(`${API_BASE}${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }

  // Always include Authorization header with Cognito ID token
  const token = getIdToken();
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
    // Token expired or unauthorized — redirect to login
    if (typeof window !== 'undefined') {
      localStorage.removeItem('gcc_admin_tokens');
      window.location.href = '/login';
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

export async function getSummary(): Promise<SummaryData> {
  return fetchApi('/dashboard/summary');
}

export async function getConversations(period: string = 'day'): Promise<{ data: ConversationPoint[]; total: number }> {
  return fetchApi('/dashboard/conversations', { period });
}

export async function getFaq(limit: number = 5): Promise<{ faq: FaqItem[]; totalUnique: number }> {
  return fetchApi('/dashboard/faq', { limit: String(limit) });
}

export async function getFaqAll(limit: number = 30, offset: number = 0): Promise<{ faq: FaqItem[]; total: number; offset: number; limit: number }> {
  return fetchApi('/dashboard/faq/all', { limit: String(limit), offset: String(offset) });
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

export async function deleteDocument(key: string): Promise<{ status: string }> {
  return fetchApi('/dashboard/documents', { key }, { method: 'DELETE' });
}

/**
 * Request a presigned PUT URL for a document upload.
 *
 * `relativePath` carries the folder structure (e.g. "folderA/sub/report.pdf")
 * so the backend mirrors the dropped layout under uploads/ in S3. It also
 * doubles as the flat filename for single-file uploads.
 */
export async function getUploadUrl(relativePath: string, contentType: string): Promise<{ url: string; key: string }> {
  return fetchApi('/dashboard/documents/upload', undefined, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relativePath, contentType }),
  });
}

export async function getNegativeFeedback(limit: number = 50, offset: number = 0) {
  return fetchApi('/dashboard/negative-feedback', { limit: String(limit), offset: String(offset) });
}
