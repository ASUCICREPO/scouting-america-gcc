"use client";

import { MessageCircle } from "lucide-react";

interface WelcomeViewProps {
  onChipClick: (text: string) => void;
}

const QUICK_ACTIONS = [
  ["Join Scouting", "Find a Unit"],
  ["Upcoming Events", "Volunteer"],
];

export default function WelcomeView({ onChipClick }: WelcomeViewProps) {
  return (
    <div className="animate-in">
      {/* Hero Video/Image Area */}
      <div className="hero-video">
        <div
          style={{
            width: "100%",
            height: "100%",
            background:
              "linear-gradient(135deg, #003B75 0%, #005DAA 50%, #0077CC 100%)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: "50%",
              background: "rgba(255,255,255,0.15)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <polygon
                points="12,2 15,8 22,9 17,14 18,21 12,18 6,21 7,14 2,9 9,8"
                fill="rgba(255,255,255,0.9)"
              />
            </svg>
          </div>
          <span
            style={{
              color: "rgba(255,255,255,0.8)",
              fontSize: 13,
              fontWeight: 500,
            }}
          >
            Scouting America
          </span>
        </div>
      </div>

      {/* Welcome message */}
      <div className="ai-message" style={{ marginTop: 16 }}>
        <div className="ai-avatar">
          <MessageCircle size={14} color="white" />
        </div>
        <div className="ai-bubble">
          <p className="ai-text">
            Welcome to Scouting America! How can I help today?
          </p>
          <p className="ai-subtext">Is this what you&apos;re looking for?</p>
        </div>
      </div>

      {/* Quick action chips */}
      <div style={{ paddingLeft: 36, marginTop: 12 }}>
        {QUICK_ACTIONS.map((row, rowIndex) => (
          <div
            className="chips-container"
            key={rowIndex}
            style={{ marginBottom: 8 }}
          >
            {row.map((chip) => (
              <button
                key={chip}
                className="chip"
                onClick={() => onChipClick(chip)}
              >
                {chip}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
