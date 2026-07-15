'use client';

import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, ReactNode } from 'react';
import { useLanguage } from '@/context/LanguageContext';

export interface AppSettings {
  theme: 'light' | 'dark';
  language: 'english' | 'espanol';
  textSize: 'small' | 'medium' | 'large';
  companyLogo: string | null;
  profileImage: string | null;
  firstName: string;
  lastName: string;
}

const defaultSettings: AppSettings = {
  theme: 'light',
  language: 'english',
  textSize: 'medium',
  companyLogo: null,
  profileImage: null,
  firstName: '',
  lastName: '',
};

const SETTINGS_KEY = 'gcc_admin_app_settings';
const SETTINGS_CHANGE_EVENT = 'gcc-admin-settings-change';
let cachedSettingsRaw: string | null | undefined;
let cachedSettings = defaultSettings;

function readSettings(): AppSettings {
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (raw === cachedSettingsRaw) return cachedSettings;
  cachedSettingsRaw = raw;
  try {
    cachedSettings = { ...defaultSettings, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    cachedSettings = defaultSettings;
  }
  return cachedSettings;
}

function subscribeToSettings(onStoreChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === SETTINGS_KEY) onStoreChange();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(SETTINGS_CHANGE_EVENT, onStoreChange);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(SETTINGS_CHANGE_EVENT, onStoreChange);
  };
}

interface SettingsContextType {
  settings: AppSettings;
  updateSettings: (partial: Partial<AppSettings>) => void;
}

const SettingsContext = createContext<SettingsContextType>({
  settings: defaultSettings,
  updateSettings: () => {},
});

export function SettingsProvider({ children }: { children: ReactNode }) {
  const { language, setLanguage } = useLanguage();
  const storedSettings = useSyncExternalStore(subscribeToSettings, readSettings, () => defaultSettings);
  const settings = useMemo<AppSettings>(() => ({
    ...storedSettings,
    language: language === 'es' ? 'espanol' : 'english',
  }), [storedSettings, language]);

  useEffect(() => {
    // Apply theme
    document.documentElement.setAttribute('data-theme', settings.theme);
    // Apply text size
    document.documentElement.setAttribute('data-text-size', settings.textSize);
  }, [settings.theme, settings.textSize]);

  function updateSettings(partial: Partial<AppSettings>) {
    if (partial.language) {
      setLanguage(partial.language === 'espanol' ? 'es' : 'en');
    }
    const updated = { ...readSettings(), ...partial };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(updated));
    cachedSettingsRaw = undefined;
    window.dispatchEvent(new Event(SETTINGS_CHANGE_EVENT));
  }

  return (
    <SettingsContext.Provider value={{ settings, updateSettings }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  return useContext(SettingsContext);
}
