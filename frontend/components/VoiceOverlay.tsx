"use client";

import { Mic } from "lucide-react";

interface VoiceOverlayProps {
  isVisible: boolean;
  onCancel: () => void;
}

export default function VoiceOverlay({ isVisible, onCancel }: VoiceOverlayProps) {
  if (!isVisible) return null;

  return (
    <div className="voice-overlay animate-in">
      <div className="voice-ring">
        <div className="voice-ring-inner">
          <Mic size={32} color="white" />
        </div>
      </div>
      <p className="voice-text">Listening...</p>
      <button className="voice-cancel-btn" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
