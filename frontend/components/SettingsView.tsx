"use client";

import { useState, useEffect, useRef } from "react";
import { ChevronLeft, ChevronDown, Globe, Moon, Type } from "lucide-react";

interface SettingsViewProps {
  onBack: () => void;
  /** When set, opens that policy dropdown on mount (e.g. from the chat's Terms/Privacy links). */
  initialSection?: "terms" | "privacy" | null;
}

export default function SettingsView({ onBack, initialSection = null }: SettingsViewProps) {
  const [darkMode, setDarkMode] = useState(false);
  const [fontSize, setFontSize] = useState(14);
  const [language, setLanguage] = useState<"en" | "es">("en");
  const [expandedSection, setExpandedSection] = useState<string | null>(initialSection);
  const supportRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const stored = localStorage.getItem("chat_settings");
    if (stored) {
      const parsed = JSON.parse(stored);
      setDarkMode(parsed.darkMode ?? false);
      setFontSize(parsed.fontSize ?? 14);
      setLanguage(parsed.language ?? "en");
    }
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

  const saveSettings = (updates: Partial<{ darkMode: boolean; fontSize: number; language: string }>) => {
    const next = { darkMode, fontSize, language, ...updates };
    localStorage.setItem("chat_settings", JSON.stringify(next));
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
        <p className="settings-section-label" ref={supportRef}>Support</p>
        <div className="settings-card">
          <div
            className="settings-row clickable"
            onClick={() => setExpandedSection(expandedSection === "terms" ? null : "terms")}
          >
            <span className="settings-row-text">Terms of Use</span>
            <ChevronDown size={14} style={{ transform: expandedSection === "terms" ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s", color: "var(--text-muted)" }} />
          </div>
          {expandedSection === "terms" && (
            <div className="settings-policy-content">
              <p>Welcome to the Grand Canyon Council Scouting Support Assistant.</p>
              <p>This tool is designed to provide information and guidance related to Scouting programs, policies, procedures, training, and resources. It is intended to support volunteers, parents, families, and staff by making Scouting information easier to access.</p>
              <p>This tool is trained using selected Scouting America and Grand Canyon Council policies, resources, training materials, and publications. While it is designed to provide accurate and helpful guidance, it does not replace official Scouting training, publications, policies, or the judgment of qualified volunteers and professionals.</p>
              <p>Because this tool uses artificial intelligence, responses may occasionally be incomplete, outdated, or incorrect. Users are responsible for verifying information before making decisions that affect youth, volunteers, units, finances, property, health, safety, or legal compliance.</p>
              <p>Because this tool is designed to rely on approved Scouting resources, it may not always have an answer to every question. When information is unavailable or additional guidance is needed, please contact your Unit Coach or the Grand Canyon Council Service Center, or visit <a href="https://scoutingAZ.org" target="_blank" rel="noopener noreferrer">scoutingAZ.org</a> for assistance.</p>
              <p>This tool is not monitored for emergency communications, incident reporting, safeguarding concerns, medical emergencies, or other urgent situations. Submitting information through this tool does not constitute a report to Scouting America or Grand Canyon Council.</p>
              <p>If you need to report a safeguarding concern or potential violation of Scouting&apos;s Safeguarding Youth policies, contact the Grand Canyon Council Scout Executive immediately using the contact information available at <a href="https://scoutingAZ.org" target="_blank" rel="noopener noreferrer">scoutingAZ.org</a>.</p>
              <p>Users are expected to use this tool in a manner consistent with the values of the Scout Oath and Scout Law.</p>
              <p>By using this tool, you acknowledge these terms and agree to use the information provided responsibly and in support of a safe, positive Scouting experience.</p>
            </div>
          )}

          <div
            className="settings-row clickable"
            onClick={() => setExpandedSection(expandedSection === "privacy" ? null : "privacy")}
          >
            <span className="settings-row-text">Privacy Policy</span>
            <ChevronDown size={14} style={{ transform: expandedSection === "privacy" ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s", color: "var(--text-muted)" }} />
          </div>
          {expandedSection === "privacy" && (
            <div className="settings-policy-content">
              <p><strong>Your privacy matters to us.</strong></p>
              <p>This tool is provided by Grand Canyon Council to help answer questions and support Scouting volunteers, parents, and families. We do not collect or store personal information beyond what is necessary to provide the service.</p>
              <p>Conversations with the tool may be used in aggregate to understand overall usage, improve the experience, and identify common topics of interest. Individual conversations are not reviewed for marketing purposes, sold to third parties, or used to build advertising profiles.</p>
              <p>To make your experience more helpful, the tool may use browser-based technology (similar to cookies) to remember previous conversations on your device. This information is used only to improve your experience with the tool.</p>
              <p>Please do not use this tool to submit incident reports, youth protection concerns, membership applications, medical information, or other sensitive personal information. If you need assistance with a safeguarding concern, contact the Grand Canyon Council Scout Executive immediately using the contact information available at <a href="https://scoutingAZ.org" target="_blank" rel="noopener noreferrer">scoutingAZ.org</a>.</p>
              <p>By using this tool, you acknowledge that AI-generated responses may not always be complete or accurate. When in doubt, please contact your Unit Leader, Unit Coach, or the Grand Canyon Council Service Center for assistance.</p>
            </div>
          )}

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


