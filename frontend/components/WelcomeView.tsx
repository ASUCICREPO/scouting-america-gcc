"use client";

interface WelcomeViewProps {
  onChipClick: (text: string) => void;
}

export default function WelcomeView({ onChipClick }: WelcomeViewProps) {
  return (
    <div className="welcome-container animate-in">
      {/* Avatar */}
      <div
        className="welcome-avatar"
        style={{
          width: 88,
          height: 87,
          borderRadius: "50%",
          background: "linear-gradient(135deg, #E8D5B7 0%, #D4A574 100%)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
          <path
            d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"
            fill="#8B6914"
          />
        </svg>
      </div>

      {/* Title */}
      <h1 className="welcome-title">
        Hi, Scouter! How can I
        <br />
        help you today?
      </h1>

      {/* Subtitle */}
      <p className="welcome-subtitle">
        Ask anything. AI may make mistakes, but we&apos;ll do our best to help.
      </p>
    </div>
  );
}
