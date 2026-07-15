"use client";

import { Menu } from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";
import { Language } from "@/lib/i18n";
import LanguageSwitcher from "./LanguageSwitcher";

interface HeaderProps {
  onMenuClick?: () => void;
  onLanguageChange: (language: Language) => void;
}

export default function Header({ onMenuClick, onLanguageChange }: HeaderProps) {
  const { t } = useLanguage();
  return (
    <header className="header">
      <div className="header-left">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/gcc-logo.png"
          alt="Grand Canyon Council"
          className="header-logo"
          style={{ height: 32, width: "auto" }}
        />
      </div>
      <div className="header-actions">
        <LanguageSwitcher onChange={onLanguageChange} compact />
        <button
          className="header-menu-btn"
          onClick={onMenuClick}
          aria-label={t.chat.menu}
        >
          <Menu size={16} />
        </button>
      </div>
    </header>
  );
}
