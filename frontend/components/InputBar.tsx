"use client";

import { useState, KeyboardEvent } from "react";
import { Paperclip, Camera, Send } from "lucide-react";

interface InputBarProps {
  onSend: (message: string) => void;
  disabled?: boolean;
}

export default function InputBar({ onSend, disabled }: InputBarProps) {
  const [value, setValue] = useState("");

  const handleSubmit = () => {
    if (!value.trim() || disabled) return;
    onSend(value.trim());
    setValue("");
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <>
      <p className="terms-text">
        By messaging, you agree to our{" "}
        <a href="#terms">Terms</a> &{" "}
        <a href="#privacy">Privacy Policy</a>
      </p>
      <div className="input-bar">
        <div className="input-container">
          <button
            className="input-icon-btn"
            aria-label="Attach file"
            type="button"
          >
            <Paperclip size={16} />
          </button>
          <input
            type="text"
            className="input-field"
            placeholder="Ask anything"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            aria-label="Chat message input"
          />
          <div className="input-actions">
            <button
              className="input-icon-btn"
              aria-label="Take photo"
              type="button"
            >
              <Camera size={16} />
            </button>
            <button
              className="input-icon-btn"
              aria-label="Send message"
              type="button"
              onClick={handleSubmit}
              disabled={disabled || !value.trim()}
              style={{
                color: value.trim() ? "#003B75" : undefined,
              }}
            >
              <Send size={16} />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
