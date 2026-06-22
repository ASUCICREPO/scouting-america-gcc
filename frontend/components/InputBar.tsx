"use client";

import { useState, useRef, KeyboardEvent } from "react";
import { Paperclip, Camera, Send, Mic, MicOff } from "lucide-react";

interface InputBarProps {
  onSend: (message: string) => void;
  disabled?: boolean;
}

export default function InputBar({ onSend, disabled }: InputBarProps) {
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
      // Stop listening
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }

    // Check browser support
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

    recognition.onstart = () => setIsListening(true);

    recognition.onresult = (event: any) => {
      const transcript = Array.from(event.results)
        .map((result: any) => result[0].transcript)
        .join("");
      setValue(transcript);
    };

    recognition.onerror = () => setIsListening(false);
    recognition.onend = () => setIsListening(false);

    recognitionRef.current = recognition;
    recognition.start();
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
              aria-label={isListening ? "Stop recording" : "Voice input"}
              type="button"
              onClick={toggleSpeechRecognition}
              style={{
                color: isListening ? "#e53e3e" : undefined,
              }}
            >
              {isListening ? <MicOff size={16} /> : <Mic size={16} />}
            </button>
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
