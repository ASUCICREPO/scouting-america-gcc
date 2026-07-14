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

interface SidebarProps {
  onNewChat: () => void;
  onFaqClick: () => void;
  onSettingsClick: () => void;
}

const STORAGE_KEY = "sidebar_collapsed";

export default function Sidebar({ onNewChat, onFaqClick, onSettingsClick }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "true") setCollapsed(true);
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
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
      </button>

      {/* New Chat */}
      <button className="sidebar-new-chat" onClick={onNewChat}>
        <Plus size={18} />
        {!collapsed && <span>New chat</span>}
      </button>

      {/* Chat History */}
      <div className="sidebar-section">
        <div className="sidebar-section-header">
          <MessageSquare size={14} />
          {!collapsed && <span>Chat History</span>}
        </div>
        <div className="sidebar-empty">
          {!collapsed && (
            <p>Your conversations will appear here</p>
          )}
        </div>
      </div>

      {/* Spacer */}
      <div className="sidebar-spacer" />

      {/* Bottom links */}
      <div className="sidebar-bottom">
        <button className="sidebar-item" onClick={onFaqClick}>
          <Info size={16} />
          {!collapsed && <span>More information</span>}
        </button>
        <button className="sidebar-item" onClick={onSettingsClick}>
          <Settings size={16} />
          {!collapsed && <span>Settings</span>}
        </button>
      </div>
    </aside>
  );
}
