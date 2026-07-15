"use client";

import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import { Language, Translations, translations } from "@/lib/i18n";

const LANGUAGE_STORAGE_KEY = "gcc_language";
const CHAT_SETTINGS_KEY = "chat_settings";
const ADMIN_SETTINGS_KEY = "gcc_admin_app_settings";
const LANGUAGE_CHANGE_EVENT = "gcc-language-change";
const ADMIN_SETTINGS_CHANGE_EVENT = "gcc-admin-settings-change";

interface LanguageContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: Translations;
}

const LanguageContext = createContext<LanguageContextValue | undefined>(undefined);

function storedLanguage(): Language {
  const direct = localStorage.getItem(LANGUAGE_STORAGE_KEY);
  if (direct === "en" || direct === "es") return direct;

  try {
    const chatSettings = JSON.parse(localStorage.getItem(CHAT_SETTINGS_KEY) || "{}");
    if (chatSettings.language === "en" || chatSettings.language === "es") {
      return chatSettings.language;
    }
    const adminSettings = JSON.parse(localStorage.getItem(ADMIN_SETTINGS_KEY) || "{}");
    if (adminSettings.language === "espanol") return "es";
  } catch {
    // Ignore invalid legacy settings and use English.
  }
  return "en";
}

function updateStoredObject(key: string, language: Language) {
  const legacyLanguage = key === ADMIN_SETTINGS_KEY
    ? language === "es" ? "espanol" : "english"
    : language;
  try {
    const current = JSON.parse(localStorage.getItem(key) || "{}");
    localStorage.setItem(key, JSON.stringify({ ...current, language: legacyLanguage }));
  } catch {
    localStorage.setItem(key, JSON.stringify({ language: legacyLanguage }));
  }
}

function subscribeToLanguage(onStoreChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if ([LANGUAGE_STORAGE_KEY, CHAT_SETTINGS_KEY, ADMIN_SETTINGS_KEY].includes(event.key || "")) {
      onStoreChange();
    }
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(LANGUAGE_CHANGE_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(LANGUAGE_CHANGE_EVENT, onStoreChange);
  };
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const language = useSyncExternalStore<Language>(subscribeToLanguage, storedLanguage, () => "en");

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const setLanguage = useCallback((nextLanguage: Language) => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, nextLanguage);
    updateStoredObject(CHAT_SETTINGS_KEY, nextLanguage);
    updateStoredObject(ADMIN_SETTINGS_KEY, nextLanguage);
    document.documentElement.lang = nextLanguage;
    window.dispatchEvent(new Event(LANGUAGE_CHANGE_EVENT));
    window.dispatchEvent(new Event(ADMIN_SETTINGS_CHANGE_EVENT));
  }, []);

  const value = useMemo(
    () => ({ language, setLanguage, t: translations[language] }),
    [language, setLanguage],
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
  const context = useContext(LanguageContext);
  if (!context) throw new Error("useLanguage must be used within LanguageProvider");
  return context;
}
