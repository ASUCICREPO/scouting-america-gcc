"use client";

import { useState } from "react";
import { ThumbsUp, ThumbsDown, Copy, Volume2, VolumeX, ExternalLink, ChevronRight } from "lucide-react";
import { ChatMessage } from "@/lib/api";
import MarkdownContent from "./MarkdownContent";
import { useLanguage } from "@/context/LanguageContext";
import { languageLocale } from "@/lib/i18n";

interface MessageBubbleProps {
  message: ChatMessage;
  onChipClick: (text: string) => void;
  onFeedback?: (feedback: "positive" | "negative") => void;
}

export default function MessageBubble({
  message,
  onChipClick,
  onFeedback,
}: MessageBubbleProps) {
  const { language, t } = useLanguage();
  const [copied, setCopied] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  const toggleSpeech = () => {
    if (isSpeaking) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
      return;
    }
    const utterance = new SpeechSynthesisUtterance(message.content);
    utterance.lang = languageLocale(language);
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);
    window.speechSynthesis.speak(utterance);
    setIsSpeaking(true);
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
          <p className="suggestions-label">{t.chat.suggestedFollowUps}</p>
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
        <button
          className="feedback-btn"
          aria-label={t.chat.helpful}
          aria-pressed={message.feedback === "positive"}
          onClick={() => onFeedback?.("positive")}
          disabled={!message.messageId}
          style={message.feedback === "positive" ? { opacity: 1, color: "#006747" } : undefined}
        >
          <ThumbsUp size={16} />
        </button>
        <button
          className="feedback-btn"
          aria-label={t.chat.notHelpful}
          aria-pressed={message.feedback === "negative"}
          onClick={() => onFeedback?.("negative")}
          disabled={!message.messageId}
          style={message.feedback === "negative" ? { opacity: 1, color: "#CE1126" } : undefined}
        >
          <ThumbsDown size={16} />
        </button>
        <button
          className="feedback-btn"
          aria-label={t.chat.copyResponse}
          onClick={handleCopy}
          style={copied ? { opacity: 1, color: "#006747" } : undefined}
        >
          <Copy size={16} />
        </button>
        <button
          className="feedback-btn"
          aria-label={isSpeaking ? t.chat.stopSpeaking : t.chat.readAloud}
          onClick={toggleSpeech}
          style={isSpeaking ? { opacity: 1, color: "#CE1126" } : undefined}
        >
          {isSpeaking ? <VolumeX size={16} /> : <Volume2 size={16} />}
        </button>
      </div>
    </div>
  );
}
