"use client";

import { useState, useEffect } from "react";
import { Menu } from "lucide-react";
import { isAuthenticated, getLoginUrl, logout } from "@/lib/auth";

interface HeaderProps {
  onMenuClick?: () => void;
}

export default function Header({ onMenuClick }: HeaderProps) {
  const [loggedIn, setLoggedIn] = useState(false);

  useEffect(() => {
    setLoggedIn(isAuthenticated());
  }, []);

  return (
    <header className="header">
      <div className="header-left">
        <button className="header-avatar-btn" aria-label="Home">
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
            color: "#1b1b1b",
            letterSpacing: "-0.3px",
          }}
        >
          Scouting America
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {loggedIn ? (
          <button
            onClick={logout}
            style={{
              padding: "6px 14px",
              borderRadius: 20,
              border: "1px solid #e8e8e8",
              background: "white",
              fontSize: 13,
              fontWeight: 500,
              color: "#005696",
              cursor: "pointer",
            }}
          >
            Log out
          </button>
        ) : (
          <button
            onClick={() => {
              window.location.href = getLoginUrl();
            }}
            style={{
              padding: "6px 14px",
              borderRadius: 20,
              border: "1px solid #005696",
              background: "white",
              fontSize: 13,
              fontWeight: 500,
              color: "#005696",
              cursor: "pointer",
            }}
          >
            Log in
          </button>
        )}
        <button
          className="header-menu-btn"
          onClick={onMenuClick}
          aria-label="Menu"
        >
          <Menu size={16} />
        </button>
      </div>
    </header>
  );
}
