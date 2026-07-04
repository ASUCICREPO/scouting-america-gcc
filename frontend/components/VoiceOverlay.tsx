"use client";

interface VoiceOverlayProps {
  isVisible: boolean;
  onCancel: () => void;
}

export default function VoiceOverlay({ isVisible, onCancel }: VoiceOverlayProps) {
  if (!isVisible) return null;

  return (
    <div className="voice-overlay animate-in">
      <p className="voice-text">Listening</p>
      <div className="voice-waveform">
        {Array.from({ length: 24 }).map((_, i) => (
          <div
            key={i}
            className="voice-bar"
            style={{ animationDelay: `${i * 0.06}s` }}
          />
        ))}
      </div>
      <button className="voice-cancel-btn" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
