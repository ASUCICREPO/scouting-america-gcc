"use client";

import { useLanguage } from "@/context/LanguageContext";

export default function TypingIndicator() {
  const { t } = useLanguage();
  return (
    <div className="typing-container animate-in">
      <div
        className="typing-avatar"
        style={{
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-start",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/gcc-compass-logo.png"
          alt="GCC Compass"
          style={{ width: "auto", maxWidth: "none", height: "100%", flexShrink: 0 }}
        />
      </div>
      <span style={{ fontSize: 14, color: "#5a5a72" }}>{t.chat.thinking}</span>
      <div className="typing-dots">
        <div className="typing-dot" />
        <div className="typing-dot" />
        <div className="typing-dot" />
      </div>
    </div>
  );
}
