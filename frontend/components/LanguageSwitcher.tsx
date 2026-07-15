"use client";

import { useLanguage } from "@/context/LanguageContext";
import { Language } from "@/lib/i18n";

interface LanguageSwitcherProps {
  onChange?: (language: Language) => void;
  compact?: boolean;
  className?: string;
}

export default function LanguageSwitcher({ onChange, compact = false, className = "" }: LanguageSwitcherProps) {
  const { language, setLanguage, t } = useLanguage();

  const selectLanguage = (nextLanguage: Language) => {
    if (nextLanguage === language) return;
    if (onChange) onChange(nextLanguage);
    else setLanguage(nextLanguage);
  };

  return (
    <div className={`language-switcher ${compact ? "compact" : ""} ${className}`.trim()} role="group" aria-label={t.settings.language}>
      <button
        type="button"
        className={language === "en" ? "active" : ""}
        onClick={() => selectLanguage("en")}
        aria-pressed={language === "en"}
      >
        {compact ? "EN" : t.common.english}
      </button>
      <button
        type="button"
        className={language === "es" ? "active" : ""}
        onClick={() => selectLanguage("es")}
        aria-pressed={language === "es"}
      >
        {compact ? "ES" : t.common.spanish}
      </button>
    </div>
  );
}
