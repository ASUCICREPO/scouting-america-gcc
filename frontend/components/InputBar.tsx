"use client";

import { useState, useRef, KeyboardEvent } from "react";
import { Mic, Send } from "lucide-react";

interface InputBarProps {
  onSend: (message: string) => void;
  disabled?: boolean;
  onVoiceStart?: () => void;
  onVoiceEnd?: () => void;
}

export default function InputBar({
  onSend,
  disabled,
  onVoiceStart,
  onVoiceEnd,
}: InputBarProps) {
  const [value, setValue] = useState("");
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<any>(null);

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

  const toggleSpeechRecognition = () => {
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      onVoiceEnd?.();
      return;
    }

    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      alert("Speech recognition is not supported in this browser.");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onstart = () => {
      setIsListening(true);
      onVoiceStart?.();
    };

    recognition.onresult = (event: any) => {
      const transcript = Array.from(event.results)
        .map((result: any) => result[0].transcript)
        .join("");
      setValue(transcript);
    };

    recognition.onerror = () => {
      setIsListening(false);
      onVoiceEnd?.();
    };

    recognition.onend = () => {
      setIsListening(false);
      onVoiceEnd?.();
    };

    recognitionRef.current = recognition;
    recognition.start();
  };

  return (
    <div className="input-section">
      <div className="input-container">
        <div className="input-row">
          <input
            type="text"
            className="input-field"
            placeholder="Chat with Zarg"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            aria-label="Chat message input"
          />
          <div className="input-actions">
            <button
              className="input-btn"
              aria-label="Send message"
              type="button"
              onClick={handleSubmit}
              disabled={disabled || !value.trim()}
            >
              <Send size={16} />
            </button>
            <button
              className="input-btn-voice"
              aria-label={isListening ? "Stop recording" : "Voice input"}
              type="button"
              onClick={toggleSpeechRecognition}
              style={
                isListening
                  ? { background: "#CE1126" }
                  : undefined
              }
            >
              <Mic size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
