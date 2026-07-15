"use client";

import { useState, useRef, useEffect } from "react";
import Header from "@/components/Header";
import ChatArea from "@/components/ChatArea";
import InputBar from "@/components/InputBar";
import FAQView from "@/components/FAQView";
import Sidebar from "@/components/Sidebar";
import SettingsView from "@/components/SettingsView";
import ChatDrawer from "@/components/ChatDrawer";
import PwaInstallBanner from "@/components/PwaInstallBanner";
import LanguageConfirmModal from "@/components/LanguageConfirmModal";
import { sendMessage, sendFeedback, getChatHistory, saveSession, ChatMessage, ChatResponse, Feedback } from "@/lib/api";
import { useLanguage } from "@/context/LanguageContext";
import { Language } from "@/lib/i18n";

type View = "chat" | "faq" | "settings";

export default function Home() {
  const { language, setLanguage, t } = useLanguage();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [showWelcome, setShowWelcome] = useState(true);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [currentView, setCurrentView] = useState<View>("chat");
  const [settingsSection, setSettingsSection] = useState<"terms" | "privacy" | null>(null);
  const [pendingLanguage, setPendingLanguage] = useState<Language | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const activeRequestRef = useRef(0);

  const openSettings = (section: "terms" | "privacy" | null = null) => {
    setSettingsSection(section);
    setCurrentView("settings");
  };

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
    const requestId = ++activeRequestRef.current;

    try {
      const response: ChatResponse = await sendMessage(text, sessionId, language);
      if (requestId !== activeRequestRef.current) return;

      if (response.sessionId) {
        setSessionId(response.sessionId);
        // Save session to history on first message
        if (!sessionId) {
          saveSession(response.sessionId, text, language);
        }
      }

      const aiMessage: ChatMessage = {
        role: "assistant",
        content: response.message,
        timestamp: new Date().toISOString(),
        suggestions: response.suggestions,
        links: response.links,
        messageId: response.messageId,
      };

      setMessages((prev) => [...prev, aiMessage]);
    } catch (error) {
      if (requestId !== activeRequestRef.current) return;
      console.error("Chat error:", error);
      const errorMessage: ChatMessage = {
        role: "assistant",
        content: t.chat.errorMessage,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      if (requestId === activeRequestRef.current) setIsLoading(false);
    }
  };

  const handleChipClick = (chipText: string) => {
    handleSend(chipText);
  };

  const handleFeedback = async (index: number, feedback: Feedback) => {
    const msg = messages[index];
    if (!msg || msg.role !== "assistant" || !msg.messageId || !sessionId) return;
    // Already rated this way — no-op (avoids the UI clearing a rating the
    // backend still holds). Switching between up/down is allowed and persisted.
    if (msg.feedback === feedback) return;
    const previous = msg.feedback;
    // Optimistically reflect the choice.
    setMessages((prev) =>
      prev.map((m, i) => (i === index ? { ...m, feedback } : m))
    );
    try {
      await sendFeedback(sessionId, msg.messageId, feedback);
    } catch (err) {
      console.error("Feedback error:", err);
      // Revert on failure.
      setMessages((prev) =>
        prev.map((m, i) => (i === index ? { ...m, feedback: previous } : m))
      );
    }
  };

  const handleEndChat = () => {
    activeRequestRef.current += 1;
    setIsLoading(false);
    setMessages([]);
    setSessionId(undefined);
    setShowWelcome(true);
  };

  const handleLanguageChange = (nextLanguage: Language) => {
    if (nextLanguage === language) return;
    if (messages.length > 0) {
      setPendingLanguage(nextLanguage);
      return;
    }
    setLanguage(nextLanguage);
  };

  const confirmLanguageChange = () => {
    if (!pendingLanguage) return;
    handleEndChat();
    setLanguage(pendingLanguage);
    setPendingLanguage(null);
  };

  const handleNewChat = () => {
    handleEndChat();
    setIsDrawerOpen(false);
  };

  const handleLoadSession = async (sid: string) => {
    activeRequestRef.current += 1;
    setIsLoading(false);
    try {
      const history = await getChatHistory(sid);
      setMessages(history.messages);
      setLanguage(history.language);
      setSessionId(sid);
      setShowWelcome(false);
      setCurrentView("chat");
    } catch (err) {
      console.error("Failed to load session:", err);
    }
  };

  const renderContent = () => {
    switch (currentView) {
      case "faq":
        return <FAQView onBack={() => setCurrentView("chat")} />;
      case "settings":
        return (
          <SettingsView
            onBack={() => setCurrentView("chat")}
            initialSection={settingsSection}
            onLanguageChange={handleLanguageChange}
          />
        );
      case "chat":
      default:
        return (
          <>
            <ChatArea
              messages={messages}
              isLoading={isLoading}
              showWelcome={showWelcome}
              onChipClick={handleChipClick}
              onFeedback={handleFeedback}
              chatEndRef={chatEndRef}
            />
            <p className="terms-text">
              {t.chat.termsAgreement}{" "}
              <a href="#" onClick={(e) => { e.preventDefault(); openSettings("terms"); }}>{t.chat.terms}</a>{" "}
              {t.chat.and}{" "}
              <a href="#" onClick={(e) => { e.preventDefault(); openSettings("privacy"); }}>{t.chat.privacyPolicy}</a>
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
        onSettingsClick={() => openSettings()}
        onLoadSession={handleLoadSession}
        activeSessionId={sessionId}
      />

      {/* Main chat area */}
      <div className="app-shell">
        <div className="status-bar-spacer" />
        <Header onMenuClick={() => setIsDrawerOpen(true)} />
        {renderContent()}
        <div className="safe-bottom" />
      </div>

      {/* Mobile drawer (hidden on desktop) */}
      <ChatDrawer
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        onNewChat={handleNewChat}
        onFaqClick={() => setCurrentView("faq")}
        onSettingsClick={() => openSettings()}
        onLoadSession={handleLoadSession}
        activeSessionId={sessionId}
      />
      <PwaInstallBanner />
      <LanguageConfirmModal
        isOpen={pendingLanguage !== null}
        onCancel={() => setPendingLanguage(null)}
        onConfirm={confirmLanguageChange}
      />
    </div>
  );
}
