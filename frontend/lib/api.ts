import { API_BASE_URL } from "./config";

export type Feedback = "positive" | "negative";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
  suggestions?: string[];
  links?: { title: string; url: string }[];
  /** Server turn id (DynamoDB sort key) used to attach feedback. */
  messageId?: string;
  /** Locally-tracked rating the user gave this response. */
  feedback?: Feedback;
}

export interface ChatResponse {
  message: string;
  suggestions?: string[];
  links?: { title: string; url: string }[];
  sessionId?: string;
  messageId?: string;
}

export async function sendMessage(
  message: string,
  sessionId?: string
): Promise<ChatResponse> {
  const response = await fetch(`${API_BASE_URL}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      question: message,
      sessionId,
    }),
  });

  if (!response.ok) {
    throw new Error(`Chat API error: ${response.status}`);
  }

  const data = await response.json();
  return {
    message: data.answer || data.message || '',
    suggestions: data.suggestions,
    links: data.links,
    sessionId: data.sessionId,
    messageId: data.messageId,
  };
}

export interface HistoryItem {
  question: string;
  answer: string;
  timestamp: string;
}

export async function getChatHistory(sessionId: string): Promise<ChatMessage[]> {
  const response = await fetch(`${API_BASE_URL}/chat/history/${sessionId}`);
  if (!response.ok) {
    throw new Error(`History API error: ${response.status}`);
  }
  const data = await response.json();
  const messages: ChatMessage[] = [];
  for (const item of data.history || []) {
    messages.push({ role: "user", content: item.question, timestamp: item.timestamp });
    messages.push({ role: "assistant", content: item.answer, timestamp: item.timestamp });
  }
  return messages;
}

/**
 * Record a thumbs up/down rating for a specific assistant response.
 * `messageId` is the turn id returned by sendMessage.
 */
export async function sendFeedback(
  sessionId: string,
  messageId: string,
  feedback: Feedback
): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/chat/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, messageId, feedback }),
  });

  if (!response.ok) {
    throw new Error(`Feedback API error: ${response.status}`);
  }
}

// Local session storage
export interface SavedSession {
  sessionId: string;
  title: string; // first user message
  timestamp: string;
}

const SESSIONS_KEY = "chat_sessions";

export function getSavedSessions(): SavedSession[] {
  if (typeof window === "undefined") return [];
  const stored = localStorage.getItem(SESSIONS_KEY);
  if (!stored) return [];
  try {
    return JSON.parse(stored);
  } catch {
    return [];
  }
}

export function saveSession(sessionId: string, firstMessage: string): void {
  const sessions = getSavedSessions();
  // Don't duplicate
  if (sessions.some(s => s.sessionId === sessionId)) return;
  sessions.unshift({
    sessionId,
    title: firstMessage.length > 50 ? firstMessage.slice(0, 50) + "..." : firstMessage,
    timestamp: new Date().toISOString(),
  });
  // Keep max 20 sessions
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions.slice(0, 20)));
}

export function clearSavedSessions(): void {
  localStorage.removeItem(SESSIONS_KEY);
}
