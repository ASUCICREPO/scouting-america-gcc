"use client";

export default function TypingIndicator() {
  return (
    <div className="typing-container animate-in">
      <div
        className="typing-avatar"
        style={{
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/gcc-emblem.jpg"
          alt="Grand Canyon Council"
          style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }}
        />
      </div>
      <span style={{ fontSize: 14, color: "#5a5a72" }}>Thinking...</span>
      <div className="typing-dots">
        <div className="typing-dot" />
        <div className="typing-dot" />
        <div className="typing-dot" />
      </div>
    </div>
  );
}
