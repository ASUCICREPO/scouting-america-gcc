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
