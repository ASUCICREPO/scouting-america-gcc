import { beforeEach, describe, expect, it, vi } from "vitest";

import { getChatHistory, sendMessage } from "./api";

const jsonResponse = (body: unknown): Response => ({
  ok: true,
  status: 200,
  json: vi.fn().mockResolvedValue(body),
}) as unknown as Response;

describe("public chat citation links", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("maps signed source links from a live chat response", async () => {
    const links = [{
      title: "Camp Guide.pdf",
      url: "https://signed.example/Camp%20Guide.pdf",
    }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      answer: "Grounded answer",
      links,
      sessionId: "session-1",
      sessionToken: "session-token",
      messageId: "message-1",
      language: "en",
    })));

    await expect(sendMessage("Where is camp?")).resolves.toMatchObject({
      message: "Grounded answer",
      links,
    });
  });

  it("keeps refreshed source links on assistant messages loaded from history", async () => {
    const links = [{
      title: "History Guide.pdf",
      url: "https://signed.example/History%20Guide.pdf",
    }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      history: [{
        question: "Earlier question",
        answer: "Earlier answer",
        timestamp: "2026-08-18T00:00:00.000Z",
        links,
        language: "en",
      }],
    })));

    const history = await getChatHistory("session-1", "session-token");

    expect(history.messages).toEqual([
      {
        role: "user",
        content: "Earlier question",
        timestamp: "2026-08-18T00:00:00.000Z",
      },
      {
        role: "assistant",
        content: "Earlier answer",
        timestamp: "2026-08-18T00:00:00.000Z",
        links,
      },
    ]);
  });
});
