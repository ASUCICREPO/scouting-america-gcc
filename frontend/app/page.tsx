"use client";

import { useState, useRef, useEffect } from "react";
import Header from "@/components/Header";
import ChatArea from "@/components/ChatArea";
import InputBar from "@/components/InputBar";
import TabBar from "@/components/TabBar";
import { sendMessage, ChatMessage, ChatResponse } from "@/lib/api";
import { getStoredTokens } from "@/lib/auth";

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [showWelcome, setShowWelcome] = useState(true);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSend = async (text: string) => {
    if (!text.trim() || isLoading) return;

    setShowWelcome(false);

    const userMessage: ChatMessage = {
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setIsLoading(true);

    try {
      const tokens = getStoredTokens();
      const response: ChatResponse = await sendMessage(
        text,
        sessionId,
        tokens?.idToken
      );

      if (response.sessionId) {
        setSessionId(response.sessionId);
      }

      const aiMessage: ChatMessage = {
        role: "assistant",
        content: response.message,
        timestamp: new Date().toISOString(),
        suggestions: response.suggestions,
        links: response.links,
      };

      setMessages((prev) => [...prev, aiMessage]);
    } catch (error) {
      console.error("Chat error:", error);
      const errorMessage: ChatMessage = {
        role: "assistant",
        content: "I'm sorry, I'm having trouble connecting right now. Please try again.",
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleChipClick = (chipText: string) => {
    handleSend(chipText);
  };

  const handleEndChat = () => {
    setMessages([]);
    setSessionId(undefined);
    setShowWelcome(true);
  };

  return (
    <div className="app-shell">
      <div className="status-bar-spacer" />
      <Header />
      <ChatArea
        messages={messages}
        isLoading={isLoading}
        showWelcome={showWelcome}
        onChipClick={handleChipClick}
        onEndChat={handleEndChat}
        chatEndRef={chatEndRef}
      />
      <InputBar onSend={handleSend} disabled={isLoading} />
      <TabBar />
      <div className="safe-bottom" />
    </div>
  );
}
