"use client";

import { useState } from "react";
import { ThumbsUp, Copy, ExternalLink, ChevronRight } from "lucide-react";
import { ChatMessage } from "@/lib/api";
import MarkdownContent from "./MarkdownContent";

interface MessageBubbleProps {
  message: ChatMessage;
  onChipClick: (text: string) => void;
}

export default function MessageBubble({
  message,
  onChipClick,
}: MessageBubbleProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  if (message.role === "user") {
    return (
      <div className="user-message-row animate-in">
        <div className="user-bubble">{message.content}</div>
      </div>
    );
  }

  return (
    <div className="ai-response animate-in">
      {/* Response text (rendered as markdown) */}
      <MarkdownContent content={message.content} className="ai-response-body" />


      {/* Link cards */}
      {message.links && message.links.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {message.links.map((link, idx) => (
            <a
              key={idx}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="link-card"
            >
              <ExternalLink size={15} className="link-card-icon" />
              <span className="link-card-text">{link.title}</span>
              <ChevronRight size={13} className="link-card-arrow" />
            </a>
          ))}
        </div>
      )}

      {/* Suggestion chips */}
      {message.suggestions && message.suggestions.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <p className="suggestions-label">Suggested follow-ups</p>
          {message.suggestions.map((suggestion) => (
            <button
              key={suggestion}
              className="suggestion-btn"
              onClick={() => onChipClick(suggestion)}
            >
              <span className="suggestion-btn-text">{suggestion}</span>
              <ChevronRight size={13} className="suggestion-btn-icon" />
            </button>
          ))}
        </div>
      )}

      {/* Feedback row */}
      <div className="feedback-row">
        <button className="feedback-btn" aria-label="Helpful">
          <ThumbsUp size={16} />
        </button>
        <button
          className="feedback-btn"
          aria-label="Copy response"
          onClick={handleCopy}
          style={copied ? { opacity: 1, color: "#006747" } : undefined}
        >
          <Copy size={16} />
        </button>
      </div>
    </div>
  );
}
