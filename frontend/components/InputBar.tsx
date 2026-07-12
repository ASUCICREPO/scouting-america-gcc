"use client";

import { useState, useRef, useEffect, KeyboardEvent } from "react";
import { Mic, Send, X, Check } from "lucide-react";

interface InputBarProps {
  onSend: (message: string) => void;
  disabled?: boolean;
}

export default function InputBar({ onSend, disabled }: InputBarProps) {
  const [value, setValue] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [barHeights, setBarHeights] = useState<number[]>(new Array(40).fill(3));
  const recognitionRef = useRef<any>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (audioContextRef.current) audioContextRef.current.close();
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    };
  }, []);

  const startAudioAnalysis = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 128;
      source.connect(analyser);
      analyserRef.current = analyser;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const barCount = 40;

      const updateBars = () => {
        analyser.getByteFrequencyData(dataArray);
        // Map frequency data to bar heights (3px min = dot, 28px max)
        const newHeights: number[] = [];
        const step = Math.floor(dataArray.length / barCount);
        for (let i = 0; i < barCount; i++) {
          const val = dataArray[i * step] || 0;
          // Normalize 0-255 to 3-28px
          const height = Math.max(3, (val / 255) * 28);
          newHeights.push(height);
        }
        setBarHeights(newHeights);
        animFrameRef.current = requestAnimationFrame(updateBars);
      };
      updateBars();
    } catch {
      // Fallback: static dots if mic access fails
    }
  };

  const stopAudioAnalysis = () => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    analyserRef.current = null;
    setBarHeights(new Array(40).fill(3));
  };

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

  const startListening = () => {
    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      alert("Speech recognition is not supported in this browser.");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onstart = () => {
      setIsListening(true);
      setTranscript("");
      startAudioAnalysis();
    };

    recognition.onresult = (event: any) => {
      const result = Array.from(event.results)
        .map((r: any) => r[0].transcript)
        .join("");
      setTranscript(result);
    };

    recognition.onerror = () => {
      setIsListening(false);
      stopAudioAnalysis();
    };

    recognition.onend = () => {
      setIsListening(false);
      stopAudioAnalysis();
    };

    recognitionRef.current = recognition;
    recognition.start();
  };

  const cancelListening = () => {
    recognitionRef.current?.stop();
    setIsListening(false);
    setTranscript("");
    stopAudioAnalysis();
  };

  const confirmListening = () => {
    recognitionRef.current?.stop();
    setIsListening(false);
    setValue(transcript);
    setTranscript("");
    stopAudioAnalysis();
  };

  // Recording state
  if (isListening) {
    return (
      <div className="input-section">
        <div className="input-container input-recording">
          <div className="input-row">
            <div className="recording-waveform">
              {barHeights.map((h, i) => (
                <div
                  key={i}
                  className="recording-bar"
                  style={{ height: `${h}px`, animation: "none" }}
                />
              ))}
            </div>
            <div className="recording-actions">
              <button
                className="recording-cancel-btn"
                onClick={cancelListening}
                aria-label="Cancel recording"
                type="button"
              >
                <X size={18} />
              </button>
              <button
                className="recording-confirm-btn"
                onClick={confirmListening}
                aria-label="Confirm recording"
                type="button"
              >
                <Check size={18} />
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Normal state
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
              aria-label="Voice input"
              type="button"
              onClick={startListening}
            >
              <Mic size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
