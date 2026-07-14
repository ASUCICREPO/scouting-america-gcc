"use client";

import { useState, useRef, useEffect } from "react";
import Header from "@/components/Header";
import ChatArea from "@/components/ChatArea";
import InputBar from "@/components/InputBar";
import TabBar from "@/components/TabBar";
import FAQView from "@/components/FAQView";
import Sidebar from "@/components/Sidebar";
import SettingsView from "@/components/SettingsView";
import ChatDrawer from "@/components/ChatDrawer";
import PwaInstallBanner from "@/components/PwaInstallBanner";
import { sendMessage, ChatMessage, ChatResponse } from "@/lib/api";

type View = "chat" | "faq" | "settings";

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [showWelcome, setShowWelcome] = useState(true);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [currentView, setCurrentView] = useState<View>("chat");
  const chatEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  // Load and apply persisted settings on mount
  useEffect(() => {
    const stored = localStorage.getItem("chat_settings");
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (parsed.darkMode) {
          document.documentElement.setAttribute("data-theme", "dark");
        }
        if (parsed.fontSize) {
          document.documentElement.style.setProperty("--chat-font-size", `${parsed.fontSize}px`);
        }
      } catch {}
    }
  }, []);

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
      const response: ChatResponse = await sendMessage(text, sessionId);

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
        content:
          "I'm sorry, I'm having trouble connecting right now. Please try again.",
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

  const handleNewChat = () => {
    handleEndChat();
    setIsDrawerOpen(false);
  };

  const renderContent = () => {
    switch (currentView) {
      case "faq":
        return <FAQView onBack={() => setCurrentView("chat")} />;
      case "settings":
        return <SettingsView onBack={() => setCurrentView("chat")} />;
      case "chat":
      default:
        return (
          <>
            <ChatArea
              messages={messages}
              isLoading={isLoading}
              showWelcome={showWelcome}
              onChipClick={handleChipClick}
              onEndChat={handleEndChat}
              chatEndRef={chatEndRef}
            />
            <p className="terms-text">
              By messaging, you agree to our{" "}
              <a href="#terms">Terms</a> &{" "}
              <a href="#privacy">Privacy Policy</a>
            </p>
            <InputBar onSend={handleSend} disabled={isLoading} />
          </>
        );
    }
  };

  return (
    <div className="app-layout">
      {/* Desktop persistent sidebar */}
      <Sidebar
        onNewChat={handleNewChat}
        onFaqClick={() => setCurrentView("faq")}
        onSettingsClick={() => setCurrentView("settings")}
      />

      {/* Main chat area */}
      <div className="app-shell">
        <div className="status-bar-spacer" />
        <Header onMenuClick={() => setIsDrawerOpen(true)} />
        {renderContent()}
        <TabBar />
        <div className="safe-bottom" />
      </div>

      {/* Mobile drawer (hidden on desktop) */}
      <ChatDrawer
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        onNewChat={handleNewChat}
        onSettingsClick={() => {
          setIsDrawerOpen(false);
          setCurrentView("faq");
        }}
      />
      <PwaInstallBanner />
    </div>
  );
}
