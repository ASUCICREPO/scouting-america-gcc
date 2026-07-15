"use client";

import { useLanguage } from "@/context/LanguageContext";

interface WelcomeViewProps {
  onChipClick: (text: string) => void;
}

export default function WelcomeView({ onChipClick }: WelcomeViewProps) {
  const { t } = useLanguage();
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
        {t.chat.welcomeTitle}
      </h1>

      {/* Subtitle */}
      <p className="welcome-subtitle">
        {t.chat.welcomeSubtitle}
      </p>

      <div className="welcome-quick-actions">
        {t.chat.quickActions.map((action) => (
          <button key={action.label} type="button" onClick={() => onChipClick(action.prompt)}>
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}
