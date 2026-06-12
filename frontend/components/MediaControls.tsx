"use client";

import { ThumbsUp, Maximize2, XCircle } from "lucide-react";

interface MediaControlsProps {
  onEndChat: () => void;
}

export default function MediaControls({ onEndChat }: MediaControlsProps) {
  return (
    <div className="media-controls">
      <button className="media-btn" aria-label="Like">
        <ThumbsUp size={15} />
      </button>
      <button className="media-btn" aria-label="Fullscreen">
        <Maximize2 size={15} />
      </button>
      <button className="media-btn media-btn-end" onClick={onEndChat}>
        <XCircle size={13} />
        <span>End</span>
      </button>
    </div>
  );
}
