"use client";

import { Suspense } from "react";
import AuthCallbackContent from "./AuthCallbackContent";

export default function AuthCallback() {
  return (
    <Suspense
      fallback={
        <div className="app-shell" style={{ justifyContent: "center", alignItems: "center" }}>
          <div className="typing-indicator">
            <div className="typing-dot" />
            <div className="typing-dot" />
            <div className="typing-dot" />
          </div>
          <p style={{ marginTop: 16, color: "#666", fontSize: 14 }}>
            Signing you in...
          </p>
        </div>
      }
    >
      <AuthCallbackContent />
    </Suspense>
  );
}
