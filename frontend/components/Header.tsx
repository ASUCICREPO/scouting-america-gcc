"use client";

import { isAuthenticated, getLoginUrl, logout } from "@/lib/auth";
import { MessageCircle } from "lucide-react";

export default function Header() {
  const loggedIn = typeof window !== "undefined" && isAuthenticated();

  return (
    <header className="header">
      <div className="header-left">
        <div className="header-logo">
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: "50%",
              background: "#003B75",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <MessageCircle size={16} color="white" />
          </div>
        </div>
        <span className="header-title">AI Assistant</span>
      </div>
      {loggedIn ? (
        <button className="login-btn" onClick={logout}>
          Log out
        </button>
      ) : (
        <button
          className="login-btn"
          onClick={() => {
            window.location.href = getLoginUrl();
          }}
        >
          Log in
        </button>
      )}
    </header>
  );
}
