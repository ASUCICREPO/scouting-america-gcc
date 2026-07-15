"use client";

import { useState, useEffect } from "react";
import { X, Plus, Info, Settings } from "lucide-react";
import { getSavedSessions, SavedSession } from "@/lib/api";
import { useLanguage } from "@/context/LanguageContext";

interface ChatDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onNewChat: () => void;
  onFaqClick: () => void;
  onSettingsClick: () => void;
  onLoadSession: (sessionId: string) => void;
  activeSessionId?: string;
}

export default function ChatDrawer({
  isOpen,
  onClose,
  onNewChat,
  onFaqClick,
  onSettingsClick,
  onLoadSession,
  activeSessionId,
}: ChatDrawerProps) {
  const { t } = useLanguage();
  const [sessions, setSessions] = useState<SavedSession[]>([]);

  useEffect(() => {
    if (!isOpen) return;
    const frame = window.requestAnimationFrame(() => setSessions(getSavedSessions()));
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <div className="drawer animate-in">
        <button className="drawer-close-btn" onClick={onClose} aria-label={t.common.close}>
          <X size={20} />
        </button>

        {/* New chat button */}
        <button className="new-chat-btn" onClick={onNewChat}>
          <Plus size={18} />
          <span>{t.chat.newChat}</span>
        </button>

        {/* Chat History */}
        <p className="history-section-title">{t.chat.chatHistory}</p>
        {sessions.length > 0 ? (
          sessions.map((session) => (
            <div
              key={session.sessionId}
              className={`history-item ${activeSessionId === session.sessionId ? "active" : ""}`}
              onClick={() => {
                onLoadSession(session.sessionId);
                onClose();
              }}
            >
              {session.title}
            </div>
          ))
        ) : (
          <div className="history-empty">{t.chat.noPastConversations}</div>
        )}

        {/* More information & Settings */}
        <p className="history-section-title">{t.chat.support}</p>
        <div className="history-item" onClick={() => { onFaqClick(); onClose(); }}>
          <Info size={14} style={{ marginRight: 8, opacity: 0.6 }} />
          {t.chat.moreInformation}
        </div>
        <div className="history-item" onClick={() => { onSettingsClick(); onClose(); }}>
          <Settings size={14} style={{ marginRight: 8, opacity: 0.6 }} />
          {t.common.settings}
        </div>
      </div>
    </>
  );
}
