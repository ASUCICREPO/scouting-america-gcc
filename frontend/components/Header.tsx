"use client";

import { Menu } from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";

interface HeaderProps {
  onMenuClick?: () => void;
}

export default function Header({ onMenuClick }: HeaderProps) {
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
      <button
        className="header-menu-btn"
        onClick={onMenuClick}
        aria-label={t.chat.menu}
      >
        <Menu size={16} />
      </button>
    </header>
  );
}
