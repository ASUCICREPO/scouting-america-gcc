"use client";

import { X, Plus } from "lucide-react";

interface ChatDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onNewChat: () => void;
  onSettingsClick: () => void;
}

export default function ChatDrawer({
  isOpen,
  onClose,
  onNewChat,
  onSettingsClick,
}: ChatDrawerProps) {
  if (!isOpen) return null;

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <div className="drawer animate-in">
        <button className="drawer-close-btn" onClick={onClose} aria-label="Close">
          <X size={20} />
        </button>

        {/* New chat button */}
        <button className="new-chat-btn" onClick={onNewChat}>
          <Plus size={18} />
          <span>New chat</span>
        </button>

        {/* Chat History — conversations are session-only and not persisted yet */}
        <p className="history-section-title">Chat History</p>
        <div className="history-empty">No past conversations</div>

        {/* Settings */}
        <p className="history-section-title">More information</p>
        <div className="history-item" onClick={onSettingsClick}>
          Settings
        </div>
      </div>
    </>
  );
}
