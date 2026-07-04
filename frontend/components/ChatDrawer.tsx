"use client";

import { X, Plus } from "lucide-react";

const HISTORY_ITEMS = [
  "What are the core values of Scouting?",
  "Scouts BSA vs. Cub Scouts",
  "Merit Badge Requirements",
  "Upcoming Council Events",
  "Registration Fees & Financial Assistance",
];

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

        {/* Chat History */}
        <p className="history-section-title">Chat History</p>
        {HISTORY_ITEMS.map((item, idx) => (
          <div key={idx} className="history-item">
            {item}
          </div>
        ))}

        {/* Settings */}
        <p className="history-section-title">More information</p>
        <div className="history-item" onClick={onSettingsClick}>
          Settings
        </div>
      </div>
    </>
  );
}
