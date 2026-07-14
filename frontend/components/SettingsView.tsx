"use client";

import { useState, useEffect } from "react";
import { ChevronLeft, Globe, Moon, Type } from "lucide-react";

interface SettingsViewProps {
  onBack: () => void;
}

export default function SettingsView({ onBack }: SettingsViewProps) {
  const [darkMode, setDarkMode] = useState(false);
  const [fontSize, setFontSize] = useState(14);
  const [language, setLanguage] = useState<"en" | "es">("en");

  useEffect(() => {
    const stored = localStorage.getItem("chat_settings");
    if (stored) {
      const parsed = JSON.parse(stored);
      setDarkMode(parsed.darkMode ?? false);
      setFontSize(parsed.fontSize ?? 14);
      setLanguage(parsed.language ?? "en");
    }
  }, []);

  const saveSettings = (updates: Partial<{ darkMode: boolean; fontSize: number; language: string }>) => {
    const current = { darkMode, fontSize, language, ...updates };
    localStorage.setItem("chat_settings", JSON.stringify(current));
    if ("darkMode" in updates) setDarkMode(updates.darkMode!);
    if ("fontSize" in updates) setFontSize(updates.fontSize!);
    if ("language" in updates) setLanguage(updates.language as "en" | "es");
  };

  return (
    <div className="settings-page">
      <div className="settings-back-row">
        <button className="settings-back-btn" onClick={onBack} aria-label="Back">
          <ChevronLeft size={18} />
        </button>
        <h2 className="settings-page-title">Settings</h2>
      </div>

      <div className="settings-content">
        {/* Appearance section */}
        <p className="settings-section-label">Appearance</p>
        <div className="settings-card">
          <div className="settings-row">
            <Globe size={18} className="settings-row-icon" />
            <span className="settings-row-text">Language</span>
            <div className="settings-toggle-group">
              <button
                className={`settings-toggle-btn ${language === "en" ? "active" : ""}`}
                onClick={() => saveSettings({ language: "en" })}
              >
                EN
              </button>
              <button
                className={`settings-toggle-btn ${language === "es" ? "active" : ""}`}
                onClick={() => saveSettings({ language: "es" })}
              >
                ES
              </button>
            </div>
          </div>

          <div className="settings-row">
            <Moon size={18} className="settings-row-icon" />
            <span className="settings-row-text">Dark Mode</span>
            <button
              className={`settings-switch ${darkMode ? "on" : ""}`}
              onClick={() => saveSettings({ darkMode: !darkMode })}
              aria-label="Toggle dark mode"
            >
              <div className="settings-switch-thumb" />
            </button>
          </div>

          <div className="settings-row">
            <Type size={18} className="settings-row-icon" />
            <span className="settings-row-text">Text Size</span>
            <input
              type="range"
              min={12}
              max={20}
              value={fontSize}
              onChange={(e) => saveSettings({ fontSize: Number(e.target.value) })}
              className="settings-slider"
              aria-label="Text size"
            />
            <span className="settings-row-value">{fontSize}px</span>
          </div>
        </div>

        {/* Support section */}
        <p className="settings-section-label">Support</p>
        <div className="settings-card">
          <div className="settings-row clickable">
            <span className="settings-row-text">About us</span>
          </div>
          <div className="settings-row clickable">
            <span className="settings-row-text">Privacy policy</span>
          </div>
          <div className="settings-row clickable">
            <span className="settings-row-text">Help</span>
          </div>
          <div className="settings-row clickable">
            <span className="settings-row-text">Contact us</span>
          </div>
        </div>
      </div>
    </div>
  );
}
