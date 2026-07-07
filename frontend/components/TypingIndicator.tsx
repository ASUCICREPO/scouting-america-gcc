"use client";

export default function TypingIndicator() {
  return (
    <div className="typing-container animate-in">
      <div
        className="typing-avatar"
        style={{
          background: "linear-gradient(135deg, #E8D5B7 0%, #D4A574 100%)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path
            d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"
            fill="#8B6914"
          />
        </svg>
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
