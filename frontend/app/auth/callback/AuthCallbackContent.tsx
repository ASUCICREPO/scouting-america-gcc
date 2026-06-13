"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { exchangeCode } from "@/lib/auth";

export default function AuthCallbackContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const code = searchParams.get("code");
    if (code) {
      exchangeCode(code)
        .then(() => {
          router.push("/");
        })
        .catch((err) => {
          console.error("Auth error:", err);
          setError("Authentication failed. Please try again.");
        });
    } else {
      setError("No authorization code received.");
    }
  }, [searchParams, router]);

  if (error) {
    return (
      <div className="app-shell" style={{ justifyContent: "center", alignItems: "center" }}>
        <p style={{ color: "#CE1126", fontSize: 14 }}>{error}</p>
        <button
          className="login-btn"
          style={{ marginTop: 16 }}
          onClick={() => router.push("/")}
        >
          Return Home
        </button>
      </div>
    );
  }

  return (
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
  );
}
