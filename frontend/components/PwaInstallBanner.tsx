"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import { X, Download, SquareArrowUp } from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export default function PwaInstallBanner() {
  const { t } = useLanguage();
  const [isExpanded, setIsExpanded] = useState(true);
  const [showIosGuidance, setShowIosGuidance] = useState(false);
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const desktopQuery = window.matchMedia("(min-width: 768px)");
    const standaloneQuery = window.matchMedia("(display-mode: standalone)");
    const isInstalled = () =>
      standaloneQuery.matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone ===
        true;
    const isIosDevice =
      /iPad|iPhone|iPod/i.test(window.navigator.userAgent) ||
      (window.navigator.platform === "MacIntel" &&
        window.navigator.maxTouchPoints > 1);

    const handler = (e: Event) => {
      if (!desktopQuery.matches || isInstalled()) return;
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    const installedHandler = () => {
      setShowIosGuidance(false);
      setDeferredPrompt(null);
    };

    const displayModeHandler = () => {
      if (isInstalled()) {
        installedHandler();
        return;
      }

      if (!desktopQuery.matches && isIosDevice) {
        setDeferredPrompt(null);
        setShowIosGuidance(true);
        return;
      }

      setShowIosGuidance(false);
      if (!desktopQuery.matches) {
        setDeferredPrompt(null);
      }
    };

    const initialDisplayCheck = window.requestAnimationFrame(displayModeHandler);
    window.addEventListener("beforeinstallprompt", handler);
    window.addEventListener("appinstalled", installedHandler);
    desktopQuery.addEventListener("change", displayModeHandler);
    standaloneQuery.addEventListener("change", displayModeHandler);

    return () => {
      window.cancelAnimationFrame(initialDisplayCheck);
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
      setDeferredPrompt(null);
    }
  };

  const isAvailable = showIosGuidance || deferredPrompt !== null;

  if (!isAvailable) return null;

  if (!isExpanded) {
    return (
      <button
        type="button"
        className={`pwa-banner-toggle${showIosGuidance ? " pwa-banner-toggle-mobile" : ""}`}
        onClick={() => setIsExpanded(true)}
        aria-label={t.chat.showInstall}
        aria-expanded="false"
        title={t.chat.showInstall}
      >
        {showIosGuidance ? (
          <SquareArrowUp size={20} />
        ) : (
          <Download size={20} />
        )}
      </button>
    );
  }

  return (
    <div
      className={`pwa-banner${showIosGuidance ? " pwa-banner-mobile" : ""}`}
      role="region"
      aria-label={t.chat.installRegion}
    >
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
          {showIosGuidance && (
            <p className="pwa-banner-instructions">
              <SquareArrowUp size={16} aria-hidden="true" />
              <span>{t.chat.iosInstallInstructions}</span>
            </p>
          )}
        </div>
        {!showIosGuidance && (
          <button
            type="button"
            className="pwa-banner-install"
            onClick={handleInstall}
          >
            <Download size={14} />
            <span>{t.chat.install}</span>
          </button>
        )}
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
