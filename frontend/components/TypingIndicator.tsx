"use client";

import { MessageCircle } from "lucide-react";

export default function TypingIndicator() {
  return (
    <div className="ai-message animate-in">
      <div className="ai-avatar">
        <MessageCircle size={14} color="white" />
      </div>
      <div className="typing-indicator">
        <div className="typing-dot" />
        <div className="typing-dot" />
        <div className="typing-dot" />
      </div>
    </div>
  );
}
