import { API_BASE_URL } from "./config";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
  suggestions?: string[];
  links?: { title: string; url: string }[];
}

export interface ChatResponse {
  message: string;
  suggestions?: string[];
  links?: { title: string; url: string }[];
  sessionId?: string;
}

export async function sendMessage(
  message: string,
  sessionId?: string,
  token?: string
): Promise<ChatResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (token) {
    headers["Authorization"] = token;
  }

  const response = await fetch(`${API_BASE_URL}/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      question: message,
      sessionId,
    }),
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('Please log in to chat with the assistant.');
    }
    throw new Error(`Chat API error: ${response.status}`);
  }

  const data = await response.json();
  // Map backend response format to frontend expected format
  return {
    message: data.answer || data.message || '',
    suggestions: data.suggestions,
    links: data.links,
    sessionId: data.sessionId,
  };
}

export async function getAnalytics(token: string) {
  const response = await fetch(`${API_BASE_URL}/analytics`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Analytics API error: ${response.status}`);
  }

  return response.json();
}
