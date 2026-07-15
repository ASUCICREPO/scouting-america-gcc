"use client";

import { useState, useRef, useEffect, KeyboardEvent } from "react";
import { Mic, Send, X, Check } from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";
import { languageLocale } from "@/lib/i18n";

interface SpeechRecognitionResultLike {
  0: { transcript: string };
}

interface SpeechRecognitionEventLike {
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionLike;
}

interface InputBarProps {
  onSend: (message: string) => void;
  disabled?: boolean;
}

export default function InputBar({ onSend, disabled }: InputBarProps) {
  const { language, t } = useLanguage();
  const [value, setValue] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [barHeights, setBarHeights] = useState<number[]>(new Array(40).fill(3));
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
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
    const speechWindow = window as typeof window & {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };
    const SpeechRecognition =
      speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      alert(t.chat.speechUnsupported);
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = languageLocale(language);

    recognition.onstart = () => {
      setIsListening(true);
      setTranscript("");
      startAudioAnalysis();
    };

    recognition.onresult = (event: SpeechRecognitionEventLike) => {
      const result = Array.from(event.results)
        .map((resultItem) => resultItem[0].transcript)
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
                aria-label={t.chat.cancelRecording}
                type="button"
              >
                <X size={18} />
              </button>
              <button
                className="recording-confirm-btn"
                onClick={confirmListening}
                aria-label={t.chat.confirmRecording}
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
            placeholder={t.chat.inputPlaceholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            aria-label={t.chat.inputLabel}
          />
          <div className="input-actions">
            <button
              className="input-btn"
              aria-label={t.chat.sendMessage}
              type="button"
              onClick={handleSubmit}
              disabled={disabled || !value.trim()}
            >
              <Send size={16} />
            </button>
            <button
              className="input-btn-voice"
              aria-label={t.chat.voiceInput}
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
