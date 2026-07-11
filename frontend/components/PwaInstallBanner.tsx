"use client";

import { useState, useEffect } from "react";
import { X, Download } from "lucide-react";

export default function PwaInstallBanner() {
  const [showBanner, setShowBanner] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);

  useEffect(() => {
    // Check if already installed (standalone mode)
    const isInstalled =
      window.matchMedia("(display-mode: standalone)").matches ||
      (window.navigator as any).standalone === true;

    if (isInstalled) return;

    // Show banner on load (always, unless installed)
    setShowBanner(true);

    // Capture the beforeinstallprompt event
    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };

    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const handleInstall = async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === "accepted") {
        setShowBanner(false);
      }
      setDeferredPrompt(null);
    }
  };

  const handleDismiss = () => {
    setShowBanner(false);
    // Don't persist — will show again on next page load
  };

  if (!showBanner) return null;

  return (
    <div className="pwa-banner">
      <div className="pwa-banner-content">
        <div className="pwa-banner-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"
              fill="#005696"
            />
          </svg>
        </div>
        <div className="pwa-banner-text">
          <p className="pwa-banner-title">Add Scout AI to your home screen</p>
          <p className="pwa-banner-sub">Quick access, works offline</p>
        </div>
        <button className="pwa-banner-install" onClick={handleInstall}>
          <Download size={14} />
          <span>Install</span>
        </button>
        <button className="pwa-banner-close" onClick={handleDismiss} aria-label="Dismiss">
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
