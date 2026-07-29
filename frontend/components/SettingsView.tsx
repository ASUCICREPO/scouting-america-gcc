"use client";

import { useState, useEffect, useRef } from "react";
import { ChevronLeft, ChevronDown, Globe, Moon, Type } from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";
import { Language } from "@/lib/i18n";

const SUPPORT_EMAIL = "GCC.Info@scoutingaz.org";

interface SettingsViewProps {
  onBack: () => void;
  /** When set, opens that policy dropdown on mount (e.g. from the chat's Terms/Privacy links). */
  initialSection?: "terms" | "privacy" | null;
  onLanguageChange: (language: Language) => void;
}

export default function SettingsView({ onBack, initialSection = null, onLanguageChange }: SettingsViewProps) {
  const { language, t } = useLanguage();
  const [darkMode, setDarkMode] = useState(false);
  const [fontSize, setFontSize] = useState(14);
  const [expandedSection, setExpandedSection] = useState<string | null>(initialSection);
  const supportRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const stored = localStorage.getItem("chat_settings");
      if (stored) {
        const parsed = JSON.parse(stored);
        setDarkMode(parsed.darkMode ?? false);
        setFontSize(parsed.fontSize ?? 14);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  // Apply settings to DOM
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", darkMode ? "dark" : "light");
  }, [darkMode]);

  useEffect(() => {
    document.documentElement.style.setProperty("--chat-font-size", `${fontSize}px`);
  }, [fontSize]);

  // When opened from a Terms/Privacy link, scroll the Support section into view.
  useEffect(() => {
    if (initialSection) {
      supportRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [initialSection]);

  const saveSettings = (updates: Partial<{ darkMode: boolean; fontSize: number }>) => {
    const next = { darkMode, fontSize, language, ...updates };
    localStorage.setItem("chat_settings", JSON.stringify(next));
    if ("darkMode" in updates) setDarkMode(updates.darkMode!);
    if ("fontSize" in updates) setFontSize(updates.fontSize!);
  };

  return (
    <div className="settings-page">
      <div className="settings-back-row">
        <button className="settings-back-btn" onClick={onBack} aria-label={t.common.back}>
          <ChevronLeft size={18} />
        </button>
        <h2 className="settings-page-title">{t.settings.title}</h2>
      </div>

      <div className="settings-content">
        {/* Appearance section */}
        <p className="settings-section-label">{t.settings.appearance}</p>
        <div className="settings-card">
          <div className="settings-row">
            <Globe size={18} className="settings-row-icon" />
            <span className="settings-row-text">{t.settings.language}</span>
            <div className="settings-toggle-group">
              <button
                className={`settings-toggle-btn ${language === "en" ? "active" : ""}`}
                onClick={() => onLanguageChange("en")}
                aria-pressed={language === "en"}
              >
                EN
              </button>
              <button
                className={`settings-toggle-btn ${language === "es" ? "active" : ""}`}
                onClick={() => onLanguageChange("es")}
                aria-pressed={language === "es"}
              >
                ES
              </button>
            </div>
          </div>

          <div className="settings-row">
            <Moon size={18} className="settings-row-icon" />
            <span className="settings-row-text">{t.settings.darkMode}</span>
            <button
              className={`settings-switch ${darkMode ? "on" : ""}`}
              onClick={() => saveSettings({ darkMode: !darkMode })}
              aria-label={t.settings.toggleDarkMode}
            >
              <div className="settings-switch-thumb" />
            </button>
          </div>

          <div className="settings-row">
            <Type size={18} className="settings-row-icon" />
            <span className="settings-row-text">{t.settings.textSize}</span>
            <input
              type="range"
              min={12}
              max={20}
              value={fontSize}
              onChange={(e) => saveSettings({ fontSize: Number(e.target.value) })}
              className="settings-slider"
              aria-label={t.settings.textSize}
            />
            <span className="settings-row-value">{fontSize}px</span>
          </div>
        </div>

        {/* Support section */}
        <p className="settings-section-label" ref={supportRef}>{t.settings.support}</p>
        <div className="settings-card">
          <div
            className="settings-row clickable"
            onClick={() => setExpandedSection(expandedSection === "terms" ? null : "terms")}
          >
            <span className="settings-row-text">{t.settings.termsOfUse}</span>
            <ChevronDown size={14} style={{ transform: expandedSection === "terms" ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s", color: "var(--text-muted)" }} />
          </div>
          {expandedSection === "terms" && (
            <div className="settings-policy-content">
              {t.settings.termsParagraphs.map((paragraph) => <PolicyParagraph key={paragraph} text={paragraph} />)}
            </div>
          )}

          <div
            className="settings-row clickable"
            onClick={() => setExpandedSection(expandedSection === "privacy" ? null : "privacy")}
          >
            <span className="settings-row-text">{t.settings.privacyPolicy}</span>
            <ChevronDown size={14} style={{ transform: expandedSection === "privacy" ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s", color: "var(--text-muted)" }} />
          </div>
          {expandedSection === "privacy" && (
            <div className="settings-policy-content">
              {t.settings.privacyParagraphs.map((paragraph, index) => (
                index === 0 ? <p key={paragraph}><strong>{paragraph}</strong></p> : <PolicyParagraph key={paragraph} text={paragraph} />
              ))}
            </div>
          )}

          <a className="settings-row clickable settings-row-link" href={`mailto:${SUPPORT_EMAIL}`}>
            <span className="settings-row-text">{t.settings.help}</span>
          </a>
          <a className="settings-row clickable settings-row-link" href={`mailto:${SUPPORT_EMAIL}`}>
            <span className="settings-row-text">{t.settings.contactUs}</span>
          </a>
        </div>
      </div>
    </div>
  );
}

function PolicyParagraph({ text }: { text: string }) {
  const [before, after] = text.split("scoutingAZ.org");
  if (after === undefined) return <p>{text}</p>;
  return (
    <p>
      {before}<a href="https://scoutingAZ.org" target="_blank" rel="noopener noreferrer">scoutingAZ.org</a>{after}
    </p>
  );
}
