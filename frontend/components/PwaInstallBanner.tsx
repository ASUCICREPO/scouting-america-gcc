"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import { X, Download } from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export default function PwaInstallBanner() {
  const { t } = useLanguage();
  const [isAvailable, setIsAvailable] = useState(false);
  const [isExpanded, setIsExpanded] = useState(true);
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const desktopQuery = window.matchMedia("(min-width: 768px)");
    const standaloneQuery = window.matchMedia("(display-mode: standalone)");
    const isInstalled = () =>
      standaloneQuery.matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone ===
        true;

    const handler = (e: Event) => {
      if (!desktopQuery.matches || isInstalled()) return;
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setIsAvailable(true);
    };

    const installedHandler = () => {
      setIsAvailable(false);
      setDeferredPrompt(null);
    };

    const displayModeHandler = () => {
      if (!desktopQuery.matches || isInstalled()) {
        installedHandler();
      }
    };

    window.addEventListener("beforeinstallprompt", handler);
    window.addEventListener("appinstalled", installedHandler);
    desktopQuery.addEventListener("change", displayModeHandler);
    standaloneQuery.addEventListener("change", displayModeHandler);

    return () => {
      window.removeEventListener("beforeinstallprompt", handler);
      window.removeEventListener("appinstalled", installedHandler);
      desktopQuery.removeEventListener("change", displayModeHandler);
      standaloneQuery.removeEventListener("change", displayModeHandler);
    };
  }, []);

  const handleInstall = async () => {
    if (!deferredPrompt) return;

    try {
      await deferredPrompt.prompt();
      await deferredPrompt.userChoice;
    } finally {
      setIsAvailable(false);
      setDeferredPrompt(null);
    }
  };

  if (!isAvailable) return null;

  if (!isExpanded) {
    return (
      <button
        type="button"
        className="pwa-banner-toggle"
        onClick={() => setIsExpanded(true)}
        aria-label={t.chat.showInstall}
        aria-expanded="false"
        title={t.chat.showInstall}
      >
        <Download size={20} />
      </button>
    );
  }

  return (
    <div className="pwa-banner" role="region" aria-label={t.chat.installRegion}>
      <div className="pwa-banner-content">
        <div className="pwa-banner-icon">
          <Image
            src="/gcc-emblem.jpg"
            alt="Grand Canyon Council"
            width={40}
            height={40}
          />
        </div>
        <div className="pwa-banner-text">
          <p className="pwa-banner-title">{t.chat.installTitle}</p>
        </div>
        <button
          type="button"
          className="pwa-banner-install"
          onClick={handleInstall}
        >
          <Download size={14} />
          <span>{t.chat.install}</span>
        </button>
        <button
          type="button"
          className="pwa-banner-close"
          onClick={() => setIsExpanded(false)}
          aria-label={t.chat.hideInstall}
          aria-expanded="true"
          title={t.chat.hideInstall}
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
