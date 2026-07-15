"use client";

import { useState, useEffect } from "react";
import {
  Plus,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
  Info,
  Settings,
} from "lucide-react";
import { getSavedSessions, SavedSession } from "@/lib/api";
import { useLanguage } from "@/context/LanguageContext";

interface SidebarProps {
  onNewChat: () => void;
  onFaqClick: () => void;
  onSettingsClick: () => void;
  onLoadSession: (sessionId: string) => void;
  activeSessionId?: string;
}

const STORAGE_KEY = "sidebar_collapsed";

export default function Sidebar({
  onNewChat,
  onFaqClick,
  onSettingsClick,
  onLoadSession,
  activeSessionId,
}: SidebarProps) {
  const { t } = useLanguage();
  const [collapsed, setCollapsed] = useState(false);
  const [sessions, setSessions] = useState<SavedSession[]>([]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "true") setCollapsed(true);
      setSessions(getSavedSessions());
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  // Refresh sessions when sidebar renders (e.g., after a new chat)
  useEffect(() => {
    const interval = setInterval(() => {
      setSessions(getSavedSessions());
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  const toggleCollapse = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem(STORAGE_KEY, String(next));
  };

  return (
    <aside className={`sidebar ${collapsed ? "sidebar-collapsed" : ""}`}>
      {/* Toggle button */}
      <button
        className="sidebar-toggle"
        onClick={toggleCollapse}
        aria-label={collapsed ? t.chat.expandSidebar : t.chat.collapseSidebar}
      >
        {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
      </button>

      {/* New Chat */}
      <button className="sidebar-new-chat" onClick={onNewChat}>
        <Plus size={18} />
        {!collapsed && <span>{t.chat.newChat}</span>}
      </button>

      {/* Chat History */}
      <div className="sidebar-section">
        <div className="sidebar-section-header">
          <MessageSquare size={14} />
          {!collapsed && <span>{t.chat.chatHistory}</span>}
        </div>
        {sessions.length > 0 ? (
          <div className="sidebar-history-list">
            {sessions.map((session) => (
              <button
                key={session.sessionId}
                className={`sidebar-history-item ${
                  activeSessionId === session.sessionId ? "active" : ""
                }`}
                onClick={() => onLoadSession(session.sessionId)}
                title={session.title}
              >
                {!collapsed ? (
                  <span className="sidebar-history-text">{session.title}</span>
                ) : (
                  <MessageSquare size={14} />
                )}
              </button>
            ))}
          </div>
        ) : (
          <div className="sidebar-empty">
            {!collapsed && <p>{t.chat.historyEmpty}</p>}
          </div>
        )}
      </div>

      {/* Spacer */}
      <div className="sidebar-spacer" />

      {/* Bottom links */}
      <div className="sidebar-bottom">
        <button className="sidebar-item" onClick={onFaqClick}>
          <Info size={16} />
          {!collapsed && <span>{t.chat.moreInformation}</span>}
        </button>
        <button className="sidebar-item" onClick={onSettingsClick}>
          <Settings size={16} />
          {!collapsed && <span>{t.common.settings}</span>}
        </button>
      </div>
    </aside>
  );
}
