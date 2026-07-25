import { API_BASE_URL } from "./config";
import { Language } from "./i18n";

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
  sessionToken?: string;
  messageId?: string;
  language?: Language;
}

export async function sendMessage(
  message: string,
  sessionId?: string,
  sessionToken?: string,
  language: Language = "en",
): Promise<ChatResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (sessionToken) headers["X-Session-Token"] = sessionToken;

  const response = await fetch(`${API_BASE_URL}/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      question: message,
      sessionId,
      language,
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
    sessionToken: data.sessionToken,
    messageId: data.messageId,
    language: data.language,
  };
}

export interface HistoryItem {
  question: string;
  answer: string;
  timestamp: string;
  language?: Language;
}

export async function getChatHistory(
  sessionId: string,
  sessionToken: string,
): Promise<{ messages: ChatMessage[]; language: Language }> {
  const response = await fetch(`${API_BASE_URL}/chat/history/${sessionId}`, {
    headers: { "X-Session-Token": sessionToken },
  });
  if (!response.ok) {
    throw new Error(`History API error: ${response.status}`);
  }
  const data = await response.json();
  const messages: ChatMessage[] = [];
  for (const item of data.history || []) {
    messages.push({ role: "user", content: item.question, timestamp: item.timestamp });
    messages.push({ role: "assistant", content: item.answer, timestamp: item.timestamp });
  }
  const historyLanguage = (data.history || []).find(
    (item: HistoryItem) => item.language === "en" || item.language === "es",
  )?.language;
  return { messages, language: historyLanguage || "en" };
}

/**
 * Record a thumbs up/down rating for a specific assistant response.
 * `messageId` is the turn id returned by sendMessage.
 */
export async function sendFeedback(
  sessionId: string,
  sessionToken: string,
  messageId: string,
  feedback: Feedback
): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/chat/feedback`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Token": sessionToken,
    },
    body: JSON.stringify({ sessionId, messageId, feedback }),
  });

  if (!response.ok) {
    throw new Error(`Feedback API error: ${response.status}`);
  }
}

// Local session storage
export interface SavedSession {
  sessionId: string;
  sessionToken: string;
  title: string; // first user message
  timestamp: string;
  language?: Language;
}

const SESSIONS_KEY = "chat_sessions";

export function getSavedSessions(): SavedSession[] {
  if (typeof window === "undefined") return [];
  const stored = localStorage.getItem(SESSIONS_KEY);
  if (!stored) return [];
  try {
    const sessions = JSON.parse(stored) as SavedSession[];
    // Sessions created before anonymous credentials were introduced cannot be
    // securely resumed and are intentionally omitted.
    return sessions.filter(
      (session) =>
        typeof session.sessionId === "string" &&
        typeof session.sessionToken === "string" &&
        session.sessionToken.length > 0,
    );
  } catch {
    return [];
  }
}

export function saveSession(
  sessionId: string,
  sessionToken: string,
  firstMessage: string,
  language: Language,
): void {
  const sessions = getSavedSessions();
  // Don't duplicate
  if (sessions.some(s => s.sessionId === sessionId)) return;
  sessions.unshift({
    sessionId,
    sessionToken,
    title: firstMessage.length > 50 ? firstMessage.slice(0, 50) + "..." : firstMessage,
    timestamp: new Date().toISOString(),
    language,
  });
  // Keep max 20 sessions
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions.slice(0, 20)));
}

export function getSessionToken(sessionId: string): string | undefined {
  return getSavedSessions().find((session) => session.sessionId === sessionId)?.sessionToken;
}

export function clearSavedSessions(): void {
  localStorage.removeItem(SESSIONS_KEY);
}
