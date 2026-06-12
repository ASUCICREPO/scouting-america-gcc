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
    headers["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      message,
      sessionId,
    }),
  });

  if (!response.ok) {
    throw new Error(`Chat API error: ${response.status}`);
  }

  return response.json();
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
