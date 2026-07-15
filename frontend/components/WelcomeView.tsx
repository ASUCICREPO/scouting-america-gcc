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
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
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
