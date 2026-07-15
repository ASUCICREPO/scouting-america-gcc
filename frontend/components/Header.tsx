"use client";

import { Menu } from "lucide-react";

interface HeaderProps {
  onMenuClick?: () => void;
}

export default function Header({ onMenuClick }: HeaderProps) {
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
        aria-label="Menu"
      >
        <Menu size={16} />
      </button>
    </header>
  );
}
