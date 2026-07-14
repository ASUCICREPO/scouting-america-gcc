"use client";

import { Menu } from "lucide-react";

interface HeaderProps {
  onMenuClick?: () => void;
}

export default function Header({ onMenuClick }: HeaderProps) {
  return (
    <header className="header">
      <div className="header-left">
        <button
          className="header-avatar-btn"
          aria-label="Open sidebar"
          onClick={onMenuClick}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"
              fill="#005696"
            />
          </svg>
        </button>
        <span
          style={{
            fontSize: 17,
            fontWeight: 500,
            letterSpacing: "-0.3px",
          }}
          className="header-brand-text"
        >
          Scouting America
        </span>
      </div>
      <button
        className="header-menu-btn"
        onClick={onMenuClick}
        aria-label="Menu"
      >
        <Menu size={16} />
      </button>
    </header>
  );
}
