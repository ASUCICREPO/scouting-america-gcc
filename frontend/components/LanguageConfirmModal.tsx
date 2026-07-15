"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";

interface LanguageConfirmModalProps {
  isOpen: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function LanguageConfirmModal({ isOpen, onCancel, onConfirm }: LanguageConfirmModalProps) {
  const { t } = useLanguage();

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  return (
    <div className="language-modal-overlay" onClick={onCancel}>
      <div
        className="language-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="language-modal-title"
        aria-describedby="language-modal-description"
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" className="language-modal-close" onClick={onCancel} aria-label={t.common.close}>
          <X size={18} />
        </button>
        <h2 id="language-modal-title">{t.chat.changeLanguageTitle}</h2>
        <p id="language-modal-description">{t.chat.changeLanguageMessage}</p>
        <div className="language-modal-actions">
          <button type="button" className="language-modal-cancel" onClick={onCancel}>{t.common.cancel}</button>
          <button type="button" className="language-modal-confirm" onClick={onConfirm}>{t.common.continue}</button>
        </div>
      </div>
    </div>
  );
}
