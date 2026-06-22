"use client";

import { useState } from "react";
import {
  MessageCircle,
  ThumbsUp,
  ThumbsDown,
  ExternalLink,
  Link as LinkIcon,
  Volume2,
  VolumeX,
} from "lucide-react";
import { ChatMessage } from "@/lib/api";

interface MessageBubbleProps {
  message: ChatMessage;
  onChipClick: (text: string) => void;
}

export default function MessageBubble({
  message,
  onChipClick,
}: MessageBubbleProps) {
  const [isSpeaking, setIsSpeaking] = useState(false);

  const toggleSpeech = () => {
    if (isSpeaking) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
      return;
    }
    const utterance = new SpeechSynthesisUtterance(message.content);
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);
    window.speechSynthesis.speak(utterance);
    setIsSpeaking(true);
  };

  if (message.role === "user") {
    return (
      <div className="user-message animate-in">
        <div className="user-bubble">{message.content}</div>
      </div>
    );
  }

  return (
    <div className="ai-message animate-in">
      <div className="ai-avatar">
        <MessageCircle size={14} color="white" />
      </div>
      <div className="ai-bubble">
        <p className="ai-text">{message.content}</p>

        {/* Link cards */}
        {message.links && message.links.length > 0 && (
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            {message.links.map((link, idx) => (
              <a
                key={idx}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="link-card"
              >
                <LinkIcon size={15} className="link-card-icon" />
                <span className="link-card-text">{link.title}</span>
                <ExternalLink size={13} className="link-card-arrow" />
              </a>
            ))}
          </div>
        )}

        {/* Suggestion chips */}
        {message.suggestions && message.suggestions.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <p className="follow-ups-label">Suggested follow-ups</p>
            <div className="chips-container">
              {message.suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  className="chip"
                  onClick={() => onChipClick(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Feedback row */}
        <div className="feedback-row" style={{ marginTop: 8 }}>
          <button className="feedback-btn" aria-label="Helpful">
            <ThumbsUp size={13} />
          </button>
          <button className="feedback-btn" aria-label="Not helpful">
            <ThumbsDown size={13} />
          </button>
          <button
            className="feedback-btn"
            aria-label={isSpeaking ? "Stop speaking" : "Read aloud"}
            onClick={toggleSpeech}
            style={{ color: isSpeaking ? "#e53e3e" : undefined }}
          >
            {isSpeaking ? <VolumeX size={13} /> : <Volume2 size={13} />}
          </button>
        </div>
      </div>
    </div>
  );
}
